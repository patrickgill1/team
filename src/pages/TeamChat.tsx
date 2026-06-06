import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { where, doc, updateDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { getShareOrigin } from '../utils/origin';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { ChatThread, ChatMessage } from '../types';
import MessageBubble from '../components/chat/MessageBubble';
import MessageComposer, { ComposerAttachment } from '../components/chat/MessageComposer';
import PollCard from '../components/chat/PollCard';

const TeamChat: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    addChatThread,
    updateChatThread,
    addChatMessage,
    subscribeToChatThreads,
    subscribeToClubChatThreads,
    subscribeToChatMessages,
    updateDocument,
    deleteDocument,
    getDocuments,
    getOrCreateDMThread,
  } = useFirestore();
  
  // Simple mobile-first state management
  const [currentView, setCurrentView] = useState<'threads' | 'chat'>('threads');
  // Team-scoped threads (the active team's chats + DMs) and club-scoped
  // threads (visible regardless of which team is selected). Kept in
  // separate state slots; combined via the `threads` memo below.
  const [teamThreads, setTeamThreads] = useState<ChatThread[]>([]);
  const [clubThreads, setClubThreads] = useState<ChatThread[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // In-thread search — client-side filter over already-loaded messages.
  // No server query yet; sufficient for the typical loaded window
  // (last ~200 msgs). Server-side full-text search is a later batch.
  const [threadSearchOpen, setThreadSearchOpen] = useState(false);
  const [threadSearchQuery, setThreadSearchQuery] = useState('');
  const [selectedThread, setSelectedThread] = useState<ChatThread | null>(null);
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTag, setFilterTag] = useState<string>('all');
  // Sectioned-list collapse state. Keyed by section id; persisted in
  // localStorage so it survives reloads.
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem('firefc.chatSectionsCollapsed');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const toggleSection = (id: string) => {
    setCollapsedSections(prev => {
      const next = { ...prev, [id]: !prev[id] };
      try { localStorage.setItem('firefc.chatSectionsCollapsed', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  // Per-thread visited timestamps (localStorage). Used to compute the
  // "Unread" filter + bold/dot indicator on rows without changing
  // Firestore schema. Updated on send AND on opening a thread.
  const [threadVisited, setThreadVisited] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem('firefc.threadVisited');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const markThreadVisited = (threadId: string) => {
    if (!threadId) return;
    setThreadVisited(prev => {
      const next = { ...prev, [threadId]: Date.now() };
      try { localStorage.setItem('firefc.threadVisited', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  const isThreadUnread = (thread: ChatThread): boolean => {
    const lastTs = thread.lastActivity instanceof Date
      ? thread.lastActivity.getTime()
      : new Date(thread.lastActivity || 0).getTime();
    const seenTs = threadVisited[thread.id] || 0;
    // Brand-new threads with no last message shouldn't be unread.
    if (!thread.lastMessage) return false;
    return lastTs > seenTs;
  };
  const [loading, setLoading] = useState(true);
  const [teamMembers, setTeamMembers] = useState<{ uid: string; name: string; role?: string; email?: string; photoURL?: string; childNames?: string[] }[]>([]);
  // teamId → teamName lookup. Used to label each thread with its
  // team chip now that the chat tab spans every team the user is on.
  const [teamNameById, setTeamNameById] = useState<Record<string, string>>({});
  
  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  // "Was the user at the bottom of the thread on the last render?"
  // Updated on every scroll. If true, we auto-pin to the new bottom
  // when new messages arrive OR when images load and reflow the list.
  // If false, the user has scrolled up to read history — leave them
  // alone.
  const isAtBottomRef = useRef(true);
  // Tracks the last thread we've INITIALIZED scroll for. On the first
  // render of a new thread (after its messages arrive), we instant-
  // scroll to the bottom. On subsequent renders for the same thread,
  // we only smooth-scroll if the user was already at the bottom.
  const anchoredThreadIdRef = useRef<string | null>(null);
  // Timestamp (epoch ms) marking the end of the "initial load" window
  // after a thread opens. During this window we IGNORE onScroll
  // events (iOS WebKit's automatic scroll anchoring fires synthetic
  // scrolls as images load, which would otherwise flip isAtBottomRef
  // to false and strand the user on whatever image WebKit anchored).
  const initialLoadUntilRef = useRef<number>(0);

  // New thread form
  const [newThread, setNewThread] = useState<{
    title: string;
    description: string;
    isPrivate: boolean;
    scope: 'team' | 'club' | 'coaches' | 'admins';
    tags: string[];
  }>({
    title: '',
    description: '',
    isPrivate: false,
    scope: 'club',
    tags: [],
  });

  // Direct-message picker state
  const [isDMPickerOpen, setIsDMPickerOpen] = useState(false);
  // Multi-select state for the chat picker. One selected → DM.
  // Two or more → group thread. Cleared every time the picker opens.
  const [selectedDmUids, setSelectedDmUids] = useState<Set<string>>(new Set());
  const [dmSearch, setDmSearch] = useState('');
  const [dmStarting, setDmStarting] = useState<string | null>(null);

  // Chat image lightbox — when set, the URL is shown full-screen.
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const isCoach = userData?.role === 'coach';
  const isUserClubAdmin = !!(userData as any)?.isClubAdmin;

  // Detect mobile + track viewport height. With Capacitor's
  // Keyboard.resize: 'native', iOS shrinks the WebView when the keyboard
  // appears — so window.innerHeight DOES drop from e.g. 860 → 531. But
  // position:fixed elements with `bottom: 0` continue to anchor against
  // the ORIGINAL viewport bottom (an iOS WKWebView quirk). We work around
  // it by setting the chat container's height explicitly from
  // window.innerHeight, instead of relying on CSS bottom anchoring.
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [winHeight, setWinHeight] = useState(window.innerHeight);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      setWinHeight(window.innerHeight);
      // On desktop, always show threads view alongside chat
      if (!mobile) {
        setCurrentView('threads');
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Lock background scroll while the chat is mounted so the only thing that
  // can scroll is the messages list itself. Without this, iOS rubber-bands
  // the body and the fixed bottom tab bar appears to drift over the chat.
  useEffect(() => {
    document.body.classList.add('chat-locked');
    return () => { document.body.classList.remove('chat-locked'); };
  }, []);

  // Two parallel signals for "how much of the viewport is currently hidden
  // by the keyboard," because neither one alone is reliable on iOS Capacitor:
  //
  //   1. `window.visualViewport` — standard browser API. Fires resize when
  //      the visible region shrinks for ANY reason (keyboard, page zoom,
  //      browser chrome). Works on web + most iOS WebKit builds.
  //
  //   2. Capacitor Keyboard `keyboardWillShow/Hide` — direct from the
  //      native side. Reports keyboardHeight in CSS pixels. Works even
  //      when visualViewport doesn't (some WebView builds don't fire it).
  //
  // We take the larger of the two so the composer is guaranteed to ride
  // above the keyboard no matter which mechanism actually fired.
  const [vvInset, setVvInset] = useState(0);
  const [capInset, setCapInset] = useState(0);
  const kbInset = Math.max(vvInset, capInset);

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setVvInset(inset);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  useEffect(() => {
    let cleanup: any;
    (async () => {
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform()) return;
        const { Keyboard } = await import('@capacitor/keyboard');
        const a = await Keyboard.addListener('keyboardWillShow', (info) => setCapInset(info.keyboardHeight || 0));
        const b = await Keyboard.addListener('keyboardDidShow', (info) => setCapInset(info.keyboardHeight || 0));
        const c = await Keyboard.addListener('keyboardWillHide', () => setCapInset(0));
        const d = await Keyboard.addListener('keyboardDidHide', () => setCapInset(0));
        cleanup = () => { a.remove(); b.remove(); c.remove(); d.remove(); };
      } catch { /* not running in Capacitor — web ignore */ }
    })();
    return () => { if (cleanup) cleanup(); };
  }, []);

  // When the user opens a specific conversation on mobile, hide the bottom
  // tab bar so the composer can dock right above the keyboard. The threads
  // list view still shows the tabs (so they can switch sections from there).
  useEffect(() => {
    const inConversation = isMobile && currentView === 'chat' && selectedThread;
    if (inConversation) {
      document.body.classList.add('chat-conversation');
    } else {
      document.body.classList.remove('chat-conversation');
    }
    return () => { document.body.classList.remove('chat-conversation'); };
  }, [isMobile, currentView, selectedThread]);

  // Simple navigation functions
  const showThreadsList = () => {
    console.log('Showing threads list');
    setCurrentView('threads');
    setSelectedThread(null);
  };

  const showChatView = (thread: ChatThread) => {
    setSelectedThread(thread);
    setCurrentView('chat');
    markThreadVisited(thread.id);
  };

  // Jump or animate the messages list to the bottom. Manipulating
  // scrollTop directly is more reliable on iOS WKWebView than
  // scrollIntoView({behavior:'smooth'}), which fights ongoing layout
  // shifts (image loads, keyboard show/hide) and ends up choppy.
  const scrollToBottom = (smooth = false) => {
    const c = messagesContainerRef.current;
    if (!c) return;
    if (smooth) {
      c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
    } else {
      c.scrollTop = c.scrollHeight;
    }
  };

  // Day-grain label for the divider line above a message run.
  // Today / Yesterday / weekday for the past week / full date older.
  const formatDayDivider = (date: Date): string => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const days = Math.round((today.getTime() - target.getTime()) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
    const sameYear = date.getFullYear() === now.getFullYear();
    return date.toLocaleDateString(undefined, sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' });
  };

  // Same-day check used by the message render loop to decide when to
  // inject a date divider between two adjacent messages.
  const sameLocalDay = (a: Date, b: Date): boolean => (
    a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate()
  );

  const formatTime = (date: Date | any) => {
    // Be liberal: handle Date, Firestore Timestamp ({toDate}), epoch ms,
    // or ISO strings. Fall back to a short readable time of the current
    // moment ("Just now") rather than the prior "Unknown" — a chat
    // message with no usable timestamp looks broken otherwise.
    try {
      let dateObj: Date;
      if (date instanceof Date) dateObj = date;
      else if (date && typeof date.toDate === 'function') dateObj = date.toDate();
      else if (date) dateObj = new Date(date);
      else return 'Just now';
      if (isNaN(dateObj.getTime())) return 'Just now';

      const now = new Date();
      const diff = now.getTime() - dateObj.getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'Just now';
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      const sameYear = dateObj.getFullYear() === now.getFullYear();
      return dateObj.toLocaleDateString(undefined, sameYear
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (error) {
      console.error('Error formatting time:', error);
      return 'Just now';
    }
  };

  // Fetch team names for every team the user belongs to, once.
  // Used to render the small team chip on each thread row so the
  // user can tell which Fire FC team a thread lives in.
  useEffect(() => {
    const myTeamIds = Array.from(new Set([
      ...(userData?.teamIds || []),
      ...(userData?.teamId ? [userData.teamId] : []),
    ].filter(Boolean)));
    if (myTeamIds.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const { collection, getDocs, query: fsQuery, where: fsWhere, documentId } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        // Firestore `in` queries cap at 30 — fine for any realistic
        // single user's team membership.
        const snap = await getDocs(fsQuery(
          collection(db, 'teams'),
          fsWhere(documentId(), 'in', myTeamIds.slice(0, 30)),
        ));
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const d of snap.docs) {
          const data = d.data() as any;
          map[d.id] = data?.name || '';
        }
        setTeamNameById(map);
      } catch { /* non-fatal — chips just won't render */ }
    })();
    return () => { cancelled = true; };
  }, [userData?.teamIds, userData?.teamId]);

  // Subscribe to threads across EVERY team the user belongs to. The
  // chat tab no longer hides chats / DMs based on the currently
  // "selected team" — a single inbox surfaces everything.
  useEffect(() => {
    const myTeamIds = Array.from(new Set([
      ...(userData?.teamIds || []),
      ...(userData?.teamId ? [userData.teamId] : []),
      ...(selectedTeamId ? [selectedTeamId] : []),
    ].filter(Boolean)));
    if (myTeamIds.length === 0) return;
    setLoading(true);
    const unsubscribeThreads = subscribeToChatThreads(myTeamIds, (threadsData) => {
      const processed = threadsData.map(thread => ({
        ...thread,
        lastActivity: thread.lastActivity instanceof Date ? thread.lastActivity : new Date(thread.lastActivity || Date.now()),
        createdAt: thread.createdAt instanceof Date ? thread.createdAt : new Date(thread.createdAt || Date.now()),
        messageCount: thread.messageCount || 0,
      }));
      setTeamThreads(processed);
      setLoading(false);
    });
    return () => { unsubscribeThreads(); };
  }, [userData?.teamIds, userData?.teamId, selectedTeamId, subscribeToChatThreads]);

  // Auto-create the team chat. Every team gets exactly ONE team-scoped
  // thread (named "<Team> Chat"). Created lazily on first chat-tab
  // load by any signed-in team member. Guarded by a per-team ref so
  // we don't race-create multiple while the subscription settles.
  const ensuredTeamChatRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!userData?.uid || !selectedTeamId || loading) return;
    if (ensuredTeamChatRef.current.has(selectedTeamId)) return;
    const hasTeamChat = teamThreads.some(t => {
      const scope = (t as any).scope || 'team';
      const isDM = (t as any).isDM === true;
      return !isDM && scope === 'team' && t.teamId === selectedTeamId;
    });
    if (hasTeamChat) {
      ensuredTeamChatRef.current.add(selectedTeamId);
      return;
    }
    ensuredTeamChatRef.current.add(selectedTeamId);
    (async () => {
      try {
        const teamName = selectedTeam?.name || 'Team';
        await addChatThread({
          title: `${teamName} Chat`,
          description: 'Team-wide conversation for parents and coaches.',
          teamId: selectedTeamId,
          scope: 'team',
          createdBy: userData.uid,
          createdByName: userData.name || 'Member',
          lastActivity: new Date(),
          isPinned: false,
          isPrivate: false,
          messageCount: 0,
          participants: [userData.uid],
          tags: ['team'],
        } as any);
      } catch (err) {
        // Re-try next mount if it failed.
        ensuredTeamChatRef.current.delete(selectedTeamId);
        console.warn('[chat] auto-create team chat failed', err);
      }
    })();
  }, [userData?.uid, userData?.name, selectedTeamId, selectedTeam?.name, teamThreads, loading, addChatThread]);

  // Subscribe to club-scoped threads (visible regardless of selected
  // team). Mounted once per session; role-filtering happens in the
  // `threads` memo below.
  useEffect(() => {
    const unsub = subscribeToClubChatThreads((data) => {
      const processed = data.map(thread => ({
        ...thread,
        lastActivity: thread.lastActivity instanceof Date ? thread.lastActivity : new Date(thread.lastActivity || Date.now()),
        createdAt: thread.createdAt instanceof Date ? thread.createdAt : new Date(thread.createdAt || Date.now()),
        messageCount: thread.messageCount || 0,
      }));
      setClubThreads(processed);
    });
    return () => { unsub && unsub(); };
  }, [subscribeToClubChatThreads]);

  // Merge + role-filter. Coaches see team + club + coaches scopes.
  // Parents see team + club. Admins see everything.
  const threads = React.useMemo<ChatThread[]>(() => {
    const merged: ChatThread[] = [...teamThreads, ...clubThreads];
    // Dedup by id (a thread can appear in both subscriptions if its
    // teamId happens to match the active team AND its scope is club —
    // unusual but possible).
    const byId = new Map<string, ChatThread>();
    for (const t of merged) byId.set(t.id, t);
    const all = Array.from(byId.values());
    return all
      .filter((thread: any) => {
        const scope = thread.scope || 'team';
        // Team-only private threads still gated by coach role.
        if (scope === 'team' && thread.isPrivate && !isCoach) return false;
        if (scope === 'admins' && !isUserClubAdmin) return false;
        if (scope === 'coaches' && !isCoach && !isUserClubAdmin) return false;
        // 'club' is visible to everyone.
        return true;
      })
      .sort((a: any, b: any) => {
        // Per-user pinning beats the legacy thread-level isPinned.
        const aP = (userData as any)?.pinnedThreadIds?.includes(a.id) || false;
        const bP = (userData as any)?.pinnedThreadIds?.includes(b.id) || false;
        if (aP !== bP) return aP ? -1 : 1;
        return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
      });
  }, [teamThreads, clubThreads, isCoach, isUserClubAdmin, userData]);

  // Deep-link handling (?thread=<id>) runs whenever the merged threads
  // list refreshes; consumes the param so it doesn't re-fire.
  useEffect(() => {
    const deepLinkId = searchParams.get('thread');
    if (!deepLinkId) return;
    const target = threads.find(t => t.id === deepLinkId);
    if (target) {
      setSelectedThread(target);
      setCurrentView('chat');
    }
    const next = new URLSearchParams(searchParams);
    next.delete('thread');
    setSearchParams(next, { replace: true });
  }, [threads, searchParams, setSearchParams]);

  // Desktop initial selection: pick the first thread the first time the
  // list loads, if nothing's selected yet.
  useEffect(() => {
    if (!isMobile && threads.length > 0 && !selectedThread) {
      setSelectedThread(threads[0]);
    }
  }, [threads, isMobile, selectedThread]);

  // Load team members for @mention autocomplete + email, plus a
  // parentUid → [childNames] lookup so the DM picker can show which
  // player(s) a member is connected to.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [allUsers, allPlayers] = await Promise.all([
          getDocuments('users', []).catch(() => []),
          getDocuments('players', []).catch(() => []),
        ]);
        if (cancelled) return;
        // Build parent → children map across the active team's roster.
        const teamPlayers = (allPlayers as any[]).filter((p) => {
          if (!p || p.isActive === false) return false;
          if (Array.isArray(p.teamIds) && p.teamIds.includes(selectedTeamId)) return true;
          if (p.teamId === selectedTeamId) return true;
          return false;
        });
        const childrenByParent = new Map<string, string[]>();
        for (const p of teamPlayers) {
          const parents: string[] = [
            ...(Array.isArray(p.parentIds) ? p.parentIds : []),
            ...(p.parentId ? [p.parentId] : []),
          ];
          for (const parentUid of parents) {
            if (!parentUid) continue;
            const arr = childrenByParent.get(parentUid) || [];
            arr.push(p.name);
            childrenByParent.set(parentUid, arr);
          }
        }
        const filtered = (allUsers as any[])
          .filter((u) => u && u.name && (
            (Array.isArray(u.teamIds) && u.teamIds.includes(selectedTeamId)) ||
            u.teamId === selectedTeamId
          ))
          .map((u) => ({
            uid: u.uid || u.id,
            name: u.name,
            role: u.role,
            email: (u.email || '').trim().toLowerCase(),
            photoURL: u.photoURL,
            childNames: childrenByParent.get(u.uid || u.id) || [],
          }));
        setTeamMembers(filtered);
      } catch {
        /* ignore */
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId, getDocuments]);

  // Load messages for selected thread
  useEffect(() => {
    if (selectedThread) {
      // Clear the previous thread's messages immediately so we don't
      // briefly render the old thread's data (which would trip the
      // scroll-anchor effect and leave the user mid-thread).
      setMessages([]);
      const unsubscribeMessages = subscribeToChatMessages(selectedThread.id, (messagesData) => {
        console.log('Received messages data:', messagesData);
        
        const processedMessages = messagesData.map(message => ({
          ...message,
          timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp || Date.now()),
          createdAt: message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt || Date.now())
        }));
        
        setMessages(processedMessages);
      });

      return () => {
        unsubscribeMessages();
      };
    }
  }, [selectedThread, subscribeToChatMessages]);

  // Single scroll-anchoring effect:
  //   - First time messages arrive for a given thread → INSTANT jump
  //     to bottom (no smooth animation). User lands on the newest msg.
  //   - Subsequent message updates for the same thread → smooth-scroll
  //     ONLY if the user was already at the bottom. If they've scrolled
  //     up to read history, leave them alone.
  // useLayoutEffect ensures the instant jump happens before the
  // browser paints, so there's no flash of "stuck in middle of thread".
  useLayoutEffect(() => {
    if (!selectedThread || messages.length === 0) return;
    const isNewThread = anchoredThreadIdRef.current !== selectedThread.id;
    if (isNewThread) {
      scrollToBottom(false);
      isAtBottomRef.current = true;
      anchoredThreadIdRef.current = selectedThread.id;
      // 1.5s window during which we suppress onScroll updates. Long
      // enough for most images/GIFs to load and trigger their
      // layout-shift reflows; short enough that an active user
      // scrolling within ~1.5s of opening isn't ignored forever.
      initialLoadUntilRef.current = Date.now() + 1500;
    } else if (isAtBottomRef.current) {
      scrollToBottom(true);
    }
  }, [selectedThread, messages]);

  // When images / GIFs inside the thread finish loading, the messages
  // list gets taller. ResizeObserver fires on every layout change of
  // the container's content. During the initial-load window we ALWAYS
  // re-pin (regardless of isAtBottomRef) so iOS's scroll-anchoring
  // chaos can't strand the user mid-thread; after that window we only
  // re-pin if the user is still at the bottom.
  useEffect(() => {
    const c = messagesContainerRef.current;
    if (!c || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const inInitialLoad = Date.now() < initialLoadUntilRef.current;
      if (inInitialLoad || isAtBottomRef.current) {
        c.scrollTop = c.scrollHeight;
      }
    });
    if (c.firstElementChild) ro.observe(c.firstElementChild);
    return () => ro.disconnect();
  }, [selectedThread?.id]);

  // Track whether the user is at the bottom of the thread so the
  // effects above know whether to auto-scroll. IGNORE scrolls during
  // the initial-load window — iOS WebKit fires synthetic scrolls
  // (its own scroll anchoring) as images load, and those would
  // otherwise flip the flag and strand the user mid-thread.
  const handleScroll = () => {
    if (Date.now() < initialLoadUntilRef.current) return;
    const c = messagesContainerRef.current;
    if (!c) return;
    const distFromBottom = c.scrollHeight - c.scrollTop - c.clientHeight;
    isAtBottomRef.current = distFromBottom < 80;
  };

  const createThread = async () => {
    if (!newThread.title.trim() || !userData) return;

    try {
      // Club-scoped threads (club / coaches / admins) aren't tied to a
      // team — use an empty teamId so they don't get pulled into any
      // single team's view. Only club admins can create them.
      const scope = newThread.scope || 'team';
      const isClubScope = scope !== 'team';
      if (isClubScope && !isUserClubAdmin) {
        alert('Only club admins can create club-wide channels.');
        return;
      }
      const threadData: any = {
        title: newThread.title,
        description: newThread.description,
        teamId: isClubScope ? '' : selectedTeamId,
        scope,
        createdBy: userData.uid,
        createdByName: userData.name,
        lastActivity: new Date(),
        isPinned: false,
        isPrivate: newThread.isPrivate && scope === 'team',
        messageCount: 0,
        participants: [userData.uid],
        tags: newThread.tags,
      };

      await addChatThread(threadData);

      setNewThread({ title: '', description: '', isPrivate: false, scope: 'club', tags: [] });
      setIsCreatingThread(false);
    } catch (error) {
      console.error('Error creating thread:', error);
    }
  };

  const sendMessage = async (contentArg?: string, attachmentsArg?: ComposerAttachment[], opts?: { requireAck?: boolean }) => {
    const content = (contentArg !== undefined ? contentArg : newMessage).trim();
    const attachments = attachmentsArg || [];
    if ((!content && attachments.length === 0) || !selectedThread || !userData) return;

    try {
      const messageData: any = {
        threadId: selectedThread.id,
        content,
        senderId: userData.uid,
        senderName: userData.name,
        senderPhotoUrl: (userData as any).photoURL || undefined,
        senderRole: userData.role,
        timestamp: new Date(),
        teamId: selectedTeamId,
      };
      if (replyingTo?.id) messageData.replyTo = replyingTo.id;
      if (attachments.length > 0) messageData.attachments = attachments;
      // Important / acknowledgment-required messages get the sender
      // auto-acknowledged so the recipient roster excludes them.
      if (opts?.requireAck) {
        messageData.requireAck = true;
        messageData.acknowledgedBy = [userData.uid];
      }

      await addChatMessage(messageData);
      
      const lastSnippet = content || (attachments.length > 0 ? `📷 ${attachments.length} image${attachments.length > 1 ? 's' : ''}` : '');
      await updateChatThread(selectedThread.id, {
        lastActivity: new Date(),
        messageCount: selectedThread.messageCount + 1,
        participants: Array.from(new Set([...selectedThread.participants, userData.uid])),
        lastMessage: {
          content: lastSnippet,
          senderName: userData.name,
          timestamp: new Date()
        }
      });
      // Treat sending as visiting — keeps the sender's own message
      // from registering as unread when the thread doc updates.
      markThreadVisited(selectedThread.id);

      // Push to everyone in the thread except the sender. Fires on every new
      // message — including DMs (where participants is just the two of them).
      // No prefKey filter for now (any chat opt-out can come later).
      try {
        // Use effective participants so a team-wide chat reaches
        // everyone on the team, not just the people who've previously
        // posted (which is what `selectedThread.participants` captures).
        const recipients = effectiveParticipants(selectedThread).filter(uid => uid && uid !== userData.uid);
        if (recipients.length > 0) {
          const { sendPushToUsers } = await import('../utils/notify');
          const isDM = (selectedThread as any).isDM === true;
          const pushBody = content
            ? (content.length > 140 ? `${content.slice(0, 137)}…` : content)
            : (attachments.length > 0 ? `📷 sent ${attachments.length} photo${attachments.length > 1 ? 's' : ''}` : 'New message');
          const pushTitle = isDM
            ? `${userData.name} (DM)`
            : `${userData.name} in ${selectedThread.title}`;
          // Fire-and-forget — never block the send on push delivery.
          void sendPushToUsers(recipients, {
            title: pushTitle,
            body: pushBody,
            url: `${getShareOrigin()}/chat?thread=${selectedThread.id}`,
          }, { pushPrefKey: 'chat', fromUid: userData.uid });
        }
      } catch (err) {
        console.warn('[chat] push notify failed', err);
      }

      // Email mentioned users (best-effort, dynamic import)
      if (content) {
        const mentionRe = /@([A-Za-z][A-Za-z0-9 _'-]{0,28}[A-Za-z0-9])/g;
        const names = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = mentionRe.exec(content)) !== null) {
          names.add(m[1].toLowerCase());
        }
        if (names.size > 0 && teamMembers.length > 0) {
          const targets = teamMembers.filter(
            (u) =>
              u.email &&
              u.uid !== userData.uid &&
              names.has((u.name || '').toLowerCase())
          );
          if (targets.length > 0) {
            try {
              const { sendEmailBatch } = await import('../utils/notify');
              const APP = getShareOrigin();
              const safe = content.replace(/</g, '&lt;');
              await sendEmailBatch(
                targets.map((u) => ({
                  to: u.email!,
                  subject: `${userData.name} mentioned you in ${selectedThread.title}`,
                  html: `<div style="font-family:-apple-system,sans-serif;color:#111827;"><p><b>${userData.name}</b> mentioned you in <b>${selectedThread.title}</b>:</p><blockquote style="border-left:3px solid #1e3a5f;padding-left:12px;color:#374151;white-space:pre-wrap;">${safe}</blockquote><p><a href="${APP}/chat" style="display:inline-block;background:#1e3a5f;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">Open chat</a></p></div>`,
                }))
              );
            } catch (e) {
              console.warn('[chat] mention email failed', e);
            }
          }
        }
      }
      
      setNewMessage('');
      setReplyingTo(null);
      messageInputRef.current?.focus();
    } catch (error) {
      console.error('Error sending message:', error);
    }
  };

  const deleteMessage = async (message: ChatMessage) => {
    if (!userData || message.senderId !== userData.uid) return;
    if (!window.confirm('Delete this message? This cannot be undone.')) return;
    try {
      await deleteDocument('chat_messages', message.id);
    } catch (err) {
      console.error('Error deleting message:', err);
      alert('Could not delete the message. Please try again.');
    }
  };

  // Typing presence — write `chat_threads/{id}.typingBy[uid] = epochMs`
  // at most once every 2.5s while the user is composing. Receivers
  // treat any entry whose timestamp is within the last 5s as "live."
  // This burns ~1 write per 2.5s of active typing per user; negligible.
  const lastTypingWriteRef = useRef<number>(0);
  const handleTyping = async () => {
    if (!userData?.uid || !selectedThread?.id) return;
    const now = Date.now();
    if (now - lastTypingWriteRef.current < 2500) return;
    lastTypingWriteRef.current = now;
    try {
      await updateChatThread(selectedThread.id, {
        [`typingBy.${userData.uid}`]: { ts: now, name: userData.name || 'Member' },
      } as any);
    } catch {
      // Non-critical — typing indicator is best-effort.
    }
  };

  // Resolve the *effective* participants of the selected thread.
  // The doc's `participants` field only contains users who've sent a
  // message (it gets append-only on send), which means a team-wide
  // chat that only 2 people have posted in reports "2 participants"
  // and only pushes to those 2 even though the whole team can read
  // it. For team-scoped, non-DM threads, the truth is the full team
  // roster. DMs stay as-is. Club/coach scopes fall back to the doc
  // value until we have a parallel directory query for those.
  const effectiveParticipants = (thread: ChatThread | null): string[] => {
    if (!thread) return [];
    const isDM = (thread as any).isDM === true;
    const isGroup = (thread as any).isGroup === true;
    const scope = (thread as any).scope || 'team';
    // DMs and ad-hoc groups have a fixed, known participant list.
    // Only TEAM-scoped (non-group) channels auto-expand to the full
    // team roster.
    if (isDM || isGroup) return thread.participants || [];
    if (scope === 'team' && teamMembers.length > 0) {
      const set = new Set<string>(teamMembers.map(m => m.uid).filter(Boolean));
      // Union with the doc's participants — covers visitors from
      // other teams who happen to be in the chat (rare but possible
      // via legacy data).
      (thread.participants || []).forEach(uid => uid && set.add(uid));
      return Array.from(set);
    }
    return thread.participants || [];
  };

  // Visible messages = full timeline OR filtered by the in-thread
  // search. Search is case-insensitive substring on message content.
  const visibleMessages: ChatMessage[] = (() => {
    const q = threadSearchQuery.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter(m => (m.content || '').toLowerCase().includes(q));
  })();

  // Live "X is typing…" computed from selectedThread.typingBy. Drops
  // entries older than 5s (auto-expires without an explicit "stopped
  // typing" write, which keeps the write volume halved).
  const typingNames: string[] = (() => {
    const map: Record<string, { ts: number; name: string }> = (selectedThread as any)?.typingBy || {};
    const cutoff = Date.now() - 5000;
    return Object.entries(map)
      .filter(([uid, v]) => uid !== userData?.uid && v && typeof v.ts === 'number' && v.ts > cutoff)
      .map(([_, v]) => v.name || 'Someone');
  })();

  // Own-message edit. Firestore rules already allow updates to
  // content/edited/editedAt by the sender, so no rules change needed.
  // Lock the field shape so we don't accidentally drop other fields.
  const editMessage = async (message: ChatMessage, newContent: string) => {
    if (!userData || message.senderId !== userData.uid) return;
    const trimmed = newContent.trim();
    if (!trimmed || trimmed === (message.content || '').trim()) return;
    await updateDocument('chat_messages', message.id, {
      content: trimmed,
      edited: true,
      editedAt: new Date(),
    });
  };

  const deleteThread = async (thread: ChatThread) => {
    if (!userData) return;
    const isDM = (thread as any).isDM === true;
    const scope = (thread as any).scope || 'team';
    // Permissions:
    //   - DMs: either participant can delete.
    //   - Team threads: any coach can delete.
    //   - Club / Coaches / Admins channels: only club admins can delete
    //     (they're cross-team artifacts, regular coaches shouldn't nuke
    //     other teams' chat history).
    const canDelete =
      (isDM && thread.participants.includes(userData.uid)) ||
      (scope === 'team' && isCoach) ||
      (scope !== 'team' && isUserClubAdmin);
    if (!canDelete) return;
    const label = isDM ? 'this conversation' : `"${thread.title}"`;
    if (!window.confirm(`Delete ${label} for everyone? All messages will be removed and this can't be undone.`)) return;
    try {
      // Cascade-delete all messages in the thread. Best-effort: even if
      // some messages fail, still try to remove the thread doc afterward.
      const msgs: any[] = await getDocuments('chat_messages', [
        where('threadId', '==', thread.id),
      ]).catch(() => []);
      await Promise.all(
        (msgs || []).map((m) => deleteDocument('chat_messages', m.id).catch(() => null))
      );
      await deleteDocument('chat_threads', thread.id);
      // If we were viewing this thread, pop back to the threads list.
      if (selectedThread?.id === thread.id) {
        setSelectedThread(null);
        setCurrentView('threads');
      }
    } catch (err) {
      console.error('Error deleting thread:', err);
      alert('Could not delete this chat. Please try again.');
    }
  };

  // Send a poll as a chat message. The poll is stored on the message
  // doc (under `poll`) and rendered inline by PollCard.
  const sendPoll = async (poll: { question: string; options: string[]; multi: boolean }) => {
    if (!selectedThread || !userData) return;
    const opts = poll.options.map((text, i) => ({
      id: `${Date.now()}-${i}`,
      text,
      voters: [] as string[],
    }));
    const messageData: any = {
      threadId: selectedThread.id,
      content: '',
      senderId: userData.uid,
      senderName: userData.name,
      senderPhotoUrl: (userData as any).photoURL || undefined,
      senderRole: userData.role,
      timestamp: new Date(),
      teamId: selectedTeamId,
      poll: { question: poll.question, options: opts, multi: !!poll.multi },
    };
    try {
      await addChatMessage(messageData);
      await updateChatThread(selectedThread.id, {
        lastActivity: new Date(),
        messageCount: selectedThread.messageCount + 1,
        participants: Array.from(new Set([...selectedThread.participants, userData.uid])),
        lastMessage: {
          content: `📊 ${poll.question}`,
          senderName: userData.name,
          timestamp: new Date(),
        },
      });
    } catch (err) {
      console.error('Poll send failed:', err);
    }
  };

  // Cast / toggle a vote on a poll option. Single-choice polls move
  // the user's vote when they pick a different option; multi-choice
  // polls toggle membership in each option independently.
  const voteOnPoll = async (messageId: string, optionId: string) => {
    if (!userData) return;
    const msg = messages.find((m) => m.id === messageId);
    if (!msg || !msg.poll) return;
    const multi = !!msg.poll.multi;
    const nextOptions = msg.poll.options.map((o) => {
      const has = o.voters.includes(userData.uid);
      if (o.id === optionId) {
        return { ...o, voters: has ? o.voters.filter((u) => u !== userData.uid) : [...o.voters, userData.uid] };
      }
      // For single-choice polls, voting on a different option removes
      // the user from this one.
      if (!multi && has) {
        return { ...o, voters: o.voters.filter((u) => u !== userData.uid) };
      }
      return o;
    });
    try {
      await updateDocument('chat_messages', messageId, {
        'poll.options': nextOptions,
      });
    } catch (err) {
      console.error('Vote failed:', err);
    }
  };

  // Acknowledge an important message — adds the user's uid to the
  // message's acknowledgedBy[] array. The button on the bubble flips
  // to a "✓ You've seen this" confirmation once acknowledged.
  const acknowledgeMessage = async (message: ChatMessage) => {
    if (!userData) return;
    const current: string[] = Array.isArray((message as any).acknowledgedBy) ? (message as any).acknowledgedBy : [];
    if (current.includes(userData.uid)) return;
    try {
      await updateDocument('chat_messages', message.id, {
        acknowledgedBy: Array.from(new Set([...current, userData.uid])),
      });
    } catch (err) {
      console.error('Acknowledge failed:', err);
    }
  };

  // Pin/unpin a message within the active thread. Coaches can pin in
  // team threads; club admins can pin in club-scope channels.
  const togglePinMessage = async (message: ChatMessage) => {
    if (!selectedThread || !userData) return;
    const current = ((selectedThread as any).pinnedMessageIds || []) as string[];
    const isPinned = current.includes(message.id);
    const next = isPinned
      ? current.filter((id) => id !== message.id)
      : [message.id, ...current].slice(0, 10); // cap at 10 pins per thread
    try {
      await updateChatThread(selectedThread.id, { pinnedMessageIds: next } as any);
      // Optimistic local update so the UI doesn't lag behind the snapshot.
      setSelectedThread({ ...selectedThread, pinnedMessageIds: next } as any);
    } catch (err) {
      console.error('Pin toggle failed:', err);
    }
  };

  const toggleReaction = async (message: ChatMessage, emoji: string) => {
    if (!userData) return;
    const existing = message.reactions || [];
    const mineIdx = existing.findIndex((r) => r.userId === userData.uid && r.emoji === emoji);
    let next;
    if (mineIdx >= 0) {
      next = existing.filter((_, i) => i !== mineIdx);
    } else {
      next = [...existing, { emoji, userId: userData.uid, userName: userData.name }];
    }
    try {
      await updateDocument('chat_messages', message.id, { reactions: next });
    } catch (err) {
      console.error('Error toggling reaction:', err);
    }
  };

  // Per-user thread pinning — each user maintains their own list of
  // pinned thread IDs on their user doc. Coaches can't pin "for
  // everyone" anymore. The thread doc's legacy `isPinned` is ignored
  // for new pins (kept for back-compat reads).
  const myPinnedThreadIds: string[] = Array.isArray((userData as any)?.pinnedThreadIds)
    ? (userData as any).pinnedThreadIds
    : [];
  const isThreadPinned = (thread: ChatThread): boolean =>
    myPinnedThreadIds.includes(thread.id);
  const togglePinThread = async (thread: ChatThread) => {
    if (!userData?.uid) return;
    const next = myPinnedThreadIds.includes(thread.id)
      ? myPinnedThreadIds.filter(id => id !== thread.id)
      : [...myPinnedThreadIds, thread.id];
    try {
      await updateDoc(doc(db, 'users', userData.uid), { pinnedThreadIds: next });
    } catch (err) {
      console.error('Error toggling pin:', err);
    }
  };

  const filteredThreads = threads.filter(thread => {
    // Hide DMs the current user is not part of.
    const isDM = (thread as any).isDM === true;
    if (isDM && userData?.uid && !thread.participants.includes(userData.uid)) {
      return false;
    }
    const matchesSearch = thread.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         thread.description?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filterTag === 'all' ||
                         (filterTag === 'unread' && isThreadUnread(thread)) ||
                         (filterTag === 'pinned' && isThreadPinned(thread)) ||
                         (filterTag === 'private' && thread.isPrivate) ||
                         (filterTag === 'direct' && isDM) ||
                         thread.tags?.includes(filterTag);
    return matchesSearch && matchesFilter;
  });

  // Group threads into the visual sections the chat list renders.
  // Each thread lands in exactly one section by this priority order:
  //   Pinned > DMs > Groups > Team chats > Club channels
  // Sections only render when their group has at least one match, so
  // a parent with no group chats never sees an empty "Groups" header.
  type SectionId = 'pinned' | 'dms' | 'groups' | 'teams' | 'club';
  const SECTION_LABELS: Record<SectionId, string> = {
    pinned: 'Pinned',
    dms: 'Direct messages',
    groups: 'Group chats',
    teams: 'Team chats',
    club: 'Club channels',
  };
  const chatSections: Array<{ id: SectionId; label: string; threads: ChatThread[] }> = (() => {
    const buckets: Record<SectionId, ChatThread[]> = {
      pinned: [], dms: [], groups: [], teams: [], club: [],
    };
    for (const t of filteredThreads) {
      if (isThreadPinned(t)) { buckets.pinned.push(t); continue; }
      if ((t as any).isDM === true) { buckets.dms.push(t); continue; }
      if ((t as any).isGroup === true) { buckets.groups.push(t); continue; }
      const scope = (t as any).scope || 'team';
      if (scope === 'team') buckets.teams.push(t);
      else buckets.club.push(t);
    }
    const order: SectionId[] = ['pinned', 'dms', 'groups', 'teams', 'club'];
    return order
      .filter(id => buckets[id].length > 0)
      .map(id => ({ id, label: SECTION_LABELS[id], threads: buckets[id] }));
  })();

  // Display title for a thread — for DMs, show the OTHER person's name.
  const getThreadDisplayTitle = (thread: ChatThread): string => {
    const isDM = (thread as any).isDM === true;
    if (!isDM) return thread.title;
    const map = (thread as any).dmParticipantNames as Record<string, string> | undefined;
    const otherUid = thread.participants.find(uid => uid !== userData?.uid);
    if (map && otherUid && map[otherUid]) return map[otherUid];
    if (otherUid) {
      const m = teamMembers.find(tm => tm.uid === otherUid);
      if (m?.name) return m.name;
    }
    return thread.title.replace(/^DM:\s*/, '');
  };

  // Profile photo for a thread row. DMs → the OTHER participant's photoURL.
  // Group chats fall back to the colored-initial avatar (no real photo).
  const getThreadPhotoUrl = (thread: ChatThread): string | undefined => {
    const isDM = (thread as any).isDM === true;
    if (!isDM) return undefined;
    const otherUid = thread.participants.find(uid => uid !== userData?.uid);
    if (!otherUid) return undefined;
    const m = teamMembers.find(tm => tm.uid === otherUid);
    return m?.photoURL || undefined;
  };

  // Live photo lookup for message bubble avatars. Older messages don't
  // carry senderPhotoUrl on the doc itself, so MessageBubble falls back
  // to this teamMembers-backed lookup.
  const getSenderPhotoUrl = (senderId: string): string | undefined => {
    if (!senderId) return undefined;
    if (userData?.uid === senderId) return (userData as any)?.photoURL || undefined;
    const m = teamMembers.find(tm => tm.uid === senderId);
    return m?.photoURL || undefined;
  };

  // Used by the Read-by sheet to render names for each uid in readBy.
  const getUserName = (uid: string): string | undefined => {
    if (!uid) return undefined;
    if (userData?.uid === uid) return userData?.name || 'You';
    const m = teamMembers.find(tm => tm.uid === uid);
    return m?.name;
  };

  // Write a read-receipt to a message. Throttled at the call site
  // (MessageBubble fires once per first-render). Optimistic + best-effort
  // — if it fails we just keep going. Targets `chat_messages` — the
  // actual collection chat messages live in (NOT /messages, which is
  // an unrelated legacy collection).
  const markMessageRead = async (m: ChatMessage) => {
    if (!userData?.uid) return;
    try {
      const { doc: fsDoc, updateDoc } = await import('firebase/firestore');
      const { db } = await import('../utils/firebase');
      const ref = fsDoc(db, 'chat_messages', m.id);
      await updateDoc(ref, { [`readBy.${userData.uid}`]: Date.now() });
    } catch (err) {
      // Read receipts are non-critical; ignore failures (older messages
      // may not have the field yet).
    }
  };

  const startDM = async (member: { uid: string; name: string }) => {
    if (!userData || !selectedTeamId || dmStarting) return;
    setDmStarting(member.uid);
    try {
      const threadId = await getOrCreateDMThread({
        teamId: selectedTeamId,
        me: { uid: userData.uid, name: userData.name },
        other: { uid: member.uid, name: member.name },
      });
      // Try to find it in current threads; if not yet streamed in, build a minimal one.
      const existing = threads.find(t => t.id === threadId);
      if (existing) {
        setSelectedThread(existing);
      } else {
        setSelectedThread({
          id: threadId as string,
          title: `DM: ${userData.name} & ${member.name}`,
          teamId: selectedTeamId,
          createdBy: userData.uid,
          createdByName: userData.name,
          createdAt: new Date(),
          lastActivity: new Date(),
          isPinned: false,
          isPrivate: false,
          messageCount: 0,
          participants: [userData.uid, member.uid],
          tags: ['direct'],
          // @ts-ignore extras
          isDM: true,
          dmParticipantNames: { [userData.uid]: userData.name, [member.uid]: member.name },
        } as any);
      }
      setCurrentView('chat');
      setIsDMPickerOpen(false);
      setDmSearch('');
      setSelectedDmUids(new Set());
    } catch (err) {
      console.error('Failed to open DM:', err);
      alert('Could not open direct message. Please try again.');
    } finally {
      setDmStarting(null);
    }
  };

  // Create an ad-hoc group thread with the current selection.
  // Unlike DMs, groups don't dedupe — each create makes a new thread,
  // because users may want separate group chats for different purposes
  // with overlapping membership.
  const startGroupChat = async () => {
    if (!userData || !selectedTeamId) return;
    const uids = Array.from(selectedDmUids);
    if (uids.length < 2) return;
    const members = uids
      .map(uid => teamMembers.find(tm => tm.uid === uid))
      .filter(Boolean) as Array<{ uid: string; name: string }>;
    if (members.length !== uids.length) {
      alert('Some selected members could not be resolved. Try again.');
      return;
    }
    const allParticipants = [userData.uid, ...members.map(m => m.uid)];
    const firstNames = [userData.name, ...members.map(m => m.name)]
      .map(n => (n || 'Member').split(' ')[0]);
    const title = firstNames.length <= 3
      ? firstNames.join(', ')
      : `${firstNames.slice(0, 2).join(', ')} +${firstNames.length - 2}`;
    setDmStarting('group');
    try {
      const threadId = await addChatThread({
        title,
        description: '',
        teamId: selectedTeamId,
        createdBy: userData.uid,
        createdByName: userData.name,
        createdAt: new Date(),
        lastActivity: new Date(),
        isPinned: false,
        isPrivate: false,
        isDM: false,
        // New flag so the chat UI can render group-style affordances
        // without confusing groups with team-scoped channels.
        isGroup: true,
        messageCount: 0,
        participants: allParticipants,
        tags: ['group'],
      } as any);
      setSelectedThread({
        id: threadId as string,
        title,
        teamId: selectedTeamId,
        createdBy: userData.uid,
        createdByName: userData.name,
        createdAt: new Date(),
        lastActivity: new Date(),
        isPinned: false,
        isPrivate: false,
        messageCount: 0,
        participants: allParticipants,
        tags: ['group'],
        // @ts-ignore extras
        isGroup: true,
      } as any);
      setCurrentView('chat');
      setIsDMPickerOpen(false);
      setDmSearch('');
      setSelectedDmUids(new Set());
    } catch (err) {
      console.error('Failed to create group chat:', err);
      alert('Could not create the group. Try again.');
    } finally {
      setDmStarting(null);
    }
  };

  // Dispatch the picker's "Start" button — 1 selected goes to DM,
  // 2+ goes to group create.
  const startSelectedChat = async () => {
    const uids = Array.from(selectedDmUids);
    if (uids.length === 0) return;
    if (uids.length === 1) {
      const m = teamMembers.find(tm => tm.uid === uids[0]);
      if (!m) return;
      await startDM({ uid: m.uid, name: m.name });
      return;
    }
    await startGroupChat();
  };

  const toggleDmSelection = (uid: string) => {
    setSelectedDmUids(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  };

  console.log('Current state:', { currentView, isMobile, selectedThread: selectedThread?.title });

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-600 mx-auto mb-2"></div>
          <p className="text-gray-600">Loading chat...</p>
        </div>
      </div>
    );
  }

  // Reusable DM picker modal — rendered in both mobile and desktop returns.
  const dmCandidates = teamMembers
    .filter(m => m.uid && m.uid !== userData?.uid && m.name)
    .filter(m => {
      if (!dmSearch) return true;
      const q = dmSearch.toLowerCase();
      if (m.name.toLowerCase().includes(q)) return true;
      if (m.childNames && m.childNames.some(c => c.toLowerCase().includes(q))) return true;
      return false;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const dmPickerModal = isDMPickerOpen ? (
    <div
      className="fixed inset-0 flex items-center justify-center px-4 bg-black/60 backdrop-blur-sm"
      style={{
        // zIndex via inline style — guaranteed to beat the nav (z-50)
        // and the page header (z-40) even if Tailwind didn't ship z-[60].
        zIndex: 100,
        // Outer padding clears the fixed page header at top and the
        // fixed bottom tab bar at bottom, so the modal can't visually
        // collide with them no matter how z-stacking resolves.
        paddingTop: 'calc(4rem + env(safe-area-inset-top))',
        paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))',
      }}
      onClick={() => { setIsDMPickerOpen(false); setDmSearch(''); }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-full flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gradient-to-r from-violet-50 to-white">
          <div>
            <h3 className="text-lg font-bold text-gray-900">
              {selectedDmUids.size <= 1 ? 'New chat' : `New group · ${selectedDmUids.size + 1} people`}
            </h3>
            <p className="text-xs text-gray-500">
              {selectedDmUids.size === 0
                ? 'Pick one person for a DM, or several for a group chat.'
                : selectedDmUids.size === 1
                  ? 'Pick another person to make this a group.'
                  : 'Tap Start to create the group chat.'}
            </p>
          </div>
          <button
            onClick={() => { setIsDMPickerOpen(false); setDmSearch(''); setSelectedDmUids(new Set()); }}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-4 border-b border-gray-100">
          <input
            type="text"
            value={dmSearch}
            onChange={e => setDmSearch(e.target.value)}
            placeholder="Search by name or player..."
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-violet-500 text-base"
            style={{ fontSize: '16px' }}
            autoFocus
          />
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {dmCandidates.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">
              {teamMembers.length <= 1
                ? 'No other members on this team yet.'
                : 'No matches for that search.'}
            </div>
          ) : (
            dmCandidates.map(m => {
              const checked = selectedDmUids.has(m.uid);
              return (
                <button
                  key={m.uid}
                  onClick={() => toggleDmSelection(m.uid)}
                  disabled={dmStarting === m.uid || dmStarting === 'group'}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl transition-colors text-left disabled:opacity-50 ${
                    checked ? 'bg-violet-100 ring-1 ring-violet-300' : 'hover:bg-violet-50'
                  }`}
                >
                  <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center text-white text-base font-bold ${m.role === 'coach' ? 'bg-blue-600' : 'bg-emerald-600'}`}>
                    {m.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-gray-900 truncate">{m.name}</p>
                    {m.childNames && m.childNames.length > 0 ? (
                      <p className="text-xs text-gray-500 truncate">{m.childNames.join(', ')}</p>
                    ) : (
                      <p className="text-xs text-gray-500 capitalize">{m.role || 'member'}</p>
                    )}
                  </div>
                  {/* Checkbox-style indicator on the right. */}
                  <span
                    className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                      checked
                        ? 'bg-violet-600 border-violet-600 text-white'
                        : 'border-slate-300 bg-white'
                    }`}
                    aria-hidden
                  >
                    {checked && (
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Footer with Start button. Disabled when no one is selected;
            label adapts to "Send DM" / "Create group". */}
        <div className="px-4 py-3 border-t border-slate-100 bg-white">
          <button
            type="button"
            onClick={startSelectedChat}
            disabled={selectedDmUids.size === 0 || dmStarting !== null}
            className="w-full bg-gradient-to-br from-violet-500 to-violet-700 hover:from-violet-400 hover:to-violet-600 text-white text-xs font-extrabold tracking-widest uppercase py-3 px-4 rounded-xl shadow-md transition disabled:opacity-40 flex items-center justify-center"
          >
            {dmStarting !== null ? (
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/40 border-t-white" />
            ) : selectedDmUids.size <= 1 ? (
              'Send direct message'
            ) : (
              `Create group · ${selectedDmUids.size + 1} people`
            )}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // Image lightbox — tap-to-close, native long-press still triggers
  // iOS's "Save Image / Copy / Share" menu since the <img> isn't
  // wrapped in any interactive element.
  const lightbox = lightboxUrl ? (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/90 backdrop-blur-sm"
      style={{ zIndex: 200 }}
      onClick={() => setLightboxUrl(null)}
    >
      <button
        onClick={(e) => { e.stopPropagation(); setLightboxUrl(null); }}
        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center"
        style={{ top: 'calc(1rem + env(safe-area-inset-top))' }}
        aria-label="Close"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
      <img
        src={lightboxUrl}
        alt=""
        onClick={(e) => e.stopPropagation()}
        className="max-w-[95vw] max-h-[90vh] object-contain rounded-lg select-none"
      />
    </div>
  ) : null;

  // MOBILE: Single view at a time
  if (isMobile) {
    return (
      <>
      {/* Fixed-position layout pinned between top header + bottom tab bar.
          Capacitor Keyboard.resize: 'native' resizes the WebView when the
          keyboard appears (window.innerHeight drops), BUT a WKWebView
          quirk keeps `position: fixed; bottom: 0` anchored to the original
          viewport bottom — so the composer ends up hidden behind the
          keyboard despite ih being smaller. Workaround: set the container
          height explicitly from winHeight (which DOES reflect the
          keyboard) and skip `bottom`. */}
      <div
        // bg-white (not gray-50). Both child views already paint their
        // own bg-white, so the container color is only visible behind
        // the iOS keyboard's slightly-rounded top corners. Gray bled
        // through there as two little gray quarter-circles next to the
        // composer; white makes the seam disappear.
        className="fixed inset-x-0 flex flex-col bg-white z-10 overflow-hidden"
        style={{
          // Mobile top bar is a flat h-14 now (no safe-top — native shell
          // already positions the WebView below the system bar), so the
          // chat container slots in cleanly below it.
          top: '3.5rem',
          // Explicit height from window.innerHeight (in CSS pixels).
          // For threads view, also subtract the bottom tab bar height.
          height:
            currentView === 'chat' && selectedThread
              ? `calc(${winHeight}px - 3.5rem)`
              : `calc(${winHeight}px - 3.5rem - 3rem)`,
        }}
      >
        {currentView === 'threads' ? (
          // THREADS LIST VIEW
          <div className="flex-1 min-h-0 flex flex-col bg-white">
            {/* Header */}
            <div className="p-4 border-b border-gray-200 bg-white">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-gray-900">Messages</h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { setIsDMPickerOpen(true); setSelectedDmUids(new Set()); }}
                    className="bg-violet-600 hover:bg-violet-700 text-white p-2.5 rounded-lg transition-colors"
                    title="Direct message"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                  </button>
                  {isUserClubAdmin && (
                    <button
                      onClick={() => setIsCreatingThread(true)}
                      className="bg-cyan-600 hover:bg-cyan-700 text-white p-2.5 rounded-lg transition-colors"
                      title="New club channel"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              {/* Search */}
              <div className="relative mb-3">
                <input
                  type="text"
                  placeholder="Search threads..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 text-base"
                  style={{ fontSize: '16px' }}
                />
                <svg className="w-5 h-5 text-gray-400 absolute left-3 top-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>

              {/* Filters. 'Coach' is the coach-only-thread filter
                  (thread.isPrivate); hide it from parents since they
                  can't see those threads at all. */}
              <div className="flex space-x-2 overflow-x-auto">
                {(() => {
                  const unreadCount = filteredThreads.filter(t => isThreadUnread(t)).length
                    // Include threads from `threads` that the active filter
                    // is hiding so the badge reflects reality across the
                    // whole list, not just within the current chip.
                    || threads.filter(t => isThreadUnread(t)).length;
                  return [
                    { key: 'all', label: 'All' },
                    { key: 'unread', label: unreadCount > 0 ? `Unread · ${unreadCount}` : 'Unread' },
                    { key: 'pinned', label: 'Pinned' },
                    { key: 'direct', label: 'DMs' },
                    ...(isCoach ? [{ key: 'private', label: 'Coach' }] : []),
                  ];
                })().map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setFilterTag(key)}
                    className={`px-3 py-2 text-sm rounded-full transition-colors ${
                      filterTag === key
                        ? 'bg-cyan-50 text-cyan-700 font-medium'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Threads List — iMessage / Messages-style rows. Bottom
                padding clears the fixed app tab bar so the last section
                (often Club Channels) isn't trapped under it. */}
            <div
              className="flex-1 min-h-0 overflow-y-auto"
              style={{ overscrollBehavior: 'contain', paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))' }}
            >
              {(() => {
                // Row renderer — shared between sectioned and flat layouts.
                const renderRow = (thread: ChatThread) => {
                  const isDM = (thread as any).isDM === true;
                  const displayTitle = getThreadDisplayTitle(thread);
                  const initial = (displayTitle || '?').charAt(0).toUpperCase();
                  let hh = 0;
                  for (let i = 0; i < (displayTitle || '').length; i++) hh = (hh * 31 + displayTitle.charCodeAt(i)) >>> 0;
                  const palette = ['bg-rose-500','bg-amber-500','bg-emerald-500','bg-cyan-500','bg-violet-500','bg-fuchsia-500','bg-blue-500','bg-teal-500'];
                  const avatarBg = palette[hh % palette.length];
                  const threadPhotoUrl = getThreadPhotoUrl(thread);
                  const preview = thread.lastMessage?.content || (thread.description || (isDM ? 'Tap to send a message' : 'No messages yet'));
                  const ago = formatTime(thread.lastActivity);
                  const unread = isThreadUnread(thread);
                  return (
                  <button
                    key={thread.id}
                    onClick={() => showChatView(thread)}
                    className="w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 transition-colors flex items-start gap-3"
                  >
                    {threadPhotoUrl ? (
                      <img
                        src={threadPhotoUrl}
                        alt={displayTitle}
                        className="w-12 h-12 rounded-full object-cover flex-shrink-0 shadow-sm ring-1 ring-black/5"
                        onError={(e) => {
                          // Hide a broken Storage URL so the colored
                          // initial below it can take over instead.
                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                          const sib = (e.currentTarget as HTMLImageElement).nextElementSibling as HTMLElement | null;
                          if (sib) sib.style.display = 'flex';
                        }}
                      />
                    ) : null}
                    <div
                      className={`w-12 h-12 rounded-full flex-shrink-0 flex items-center justify-center text-white text-base font-bold shadow-sm ${avatarBg}`}
                      style={threadPhotoUrl ? { display: 'none' } : undefined}
                    >
                      {initial}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        {unread && (
                          <span aria-hidden className="w-2 h-2 rounded-full bg-cyan-500 flex-shrink-0" />
                        )}
                        <span className={`truncate text-[15px] ${unread ? 'font-extrabold text-slate-900' : 'font-semibold text-gray-900'}`}>{displayTitle}</span>
                        {/* Team chip — only shows when the user is on
                            multiple teams AND the thread is actually
                            team-scoped. DMs and groups aren't tied to a
                            team in a meaningful way, so a team label
                            there is just noise. */}
                        {!isDM
                          && !(thread as any).isGroup
                          && Object.keys(teamNameById).length > 1
                          && thread.teamId
                          && teamNameById[thread.teamId] && (
                          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 ring-1 ring-slate-200 flex-shrink-0">
                            {teamNameById[thread.teamId]}
                          </span>
                        )}
                        {isThreadPinned(thread) && (
                          <svg className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                          </svg>
                        )}
                        {thread.isPrivate && (
                          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-50 text-red-700 ring-1 ring-red-200 flex-shrink-0">
                            Coach only
                          </span>
                        )}
                        {(thread as any).scope === 'club' && (
                          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 ring-1 ring-amber-200 flex-shrink-0">
                            🏛️ Club
                          </span>
                        )}
                        {(thread as any).scope === 'coaches' && (
                          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-50 text-blue-800 ring-1 ring-blue-200 flex-shrink-0">
                            Coaches
                          </span>
                        )}
                        {(thread as any).scope === 'admins' && (
                          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-50 text-violet-800 ring-1 ring-violet-200 flex-shrink-0">
                            Admins
                          </span>
                        )}
                        {isDM && (
                          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 ring-1 ring-violet-200 flex-shrink-0">
                            DM
                          </span>
                        )}
                        <span className="ml-auto text-[11px] text-gray-400 font-medium flex-shrink-0 pl-2">{ago}</span>
                      </div>
                      <div className="text-sm text-gray-500 truncate">
                        {thread.lastMessage?.senderName && (
                          <span className="font-medium text-gray-700">{thread.lastMessage.senderName}: </span>
                        )}
                        {preview}
                      </div>
                    </div>
                  </button>
                );
                };
                // Sectioned layout when on the default "All" filter,
                // flat layout when filtering / searching (sections would
                // just add noise when the user is already narrowing).
                if (filterTag === 'all' && !searchQuery.trim()) {
                  return chatSections.map(section => {
                    const collapsed = collapsedSections[section.id] === true;
                    const sectionUnread = section.threads.filter(t => isThreadUnread(t)).length;
                    return (
                      <div key={section.id}>
                        <button
                          type="button"
                          onClick={() => toggleSection(section.id)}
                          className="w-full px-4 py-2 flex items-center justify-between bg-slate-50 border-b border-slate-200 hover:bg-slate-100"
                        >
                          <span className="flex items-center gap-2 text-[10px] font-extrabold tracking-widest uppercase text-slate-600">
                            {section.label}
                            <span className="text-slate-400">{section.threads.length}</span>
                            {sectionUnread > 0 && (
                              <span className="px-1.5 py-0.5 rounded-full bg-cyan-500 text-white text-[9px] font-extrabold">
                                {sectionUnread} new
                              </span>
                            )}
                          </span>
                          <svg
                            className={`w-3.5 h-3.5 text-slate-400 transition-transform ${collapsed ? '-rotate-90' : ''}`}
                            fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                        {!collapsed && section.threads.map(renderRow)}
                      </div>
                    );
                  });
                }
                return filteredThreads.map(renderRow);
              })()}

              {filteredThreads.length === 0 && (
                <div className="p-10 text-center">
                  <div className="w-16 h-16 mx-auto mb-3 rounded-full bg-gray-100 flex items-center justify-center">
                    <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                    </svg>
                  </div>
                  <p className="text-gray-700 font-semibold mb-1">No conversations yet</p>
                  <p className="text-gray-500 text-sm mb-4">Start a chat with a teammate or create a new team thread.</p>
                  <div className="flex justify-center gap-2">
                    <button
                      onClick={() => { setIsDMPickerOpen(true); setSelectedDmUids(new Set()); }}
                      className="px-4 py-2 text-sm font-semibold rounded-full bg-violet-600 text-white hover:bg-violet-700"
                    >
                      New DM
                    </button>
                    {isUserClubAdmin && (
                      <button
                        onClick={() => setIsCreatingThread(true)}
                        className="px-4 py-2 text-sm font-semibold rounded-full bg-cyan-600 text-white hover:bg-cyan-700"
                      >
                        New club channel
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          // CHAT VIEW
          selectedThread && (
            <div className="flex-1 min-h-0 flex flex-col bg-white">
              {/* Chat Header with Back Button */}
              <div className="bg-white border-b border-gray-200 p-4">
                <div className="flex items-center space-x-3">
                  <button
                    onClick={showThreadsList}
                    className="flex items-center justify-center w-10 h-10 bg-gray-100 hover:bg-gray-200 rounded-full transition-colors flex-shrink-0"
                  >
                    <svg className="w-6 h-6 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2">
                      <h1 className="text-lg font-semibold text-gray-900 truncate">{getThreadDisplayTitle(selectedThread)}</h1>
                      {isThreadPinned(selectedThread) && (
                        <svg className="w-4 h-4 text-yellow-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                        </svg>
                      )}
                      {selectedThread.isPrivate && (
                        <span className="bg-red-100 text-red-800 text-xs px-2 py-1 rounded-full flex-shrink-0">Coach Only</span>
                      )}
                    </div>
                    <div className="flex items-center space-x-2 text-xs text-gray-500 mt-1">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                      </svg>
                      <span>{effectiveParticipants(selectedThread).length} participants</span>
                    </div>
                  </div>

                  <button
                    onClick={() => {
                      setThreadSearchOpen(o => !o);
                      if (threadSearchOpen) setThreadSearchQuery('');
                    }}
                    className={`flex items-center justify-center w-10 h-10 rounded-full transition-colors flex-shrink-0 ${
                      threadSearchOpen ? 'bg-cyan-100 text-cyan-700' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-50'
                    }`}
                    aria-label="Search messages"
                    title="Search messages"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                  </button>

                  {(() => {
                    const sel: any = selectedThread;
                    const sc = sel.scope || 'team';
                    const isDM = sel.isDM === true;
                    const can =
                      (isDM && sel.participants.includes(userData?.uid || '')) ||
                      (sc === 'team' && isCoach) ||
                      (sc !== 'team' && isUserClubAdmin);
                    return can;
                  })() && (
                    <button
                      onClick={() => deleteThread(selectedThread)}
                      className="flex items-center justify-center w-10 h-10 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-full transition-colors flex-shrink-0"
                      aria-label="Delete chat"
                      title="Delete chat"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
                      </svg>
                    </button>
                  )}
                </div>

                {threadSearchOpen && (
                  <div className="mt-2 relative">
                    <svg className="absolute inset-y-0 left-0 pl-3 my-auto w-4 h-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input
                      autoFocus
                      value={threadSearchQuery}
                      onChange={(e) => setThreadSearchQuery(e.target.value)}
                      placeholder="Search this conversation…"
                      className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                    />
                  </div>
                )}
              </div>

              {/* Pinned messages strip — collapsible bar across the top
                  of the conversation. Tap a pinned message to scroll
                  to it in the thread. */}
              {(() => {
                const pinIds: string[] = (selectedThread as any).pinnedMessageIds || [];
                if (pinIds.length === 0) return null;
                const pinned = pinIds
                  .map((id) => messages.find((m) => m.id === id))
                  .filter(Boolean) as ChatMessage[];
                if (pinned.length === 0) return null;
                return (
                  <div className="bg-amber-50 border-b border-amber-200 px-3 py-2 flex items-center gap-2 overflow-x-auto scrollbar-hide">
                    <span className="inline-flex items-center gap-1 text-[10px] font-extrabold tracking-widest uppercase text-amber-800 flex-shrink-0">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <line x1="12" y1="17" x2="12" y2="22"/>
                        <path d="M5 17h14l-1.5-3.5L17 5H7l-.5 8.5L5 17z"/>
                      </svg>
                      Pinned
                    </span>
                    {pinned.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          const el = document.getElementById(`msg-${p.id}`);
                          if (el && messagesContainerRef.current) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            el.classList.add('ring-2', 'ring-amber-400', 'rounded-2xl');
                            setTimeout(() => {
                              el.classList.remove('ring-2', 'ring-amber-400', 'rounded-2xl');
                            }, 1500);
                          }
                        }}
                        className="text-xs bg-white ring-1 ring-amber-200 rounded-full px-2.5 py-1 flex-shrink-0 max-w-[220px] truncate text-slate-700 hover:bg-amber-100"
                      >
                        <span className="font-semibold text-slate-900">{p.senderName.split(' ')[0]}:</span>{' '}
                        {(p.content || (p.attachments?.length ? 'Photo' : 'message')).slice(0, 60)}
                      </button>
                    ))}
                  </div>
                );
              })()}

              {/* Messages — min-h-0 is critical: without it, flex-1 won't
                  shrink the messages div, and many messages push the composer
                  off the bottom of the container.
                  overscroll-contain prevents the scroll from bubbling out to
                  the body (the cause of the tab bar 'riding up'). */}
              <div
                ref={messagesContainerRef}
                onScroll={handleScroll}
                className="flex-1 min-h-0 overflow-y-auto p-4"
                style={{
                  overscrollBehavior: 'contain',
                  // Disable browser's automatic scroll anchoring —
                  // otherwise iOS picks some random visible image to
                  // anchor on as the list reflows, jumping the user
                  // to whichever image just had a layout change.
                  overflowAnchor: 'none' as any,
                }}
              >
                {/* Inner wrapper so ResizeObserver has a stable child
                    to observe — its height changes as images load. */}
                <div className="space-y-4">
                {threadSearchQuery.trim() && visibleMessages.length === 0 && (
                  <div className="text-center text-sm text-slate-500 py-6">
                    No messages match "{threadSearchQuery.trim()}".
                  </div>
                )}
                {threadSearchQuery.trim() && visibleMessages.length > 0 && (
                  <div className="text-[10px] font-extrabold tracking-widest uppercase text-slate-500 text-center mb-1">
                    {visibleMessages.length} match{visibleMessages.length === 1 ? '' : 'es'}
                  </div>
                )}
                {visibleMessages.map((message, idx) => {
                  // Compute sender-group boundaries so the bubble can render
                  // an avatar + name only on the first message of a run, and
                  // a timestamp only under the last.
                  const prev = visibleMessages[idx - 1];
                  const next = visibleMessages[idx + 1];
                  const ts = (m: any) => (m?.timestamp instanceof Date ? m.timestamp.getTime() : new Date(m?.timestamp || 0).getTime());
                  const GAP_MS = 5 * 60 * 1000;
                  const isFirstInGroup = !prev || prev.senderId !== message.senderId || ts(message) - ts(prev) > GAP_MS;
                  const isLastInGroup = !next || next.senderId !== message.senderId || ts(next) - ts(message) > GAP_MS;
                  // Day divider — show a Today / Yesterday / weekday /
                  // full-date pill whenever the message's local day
                  // differs from the previous message's day. First
                  // message in the thread always gets one too.
                  const msgDate = new Date(ts(message));
                  const prevDate = prev ? new Date(ts(prev)) : null;
                  const showDayDivider = !prevDate || !sameLocalDay(msgDate, prevDate);
                  return (
                    <React.Fragment key={message.id}>
                    {showDayDivider && (
                      <div className="flex items-center gap-3 my-2">
                        <div className="flex-1 h-px bg-slate-200" />
                        <span className="text-[10px] font-extrabold tracking-widest uppercase text-slate-500 px-2">
                          {formatDayDivider(msgDate)}
                        </span>
                        <div className="flex-1 h-px bg-slate-200" />
                      </div>
                    )}
                    <div id={`msg-${message.id}`} className="transition-shadow">
                    <MessageBubble
                      message={message}
                      currentUserId={userData?.uid || ''}
                      currentUserName={userData?.name || ''}
                      replyTarget={message.replyTo ? messages.find((mm) => mm.id === message.replyTo) || null : null}
                      onReply={setReplyingTo}
                      onToggleReaction={toggleReaction}
                      onDelete={deleteMessage}
                      onEdit={editMessage}
                      onTogglePin={togglePinMessage}
                      isPinned={((selectedThread as any)?.pinnedMessageIds || []).includes(message.id)}
                      canPin={(() => {
                        // Anyone can pin their own messages (Patrick's
                        // ask — feels native, matches what users expect
                        // from threads/Slack-style apps).
                        if (message.senderId === userData?.uid) return true;
                        const sc = (selectedThread as any)?.scope || 'team';
                        // Pinning OTHER people's messages stays gated:
                        // coaches + team managers in team threads, club
                        // admins in club-scope channels.
                        if (sc === 'team') {
                          const r = userData?.role as string | undefined;
                          return r === 'coach' || r === 'team_manager';
                        }
                        return isUserClubAdmin;
                      })()}
                      onStartDm={(uid, name) => startDM({ uid, name })}
                      onToggleMute={async (uid, name) => {
                        if (!userData?.uid) return;
                        const cur: string[] = Array.isArray((userData as any).mutedUserIds) ? (userData as any).mutedUserIds : [];
                        const next = cur.includes(uid) ? cur.filter(u => u !== uid) : [...cur, uid];
                        try {
                          await updateDoc(doc(db, 'users', userData.uid), { mutedUserIds: next });
                        } catch (err) {
                          console.warn('mute toggle failed', err);
                        }
                      }}
                      isMuted={Array.isArray((userData as any)?.mutedUserIds) && (userData as any).mutedUserIds.includes(message.senderId)}
                      onImageClick={(url) => setLightboxUrl(url)}
                      onPollVote={voteOnPoll}
                      onAcknowledge={acknowledgeMessage}
                      threadParticipantCount={effectiveParticipants(selectedThread).length}
                      formatTime={formatTime}
                      isFirstInGroup={isFirstInGroup}
                      isLastInGroup={isLastInGroup}
                      getSenderPhotoUrl={getSenderPhotoUrl}
                      getUserName={getUserName}
                      onMarkRead={markMessageRead}
                    />
                    </div>
                    </React.Fragment>
                  );
                })}
                <div ref={messagesEndRef} />
                </div>
              </div>

              {/* Message Input.
                  When the keyboard is closed we need internal safe-area
                  padding so the input clears the home indicator. When the
                  keyboard is open, the keyboard itself sits above the home
                  indicator so no extra padding needed. */}
              {typingNames.length > 0 && (
                <div className="px-4 pt-1.5 pb-0.5 text-[11px] text-slate-500 italic">
                  {typingNames.length === 1
                    ? `${typingNames[0]} is typing…`
                    : typingNames.length === 2
                    ? `${typingNames[0]} and ${typingNames[1]} are typing…`
                    : `${typingNames.length} people are typing…`}
                </div>
              )}
              <MessageComposer
                threadId={selectedThread.id}
                teamId={selectedTeamId}
                members={teamMembers}
                replyingTo={replyingTo}
                onCancelReply={() => setReplyingTo(null)}
                onSend={(c, atts, opts) => sendMessage(c, atts, opts)}
                onSendPoll={sendPoll}
                canMarkImportant={isCoach || isUserClubAdmin}
                rows={2}
                safeAreaInsetBottom={kbInset === 0}
                onTyping={handleTyping}
              />
            </div>
          )
        )}

        {/* Create Thread Modal */}
        {isCreatingThread && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-lg shadow-lg w-full max-w-md max-h-screen overflow-y-auto">
              <div className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-medium text-gray-900">Create New Thread</h3>
                  <button
                    onClick={() => setIsCreatingThread(false)}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Thread Title
                    </label>
                    <input
                      type="text"
                      value={newThread.title}
                      onChange={(e) => setNewThread(prev => ({ ...prev, title: e.target.value }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-cyan-500 text-base"
                      placeholder="Enter thread title..."
                      style={{ fontSize: '16px' }}
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Description (Optional)
                    </label>
                    <textarea
                      value={newThread.description}
                      onChange={(e) => setNewThread(prev => ({ ...prev, description: e.target.value }))}
                      rows={3}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-cyan-500 text-base"
                      placeholder="What's this thread about?"
                      style={{ fontSize: '16px' }}
                    />
                  </div>

                  {/* Channel scope — every team gets ONE auto-created
                      team chat (see ensureTeamChat below). Beyond that,
                      only club admins create channels, and only at the
                      club / coaches / admins level. Keeps the chat
                      surface simple: team chat, club chats, DMs.  */}
                  {isUserClubAdmin && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Visible to
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { k: 'club' as const, label: 'Whole club', desc: 'Every team, every member' },
                          { k: 'coaches' as const, label: 'Coaches only', desc: 'All coaches club-wide' },
                          { k: 'admins' as const, label: 'Admins only', desc: 'Club admins only' },
                        ].map((opt) => {
                          const active = newThread.scope === opt.k;
                          return (
                            <button
                              key={opt.k}
                              type="button"
                              onClick={() => setNewThread(prev => ({ ...prev, scope: opt.k }))}
                              className={`text-left p-2.5 rounded-xl ring-1 transition ${
                                active ? 'ring-cyan-500 bg-cyan-50/60' : 'ring-gray-200 bg-white hover:bg-gray-50'
                              }`}
                            >
                              <p className="font-semibold text-gray-900 text-sm">{opt.label}</p>
                              <p className="text-[11px] text-gray-500">{opt.desc}</p>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {isCoach && newThread.scope === 'team' && (
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        id="isPrivate"
                        checked={newThread.isPrivate}
                        onChange={(e) => setNewThread(prev => ({ ...prev, isPrivate: e.target.checked }))}
                        className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500 w-4 h-4"
                      />
                      <label htmlFor="isPrivate" className="ml-2 text-sm text-gray-700">
                        Coach-only thread
                      </label>
                    </div>
                  )}
                </div>

                <div className="flex space-x-3 mt-6">
                  <button
                    onClick={() => setIsCreatingThread(false)}
                    className="flex-1 px-4 py-2.5 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={createThread}
                    disabled={!newThread.title.trim()}
                    className="flex-1 px-4 py-2.5 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 disabled:bg-gray-400 transition-colors font-medium"
                  >
                    Create
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        {dmPickerModal}
      </div>
      {lightbox}
      </>
    );
  }

  // DESKTOP: Side-by-side layout. Sidebar (lg:ml-64) means the chat fills
  // the remaining width; height fills the viewport (no top/bottom nav on
  // desktop). dvh so URL-bar chrome doesn't shift the layout.
  return (
    <div className="flex bg-gray-50" style={{ height: '100dvh' }}>
      {/* Desktop Sidebar */}
      <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Messages</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setIsDMPickerOpen(true); setSelectedDmUids(new Set()); }}
                className="bg-violet-600 hover:bg-violet-700 text-white p-2 rounded-lg transition-colors"
                title="Direct message"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </button>
              {isUserClubAdmin && (
                <button
                  onClick={() => setIsCreatingThread(true)}
                  className="bg-cyan-600 hover:bg-cyan-700 text-white p-2 rounded-lg transition-colors"
                  title="New club channel"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          <div className="relative mb-3">
            <input
              type="text"
              placeholder="Search threads..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
            />
            <svg className="w-4 h-4 text-gray-400 absolute left-3 top-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>

          <div className="flex space-x-2">
            {[
              { key: 'all', label: 'All' },
              { key: 'pinned', label: 'Pinned' },
              { key: 'direct', label: 'DMs' },
              ...(isCoach ? [{ key: 'private', label: 'Coach' }] : []),
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setFilterTag(key)}
                className={`px-3 py-1 text-xs rounded-full transition-colors ${
                  filterTag === key
                    ? 'bg-cyan-50 text-cyan-700 font-medium'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Desktop Threads List */}
        <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          {filteredThreads.map((thread) => (
            <div
              key={thread.id}
              onClick={() => setSelectedThread(thread)}
              className={`p-4 border-b border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors ${
                selectedThread?.id === thread.id ? 'bg-cyan-50 border-l-4 border-l-blue-600' : ''
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2 mb-1">
                    <h3 className="font-medium text-gray-900 truncate">{getThreadDisplayTitle(thread)}</h3>
                    {isThreadPinned(thread) && (
                      <svg className="w-4 h-4 text-yellow-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                    )}
                    {thread.isPrivate && (
                      <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                    )}
                  </div>
                  
                  {thread.description && (
                    <p className="text-sm text-gray-600 truncate mb-2">{thread.description}</p>
                  )}
                  
                  {thread.lastMessage && (
                    <p className="text-xs text-gray-500 truncate mb-2">
                      <span className="font-medium">{thread.lastMessage.senderName}:</span> {thread.lastMessage.content}
                    </p>
                  )}
                  
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">{thread.messageCount || 0} messages</span>
                    <span className="text-xs text-gray-500">{formatTime(thread.lastActivity)}</span>
                  </div>
                </div>
                
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePinThread(thread);
                  }}
                  title={isThreadPinned(thread) ? 'Unpin chat' : 'Pin chat'}
                  className={`ml-2 p-1 rounded transition-colors ${
                    isThreadPinned(thread) ? 'text-yellow-500 hover:text-yellow-600' : 'text-gray-400 hover:text-gray-600'
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Desktop Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {selectedThread ? (
          <>
            {/* Desktop Chat Header */}
            <div className="bg-white border-b border-gray-200 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center space-x-2">
                    <h1 className="text-xl font-semibold text-gray-900">{getThreadDisplayTitle(selectedThread)}</h1>
                    {isThreadPinned(selectedThread) && (
                      <svg className="w-5 h-5 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                    )}
                    {selectedThread.isPrivate && (
                      <span className="bg-red-100 text-red-800 text-xs px-2 py-1 rounded-full">Coach Only</span>
                    )}
                  </div>
                  {selectedThread.description && (
                    <p className="text-sm text-gray-600 mt-1">{selectedThread.description}</p>
                  )}
                </div>
                
                <div className="flex items-center space-x-3">
                  <div className="flex items-center space-x-2 text-sm text-gray-500">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                    </svg>
                    <span>{selectedThread.participants.length} participants</span>
                  </div>
                  {(() => {
                    const sel: any = selectedThread;
                    const sc = sel.scope || 'team';
                    const isDM = sel.isDM === true;
                    const can =
                      (isDM && sel.participants.includes(userData?.uid || '')) ||
                      (sc === 'team' && isCoach) ||
                      (sc !== 'team' && isUserClubAdmin);
                    return can;
                  })() && (
                    <button
                      onClick={() => deleteThread(selectedThread)}
                      className="flex items-center justify-center w-9 h-9 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-full transition-colors"
                      aria-label="Delete chat"
                      title="Delete chat"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Desktop Messages */}
            <div
              ref={messagesContainerRef}
              onScroll={handleScroll}
              className="flex-1 min-h-0 overflow-y-auto p-4"
              style={{ overscrollBehavior: 'contain', overflowAnchor: 'none' as any }}
            >
              <div className="space-y-4">
              {messages.map((message, idx) => {
                const prev = messages[idx - 1];
                const next = messages[idx + 1];
                const ts = (m: any) => (m?.timestamp instanceof Date ? m.timestamp.getTime() : new Date(m?.timestamp || 0).getTime());
                const GAP_MS = 5 * 60 * 1000;
                const isFirstInGroup = !prev || prev.senderId !== message.senderId || ts(message) - ts(prev) > GAP_MS;
                const isLastInGroup = !next || next.senderId !== message.senderId || ts(next) - ts(message) > GAP_MS;
                return (
                  <div key={message.id} id={`msg-${message.id}`} className="transition-shadow">
                  <MessageBubble
                    message={message}
                    currentUserId={userData?.uid || ''}
                    currentUserName={userData?.name || ''}
                    replyTarget={message.replyTo ? messages.find((mm) => mm.id === message.replyTo) || null : null}
                    onReply={setReplyingTo}
                    onToggleReaction={toggleReaction}
                    onDelete={deleteMessage}
                    onEdit={editMessage}
                    onTogglePin={togglePinMessage}
                    isPinned={((selectedThread as any)?.pinnedMessageIds || []).includes(message.id)}
                    canPin={(() => {
                      if (message.senderId === userData?.uid) return true;
                      const sc = (selectedThread as any)?.scope || 'team';
                      if (sc === 'team') return isCoach;
                      return isUserClubAdmin;
                    })()}
                    onImageClick={(url) => setLightboxUrl(url)}
                    onPollVote={voteOnPoll}
                    onAcknowledge={acknowledgeMessage}
                    threadParticipantCount={effectiveParticipants(selectedThread).length}
                    formatTime={formatTime}
                    isFirstInGroup={isFirstInGroup}
                    isLastInGroup={isLastInGroup}
                    getSenderPhotoUrl={getSenderPhotoUrl}
                      getUserName={getUserName}
                      onMarkRead={markMessageRead}
                  />
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Desktop Message Input */}
            {selectedThread && (
              <MessageComposer
                threadId={selectedThread.id}
                teamId={selectedTeamId}
                members={teamMembers}
                replyingTo={replyingTo}
                onCancelReply={() => setReplyingTo(null)}
                onSend={(c, atts, opts) => sendMessage(c, atts, opts)}
                onSendPoll={sendPoll}
                canMarkImportant={isCoach || isUserClubAdmin}
                rows={3}
              />
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <h3 className="text-lg font-medium text-gray-900 mb-2">Select a thread to start chatting</h3>
              <p className="text-gray-500">Choose a thread from the sidebar or create a new one</p>
            </div>
          </div>
        )}
      </div>

      {/* Desktop Create Thread Modal */}
      {isCreatingThread && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-lg w-full max-w-md">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">Create New Thread</h3>
                <button
                  onClick={() => setIsCreatingThread(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Thread Title
                  </label>
                  <input
                    type="text"
                    value={newThread.title}
                    onChange={(e) => setNewThread(prev => ({ ...prev, title: e.target.value }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    placeholder="Enter thread title..."
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description (Optional)
                  </label>
                  <textarea
                    value={newThread.description}
                    onChange={(e) => setNewThread(prev => ({ ...prev, description: e.target.value }))}
                    rows={3}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    placeholder="What's this thread about?"
                  />
                </div>

                {isUserClubAdmin && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Visible to</label>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { k: 'team' as const, label: 'This team', desc: 'Just your selected team' },
                        { k: 'club' as const, label: 'Whole club', desc: 'Every team, every member' },
                        { k: 'coaches' as const, label: 'Coaches only', desc: 'All coaches club-wide' },
                        { k: 'admins' as const, label: 'Admins only', desc: 'Club admins only' },
                      ].map((opt) => {
                        const active = newThread.scope === opt.k;
                        return (
                          <button
                            key={opt.k}
                            type="button"
                            onClick={() => setNewThread(prev => ({ ...prev, scope: opt.k }))}
                            className={`text-left p-2.5 rounded-xl ring-1 transition ${
                              active ? 'ring-cyan-500 bg-cyan-50/60' : 'ring-gray-200 bg-white hover:bg-gray-50'
                            }`}
                          >
                            <p className="font-semibold text-gray-900 text-sm">{opt.label}</p>
                            <p className="text-[11px] text-gray-500">{opt.desc}</p>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {isCoach && newThread.scope === 'team' && (
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      id="isPrivate"
                      checked={newThread.isPrivate}
                      onChange={(e) => setNewThread(prev => ({ ...prev, isPrivate: e.target.checked }))}
                      className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
                    />
                    <label htmlFor="isPrivate" className="ml-2 text-sm text-gray-700">
                      Coach-only thread
                    </label>
                  </div>
                )}
              </div>

              <div className="flex justify-end space-x-3 mt-6">
                <button
                  onClick={() => setIsCreatingThread(false)}
                  className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={createThread}
                  disabled={!newThread.title.trim()}
                  className="px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 disabled:bg-gray-400 transition-colors"
                >
                  Create Thread
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {dmPickerModal}
      {lightbox}
    </div>
  );
};

export default TeamChat;