import React, { useState, useEffect, useMemo, useRef, useLayoutEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { where, doc, updateDoc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { getAuth, onIdTokenChanged } from 'firebase/auth';
import { db } from '../utils/firebase';
import { getShareOrigin } from '../utils/origin';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { ChatThread, ChatMessage } from '../types';
import { resolveSenderRole } from '../utils/helpers';
import MessageBubble from '../components/chat/MessageBubble';
import SilentErrorBoundary from '../components/common/SilentErrorBoundary';
import DataGate from '../components/common/DataGate';
import { useClubId } from '../hooks/useClubId';
import ChatImageLightbox, { LightboxImage } from '../components/chat/ChatImageLightbox';
import GlobalChatSearch from '../components/chat/GlobalChatSearch';
import SwipeableThreadRow from '../components/chat/SwipeableThreadRow';
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
    getOlderChatMessages,
    updateDocument,
    deleteDocument,
    getDocuments,
    getOrCreateDMThread,
    getPlayersByTeam,
  } = useFirestore();
  
  // Simple mobile-first state management
  const [currentView, setCurrentView] = useState<'threads' | 'chat'>('threads');
  // Per-thread draft cache. When the user switches threads we save
  // their current composer text under the OLD thread id and restore
  // the new thread's saved text. Match every modern chat app.
  const [draftsByThread, setDraftsByThread] = useState<Record<string, string>>({});
  // Optimistic-send queue. Each pending message gets a temp id and
  // renders immediately; we strip it once the real subscription
  // delivers a doc with the same content+sender+timestamp window OR
  // after a short ceiling so a failed send doesn't ghost forever.
  const [pendingMessages, setPendingMessages] = useState<Array<ChatMessage & { __pending: true; __failed?: boolean }>>([]);
  // Pagination state for "load older messages" on scroll-up. We store
  // the older batches separately from the live tail so the active
  // subscription doesn't blow them away on every re-render.
  const [olderMessages, setOlderMessages] = useState<ChatMessage[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  // Image lightbox state — opens full-screen when an image attachment
  // in the thread is tapped. The gallery includes every image in
  // the loaded thread window so the user can swipe between them.
  const [chatLightbox, setChatLightbox] = useState<{ images: LightboxImage[]; startIndex: number } | null>(null);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const openImage = (url: string) => {
    // Collect every image in the visible thread, in chronological order.
    const all: LightboxImage[] = [];
    for (const m of visibleMessages) {
      const atts = (m as any).attachments as Array<{ url: string; type?: string }> | undefined;
      if (!atts) continue;
      for (const a of atts) {
        if (a?.url && (!a.type || a.type.startsWith('image'))) {
          all.push({
            url: a.url,
            caption: (m as any).content || undefined,
            senderName: m.senderName,
            timestamp: m.timestamp,
          });
        }
      }
    }
    const startIndex = Math.max(0, all.findIndex(img => img.url === url));
    setChatLightbox({ images: all.length > 0 ? all : [{ url }], startIndex });
  };
  // Slide direction for chat-view entry/exit. Animation is purely
  // visual — we clear the state flag with a ref-cancelled timeout so
  // a rapid retap (back → tap thread A → tap thread B) can't race.
  const [chatSlideDir, setChatSlideDir] = useState<'in' | 'out' | null>(null);
  const slideTimeoutRef = useRef<number | null>(null);
  const cancelSlideTimeout = () => {
    if (slideTimeoutRef.current != null) {
      window.clearTimeout(slideTimeoutRef.current);
      slideTimeoutRef.current = null;
    }
  };
  // Team-scoped threads (the active team's chats + DMs) and club-scoped
  // threads (visible regardless of which team is selected). Kept in
  // separate state slots; combined via the `threads` memo below.
  const [teamThreads, setTeamThreads] = useState<ChatThread[]>([]);
  const [clubThreads, setClubThreads] = useState<ChatThread[]>([]);

  // Force-resub counter — bumped whenever Firebase Auth issues a fresh
  // ID token. Each bump tears down and remounts the threads
  // subscriptions so the new query runs against the new auth context.
  //
  // Why: Firestore rules on chat_threads gate DM reads by
  //   request.auth.uid in resource.data.participants
  // If the auth token is mid-refresh (common on mobile when cellular
  // hands off towers or WiFi reconnects), `request.auth.uid` is briefly
  // null/stale and the rule denies every DM doc. The subscription
  // silently drops those docs and the user sees their DMs vanish. Team
  // and club threads stay because they don't require the participant
  // check. Patrick hit this on cellular 2026-06-15 and lost trust in
  // the app's ability to keep his DMs intact.
  //
  // onIdTokenChanged fires on initial mount AND on every token refresh,
  // so this self-heals the transient: the moment a fresh token lands,
  // the threads subscription re-runs with the working auth.
  const [authChurn, setAuthChurn] = useState(0);
  useEffect(() => {
    const unsub = onIdTokenChanged(getAuth(), () => {
      setAuthChurn((c) => c + 1);
    });
    return () => unsub();
  }, []);

  // Clear the app-icon badge whenever the user lands on the chat
  // page. If they got here from tapping the notification banner,
  // the badge should drop the moment they arrive rather than
  // waiting for the next foreground event. No-op on web. ALSO
  // stamps the header notification bar's chat pill so it dims
  // immediately once the user has looked.
  useEffect(() => {
    (async () => {
      try {
        const { clearAppBadge } = await import('../utils/nativeShell');
        void clearAppBadge();
      } catch { /* ignore */ }
      try {
        const { markChatSeen } = await import('../components/common/NotificationsHeaderBar');
        markChatSeen(selectedTeamId || null);
      } catch { /* ignore */ }
    })();
  }, [selectedTeamId]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // ATOMIC RENDER for the messages area inside a chat. Flips false
  // when a new thread is selected, true on the first subscription
  // snapshot. Until true, the chat view shows empty silence (and a
  // 400ms progress hint if the wait stretches), not the 'No messages
  // yet' empty state — which previously appeared during cold-load
  // and made users think the DM was broken. Same pattern as the
  // thread list pilot (4b379fb) and dashboard/wall rollouts.
  // The companion useEffect that gates the progress hint lives
  // below `selectedThread` is declared so the dep array can read
  // its `?.id`.
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [messagesShowProgress, setMessagesShowProgress] = useState(false);
  // In-thread search — client-side filter over already-loaded messages.
  // No server query yet; sufficient for the typical loaded window
  // (last ~200 msgs). Server-side full-text search is a later batch.
  const [threadSearchOpen, setThreadSearchOpen] = useState(false);
  const [threadSearchQuery, setThreadSearchQuery] = useState('');
  const [selectedThread, setSelectedThread] = useState<ChatThread | null>(null);
  // Companion effect to messagesLoaded/messagesShowProgress declared
  // above — placed here so it can read selectedThread.id in its dep
  // array. Schedules the slim crimson hint at the top of the chat
  // column 400ms after a new thread is opened, only if the
  // subscription hasn't fired yet by then.
  useEffect(() => {
    if (messagesLoaded) { setMessagesShowProgress(false); return; }
    const t = window.setTimeout(() => setMessagesShowProgress(true), 400);
    return () => window.clearTimeout(t);
  }, [messagesLoaded, selectedThread?.id]);
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
  // Per-thread visited timestamps. Stored in BOTH localStorage (fast
  // local read) AND the user's Firestore doc (durable across iOS
  // WebView storage purges + app updates + device switches). On boot
  // we read localStorage immediately so the unread chip renders
  // without a network round-trip, then merge in the Firestore copy
  // when it loads. The fact that iOS evicted WebView localStorage
  // between sessions is why previously-read threads were showing
  // unread again — the user-doc copy survives that.
  const [threadVisited, setThreadVisited] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem('firefc.threadVisited');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  // Hydrate from the user doc once it's loaded. Server values take
  // precedence per-thread when their timestamp is newer (so a read
  // made on another device propagates here).
  useEffect(() => {
    const remote = (userData as any)?.chatThreadsLastSeen as Record<string, number> | undefined;
    if (!remote) return;
    setThreadVisited(prev => {
      const merged: Record<string, number> = { ...prev };
      for (const [tid, ts] of Object.entries(remote)) {
        if (typeof ts === 'number' && ts > (merged[tid] || 0)) merged[tid] = ts;
      }
      try { localStorage.setItem('firefc.threadVisited', JSON.stringify(merged)); } catch {/* ignore */}
      return merged;
    });
  }, [(userData as any)?.chatThreadsLastSeen]);

  // One-time backfill for legacy threads from 1.6.1 (before per-thread
  // seen timestamps were persisted to the user doc). For each thread
  // where the lastMessage is FROM me OR the thread has no recent
  // activity (older than 30 days), mark it seen as of now. Avoids the
  // "everything's unread after reinstall" cosmetic noise without
  // overwriting genuinely new messages.
  const allThreads = useMemo(() => [...teamThreads, ...clubThreads], [teamThreads, clubThreads]);
  const didBackfillRef = React.useRef(false);
  useEffect(() => {
    if (didBackfillRef.current) return;
    if (!userData?.uid) return;
    if (allThreads.length === 0) return;
    const remote = (userData as any)?.chatThreadsLastSeen as Record<string, number> | undefined;
    const myName = userData.name;
    const now = Date.now();
    const STALE_MS = 30 * 24 * 60 * 60 * 1000;
    const additions: Record<string, number> = {};
    for (const t of allThreads) {
      // Already have a server-side seen record? Skip.
      if (remote && typeof remote[t.id] === 'number') continue;
      // Last message is from me (legacy: matched by senderName since
      // senderId only started landing in 2.0). Treat as seen.
      const lastSenderId = (t.lastMessage as any)?.senderId;
      const lastSenderName = (t.lastMessage as any)?.senderName;
      const lastIsMine = lastSenderId
        ? lastSenderId === userData.uid
        : (lastSenderName && lastSenderName === myName);
      const ageMs = now - (t.lastActivity instanceof Date
        ? t.lastActivity.getTime()
        : new Date(t.lastActivity || 0).getTime());
      if (lastIsMine || ageMs > STALE_MS) {
        additions[t.id] = now;
      }
    }
    if (Object.keys(additions).length === 0) {
      didBackfillRef.current = true;
      return;
    }
    didBackfillRef.current = true;
    // Update local state + write through to Firestore in one go.
    setThreadVisited(prev => {
      const next = { ...prev, ...additions };
      try { localStorage.setItem('firefc.threadVisited', JSON.stringify(next)); } catch {/* ignore */}
      return next;
    });
    try {
      const patch: Record<string, number> = {};
      for (const [tid, ts] of Object.entries(additions)) patch[`chatThreadsLastSeen.${tid}`] = ts;
      updateDoc(doc(db, 'users', userData.uid), patch).catch(() => {/* ignore */});
    } catch {/* ignore */}
  }, [allThreads, userData?.uid, userData?.name]);
  const markThreadVisited = (threadId: string) => {
    if (!threadId || !userData?.uid) return;
    const ts = Date.now();
    setThreadVisited(prev => {
      const next = { ...prev, [threadId]: ts };
      try { localStorage.setItem('firefc.threadVisited', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    // Write-through to Firestore. Field-level merge so we don't clobber
    // other threads' timestamps. Fire-and-forget — UI doesn't wait.
    try {
      updateDoc(doc(db, 'users', userData.uid), {
        [`chatThreadsLastSeen.${threadId}`]: ts,
      }).catch(() => {/* ignore — localStorage still has it */});
    } catch {/* ignore */}
  };
  const isThreadUnread = (thread: ChatThread): boolean => {
    // Brand-new threads with no last message shouldn't be unread.
    if (!thread.lastMessage) return false;
    // YOU can't be unread on a message YOU sent. This short-circuit is
    // critical after a reinstall — without it, every DM where you
    // wrote the last reply looks unread because there's no local cache.
    if (thread.lastMessage.senderId && userData?.uid && thread.lastMessage.senderId === userData.uid) {
      return false;
    }
    const lastTs = thread.lastActivity instanceof Date
      ? thread.lastActivity.getTime()
      : new Date(thread.lastActivity || 0).getTime();
    const seenTs = threadVisited[thread.id] || 0;
    return lastTs > seenTs;
  };
  const [loading, setLoading] = useState(true);
  // ATOMIC RENDER: track both thread subscriptions independently so we
  // can wait until both have fired at least once before showing
  // anything — eliminates the staggered 'chats pop in one at a time'
  // cascade Patrick called out 2026-06-21. Pilot for the 'cleanest
  // possible' loading pattern: empty silence, then a single fade-in
  // when ready. No skeletons, no shimmer.
  const [clubLoaded, setClubLoaded] = useState(false);
  const [hardTimeoutFired, setHardTimeoutFired] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const threadsReady = hardTimeoutFired || (!loading && clubLoaded);
  // Hard timeout: if a subscription stalls (offline, rules denial,
  // network issue), surface what we have after 2 seconds instead of
  // sitting in silence forever.
  useEffect(() => {
    const t = window.setTimeout(() => setHardTimeoutFired(true), 2000);
    return () => window.clearTimeout(t);
  }, []);
  // Progress hint: thin crimson bar at the top of the list, only if
  // load takes longer than the eye reads as 'instant' (~400ms). If
  // ready arrives faster, the bar never shows — cleaner than a
  // spinner that flashes for one frame.
  useEffect(() => {
    if (threadsReady) { setShowProgress(false); return; }
    const t = window.setTimeout(() => setShowProgress(true), 400);
    return () => window.clearTimeout(t);
  }, [threadsReady]);
  const [teamMembers, setTeamMembers] = useState<{ uid: string; name: string; role?: string; email?: string; photoURL?: string; childNames?: string[] }[]>([]);
  // Cross-team user cache. Populated on demand by resolveUnknownUids
  // when MessageBubble's Seen-by sheet sees a UID the active-team
  // roster can't name (former teammates, coaches who moved teams,
  // etc.). Persists for the session so we don't re-fetch.
  const [crossUserCache, setCrossUserCache] = useState<Record<string, { name: string; photoURL?: string }>>({});
  // In-flight set — keeps us from firing duplicate fetches when the
  // same uid appears in multiple bubbles' useEffects on the same render.
  const crossUserPendingRef = React.useRef<Set<string>>(new Set());
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
    scope: 'team',
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

  const currentRole = (userData as any)?.role;
  const isCoach = currentRole === 'coach';
  const isTeamStaff = currentRole === 'coach' || currentRole === 'team_manager';
  const isUserClubAdmin = !!(userData as any)?.isClubAdmin;
  const canCreateTeamThread = !!selectedTeamId && (isTeamStaff || isUserClubAdmin);
  const canCreateAnyThread = canCreateTeamThread || isUserClubAdmin;
  const openCreateThread = () => {
    setNewThread(prev => ({
      ...prev,
      scope: canCreateTeamThread ? 'team' : 'club',
      isPrivate: false,
    }));
    setIsCreatingThread(true);
  };
  // Fallback clubId resolver — same chain Branding + AdminCockpit use.
  // Tries userData.clubId → user's first team's clubId → 'any club'.
  // Used by createThread when selectedTeam.clubId is missing, so a
  // club-scope thread create doesn't dead-end on partially-stamped
  // team data.
  const { clubId: fallbackClubId } = useClubId();

  // Detect mobile + track viewport height. With Capacitor's
  // Keyboard.resize: 'native', iOS shrinks the WebView when the keyboard
  // appears — so window.innerHeight DOES drop from e.g. 860 → 531. But
  // position:fixed elements with `bottom: 0` continue to anchor against
  // the ORIGINAL viewport bottom (an iOS WKWebView quirk). We work around
  // it by setting the chat container's height explicitly from
  // window.innerHeight, instead of relying on CSS bottom anchoring.
  // 1024 (Tailwind 'lg') instead of 768 so iPad portrait
  // (768x1024) uses the mobile single-view layout. The desktop
  // two-pane layout assumes 'no top/bottom nav' and uses
  // height: 100dvh — but Navigation.tsx only hides its mobile
  // chrome at lg+. Between 768 and 1023 the mobile chrome IS
  // showing AND the desktop layout doesn't subtract for it, so
  // the composer at the bottom of the chat gets pushed off the
  // viewport. Patrick: 'i can[not] get a type box to show up
  // on ipad simulator in chat.'
  const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);
  const [winHeight, setWinHeight] = useState(window.innerHeight);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 1024;
      setIsMobile(mobile);
      setWinHeight(window.innerHeight);
      // Previously forced currentView = 'threads' on every desktop
      // resize, which silently blanked the chat panel whenever the
      // browser fired a resize event (including initial mobile-devtools
      // toggles). The desktop layout already shows both panels side-
      // by-side regardless of currentView, so the reset was unnecessary
      // and actively harmful.
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Lock background scroll while the chat is mounted so the only thing that
  // can scroll is the messages list itself. Without this, iOS rubber-bands
  // the body and the fixed bottom tab bar appears to drift over the chat.
  useEffect(() => {
    document.body.classList.add('chat-locked');
    // Also stamp the html element so the CSS rule that paints every
    // ancestor white can match without depending on :has() (older iOS
    // Safari builds don't have it).
    document.documentElement.classList.add('chat-locked');
    return () => {
      document.body.classList.remove('chat-locked');
      document.documentElement.classList.remove('chat-locked');
    };
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

  // Navigation. State changes are synchronous so a rapid retap can't
  // race. The slide direction is decorative — the CSS keyframe runs
  // alongside the (already-completed) React state change. A ref-backed
  // timeout clears the direction flag and is cancelled if a new
  // navigation starts before it fires.
  const showThreadsList = () => {
    cancelSlideTimeout();
    if (selectedThread?.id && newMessage) {
      setDraftsByThread(prev => ({ ...prev, [selectedThread.id]: newMessage }));
    } else if (selectedThread?.id) {
      setDraftsByThread(prev => {
        if (!prev[selectedThread.id]) return prev;
        const { [selectedThread.id]: _omit, ...rest } = prev;
        return rest;
      });
    }
    setCurrentView('threads');
    setSelectedThread(null);
    setNewMessage('');
    setChatSlideDir(null);
  };

  const showChatView = (thread: ChatThread) => {
    cancelSlideTimeout();
    if (selectedThread?.id && newMessage) {
      setDraftsByThread(prev => ({ ...prev, [selectedThread.id]: newMessage }));
    }
    setSelectedThread(thread);
    setNewMessage(draftsByThread[thread.id] || '');
    setCurrentView('chat');
    setChatSlideDir('in');
    // Matches the .animate-slide-in-right duration (0.35s) with a
    // little headroom so the class is still attached when the keyframe
    // finishes. Previously 240ms — too short, animation got yanked
    // partway through, which was half the reason transitions felt
    // 'flashy' rather than 'sliding.'
    slideTimeoutRef.current = window.setTimeout(() => {
      setChatSlideDir(null);
      slideTimeoutRef.current = null;
    }, 380);
    markThreadVisited(thread.id);
  };

  // Jump or animate the messages list to the bottom. Manipulating
  // Direct scrollTop on the messages container — NOT scrollIntoView.
  // scrollIntoView walks UP the DOM to find the first scrollable
  // ancestor, which on Android Chromium can be the page body or a
  // parent flex container instead of the messages list. The result:
  // sending a long message would scroll a DIFFERENT element, shoving
  // the entire thread to the top of the viewport (Patrick: "i sent a
  // long message and it took me to the very top of the thread").
  // Direct scrollTop on the ref we own is unambiguous.
  //
  // scrollIntoView is kept ONLY as a fallback if the container ref
  // hasn't mounted yet, which should be effectively never.
  const scrollToBottom = (smooth = false) => {
    const c = messagesContainerRef.current;
    if (c) {
      if (smooth) c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
      else c.scrollTop = c.scrollHeight;
      return;
    }
    const el = messagesEndRef.current;
    if (el) el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
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
      // MERGE, don't REPLACE. A snapshot missing a thread doesn't
      // authoritatively mean "this thread is gone for you" — it can
      // mean Firestore's rules briefly denied the read during an auth
      // token refresh (the bug Patrick hit on cellular 2026-06-15).
      // iMessage / WhatsApp / Telegram model: local state is
      // authoritative for what's VISIBLE; the server is authoritative
      // for what's NEW. So we add/update from every snapshot, but we
      // only remove a thread when the user explicitly deletes it
      // (handleDeleteThread, which calls removeThreadFromLocalState).
      setTeamThreads((prev) => {
        const byId = new Map(prev.map((t) => [t.id, t]));
        for (const t of processed) byId.set(t.id, t);
        return Array.from(byId.values());
      });
      setLoading(false);
    });
    return () => { unsubscribeThreads(); };
  }, [userData?.teamIds, userData?.teamId, selectedTeamId, subscribeToChatThreads, authChurn]);

  // Auto-create the team chat. Every team gets exactly ONE team-scoped
  // thread (named "<Team> Chat").
  //
  // Patrick 2026-06-25: 'every once in a while, the app will create a
  // new chat group for a team even though we already have one.'
  //
  // Old approach used addDoc with a random ID + a local `hasTeamChat`
  // check against the subscription. The race: two sessions both load
  // before either has populated teamThreads, both pass the check,
  // both addDoc -> two threads. Fixed by using a deterministic
  // document ID (`teamchat_<teamId>`) with setDoc — concurrent
  // creates converge on the same doc, no duplicates possible. Legacy
  // teams that already have a random-ID team thread get that thread
  // promoted with `isOfficialTeamChat: true` instead of getting a
  // fresh doc.
  const ensuredTeamChatRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!userData?.uid || !selectedTeamId || loading) return;
    if (ensuredTeamChatRef.current.has(selectedTeamId)) return;
    ensuredTeamChatRef.current.add(selectedTeamId);

    (async () => {
      try {
        const { doc: fsDocFn, getDoc, setDoc: fsSetDoc, updateDoc: fsUpdateDoc, serverTimestamp } = await import('firebase/firestore');
        const { db: fsDb } = await import('../utils/firebase');
        const officialId = `teamchat_${selectedTeamId}`;
        const officialRef = fsDocFn(fsDb, 'chat_threads', officialId);

        // Fast path: canonical doc already exists.
        const officialSnap = await getDoc(officialRef);
        if (officialSnap.exists()) return;

        // Legacy: a random-ID team thread already exists from before
        // the deterministic-ID rollout. Stamp it as official rather
        // than create a duplicate.
        const existingLegacy = teamThreads.find((t) => {
          const scope = (t as any).scope || 'team';
          const isDM = (t as any).isDM === true;
          return !isDM && scope === 'team' && t.teamId === selectedTeamId && t.id !== officialId;
        });
        if (existingLegacy) {
          await fsUpdateDoc(fsDocFn(fsDb, 'chat_threads', existingLegacy.id), {
            isOfficialTeamChat: true,
          });
          return;
        }

        // Create the canonical doc. setDoc on a deterministic id is
        // idempotent under concurrent writers — they overwrite each
        // other with the same data, never produce dupes.
        const teamName = selectedTeam?.name || 'Team';
        await fsSetDoc(officialRef, {
          id: officialId,
          title: `${teamName} Chat`,
          description: 'Team-wide conversation for parents and coaches.',
          teamId: selectedTeamId,
          scope: 'team',
          isOfficialTeamChat: true,
          createdBy: userData.uid,
          createdByName: userData.name || 'Member',
          createdAt: serverTimestamp(),
          lastActivity: serverTimestamp(),
          isPinned: false,
          isPrivate: false,
          messageCount: 0,
          participants: [userData.uid],
          tags: ['team'],
        }, { merge: true });
      } catch (err) {
        ensuredTeamChatRef.current.delete(selectedTeamId);
        console.warn('[chat] auto-create team chat failed', err);
      }
    })();
  }, [userData?.uid, userData?.name, selectedTeamId, selectedTeam?.name, teamThreads, loading]);

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
      // Same merge-don't-replace pattern as the team-scoped subscription
      // above. Don't blank a club channel just because the snapshot
      // dropped it (e.g., rule denial during auth refresh).
      setClubThreads((prev) => {
        const byId = new Map(prev.map((t) => [t.id, t]));
        for (const t of processed) byId.set(t.id, t);
        return Array.from(byId.values());
      });
      // Mark this subscription as having fired at least once — paired
      // with `loading` (team subscription) to gate the atomic render.
      setClubLoaded(true);
    });
    return () => { unsub && unsub(); };
  }, [subscribeToClubChatThreads, authChurn]);

  // Merge + role-filter. Coaches see team + club + coaches scopes.
  // Parents see team + club. Admins see everything.
  const threads = React.useMemo<ChatThread[]>(() => {
    const merged: ChatThread[] = [...teamThreads, ...clubThreads];
    // Dedup by id (a thread can appear in both subscriptions if its
    // teamId happens to match the active team AND its scope is club —
    // unusual but possible).
    const byId = new Map<string, ChatThread>();
    for (const t of merged) byId.set(t.id, t);
    // Filter out threads soft-deleted by the merge-duplicate-dms
    // migration (isActive === false). Those threads still exist in
    // Firestore (PITR isn't enabled, so we soft-delete per memory)
    // but their messages have been rewired to the canonical thread.
    // Without this filter, parents on multi-team accounts would
    // still see the merged-away DM rows next to the canonical one.
    const all = Array.from(byId.values()).filter(t => (t as any).isActive !== false);
    // Pre-compute the user's team memberships once so the per-thread
    // membership check is cheap. Treat legacy single-team users
    // (teamId-only, no teamIds[]) the same as members of [teamId].
    const myTeamIds = new Set<string>([
      ...(Array.isArray((userData as any)?.teamIds) ? (userData as any).teamIds : []),
      ...(((userData as any)?.teamId) ? [(userData as any).teamId] : []),
    ]);

    return all
      .filter((thread: any) => {
        const scope = thread.scope || 'team';

        // DMs + groups follow the USER, not the selected team.
        // Patrick 2026-06-25: 'I don't want to have to switch teams
        // to check dm's.' Privacy is already enforced via the
        // participants[] check on the thread rule + below.
        if (thread.isDM === true || thread.isGroup === true) {
          const me = (userData as any)?.uid;
          if (!me) return false;
          const parts: string[] = Array.isArray(thread.participants) ? thread.participants : [];
          return parts.includes(me);
        }

        // Team-only private threads still gated by coach role.
        if (scope === 'team' && thread.isPrivate && !isTeamStaff) return false;
        if (scope === 'admins' && !isUserClubAdmin) return false;
        if (scope === 'coaches' && !isTeamStaff && !isUserClubAdmin) return false;

        // Cross-team / cross-club membership gate. Three shapes:
        //
        //   1. team-anchored ('team' scope, teamId set): show only
        //      when thread.teamId === selectedTeamId.
        //   2. team-coaches ('coaches' scope, teamId set): rare —
        //      a coaches channel scoped to one specific team. Same
        //      rule as #1.
        //   3. club-coaches ('coaches' / 'club' / 'admins' scope,
        //      no teamId): show across every team in the same club.
        //      Matched by thread.clubId === selectedTeam.clubId.
        //      This is the 'Coaches, Managers and Staff' shape — one
        //      club-wide thread visible from any of that club's
        //      teams.
        //
        // Admins NO LONGER bypass — viewing one team should show
        // that team's threads, not every club's. The /club page is
        // the right surface for cross-club visibility.
        const selectedClubId = (selectedTeam as any)?.clubId || null;
        if ((scope === 'team' || scope === 'coaches') && thread.teamId) {
          // Team-anchored thread.
          if (!myTeamIds.has(thread.teamId)) return false;
          if (selectedTeamId && thread.teamId !== selectedTeamId) return false;
        } else if (scope === 'coaches' || scope === 'club' || scope === 'admins') {
          // Club-wide thread (no teamId). Two cases:
          //   - thread.clubId is set: require selectedClubId match.
          //   - thread.clubId is missing / empty: hide from everyone
          //     except the creator. Without a clubId the thread has
          //     no tenant scope, so showing it anywhere is a leak.
          //     Creator-only visibility lets them delete the orphan
          //     without exposing it cross-club. Patrick 2026-06-25:
          //     'I just tried making a new coach chat on my club,
          //     and sure enough, it showed up on the other account.'
          const me = (userData as any)?.uid;
          if (thread.clubId) {
            if (!selectedClubId || thread.clubId !== selectedClubId) return false;
          } else {
            if (thread.createdBy !== me) return false;
          }
        }

        return true;
      })
      .sort((a: any, b: any) => {
        // Order: user-pinned first → team-scoped channels next → groups
        // → DMs, then by recency within each tier. This puts the team
        // chat at the top by default without the user having to pin
        // anything, and keeps DMs from drowning out announcements.
        const aP = (userData as any)?.pinnedThreadIds?.includes(a.id) || false;
        const bP = (userData as any)?.pinnedThreadIds?.includes(b.id) || false;
        if (aP !== bP) return aP ? -1 : 1;
        const tierOf = (t: any) => {
          if (t.isDM) return 3;
          if (t.isGroup) return 2;
          return 1; // team / club / coaches / admins scopes
        };
        const aT = tierOf(a);
        const bT = tierOf(b);
        if (aT !== bT) return aT - bT;
        return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
      });
  }, [teamThreads, clubThreads, isTeamStaff, isUserClubAdmin, userData, selectedTeamId]);

  // When a deep link includes &message=<id>, we stash it here and the
  // messages-watching effect below scrolls to it once the bubble lands
  // in the DOM. Cleared on success so we don't re-fire on the next
  // messages snapshot.
  const [pendingScrollMsgId, setPendingScrollMsgId] = useState<string | null>(null);

  // Deep-link handling (?thread=<id>&message=<id>) runs whenever the
  // merged threads list refreshes; consumes the params so they don't
  // re-fire.
  useEffect(() => {
    const deepLinkId = searchParams.get('thread');
    const msgId = searchParams.get('message');
    if (!deepLinkId) return;
    const target = threads.find(t => t.id === deepLinkId);
    // Bail until threads actually loaded — otherwise we'd consume the
    // URL params on the empty first render and lose the deep link.
    if (!target) return;
    // If the user is actively composing in another thread, don't
    // yank them away — that's how drafts get lost. Skip the auto-
    // switch unless they've explicitly emptied the composer.
    if (selectedThread && selectedThread.id !== deepLinkId && newMessage.trim()) {
      // Keep the deep-link params in the URL — they can tap the
      // target thread from the list later without losing their draft.
      return;
    }
    // Save any in-flight draft on the source thread so the round-trip
    // preserves it.
    if (selectedThread?.id && newMessage) {
      setDraftsByThread(prev => ({ ...prev, [selectedThread.id]: newMessage }));
    }
    setSelectedThread(target);
    setNewMessage(draftsByThread[target.id] || '');
    setCurrentView('chat');
    if (msgId) setPendingScrollMsgId(msgId);
    const next = new URLSearchParams(searchParams);
    next.delete('thread');
    next.delete('message');
    setSearchParams(next, { replace: true });
  }, [threads, searchParams, setSearchParams, selectedThread, newMessage, draftsByThread]);

  // Scroll to + flash-highlight a specific message once it's in the
  // DOM. Same visual treatment as the reply-quote tap so the eye
  // catches it. Polls a few frames in case the bubble hasn't rendered
  // yet (messages subscription may not have caught up).
  useEffect(() => {
    if (!pendingScrollMsgId) return;
    let attempts = 0;
    const tryScroll = () => {
      const el = document.getElementById(`msg-${pendingScrollMsgId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('ring-2', 'ring-amber-400', 'rounded-2xl');
        window.setTimeout(() => {
          el.classList.remove('ring-2', 'ring-amber-400', 'rounded-2xl');
        }, 1600);
        setPendingScrollMsgId(null);
        return;
      }
      attempts += 1;
      // ~3s of polling at 200ms covers slow snapshot + image-decoded
      // layout shifts. After that we give up — message was probably
      // deleted or doesn't belong to this thread.
      if (attempts < 15) window.setTimeout(tryScroll, 200);
      else setPendingScrollMsgId(null);
    };
    tryScroll();
  }, [pendingScrollMsgId, messages]);

  // Desktop initial selection: pick the first thread the first time the
  // list loads, if nothing's selected yet.
  useEffect(() => {
    if (!isMobile && threads.length > 0 && !selectedThread) {
      setSelectedThread(threads[0]);
    }
  }, [threads, isMobile, selectedThread]);

  // Preload image attachments that show up on the latest message of
  // each thread, so when the user opens the chat the photo is already
  // in browser cache instead of popping in after the reactions render.
  // Cheap — 1 hit per thread, one-shot per session.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    for (const t of threads) {
      const atts = (t.lastMessage as any)?.attachments as Array<{ url: string }> | undefined;
      if (!atts) continue;
      for (const a of atts) {
        if (a?.url) {
          const img = new Image();
          img.src = a.url;
        }
      }
    }
  }, [threads]);

  // Pre-warm the first page of messages for the top 5 threads as soon
  // as the list loads. By the time the user taps one, the SDK already
  // has the data, so the chat view paints instantly rather than after
  // the live subscription connects.
  useEffect(() => {
    if (threads.length === 0) return;
    void import('../utils/chatPrewarm').then(({ prewarmThreads }) => {
      prewarmThreads(threads.map(t => t.id), { topN: 5 });
    });
  }, [threads]);

  // Load team members for @mention autocomplete + email, plus a
  // parentUid → [childNames] lookup so the DM picker can show which
  // player(s) a member is connected to.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [allUsers, teamPlayers] = await Promise.all([
          getDocuments('users', []).catch(() => []),
          selectedTeamId ? getPlayersByTeam(selectedTeamId).catch(() => []) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        // Build parent → children map across the active team's roster.
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
            photoURL: u.photoURL || u.profilePhotoUrl,
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
      // Reset the messages-loaded flag — the next snapshot fire
      // flips it back to true. Until then the chat view renders
      // empty silence (atomic-render pattern) instead of the
      // 'No messages yet' empty state, which previously appeared
      // for the 1-2s a cold subscription took to resolve on
      // Android. Patrick 2026-06-21: 'doesn't show anything if i
      // open the chat... i was sitting there trying to look for
      // the console, and all the chats loaded.'
      setMessagesLoaded(false);
      // Reset pagination state for the new thread.
      setOlderMessages([]);
      setHasMoreOlder(true);
      setLoadingOlder(false);
      // Clear pending optimistic rows from the previous thread —
      // they'd otherwise leak into the new conversation.
      setPendingMessages(prev => prev.filter(p => p.threadId === selectedThread.id));
      const unsubscribeMessages = subscribeToChatMessages(selectedThread.id, (messagesData) => {
        const processedMessages = messagesData.map(message => ({
          ...message,
          timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp || Date.now()),
          createdAt: message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt || Date.now())
        }));
        setMessages(processedMessages);
        // First snapshot arrived — chat view can stop hiding the
        // empty-state and either show the messages or the real
        // empty-state. Subsequent snapshots are no-ops on this flag.
        setMessagesLoaded(true);
        // Strip any optimistic rows whose real counterpart just landed.
        // Match by senderId + content + close-enough timestamp window —
        // good enough since we only insert pendings within the last few
        // seconds and Firestore writes back within ~1s.
        setPendingMessages(prev => prev.filter(p => {
          if (p.threadId !== selectedThread.id) return true;
          const matchExists = processedMessages.some(m =>
            m.senderId === p.senderId
            && (m.content || '') === (p.content || '')
            && Math.abs(m.timestamp.getTime() - p.timestamp.getTime()) < 60_000
          );
          return !matchExists;
        }));
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
      anchoredThreadIdRef.current = selectedThread.id;
      isAtBottomRef.current = true;
      // 3s window during which onScroll updates are suppressed (so
      // iOS's synthetic scroll-anchoring scrolls can't flip the flag).
      initialLoadUntilRef.current = Date.now() + 3000;

      // Multi-frame sentinel scroll: keep calling scrollToBottom
      // every animation frame for ~1s. scrollToBottom uses
      // scrollIntoView on the bottom sentinel — so it always lands
      // at the TRUE bottom (wherever the sentinel currently is),
      // even if images are still decoding. Each frame is a no-op
      // when already at bottom, so there's no visible bouncing.
      const deadline = Date.now() + 1000;
      const pin = () => {
        scrollToBottom(false);
        if (Date.now() < deadline) requestAnimationFrame(pin);
      };
      requestAnimationFrame(pin);
    } else if (isAtBottomRef.current) {
      // Was smooth-scroll. Changed to INSTANT: when a Firestore tail
      // arrives ~200ms after the user's send (delivering the real
      // copy of the message they just sent optimistically), a smooth
      // scroll animation interfered with the instant pin our send
      // path already did — visible as the thread "jumping" mid-
      // animation. Instant always lands in one frame; no race.
      scrollToBottom(false);
    }
  }, [selectedThread, messages]);

  // Belt-and-suspenders ResizeObserver for layout shifts that happen
  // AFTER the 700ms window (slow images, late-arriving GIFs). Observes
  // the container directly so it sees every reflow, not just the
  // first child's. During the initial-load window we ALWAYS re-pin;
  // afterwards only if the user is still at the bottom.
  useEffect(() => {
    const c = messagesContainerRef.current;
    if (!c || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const inInitialLoad = Date.now() < initialLoadUntilRef.current;
      if (inInitialLoad || isAtBottomRef.current) {
        scrollToBottom(false);
      }
    });
    ro.observe(c);
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
    const atBottom = distFromBottom < 80;
    isAtBottomRef.current = atBottom;
    setIsScrolledUp(!atBottom);
    if (atBottom) setUnreadWhileScrolledUp(0);
    // Near top → load older messages. Trigger ~200px before the top
    // so the page is ready by the time the user gets there.
    if (selectedThread && c.scrollTop < 200 && !loadingOlder && hasMoreOlder) {
      void loadOlderMessages();
    }
  };

  // Load the next page of older messages and prepend. Preserves the
  // user's visual position by adjusting scrollTop to compensate for
  // the newly-inserted content's height.
  const loadOlderMessages = async () => {
    if (!selectedThread || loadingOlder || !hasMoreOlder) return;
    setLoadingOlder(true);
    try {
      // Find the oldest currently-visible message to anchor the query.
      const combined = [...olderMessages, ...messages].sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
      );
      const oldest = combined[0];
      if (!oldest) { setLoadingOlder(false); return; }
      const c = messagesContainerRef.current;
      const prevScrollHeight = c?.scrollHeight ?? 0;
      const prevScrollTop = c?.scrollTop ?? 0;
      const batch = await getOlderChatMessages(selectedThread.id, oldest.timestamp, 50);
      if (batch.length === 0) {
        setHasMoreOlder(false);
        return;
      }
      if (batch.length < 50) setHasMoreOlder(false);
      // Dedupe in case the live tail overlaps with the older batch.
      setOlderMessages(prev => {
        const seen = new Set(prev.map(m => m.id));
        const merged = [...batch.filter(m => !seen.has(m.id)), ...prev]
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        return merged;
      });
      // Restore scroll position so the user doesn't visually jump.
      requestAnimationFrame(() => {
        if (!c) return;
        const newScrollHeight = c.scrollHeight;
        c.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
      });
    } catch (err) {
      // Logger already fired inside getOlderChatMessages.
    } finally {
      setLoadingOlder(false);
    }
  };

  // UI state for the floating "new messages" pill. When the user has
  // scrolled up and new messages arrive, we count them and surface a
  // jump-to-bottom button. Resets when they hit bottom or switch
  // threads.
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [unreadWhileScrolledUp, setUnreadWhileScrolledUp] = useState(0);
  const prevMessageCountRef = useRef(0);
  useEffect(() => {
    if (!selectedThread) {
      setIsScrolledUp(false);
      setUnreadWhileScrolledUp(0);
      prevMessageCountRef.current = 0;
      return;
    }
    const newCount = messages.length;
    const prevCount = prevMessageCountRef.current;
    if (newCount > prevCount && isScrolledUp) {
      setUnreadWhileScrolledUp(c => c + (newCount - prevCount));
    }
    prevMessageCountRef.current = newCount;
  }, [messages, selectedThread, isScrolledUp]);

  const createThread = async () => {
    if (!newThread.title.trim() || !userData) return;

    try {
      const scope = newThread.scope || 'team';
      const isClubScope = scope !== 'team';
      if (scope === 'team' && (!selectedTeamId || !canCreateTeamThread)) {
        alert('Only team staff can create team channels.');
        return;
      }
      if (isClubScope && !isUserClubAdmin) {
        alert('Only club admins can create club-wide channels.');
        return;
      }
      // Club-scope threads MUST carry a clubId. Resolution order:
      //   1. selectedTeam.clubId  (canonical when stamped)
      //   2. userData.clubId      (the admin's home club)
      //   3. useClubId() fallback (any club doc in the project)
      // Without a clubId there's no tenant scope and the thread
      // leaks. Patrick 2026-06-25: 'I just tried making a new coach
      // chat on my club, and sure enough, it showed up on the other
      // account that has nothing to do with my actual team/club.'
      const selectedClubId =
        (selectedTeam as any)?.clubId
        || (userData as any)?.clubId
        || fallbackClubId
        || '';
      if (isClubScope && !selectedClubId) {
        alert("Couldn't resolve which club this thread belongs to. Open Club Branding → Save to stamp a clubId, then try again.");
        return;
      }
      const threadData: any = {
        title: newThread.title,
        description: newThread.description,
        teamId: isClubScope ? '' : selectedTeamId,
        clubId: selectedClubId || '',
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

      setNewThread({ title: '', description: '', isPrivate: false, scope: 'team', tags: [] });
      setIsCreatingThread(false);
    } catch (error) {
      console.error('Error creating thread:', error);
    }
  };

  const sendMessage = async (contentArg?: string, attachmentsArg?: ComposerAttachment[], opts?: { requireAck?: boolean; pinOnSend?: boolean }) => {
    const content = (contentArg !== undefined ? contentArg : newMessage).trim();
    const attachments = attachmentsArg || [];
    if ((!content && attachments.length === 0) || !selectedThread || !userData) return;

    // Text + photo split — Patrick 2026-06-22: 'will you make it so
    // the pic sends after the text? separate is probably better and
    // it is what ios does.' When the user composes BOTH text and
    // attachments, fire two messages: text first, then photo a beat
    // later. Each bubble gets its own tap target + real estate (the
    // photo's lightbox tap no longer fights the text bubble's
    // gesture handlers).
    //
    // opts (requireAck, pinOnSend) apply to the TEXT message only —
    // it carries the announcement intent; the photo is the supporting
    // visual. 50ms delay between writes guarantees the photo's
    // timestamp is strictly later so it sorts below the text.
    if (content && attachments.length > 0) {
      await sendMessage(content, [], opts);
      await new Promise(r => setTimeout(r, 50));
      await sendMessage('', attachments);
      return;
    }

    const sendTimestamp = new Date();
    // Client-generated UUID — idempotent retries. If the queue retries
    // a send that secretly already succeeded, we just overwrite the
    // same doc with the same data; no duplicate.
    const stableMsgId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? (crypto as any).randomUUID()
      : `cm_${sendTimestamp.getTime()}_${Math.random().toString(36).slice(2, 10)}`;
    const tempId = stableMsgId; // optimistic + final id share the same value
    const threadIdAtSend = selectedThread.id;

    // OPTIMISTIC RENDER — push the pending message straight into the
    // visible list before we round-trip to Firestore. The subscription
    // will deliver the real doc shortly; the pending row is then
    // stripped (matched by senderId + content + timestamp window).
    const pendingMessage = {
      id: tempId,
      threadId: threadIdAtSend,
      content,
      senderId: userData.uid,
      senderName: userData.name,
      senderPhotoUrl: (userData as any).photoURL || undefined,
      senderRole: resolveSenderRole(userData),
      senderRelationship: (userData as any).relationship || undefined,
      timestamp: sendTimestamp,
      teamId: selectedTeamId || '',
      replyTo: replyingTo?.id || undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
      __pending: true as const,
    };
    setPendingMessages(prev => [...prev, pendingMessage as any]);

    // The user JUST sent a message — they're at the bottom by intent,
    // regardless of what handleScroll thinks during the composer-
    // collapse layout shift. Without this force, the useLayoutEffect's
    // scrollToBottom call gated on isAtBottomRef would skip when the
    // textarea-height reset transiently flipped the flag to false,
    // leaving the user mid-thread. Patrick has reported this bug
    // multiple times: "i sent a long message and it took me to the
    // very top of the thread" / "sending bug is still alive".
    isAtBottomRef.current = true;
    // Extended to 1500ms to cover the Firestore tail arrival window
    // (real message replaces pending in ~200-500ms; the
    // re-reconciliation can fire a scroll event that would otherwise
    // flip isAtBottomRef via handleScroll). 1.5s is well past that.
    initialLoadUntilRef.current = Date.now() + 1500;
    // Multi-frame scroll pin: every animation frame for ~600ms after
    // send, force the messages container to its bottom. Catches the
    // optimistic message landing in the DOM, the composer-collapse
    // height change, AND the Firestore tail arrival's DOM
    // reconciliation. Each frame is a no-op when already pinned.
    const deadline = Date.now() + 600;
    const pinAfterSend = () => {
      scrollToBottom(false);
      if (Date.now() < deadline) requestAnimationFrame(pinAfterSend);
    };
    requestAnimationFrame(pinAfterSend);

    // Clear composer immediately so the user feels the send "land".
    setNewMessage('');
    if (selectedThread?.id) {
      setDraftsByThread(prev => {
        if (!prev[selectedThread.id]) return prev;
        const { [selectedThread.id]: _omit, ...rest } = prev;
        return rest;
      });
    }
    setReplyingTo(null);
    messageInputRef.current?.focus();

    // Extract structured mentions from the content so the inbox can
    // surface them via array-contains queries. The composer inserts
    // plain @Name text — no inline markers — so we resolve here at
    // send time against the current team roster.
    let mentions: string[] = [];
    let mentionsEveryone = false;
    if (content) {
      const { extractMentions } = await import('../utils/extractMentions');
      const result = extractMentions(content, teamMembers.map(m => ({ uid: m.uid, name: m.name })));
      mentions = result.uids.filter(uid => uid !== userData.uid); // don't @-yourself
      mentionsEveryone = result.everyone;
    }

    const messageData: any = {
      id: stableMsgId, // pinned for idempotent writes
      threadId: threadIdAtSend,
      content,
      senderId: userData.uid,
      senderName: userData.name,
      senderPhotoUrl: (userData as any).photoURL || undefined,
      senderRole: resolveSenderRole(userData),
      senderRelationship: (userData as any).relationship || undefined,
      timestamp: sendTimestamp,
      teamId: selectedTeamId,
    };
    if (replyingTo?.id) messageData.replyTo = replyingTo.id;
    if (attachments.length > 0) messageData.attachments = attachments;
    if (mentions.length > 0) messageData.mentions = mentions;
    if (mentionsEveryone) messageData.mentionsEveryone = true;
    if (opts?.requireAck) {
      messageData.requireAck = true;
      messageData.acknowledgedBy = [userData.uid];
    }

    try {
      // Queue the actual write. The queue auto-retries on transient
      // failures with exponential backoff and reattempts everything
      // when the browser fires 'online'. Idempotent writes (client id)
      // make retries safe even if the underlying network actually did
      // deliver a previous attempt.
      const { chatSendQueue } = await import('../utils/chatSendQueue');
      await new Promise<void>((resolve, reject) => {
        chatSendQueue.enqueue({
          id: stableMsgId,
          threadId: threadIdAtSend,
          attempt: 0,
          do: async () => {
            await addChatMessage(messageData);
          },
          onSuccess: () => resolve(),
          onFinalFailure: (err) => reject(err),
        });
      });
      const newMessageId = stableMsgId;

      const lastSnippet = content || (attachments.length > 0 ? `📷 ${attachments.length} image${attachments.length > 1 ? 's' : ''}` : '');
      // "Post to wall" — pin the new message at send-time. Same data
      // mechanism as the per-message Pin action, but folded into the
      // send so coaches don't have to send-then-tap-pin. Pinned
      // messages also feed the dashboard announcements widget.
      const nextPinned: string[] | undefined = opts?.pinOnSend && newMessageId
        ? [newMessageId, ...((selectedThread as any).pinnedMessageIds || [])].slice(0, 10)
        : undefined;
      await updateChatThread(selectedThread.id, {
        lastActivity: new Date(),
        messageCount: selectedThread.messageCount + 1,
        participants: Array.from(new Set([...selectedThread.participants, userData.uid])),
        lastMessage: {
          content: lastSnippet,
          senderName: userData.name,
          senderId: userData.uid,
          timestamp: new Date()
        },
        ...(nextPinned ? { pinnedMessageIds: nextPinned } : {}),
      } as any);
      if (nextPinned) {
        setSelectedThread({ ...selectedThread, pinnedMessageIds: nextPinned } as any);
      }
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
        const mutedSet = new Set<string>(((selectedThread as any).mutedByUids || []) as string[]);
        const recipients = effectiveParticipants(selectedThread)
          .filter(uid => uid && uid !== userData.uid && !mutedSet.has(uid));
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
          // Deep-link to the EXACT message so a tap on the notification
          // banner doesn't dump the recipient at the top of a long thread.
          const deepLink = newMessageId
            ? `${getShareOrigin()}/chat?thread=${selectedThread.id}&message=${newMessageId}`
            : `${getShareOrigin()}/chat?thread=${selectedThread.id}`;
          void sendPushToUsers(recipients, {
            title: pushTitle,
            body: pushBody,
            url: deepLink,
            // Bump the recipient's app-icon badge. Absolute-count
            // semantics on iOS mean any push we send with badge>0
            // shows the little red dot; the app clears it back to 0
            // on foreground / when the user opens /chat. Using 1
            // instead of a real per-user count avoids a lookup fan-
            // out on hot-path chat sends.
            badge: 1,
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
      
      // Optimistic row already cleared the composer; this is the
      // success path. The subscription dedupes the pending row when
      // the real doc lands, so nothing else to do here.
    } catch (error) {
      console.error('Error sending message:', error);
      // Mark the pending row as failed so the user can see it didn't
      // land and decide whether to retry.
      setPendingMessages(prev => prev.map(p => p.id === tempId ? { ...p, __failed: true } : p));
    }
  };

  const deleteMessage = async (message: ChatMessage) => {
    if (!userData || message.senderId !== userData.uid) return;
    // Recall: within 60s of sending, skip the confirm dialog — treat
    // as a fat-finger undo. After that, fall back to the explicit
    // confirm so people don't accidentally vaporize old context.
    const ageMs = Date.now() - new Date(message.timestamp).getTime();
    const isRecall = ageMs < 60_000;
    if (!isRecall && !window.confirm('Delete this message? This cannot be undone.')) return;
    void import('../utils/nativeShell').then(m => m.tapHaptic(isRecall ? 'light' : 'medium'));
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
      // Current roster ONLY. We used to union with thread.participants,
      // but that array grows on every send and never prunes — so a
      // parent whose kid left the team a season ago was still counted
      // in "X participants." Worse, their stale UIDs showed up as
      // "Member" placeholders in the Seen-by sheet. Just trust the
      // active team roster.
      return teamMembers.map(m => m.uid).filter(Boolean);
    }
    return thread.participants || [];
  };

  // Visible messages = real timeline + any pending optimistic rows
  // for this thread, with the optional in-thread search filter on top.
  // Pendings always sort to the end because their timestamp is "now"
  // and the list is ascending.
  const visibleMessages: Array<ChatMessage & { __pending?: boolean; __failed?: boolean }> = (() => {
    const threadPending = selectedThread
      ? pendingMessages.filter(p => p.threadId === selectedThread.id)
      : [];
    // Dedupe in case the live tail overlaps with the older batches.
    const tailById = new Map(messages.map(m => [m.id, m]));
    const olderDeduped = olderMessages.filter(m => !tailById.has(m.id));
    const combined = [...olderDeduped, ...messages, ...threadPending].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );
    const q = threadSearchQuery.trim().toLowerCase();
    if (!q) return combined;
    return combined.filter(m => (m.content || '').toLowerCase().includes(q));
  })();

  // Live "X is typing…" computed from selectedThread.typingBy. Drops
  // entries older than 5s (auto-expires without an explicit "stopped
  // typing" write, which keeps the write volume halved).
  // Live "X is typing…" with avatar — each entry carries the uid so
  // we can resolve a fresh photoURL via getSenderPhotoUrl rather than
  // freezing whatever the sender pre-typed into their last message.
  const typingMembers: Array<{ uid: string; name: string; photoURL?: string }> = (() => {
    const map: Record<string, { ts: number; name: string }> = (selectedThread as any)?.typingBy || {};
    const cutoff = Date.now() - 5000;
    return Object.entries(map)
      .filter(([uid, v]) => uid !== userData?.uid && v && typeof v.ts === 'number' && v.ts > cutoff)
      .map(([uid, v]) => ({ uid, name: v.name || 'Someone', photoURL: getSenderPhotoUrl(uid) }));
  })();
  const typingNames: string[] = typingMembers.map(m => m.name);

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
    //   - Team threads: team staff can delete.
    //   - Club / Coaches / Admins channels: only club admins can delete
    //     (they're cross-team artifacts, regular coaches shouldn't nuke
    //     other teams' chat history).
    const canDelete =
      (isDM && thread.participants.includes(userData.uid)) ||
      (scope === 'team' && isTeamStaff) ||
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
      // Remove from local state immediately. Because the threads
      // subscriptions now MERGE snapshots instead of REPLACING (so a
      // missing-doc snapshot doesn't blank DMs), they would otherwise
      // keep a deleted thread visible until the user closes the app.
      // Explicit user-initiated deletes are the one case where a
      // missing doc IS authoritative.
      setTeamThreads((prev) => prev.filter((t) => t.id !== thread.id));
      setClubThreads((prev) => prev.filter((t) => t.id !== thread.id));
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
      senderRole: resolveSenderRole(userData),
      senderRelationship: (userData as any).relationship || undefined,
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
          senderId: userData.uid,
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
  // pinned thread IDs on their user doc. AuthContext now live-
  // subscribes to the user doc, so the write triggers a snapshot
  // which re-renders this component with the new pinned list. No
  // local override needed.
  const myPinnedThreadIds: string[] = Array.isArray((userData as any)?.pinnedThreadIds)
    ? (userData as any).pinnedThreadIds
    : [];
  const isThreadPinned = (thread: ChatThread): boolean =>
    myPinnedThreadIds.includes(thread.id);
  const togglePinThread = async (thread: ChatThread) => {
    if (!userData?.uid) return;
    void import('../utils/nativeShell').then(m => m.tapHaptic('medium'));
    const next = myPinnedThreadIds.includes(thread.id)
      ? myPinnedThreadIds.filter(id => id !== thread.id)
      : [...myPinnedThreadIds, thread.id];
    try {
      await updateDoc(doc(db, 'users', userData.uid), { pinnedThreadIds: next });
    } catch (err) {
      console.error('Error toggling pin:', err);
    }
  };

  // Per-thread mute. Tracked on the user doc (mutedThreadIds) so each
  // user owns their own preference. Also denormalized onto the thread
  // doc (mutedByUids) so the sender can filter push recipients in O(1)
  // without reading every recipient's user doc on every send.
  const myMutedThreadIds: string[] = Array.isArray((userData as any)?.mutedThreadIds)
    ? (userData as any).mutedThreadIds
    : [];
  const isThreadMuted = (thread: ChatThread): boolean =>
    myMutedThreadIds.includes(thread.id);
  const toggleMuteThread = async (thread: ChatThread) => {
    if (!userData?.uid) return;
    void import('../utils/nativeShell').then(m => m.tapHaptic('light'));
    const muting = !myMutedThreadIds.includes(thread.id);
    const nextUserMuted = muting
      ? [...myMutedThreadIds, thread.id]
      : myMutedThreadIds.filter(id => id !== thread.id);
    const threadMutedByUids: string[] = Array.isArray((thread as any).mutedByUids)
      ? (thread as any).mutedByUids
      : [];
    const nextThreadMuted = muting
      ? Array.from(new Set([...threadMutedByUids, userData.uid]))
      : threadMutedByUids.filter(uid => uid !== userData.uid);
    try {
      await Promise.all([
        updateDoc(doc(db, 'users', userData.uid), { mutedThreadIds: nextUserMuted }),
        updateDoc(doc(db, 'chat_threads', thread.id), { mutedByUids: nextThreadMuted }),
      ]);
    } catch (err) {
      const { logFirestoreError } = await import('../utils/firestoreLogger');
      logFirestoreError('write', `chat_threads/${thread.id}`, err, { op: 'toggleMuteThread' });
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
    // Patrick: team chats on top. Pinned still beats everything;
    // after that, team channels surface above DMs/groups so the
    // primary team conversation isn't buried by chatty 1:1s.
    const order: SectionId[] = ['pinned', 'teams', 'club', 'groups', 'dms'];
    return order
      .filter(id => buckets[id].length > 0)
      .map(id => ({ id, label: SECTION_LABELS[id], threads: buckets[id] }));
  })();

  // Display title for a thread.
  // - DMs: the OTHER person's CURRENT name (live from users, not the
  //   frozen dmParticipantNames snapshot which can drift if profiles
  //   update — e.g. Google/Apple sign-in syncs a new displayName).
  // - Group chats: live-compose from current participant names so the
  //   title never disagrees with the Seen-by sheet, which also reads
  //   live names.
  // - Team / club channels: the typed thread title.
  const getThreadDisplayTitle = (thread: ChatThread): string => {
    const isDM = (thread as any).isDM === true;
    const isGroup = (thread as any).isGroup === true;
    const resolveName = (uid: string): string | undefined => {
      if (uid === userData?.uid) return userData?.name;
      const m = teamMembers.find(tm => tm.uid === uid);
      if (m?.name) return m.name;
      return crossUserCache[uid]?.name;
    };
    if (isDM) {
      const otherUid = thread.participants.find(uid => uid !== userData?.uid);
      if (otherUid) {
        const live = resolveName(otherUid);
        if (live) return live;
        const map = (thread as any).dmParticipantNames as Record<string, string> | undefined;
        if (map && map[otherUid]) return map[otherUid];
      }
      return thread.title.replace(/^DM:\s*/, '');
    }
    if (isGroup) {
      // Compose from CURRENT participant names (excluding self), first
      // names only to mirror the create-time format.
      const firstNames = thread.participants
        .filter(uid => uid !== userData?.uid)
        .map(uid => (resolveName(uid) || '').split(' ')[0])
        .filter(Boolean);
      if (firstNames.length === 0) return thread.title;
      const meFirst = (userData?.name || '').split(' ')[0] || 'You';
      const all = [meFirst, ...firstNames];
      return all.length <= 3 ? all.join(', ') : `${all.slice(0, 2).join(', ')} +${all.length - 2}`;
    }
    return thread.title;
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
  // to this teamMembers-backed lookup, then to crossUserCache for users
  // who aren't on the active team.
  // Function declaration (not `const arrow = …`) so JS hoists it —
  // the typingMembers IIFE at line ~1666 calls it during render,
  // hundreds of lines before this point. As a `const` it was in the
  // temporal dead zone the moment a chat thread had another user
  // actively typing, throwing "Cannot access 'jn' before init" and
  // triggering the chat-surface silent-eb reconnect fallback. See
  // 3.9.120 fix (2026-07-08).
  function getSenderPhotoUrl(senderId: string): string | undefined {
    if (!senderId) return undefined;
    if (userData?.uid === senderId) return (userData as any)?.photoURL || undefined;
    const m = teamMembers.find(tm => tm.uid === senderId);
    if (m?.photoURL) return m.photoURL;
    return crossUserCache[senderId]?.photoURL;
  }

  // Used by the Read-by sheet to render names for each uid in readBy.
  // Consults active-team roster first, then the cross-team cache so a
  // coach viewing chat A while signed into team B still sees real names.
  const getUserName = (uid: string): string | undefined => {
    if (!uid) return undefined;
    if (userData?.uid === uid) return userData?.name || 'You';
    const m = teamMembers.find(tm => tm.uid === uid);
    if (m?.name) return m.name;
    return crossUserCache[uid]?.name;
  };

  // Pulled by MessageBubble when its Seen-by sheet sees UIDs the active
  // roster can't name. Fetches users/{uid} once per uid and caches the
  // result, which flows back through getUserName / getSenderPhotoUrl.
  const resolveUnknownUids = React.useCallback((uids: string[]) => {
    const pending = crossUserPendingRef.current;
    const todo = uids.filter(u => u && !crossUserCache[u] && !pending.has(u));
    if (todo.length === 0) return;
    todo.forEach(u => pending.add(u));
    (async () => {
      try {
        const { doc: fsDoc, getDoc } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const fetched: Record<string, { name: string; photoURL?: string }> = {};
        for (const uid of todo) {
          try {
            const snap = await getDoc(fsDoc(db, 'users', uid));
            if (snap.exists()) {
              const u: any = snap.data();
              fetched[uid] = { name: u.name || 'Member', photoURL: u.photoURL || u.profilePhotoUrl };
            } else {
              fetched[uid] = { name: 'Member' };
            }
          } catch {
            fetched[uid] = { name: 'Member' };
          } finally {
            pending.delete(uid);
          }
        }
        setCrossUserCache(prev => ({ ...prev, ...fetched }));
      } catch (err) {
        todo.forEach(u => pending.delete(u));
        console.warn('resolveUnknownUids failed', err);
      }
    })();
  }, [crossUserCache]);

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

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-line-default/[0.04]">
        <DataGate when="loading" />
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
        className="bg-surface-elevated rounded-2xl shadow-2xl w-full max-w-md max-h-full flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-line-default/10 flex items-center justify-between bg-gradient-to-r from-surface-elevated to-surface-input">
          <div>
            <h3 className="text-lg font-bold text-ink-primary">
              {selectedDmUids.size <= 1 ? 'New chat' : `New group · ${selectedDmUids.size + 1} people`}
            </h3>
            <p className="text-xs text-ink-primary/50">
              {selectedDmUids.size === 0
                ? 'Pick one person for a DM, or several for a group chat.'
                : selectedDmUids.size === 1
                  ? 'Pick another person to make this a group.'
                  : 'Tap Start to create the group chat.'}
            </p>
          </div>
          <button
            onClick={() => { setIsDMPickerOpen(false); setDmSearch(''); setSelectedDmUids(new Set()); }}
            className="p-2 rounded-lg hover:bg-line-default/[0.08] text-ink-primary/50"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-4 border-b border-line-default/5">
          <input
            type="text"
            value={dmSearch}
            onChange={e => setDmSearch(e.target.value)}
            placeholder="Search by name or player..."
            className="w-full border border-line-default/15 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-violet-500 text-base"
            style={{ fontSize: '16px' }}
            autoFocus
          />
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {dmCandidates.length === 0 ? (
            <div className="p-6 text-center text-sm text-ink-primary/50">
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
                    checked ? 'bg-violet-500/20 ring-1 ring-violet-300' : 'hover:bg-violet-500/15'
                  }`}
                >
                  <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center text-white text-base font-bold ${m.role === 'coach' ? 'bg-surface-tint' : 'bg-emerald-600'}`}>
                    {m.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-ink-primary truncate">{m.name}</p>
                    {m.childNames && m.childNames.length > 0 ? (
                      <p className="text-xs text-ink-primary/50 truncate">{m.childNames.join(', ')}</p>
                    ) : (
                      <p className="text-xs text-ink-primary/50 capitalize">{m.role || 'member'}</p>
                    )}
                  </div>
                  {/* Checkbox-style indicator on the right. */}
                  <span
                    className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                      checked
                        ? 'bg-violet-600 border-violet-600 text-white'
                        : 'border-line-default/15 bg-surface-elevated'
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
        <div className="px-4 py-3 border-t border-line-default/5 bg-surface-elevated">
          <button
            type="button"
            onClick={startSelectedChat}
            disabled={selectedDmUids.size === 0 || dmStarting !== null}
            className="w-full bg-gradient-to-br from-brand-primary to-brand-primary hover:from-brand-primary-soft hover:to-brand-primary text-white text-xs font-extrabold tracking-widest uppercase py-3 px-4 rounded-xl shadow-md transition disabled:opacity-40 flex items-center justify-center"
          >
            {dmStarting !== null ? (
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-line-default/40 border-t-white" />
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
        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-line-default/15 hover:bg-line-default/25 text-white flex items-center justify-center"
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
      {/* Bottom-edge white sentinel. Sits BEHIND the chat container at
          the bottom of the viewport so anything visible past the chat
          container's bottom edge — including iOS Safari's pre-keyboard-
          resize transitional frames — paints white. Patrick's hunch:
          the dark "stale background" he sees through the iOS keyboard's
          rounded top corners is one of those transitional layers, not
          the steady-state DOM. This pins it to white regardless. */}
      <div
        aria-hidden
        className="fixed inset-x-0 bottom-0 bg-surface-elevated pointer-events-none"
        style={{ height: '40vh', zIndex: 1 }}
      />
      {/* Fixed-position layout pinned between top header + bottom tab bar.
          Capacitor Keyboard.resize: 'native' resizes the WebView when the
          keyboard appears (window.innerHeight drops), BUT a WKWebView
          quirk keeps `position: fixed; bottom: 0` anchored to the original
          viewport bottom — so the composer ends up hidden behind the
          keyboard despite ih being smaller. Workaround: set the container
          height explicitly from winHeight (which DOES reflect the
          keyboard) and skip `bottom`. */}
      <div
        // bg-surface-elevated (not gray-50). Both child views already paint their
        // own bg-white, so the container color is only visible behind
        // the iOS keyboard's slightly-rounded top corners. Gray bled
        // through there as two little gray quarter-circles next to the
        // composer; white makes the seam disappear.
        className="fixed inset-x-0 flex flex-col bg-surface-elevated z-10 overflow-hidden"
        style={{
          // Chrome height = env(safe-area-inset-top) + h-14 since the
          // AppDelegate native strip was removed (v3.2.42) and the
          // React header now owns the safe-area zone via the
          // safe-top class. The chat container was top:'3.5rem' which
          // tucked its first ~59px (Dynamic Island safe-area) behind
          // the chrome — that's why Patrick reported 'no way to get
          // back to chats': the back button at the top of the chat
          // view was literally hidden under the GoalKickr header.
          top: 'calc(var(--gk-safe-top) + 3.5rem)',
          // Explicit height from window.innerHeight (in CSS pixels).
          // For threads view, also subtract the bottom tab bar height.
          // Subtract the safe-area too so the bottom edge still lands
          // above the home indicator instead of running off-screen.
          // Uses --gk-safe-top so Android (where MainActivity already
          // applied the inset) doesn't double-count it and leak a
          // white strip between the top chrome and chat container.
          height:
            currentView === 'chat' && selectedThread
              ? `calc(${winHeight}px - var(--gk-safe-top) - 3.5rem)`
              : `calc(${winHeight}px - var(--gk-safe-top) - 3.5rem - 3rem)`,
        }}
      >
        {currentView === 'threads' ? (
          // THREADS LIST VIEW
          <div className="flex-1 min-h-0 flex flex-col bg-surface-elevated">
            {/* Header — dark navy chrome to match the app's chrome-
                vs-content lane (Wall pills, action sheets, etc.).
                The threads list below stays light; only this top
                strip is dark, framing the search + filter controls. */}
            <div className="p-4 border-b border-line-default/10 bg-gradient-to-b from-surface-base to-surface-elevated">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-ink-primary">Messages</h2>
                <div className="flex items-center gap-2">
                  {/* New DM button. Was bg-violet-600 — Patrick: "can
                      we change the purple chat icon?" Purple read as
                      off-brand against the crimson/charcoal palette.
                      Demoted to a quiet charcoal pill with a bone
                      icon and a hover ring, so the red + ('New
                      channel', admin-only) keeps its visual primacy
                      while the DM action stays available. */}
                  <button
                    onClick={() => { setIsDMPickerOpen(true); setSelectedDmUids(new Set()); }}
                    className="bg-surface-input ring-1 ring-line-default/10 hover:bg-surface-raised hover:ring-brand-primary-soft/40 text-ink-primary p-2.5 rounded-lg transition-colors"
                    title="Direct message"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                  </button>
                  {canCreateAnyThread && (
                    <button
                      onClick={openCreateThread}
                      className="bg-brand-primary hover:bg-brand-primary text-white p-2.5 rounded-lg transition-colors"
                      title="New channel"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              {/* Search */}
              <div className="relative mb-3 flex gap-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    placeholder="Search threads..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 bg-surface-input ring-1 ring-line-default/15 text-ink-primary placeholder:text-ink-primary/45 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary-soft text-base"
                    style={{ fontSize: '16px' }}
                  />
                  <svg className="w-5 h-5 text-ink-primary/45 absolute left-3 top-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>
                <button
                  type="button"
                  onClick={() => setGlobalSearchOpen(true)}
                  title="Search every chat for a word or phrase"
                  aria-label="Search every chat"
                  className="px-3 rounded-lg bg-brand-primary/20 ring-1 ring-brand-primary-soft/40 text-ink-primary text-[11px] font-extrabold uppercase tracking-widest hover:bg-brand-primary/30"
                >
                  Search all
                </button>
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
                    ...(isTeamStaff ? [{ key: 'private', label: 'Coach' }] : []),
                  ];
                })().map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setFilterTag(key)}
                    className={`px-3 py-2 text-sm rounded-full transition-colors whitespace-nowrap ${
                      filterTag === key
                        ? 'bg-brand-primary text-white font-semibold'
                        : 'bg-line-default/10 text-ink-primary/70 hover:bg-line-default/15 hover:text-ink-primary'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Threads List — iMessage / Messages-style rows. Bottom
                padding clears the fixed app tab bar so the last section
                (often Club Channels) isn't trapped under it.

                ATOMIC RENDER: list content is wrapped in an opacity
                transition keyed to `threadsReady`. Before both Firestore
                subscriptions have fired, the area sits empty + silent
                (no skeleton). When ready, the whole list fades in as a
                single unit — no per-thread cascade. If readiness takes
                longer than 400ms, a thin crimson progress bar appears
                at the top of the area as a quiet load hint. */}
            <div
              className="flex-1 min-h-0 overflow-y-auto relative"
              style={{ overscrollBehavior: 'contain', paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))' }}
            >
              {showProgress && !threadsReady && (
                <div className="sticky top-0 z-20 h-0.5 bg-brand-primary/15 overflow-hidden" aria-hidden>
                  <div className="absolute inset-y-0 w-1/3 bg-brand-primary animate-progress-slide" />
                </div>
              )}
              <div className={`transition-opacity duration-300 ease-out ${threadsReady ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
              {(() => {
                // Row renderer — shared between sectioned and flat layouts.
                const renderRow = (thread: ChatThread) => {
                  const isDM = (thread as any).isDM === true;
                  const isGroup = (thread as any).isGroup === true;
                  const displayTitle = getThreadDisplayTitle(thread);
                  const initial = (displayTitle || '?').charAt(0).toUpperCase();
                  // DM avatars: stable hash of the OTHER user's uid (or
                  // the thread id as a fallback) into a small palette.
                  // Same contact always gets the same color across cold
                  // starts, so muscle memory works ("Taylor's the green
                  // one"). Channels stay crimson + groups stay violet so
                  // a glance still tells you what kind of thread it is.
                  // Previously this used bg-line-default/[0.04]0 — a typo'd
                  // Tailwind class that produced zero CSS, leaving the
                  // initial floating with no circle.
                  const dmAvatarBg = (): string => {
                    const palette = [
                      'bg-amber-500', 'bg-emerald-600', 'bg-sky-600',
                      'bg-fuchsia-600', 'bg-orange-500', 'bg-teal-600',
                      'bg-rose-500', 'bg-indigo-600',
                    ];
                    const seed = (thread.participants || []).find(uid => uid !== userData?.uid) || thread.id || displayTitle;
                    let h = 0;
                    for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
                    return palette[Math.abs(h) % palette.length];
                  };
                  const avatarBg = isDM
                    ? dmAvatarBg()
                    : isGroup
                      ? 'bg-violet-600'
                      : 'bg-brand-primary';
                  const threadPhotoUrl = getThreadPhotoUrl(thread);
                  const preview = thread.lastMessage?.content || (thread.description || (isDM ? 'Tap to send a message' : 'No messages yet'));
                  const ago = formatTime(thread.lastActivity);
                  const unread = isThreadUnread(thread);
                  return (
                  <SwipeableThreadRow
                    key={thread.id}
                    isPinned={isThreadPinned(thread)}
                    onPinToggle={() => togglePinThread(thread)}
                    onDelete={() => deleteThread(thread)}
                  >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => showChatView(thread)}
                    onMouseEnter={() => { void import('../utils/chatPrewarm').then(({ prewarmThread }) => prewarmThread(thread.id)); }}
                    onTouchStart={() => { void import('../utils/chatPrewarm').then(({ prewarmThread }) => prewarmThread(thread.id)); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') showChatView(thread); }}
                    className="w-full text-left px-4 py-3 border-b border-line-default/5 hover:bg-line-default/[0.05] active:bg-line-default/[0.08] transition-colors flex items-start gap-3 cursor-pointer"
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
                          <span aria-hidden className="w-2 h-2 rounded-full bg-brand-primary flex-shrink-0" />
                        )}
                        <span className={`truncate text-[15px] ${unread ? 'font-extrabold text-ink-primary' : 'font-semibold text-ink-primary'}`}>{displayTitle}</span>
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
                          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface-base text-ink-primary/65 ring-1 ring-line-default/10 flex-shrink-0">
                            {teamNameById[thread.teamId]}
                          </span>
                        )}
                        {thread.isPrivate && (
                          <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded bg-rose-600 text-white flex-shrink-0">
                            Coach only
                          </span>
                        )}
                        {(thread as any).scope === 'club' && (
                          <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded bg-amber-500 text-charcoal-950 flex-shrink-0">
                            Club
                          </span>
                        )}
                        {(thread as any).scope === 'coaches' && (
                          <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded bg-brand-primary text-white flex-shrink-0">
                            Coaches
                          </span>
                        )}
                        {isThreadMuted(thread) && (
                          <svg className="w-3.5 h-3.5 text-ink-primary/40 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-label="Muted">
                            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                            <path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
                            <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
                            <path d="M18 8a6 6 0 0 0-9.33-5" />
                            <line x1="1" y1="1" x2="23" y2="23" />
                          </svg>
                        )}
                        {(thread as any).scope === 'admins' && (
                          <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded bg-sky-600 text-white flex-shrink-0">
                            Admins
                          </span>
                        )}
                        {isDM && (
                          <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded bg-surface-input text-ink-primary/80 ring-1 ring-line-default/15 flex-shrink-0">
                            DM
                          </span>
                        )}
                        <span className="ml-auto text-[11px] text-ink-primary/40 font-medium flex-shrink-0 pl-2">{ago}</span>
                      </div>
                      <div className="text-sm text-ink-primary/50 truncate">
                        {thread.lastMessage?.senderName && (
                          <span className="font-medium text-ink-primary/85">{thread.lastMessage.senderName}: </span>
                        )}
                        {preview}
                      </div>
                    </div>
                    {/* When pinned, show a small amber pin badge as
                        STATE — not a button. The only way to toggle
                        pin is swipe-right (per Patrick's request to
                        consolidate to a single pin affordance). */}
                    {isThreadPinned(thread) && (
                      <span
                        aria-label="Pinned"
                        title="Pinned — swipe right to unpin"
                        className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-amber-500"
                      >
                        <svg className="w-4 h-4" fill="currentColor" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                          <line x1="12" y1="17" x2="12" y2="22" />
                          <path d="M5 17h14l-1.5-3.5L17 5H7l-.5 8.5L5 17z" />
                        </svg>
                      </span>
                    )}
                  </div>
                  </SwipeableThreadRow>
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
                          className="w-full px-4 py-2 flex items-center justify-between bg-line-default/[0.04] border-b border-line-default/10 hover:bg-line-default/[0.08]"
                        >
                          <span className="flex items-center gap-2 text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/65">
                            {section.label}
                            <span className="text-ink-primary/40">{section.threads.length}</span>
                            {sectionUnread > 0 && (
                              <span className="px-1.5 py-0.5 rounded-full bg-brand-primary text-white text-[9px] font-extrabold">
                                {sectionUnread} new
                              </span>
                            )}
                          </span>
                          <svg
                            className={`w-3.5 h-3.5 text-ink-primary/40 transition-transform ${collapsed ? '-rotate-90' : ''}`}
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
                  <div className="w-16 h-16 mx-auto mb-3 rounded-full bg-line-default/[0.08] flex items-center justify-center">
                    <svg className="w-8 h-8 text-ink-primary/40" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                    </svg>
                  </div>
                  <p className="text-ink-primary/85 font-semibold mb-1">No conversations yet</p>
                  <p className="text-ink-primary/50 text-sm mb-4">Start a chat with a teammate or create a new team thread.</p>
                  <div className="flex justify-center gap-2">
                    <button
                      onClick={() => { setIsDMPickerOpen(true); setSelectedDmUids(new Set()); }}
                      className="px-4 py-2 text-sm font-semibold rounded-full bg-violet-600 text-white hover:bg-violet-700"
                    >
                      New DM
                    </button>
                    {canCreateAnyThread && (
                      <button
                        onClick={openCreateThread}
                        className="px-4 py-2 text-sm font-semibold rounded-full bg-brand-primary text-white hover:bg-brand-primary"
                      >
                          New thread
                      </button>
                    )}
                  </div>
                </div>
              )}
              </div>{/* /atomic-render fade-in wrapper */}
            </div>
          </div>
        ) : (
          // CHAT VIEW
          selectedThread && (
            <div className={`flex-1 min-h-0 flex flex-col bg-surface-elevated ${
              chatSlideDir === 'in' ? 'animate-slide-in-right' : ''
            }`}>
              {/* Chat Header with Back Button */}
              <div className="bg-surface-elevated border-b border-line-default/10 p-4">
                <div className="flex items-center space-x-3">
                  <button
                    onClick={showThreadsList}
                    className="flex items-center justify-center w-10 h-10 bg-line-default/[0.08] hover:bg-line-default/[0.1] rounded-full transition-colors flex-shrink-0"
                  >
                    <svg className="w-6 h-6 text-ink-primary/85" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2">
                      <h1 className="text-lg font-semibold text-ink-primary truncate">{getThreadDisplayTitle(selectedThread)}</h1>
                      {isThreadPinned(selectedThread) && (
                        <svg className="w-4 h-4 text-yellow-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                        </svg>
                      )}
                      {selectedThread.isPrivate && (
                        <span className="bg-red-100 text-red-800 text-xs px-2 py-1 rounded-full flex-shrink-0">Coach Only</span>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={() => toggleMuteThread(selectedThread)}
                    className={`flex items-center justify-center w-10 h-10 rounded-full transition-colors flex-shrink-0 ${
                      isThreadMuted(selectedThread) ? 'bg-amber-500/20 text-amber-300' : 'text-ink-primary/40 hover:text-ink-primary/85 hover:bg-line-default/[0.05]'
                    }`}
                    aria-label={isThreadMuted(selectedThread) ? 'Unmute notifications' : 'Mute notifications'}
                    title={isThreadMuted(selectedThread) ? 'Notifications muted — tap to unmute' : 'Mute notifications'}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      {isThreadMuted(selectedThread) ? (
                        <>
                          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                          <path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
                          <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
                          <path d="M18 8a6 6 0 0 0-9.33-5" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </>
                      ) : (
                        <>
                          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                        </>
                      )}
                    </svg>
                  </button>
                  <button
                    onClick={() => {
                      setThreadSearchOpen(o => !o);
                      if (threadSearchOpen) setThreadSearchQuery('');
                    }}
                    className={`flex items-center justify-center w-10 h-10 rounded-full transition-colors flex-shrink-0 ${
                      threadSearchOpen ? 'bg-brand-primary/20 text-brand-primary-soft' : 'text-ink-primary/40 hover:text-ink-primary/85 hover:bg-line-default/[0.05]'
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
                      (sc === 'team' && isTeamStaff) ||
                      (sc !== 'team' && isUserClubAdmin);
                    return can;
                  })() && (
                    <button
                      onClick={() => deleteThread(selectedThread)}
                      className="flex items-center justify-center w-10 h-10 text-ink-primary/40 hover:text-rose-300 hover:bg-rose-500/15 rounded-full transition-colors flex-shrink-0"
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
                    <svg className="absolute inset-y-0 left-0 pl-3 my-auto w-4 h-4 text-ink-primary/40" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input
                      autoFocus
                      value={threadSearchQuery}
                      onChange={(e) => setThreadSearchQuery(e.target.value)}
                      placeholder="Search this conversation…"
                      className="w-full pl-9 pr-3 py-2 text-sm border border-line-default/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/50"
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
                  <div className="bg-amber-500/15 border-b border-amber-400/30 px-3 py-2 flex items-center gap-2 overflow-x-auto scrollbar-hide">
                    <span className="inline-flex items-center gap-1 text-[10px] font-extrabold tracking-widest uppercase text-amber-200 flex-shrink-0">
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
                        className="text-xs bg-surface-elevated ring-1 ring-amber-400/30 rounded-full px-2.5 py-1 flex-shrink-0 max-w-[220px] truncate text-ink-primary/85 hover:bg-amber-500/20"
                      >
                        <span className="font-semibold text-ink-primary">{p.senderName.split(' ')[0]}:</span>{' '}
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
                className="flex-1 min-h-0 overflow-y-auto px-3 py-3 bg-surface-elevated"
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
                    to observe — its height changes as images load.
                    Keyed by thread id + fade-in so a thread switch
                    isn't a flash: the container unmounts/remounts
                    when the thread changes and animates in, syncing
                    with the chat-view slide-in-right. Same-thread
                    re-renders (new message arrival, reaction toggle,
                    scroll) don't change the key so the fade doesn't
                    fire on every update. */}
                <div key={selectedThread?.id || 'no-thread'} className="space-y-1 animate-fade-in">
                {threadSearchQuery.trim() && visibleMessages.length === 0 && (
                  <div className="text-center text-sm text-ink-primary/50 py-6">
                    No messages match "{threadSearchQuery.trim()}".
                  </div>
                )}
                {loadingOlder && (
                  <div className="flex justify-center py-2">
                    <div className="w-5 h-5 rounded-full border-2 border-line-default/10 border-t-cyan-500 animate-spin" />
                  </div>
                )}
                {/* Loading silence: render NOTHING while the first
                    subscription snapshot is in flight. After 400ms a
                    slim crimson hint appears at the top of the
                    column. Patrick caught the broken state on
                    Android (cold subscriptions ~1-2s) where the
                    empty-state used to fire and read as 'no
                    messages' before content even tried to load. */}
                {!threadSearchQuery.trim() && !messagesLoaded && messagesShowProgress && (
                  <div className="px-4 pt-2">
                    <div className="h-0.5 bg-brand-primary/15 overflow-hidden rounded-full">
                      <div className="h-full w-1/3 bg-brand-primary animate-progress-slide" />
                    </div>
                  </div>
                )}
                {/* Genuine empty state — only render once we KNOW
                    the subscription returned zero messages. */}
                {!threadSearchQuery.trim() && messagesLoaded && visibleMessages.length === 0 && (
                  <div className="text-center py-12 animate-fade-in">
                    <div className="mx-auto w-12 h-12 rounded-full bg-brand-primary/15 ring-1 ring-brand-primary-soft flex items-center justify-center text-brand-primary mb-3">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                    </div>
                    <p className="text-sm font-semibold text-ink-primary/85">
                      {(selectedThread as any)?.isDM ? `Say hi to ${getThreadDisplayTitle(selectedThread).split(' ')[0]}` : 'No messages yet'}
                    </p>
                    <p className="text-xs text-ink-primary/50 mt-1">Type a message below to start the conversation.</p>
                  </div>
                )}
                {threadSearchQuery.trim() && visibleMessages.length > 0 && (
                  <div className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/50 text-center mb-1">
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
                        <div className="flex-1 h-px bg-line-default/15" />
                        <span className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/50 px-2">
                          {formatDayDivider(msgDate)}
                        </span>
                        <div className="flex-1 h-px bg-line-default/15" />
                      </div>
                    )}
                    <div id={`msg-${message.id}`} className={`transition-shadow ${
                      idx === visibleMessages.length - 1 ? 'animate-bubble-in' : ''
                    } ${(message as any).__pending ? 'opacity-60' : ''} ${(message as any).__failed ? 'ring-2 ring-rose-300 rounded-2xl' : ''}`}>
                    <SilentErrorBoundary
                      label="message-bubble"
                      fallback={(
                        <div className="text-[11px] text-ink-primary/35 italic px-3 py-1.5">
                          (couldn&apos;t render this message)
                        </div>
                      )}
                    >
                    <MessageBubble
                      message={message}
                      currentUserId={userData?.uid || ''}
                      currentUserName={userData?.name || ''}
                      threadIsDm={(selectedThread as any)?.isDM === true}
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
                      onStartDm={(selectedThread as any)?.isDM ? undefined : (uid, name) => startDM({ uid, name })}
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
                      onPollVote={voteOnPoll}
                      onAcknowledge={acknowledgeMessage}
                      threadParticipantCount={effectiveParticipants(selectedThread).length}
                      formatTime={formatTime}
                      isFirstInGroup={isFirstInGroup}
                      isLastInGroup={isLastInGroup}
                      getSenderPhotoUrl={getSenderPhotoUrl}
                      getUserName={getUserName}
                      resolveUnknownUids={resolveUnknownUids}
                      canSeeVoters={isTeamStaff || isUserClubAdmin}
                      onMarkRead={markMessageRead}
                      onImageClick={openImage}
                      onImageLoaded={() => {
                        // Each image load can shift the layout. If the
                        // user is still at the bottom (or inside the
                        // initial-load window), pin them back to
                        // bottom IMMEDIATELY — no perceptible bounce
                        // because this fires in the same frame the
                        // image lands. iOS WebKit's scroll anchoring
                        // would otherwise land them mid-thread on the
                        // image, which is the bug.
                        const inInitialLoad = Date.now() < initialLoadUntilRef.current;
                        if (inInitialLoad || isAtBottomRef.current) {
                          scrollToBottom(false);
                        }
                      }}
                    />
                    </SilentErrorBoundary>
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
              {typingMembers.length > 0 && (
                <div className="px-4 pt-1.5 pb-0.5 flex items-center gap-2 text-[11px] text-ink-primary/50">
                  <div className="flex -space-x-1.5">
                    {typingMembers.slice(0, 3).map((m) => (
                      m.photoURL ? (
                        <img key={m.uid} src={m.photoURL} alt={m.name} className="w-5 h-5 rounded-full object-cover ring-2 ring-white" />
                      ) : (
                        <span key={m.uid} className="w-5 h-5 rounded-full bg-gradient-to-br from-slate-400 to-slate-600 ring-2 ring-white flex items-center justify-center text-[9px] font-bold text-white">
                          {(m.name || '?').charAt(0).toUpperCase()}
                        </span>
                      )
                    ))}
                  </div>
                  <span className="italic">
                    {typingMembers.length === 1
                      ? `${typingMembers[0].name} is typing`
                      : typingMembers.length === 2
                      ? `${typingMembers[0].name} and ${typingMembers[1].name} are typing`
                      : `${typingMembers.length} people are typing`}
                  </span>
                  <span className="inline-flex gap-0.5 items-center">
                    <span className="w-1 h-1 rounded-full bg-line-default/40 animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1 h-1 rounded-full bg-line-default/40 animate-bounce" style={{ animationDelay: '120ms' }} />
                    <span className="w-1 h-1 rounded-full bg-line-default/40 animate-bounce" style={{ animationDelay: '240ms' }} />
                  </span>
                </div>
              )}
              {isScrolledUp && (
                <div className="px-3 pb-2 flex justify-center pointer-events-none">
                  <button
                    type="button"
                    onClick={() => { scrollToBottom(true); setUnreadWhileScrolledUp(0); }}
                    className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-elevated text-ink-primary text-xs font-bold shadow-lg hover:bg-surface-input transition animate-fade-in"
                  >
                    {unreadWhileScrolledUp > 0 ? `${unreadWhileScrolledUp} new ` : ''}
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9" /></svg>
                  </button>
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
                canMarkImportant={isTeamStaff || isUserClubAdmin}
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
            <div className="bg-surface-elevated rounded-lg shadow-lg w-full max-w-md max-h-screen overflow-y-auto">
              <div className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-medium text-ink-primary">Create New Thread</h3>
                  <button
                    onClick={() => setIsCreatingThread(false)}
                    className="text-ink-primary/40 hover:text-ink-primary/65"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                
                <div className="space-y-1">
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">
                      Thread Title
                    </label>
                    <input
                      type="text"
                      value={newThread.title}
                      onChange={(e) => setNewThread(prev => ({ ...prev, title: e.target.value }))}
                      className="w-full border border-line-default/15 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-brand-primary text-base"
                      placeholder="Enter thread title..."
                      style={{ fontSize: '16px' }}
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">
                      Description (Optional)
                    </label>
                    <textarea
                      value={newThread.description}
                      onChange={(e) => setNewThread(prev => ({ ...prev, description: e.target.value }))}
                      rows={3}
                      className="w-full border border-line-default/15 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-brand-primary text-base"
                      placeholder="What's this thread about?"
                      style={{ fontSize: '16px' }}
                    />
                  </div>

                  {canCreateAnyThread && (
                    <div>
                      <label className="block text-sm font-medium text-ink-primary/85 mb-1">
                        Visible to
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          ...(canCreateTeamThread ? [{ k: 'team' as const, label: selectedTeam?.name || 'Current team', desc: 'Only this team' }] : []),
                          ...(isUserClubAdmin ? [
                            { k: 'club' as const, label: 'Whole club', desc: 'Every team, every member' },
                            { k: 'coaches' as const, label: 'Coaches only', desc: 'All coaches club-wide' },
                            { k: 'admins' as const, label: 'Admins only', desc: 'Club admins only' },
                          ] : []),
                        ].map((opt) => {
                          const active = newThread.scope === opt.k;
                          return (
                            <button
                              key={opt.k}
                              type="button"
                              onClick={() => setNewThread(prev => ({ ...prev, scope: opt.k }))}
                              className={`text-left p-2.5 rounded-xl ring-1 transition ${
                                active ? 'ring-brand-primary bg-brand-primary/[0.15]' : 'ring-line-default/10 bg-surface-elevated hover:bg-line-default/[0.05]'
                              }`}
                            >
                              <p className="font-semibold text-ink-primary text-sm">{opt.label}</p>
                              <p className="text-[11px] text-ink-primary/50">{opt.desc}</p>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {isTeamStaff && newThread.scope === 'team' && (
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        id="isPrivate"
                        checked={newThread.isPrivate}
                        onChange={(e) => setNewThread(prev => ({ ...prev, isPrivate: e.target.checked }))}
                        className="rounded border-line-default/15 text-brand-primary focus:ring-brand-primary w-4 h-4"
                      />
                      <label htmlFor="isPrivate" className="ml-2 text-sm text-ink-primary/85">
                        Coach-only thread
                      </label>
                    </div>
                  )}
                </div>

                <div className="flex space-x-3 mt-6">
                  <button
                    onClick={() => setIsCreatingThread(false)}
                    className="flex-1 px-4 py-2.5 text-ink-primary/85 border border-line-default/15 rounded-lg hover:bg-line-default/[0.05] transition-colors font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={createThread}
                    disabled={!newThread.title.trim()}
                    className="flex-1 px-4 py-2.5 bg-brand-primary text-white rounded-lg hover:bg-brand-primary disabled:bg-line-default/40 transition-colors font-medium"
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
      {/* Mobile path was missing the new chatLightbox component
          (Patrick 2026-06-22) — the activation chain fired and
          state updated but the lightbox JSX only existed in the
          desktop return path. Mobile users have never been able
          to open photos. Adding here so it portal-renders into
          body regardless of which return path the component
          takes. */}
      {chatLightbox && (
        <ChatImageLightbox
          images={chatLightbox.images}
          startIndex={chatLightbox.startIndex}
          onClose={() => setChatLightbox(null)}
        />
      )}
      </>
    );
  }

  // DESKTOP: Side-by-side layout. Sidebar (lg:ml-64) means the chat fills
  // the remaining width; height fills the viewport (no top/bottom nav on
  // desktop). dvh so URL-bar chrome doesn't shift the layout.
  return (
    <div className="flex bg-line-default/[0.04]" style={{ height: '100dvh' }}>
      {/* Desktop Sidebar */}
      <div className="w-80 bg-surface-elevated border-r border-line-default/10 flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-line-default/10">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-ink-primary">Messages</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setIsDMPickerOpen(true); setSelectedDmUids(new Set()); }}
                className="bg-surface-input ring-1 ring-line-default/10 hover:bg-surface-raised hover:ring-brand-primary-soft/40 text-ink-primary p-2 rounded-lg transition-colors"
                title="Direct message"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </button>
              {canCreateAnyThread && (
                <button
                  onClick={openCreateThread}
                  className="bg-brand-primary hover:bg-brand-primary text-white p-2 rounded-lg transition-colors"
                  title="New channel"
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
              className="w-full pl-10 pr-4 py-2 border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
            />
            <svg className="w-4 h-4 text-ink-primary/40 absolute left-3 top-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>

          <div className="flex space-x-2">
            {[
              { key: 'all', label: 'All' },
              { key: 'pinned', label: 'Pinned' },
              { key: 'direct', label: 'DMs' },
              ...(isTeamStaff ? [{ key: 'private', label: 'Coach' }] : []),
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setFilterTag(key)}
                className={`px-3 py-1 text-xs rounded-full transition-colors ${
                  filterTag === key
                    ? 'bg-brand-primary/15 text-brand-primary-soft font-medium'
                    : 'bg-line-default/[0.08] text-ink-primary/65 hover:bg-line-default/[0.1]'
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
              className={`p-4 border-b border-line-default/5 cursor-pointer hover:bg-line-default/[0.05] transition-colors ${
                selectedThread?.id === thread.id ? 'bg-brand-primary/15 border-l-4 border-l-blue-600' : ''
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2 mb-1">
                    <h3 className="font-medium text-ink-primary truncate">{getThreadDisplayTitle(thread)}</h3>
                    {isThreadPinned(thread) && (
                      <svg className="w-4 h-4 text-yellow-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                    )}
                    {thread.isPrivate && (
                      <svg className="w-4 h-4 text-rose-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                    )}
                  </div>
                  
                  {thread.description && (
                    <p className="text-sm text-ink-primary/65 truncate mb-2">{thread.description}</p>
                  )}
                  
                  {thread.lastMessage && (
                    <p className="text-xs text-ink-primary/50 truncate mb-2">
                      <span className="font-medium">{thread.lastMessage.senderName}:</span> {thread.lastMessage.content}
                    </p>
                  )}
                  
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-ink-primary/50">{thread.messageCount || 0} messages</span>
                    <span className="text-xs text-ink-primary/50">{formatTime(thread.lastActivity)}</span>
                  </div>
                </div>
                
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePinThread(thread);
                  }}
                  title={isThreadPinned(thread) ? 'Unpin chat' : 'Pin chat'}
                  className={`ml-2 p-1 rounded transition-colors ${
                    isThreadPinned(thread) ? 'text-yellow-500 hover:text-yellow-600' : 'text-ink-primary/40 hover:text-ink-primary/65'
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
            <div className="bg-surface-elevated border-b border-line-default/10 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center space-x-2">
                    <h1 className="text-xl font-semibold text-ink-primary">{getThreadDisplayTitle(selectedThread)}</h1>
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
                    <p className="text-sm text-ink-primary/65 mt-1">{selectedThread.description}</p>
                  )}
                </div>
                
                <div className="flex items-center space-x-3">
                  {(() => {
                    const sel: any = selectedThread;
                    const sc = sel.scope || 'team';
                    const isDM = sel.isDM === true;
                    const can =
                      (isDM && sel.participants.includes(userData?.uid || '')) ||
                      (sc === 'team' && isTeamStaff) ||
                      (sc !== 'team' && isUserClubAdmin);
                    return can;
                  })() && (
                    <button
                      onClick={() => deleteThread(selectedThread)}
                      className="flex items-center justify-center w-9 h-9 text-ink-primary/40 hover:text-rose-300 hover:bg-rose-500/15 rounded-full transition-colors"
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
                  <SilentErrorBoundary
                    label="message-bubble"
                    fallback={(
                      <div className="text-[11px] text-ink-primary/35 italic px-3 py-1.5">
                        (couldn&apos;t render this message)
                      </div>
                    )}
                  >
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
                      if (sc === 'team') return isTeamStaff;
                      return isUserClubAdmin;
                    })()}
                    onPollVote={voteOnPoll}
                    onAcknowledge={acknowledgeMessage}
                    threadParticipantCount={effectiveParticipants(selectedThread).length}
                    formatTime={formatTime}
                    isFirstInGroup={isFirstInGroup}
                    isLastInGroup={isLastInGroup}
                    getSenderPhotoUrl={getSenderPhotoUrl}
                      getUserName={getUserName}
                      resolveUnknownUids={resolveUnknownUids}
                      canSeeVoters={isTeamStaff || isUserClubAdmin}
                      onMarkRead={markMessageRead}
                      onImageClick={openImage}
                      onImageLoaded={() => {
                        // Each image load can shift the layout. If the
                        // user is still at the bottom (or inside the
                        // initial-load window), pin them back to
                        // bottom IMMEDIATELY — no perceptible bounce
                        // because this fires in the same frame the
                        // image lands. iOS WebKit's scroll anchoring
                        // would otherwise land them mid-thread on the
                        // image, which is the bug.
                        const inInitialLoad = Date.now() < initialLoadUntilRef.current;
                        if (inInitialLoad || isAtBottomRef.current) {
                          scrollToBottom(false);
                        }
                      }}
                  />
                  </SilentErrorBoundary>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Desktop Message Input */}
            {selectedThread && (
              <>
              {isScrolledUp && (
                <div className="px-3 pb-2 flex justify-center pointer-events-none">
                  <button
                    type="button"
                    onClick={() => { scrollToBottom(true); setUnreadWhileScrolledUp(0); }}
                    className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-elevated text-ink-primary text-xs font-bold shadow-lg hover:bg-surface-input transition animate-fade-in"
                  >
                    {unreadWhileScrolledUp > 0 ? `${unreadWhileScrolledUp} new ` : ''}
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9" /></svg>
                  </button>
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
                canMarkImportant={isTeamStaff || isUserClubAdmin}
                rows={3}
              />
              </>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <svg className="w-16 h-16 text-ink-primary/35 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <h3 className="text-lg font-medium text-ink-primary mb-2">Select a thread to start chatting</h3>
              <p className="text-ink-primary/50">Choose a thread from the sidebar or create a new one</p>
            </div>
          </div>
        )}
      </div>

      {/* Desktop Create Thread Modal */}
      {isCreatingThread && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-surface-elevated rounded-lg shadow-lg w-full max-w-md">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-ink-primary">Create New Thread</h3>
                <button
                  onClick={() => setIsCreatingThread(false)}
                  className="text-ink-primary/40 hover:text-ink-primary/65"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-ink-primary/85 mb-1">
                    Thread Title
                  </label>
                  <input
                    type="text"
                    value={newThread.title}
                    onChange={(e) => setNewThread(prev => ({ ...prev, title: e.target.value }))}
                    className="w-full border border-line-default/15 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-primary"
                    placeholder="Enter thread title..."
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-ink-primary/85 mb-1">
                    Description (Optional)
                  </label>
                  <textarea
                    value={newThread.description}
                    onChange={(e) => setNewThread(prev => ({ ...prev, description: e.target.value }))}
                    rows={3}
                    className="w-full border border-line-default/15 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-primary"
                    placeholder="What's this thread about?"
                  />
                </div>

                {canCreateAnyThread && (
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">Visible to</label>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        ...(canCreateTeamThread ? [{ k: 'team' as const, label: selectedTeam?.name || 'Current team', desc: 'Only this team' }] : []),
                        ...(isUserClubAdmin ? [
                          { k: 'club' as const, label: 'Whole club', desc: 'Every team, every member' },
                          { k: 'coaches' as const, label: 'Coaches only', desc: 'All coaches club-wide' },
                          { k: 'admins' as const, label: 'Admins only', desc: 'Club admins only' },
                        ] : []),
                      ].map((opt) => {
                        const active = newThread.scope === opt.k;
                        return (
                          <button
                            key={opt.k}
                            type="button"
                            onClick={() => setNewThread(prev => ({ ...prev, scope: opt.k }))}
                            className={`text-left p-2.5 rounded-xl ring-1 transition ${
                              active ? 'ring-brand-primary bg-brand-primary/[0.15]' : 'ring-line-default/10 bg-surface-elevated hover:bg-line-default/[0.05]'
                            }`}
                          >
                            <p className="font-semibold text-ink-primary text-sm">{opt.label}</p>
                            <p className="text-[11px] text-ink-primary/50">{opt.desc}</p>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {isTeamStaff && newThread.scope === 'team' && (
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      id="isPrivate"
                      checked={newThread.isPrivate}
                      onChange={(e) => setNewThread(prev => ({ ...prev, isPrivate: e.target.checked }))}
                      className="rounded border-line-default/15 text-brand-primary focus:ring-brand-primary"
                    />
                    <label htmlFor="isPrivate" className="ml-2 text-sm text-ink-primary/85">
                      Coach-only thread
                    </label>
                  </div>
                )}
              </div>

              <div className="flex justify-end space-x-3 mt-6">
                <button
                  onClick={() => setIsCreatingThread(false)}
                  className="px-4 py-2 text-ink-primary/85 border border-line-default/15 rounded-lg hover:bg-line-default/[0.05] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={createThread}
                  disabled={!newThread.title.trim()}
                  className="px-4 py-2 bg-brand-primary text-white rounded-lg hover:bg-brand-primary disabled:bg-line-default/40 transition-colors"
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
      {chatLightbox && (
        <ChatImageLightbox
          images={chatLightbox.images}
          startIndex={chatLightbox.startIndex}
          onClose={() => setChatLightbox(null)}
        />
      )}
      {globalSearchOpen && (
        <GlobalChatSearch
          threads={threads}
          getThreadTitle={getThreadDisplayTitle}
          onResult={(threadId, messageId) => {
            const target = threads.find(t => t.id === threadId);
            if (target) {
              setGlobalSearchOpen(false);
              showChatView(target);
              setPendingScrollMsgId(messageId);
            }
          }}
          onClose={() => setGlobalSearchOpen(false)}
        />
      )}
    </div>
  );
};

export default TeamChat;