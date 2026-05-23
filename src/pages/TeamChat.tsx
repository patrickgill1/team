import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { where } from 'firebase/firestore';
import { getShareOrigin } from '../utils/origin';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { ChatThread, ChatMessage } from '../types';
import MessageBubble from '../components/chat/MessageBubble';
import MessageComposer, { ComposerAttachment } from '../components/chat/MessageComposer';

const TeamChat: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
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
  const [selectedThread, setSelectedThread] = useState<ChatThread | null>(null);
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTag, setFilterTag] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [teamMembers, setTeamMembers] = useState<{ uid: string; name: string; role?: string; email?: string; childNames?: string[] }[]>([]);
  
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
    console.log('Showing chat view for thread:', thread.title);
    setSelectedThread(thread);
    setCurrentView('chat');
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

  // Subscribe to team-scoped threads for the active team.
  useEffect(() => {
    if (!selectedTeamId) return;
    setLoading(true);
    const unsubscribeThreads = subscribeToChatThreads(selectedTeamId, (threadsData) => {
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
  }, [selectedTeamId, subscribeToChatThreads]);

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
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
      });
  }, [teamThreads, clubThreads, isCoach, isUserClubAdmin]);

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

  // On thread open OR when the messages first load for a thread,
  // jump (NOT smooth-scroll) to the bottom in a useLayoutEffect so it
  // happens before the first paint. The user lands ON the most recent
  // messages, not in the middle of the thread.
  useLayoutEffect(() => {
    if (!selectedThread || messages.length === 0) return;
    scrollToBottom(false);
    isAtBottomRef.current = true;
  // Re-run when the thread changes OR the first batch of messages
  // for a thread arrives (length 0 → N).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThread?.id, messages.length > 0]);

  // After EVERY messages-array update, scroll to bottom ONLY if the
  // user was already at the bottom. This means:
  //   - You just sent a message → you stay pinned to it.
  //   - Someone else sent a message while you were at the bottom → it
  //     animates in and you stay pinned.
  //   - You scrolled up to read history → new messages don't yank you
  //     out of where you were reading.
  useEffect(() => {
    if (!selectedThread || messages.length === 0) return;
    if (isAtBottomRef.current) scrollToBottom(true);
  }, [messages, selectedThread]);

  // When images / GIFs inside the thread finish loading, the messages
  // list gets taller. If the user was anchored to the bottom, re-pin
  // them. ResizeObserver fires on every layout change of the
  // container's content.
  useEffect(() => {
    const c = messagesContainerRef.current;
    if (!c || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (isAtBottomRef.current) {
        c.scrollTop = c.scrollHeight;
      }
    });
    // Observe the inner content (first child of the scroll container).
    if (c.firstElementChild) ro.observe(c.firstElementChild);
    return () => ro.disconnect();
  }, [selectedThread?.id]);

  // Track whether the user is at the bottom of the thread so the
  // effects above know whether to auto-scroll.
  const handleScroll = () => {
    const c = messagesContainerRef.current;
    if (!c) return;
    const distFromBottom = c.scrollHeight - c.scrollTop - c.clientHeight;
    // 80px slop — small enough that "near-bottom" still feels like
    // "I'm reading the latest", big enough that minor layout shifts
    // don't flip the flag.
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

      setNewThread({ title: '', description: '', isPrivate: false, scope: 'team', tags: [] });
      setIsCreatingThread(false);
    } catch (error) {
      console.error('Error creating thread:', error);
    }
  };

  const sendMessage = async (contentArg?: string, attachmentsArg?: ComposerAttachment[]) => {
    const content = (contentArg !== undefined ? contentArg : newMessage).trim();
    const attachments = attachmentsArg || [];
    if ((!content && attachments.length === 0) || !selectedThread || !userData) return;

    try {
      const messageData: any = {
        threadId: selectedThread.id,
        content,
        senderId: userData.uid,
        senderName: userData.name,
        senderRole: userData.role,
        timestamp: new Date(),
        teamId: selectedTeamId,
      };
      if (replyingTo?.id) messageData.replyTo = replyingTo.id;
      if (attachments.length > 0) messageData.attachments = attachments;

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

      // Push to everyone in the thread except the sender. Fires on every new
      // message — including DMs (where participants is just the two of them).
      // No prefKey filter for now (any chat opt-out can come later).
      try {
        const recipients = (selectedThread.participants || []).filter(uid => uid && uid !== userData.uid);
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
          });
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

  const togglePinThread = async (thread: ChatThread) => {
    if (!isCoach) return;

    try {
      await updateChatThread(thread.id, { isPinned: !thread.isPinned });
    } catch (error) {
      console.error('Error toggling pin:', error);
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
                         (filterTag === 'pinned' && thread.isPinned) ||
                         (filterTag === 'private' && thread.isPrivate) ||
                         (filterTag === 'direct' && isDM) ||
                         thread.tags?.includes(filterTag);
    return matchesSearch && matchesFilter;
  });

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
    } catch (err) {
      console.error('Failed to open DM:', err);
      alert('Could not open direct message. Please try again.');
    } finally {
      setDmStarting(null);
    }
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
            <h3 className="text-lg font-bold text-gray-900">Direct Message</h3>
            <p className="text-xs text-gray-500">Pick someone to start a private 1:1 chat.</p>
          </div>
          <button
            onClick={() => { setIsDMPickerOpen(false); setDmSearch(''); }}
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
            dmCandidates.map(m => (
              <button
                key={m.uid}
                onClick={() => startDM({ uid: m.uid, name: m.name })}
                disabled={dmStarting === m.uid}
                className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-violet-50 active:bg-violet-100 transition-colors text-left disabled:opacity-50"
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
                {dmStarting === m.uid ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-violet-600"></div>
                ) : (
                  <svg className="w-5 h-5 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                )}
              </button>
            ))
          )}
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
        className="fixed inset-x-0 flex flex-col bg-gray-50 z-10 overflow-hidden"
        style={{
          // Top header: 3.5rem (h-14) + safe-area for the notch.
          top: 'calc(3.5rem + env(safe-area-inset-top))',
          // Explicit height from window.innerHeight (in CSS pixels).
          // For threads view, also subtract the bottom tab bar height.
          height:
            currentView === 'chat' && selectedThread
              ? `calc(${winHeight}px - 3.5rem - env(safe-area-inset-top))`
              : `calc(${winHeight}px - 3.5rem - env(safe-area-inset-top) - 3rem - env(safe-area-inset-bottom))`,
        }}
      >
        {currentView === 'threads' ? (
          // THREADS LIST VIEW
          <div className="flex-1 min-h-0 flex flex-col bg-white">
            {/* Header */}
            <div className="p-4 border-b border-gray-200 bg-white">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-gray-900">Team Chat</h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setIsDMPickerOpen(true)}
                    className="bg-violet-600 hover:bg-violet-700 text-white p-2.5 rounded-lg transition-colors"
                    title="Direct message"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setIsCreatingThread(true)}
                    className="bg-cyan-600 hover:bg-cyan-700 text-white p-2.5 rounded-lg transition-colors"
                    title="New thread"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                    </svg>
                  </button>
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

            {/* Threads List — iMessage / Messages-style rows */}
            <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
              {filteredThreads.map((thread) => {
                const isDM = (thread as any).isDM === true;
                const displayTitle = getThreadDisplayTitle(thread);
                const initial = (displayTitle || '?').charAt(0).toUpperCase();
                let hh = 0;
                for (let i = 0; i < (displayTitle || '').length; i++) hh = (hh * 31 + displayTitle.charCodeAt(i)) >>> 0;
                const palette = ['bg-rose-500','bg-amber-500','bg-emerald-500','bg-cyan-500','bg-violet-500','bg-fuchsia-500','bg-blue-500','bg-teal-500'];
                const avatarBg = palette[hh % palette.length];
                const preview = thread.lastMessage?.content || (thread.description || (isDM ? 'Tap to send a message' : 'No messages yet'));
                const ago = formatTime(thread.lastActivity);
                return (
                  <button
                    key={thread.id}
                    onClick={() => showChatView(thread)}
                    className="w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 transition-colors flex items-start gap-3"
                  >
                    <div className={`w-12 h-12 rounded-full flex-shrink-0 flex items-center justify-center text-white text-base font-bold shadow-sm ${avatarBg}`}>
                      {initial}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="font-semibold text-gray-900 truncate text-[15px]">{displayTitle}</span>
                        {thread.isPinned && (
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
              })}

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
                      onClick={() => setIsDMPickerOpen(true)}
                      className="px-4 py-2 text-sm font-semibold rounded-full bg-violet-600 text-white hover:bg-violet-700"
                    >
                      💬 New DM
                    </button>
                    <button
                      onClick={() => setIsCreatingThread(true)}
                      className="px-4 py-2 text-sm font-semibold rounded-full bg-cyan-600 text-white hover:bg-cyan-700"
                    >
                      🧵 New thread
                    </button>
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
                      {selectedThread.isPinned && (
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
                      <span>{selectedThread.participants.length} participants</span>
                    </div>
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
              </div>

              {/* Messages — min-h-0 is critical: without it, flex-1 won't
                  shrink the messages div, and many messages push the composer
                  off the bottom of the container.
                  overscroll-contain prevents the scroll from bubbling out to
                  the body (the cause of the tab bar 'riding up'). */}
              <div
                ref={messagesContainerRef}
                onScroll={handleScroll}
                className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"
                style={{ overscrollBehavior: 'contain' }}
              >
                {/* Inner wrapper so ResizeObserver has a stable child
                    to observe — its height changes as images load. */}
                <div className="space-y-4">
                {messages.map((message, idx) => {
                  // Compute sender-group boundaries so the bubble can render
                  // an avatar + name only on the first message of a run, and
                  // a timestamp only under the last.
                  const prev = messages[idx - 1];
                  const next = messages[idx + 1];
                  const ts = (m: any) => (m?.timestamp instanceof Date ? m.timestamp.getTime() : new Date(m?.timestamp || 0).getTime());
                  const GAP_MS = 5 * 60 * 1000;
                  const isFirstInGroup = !prev || prev.senderId !== message.senderId || ts(message) - ts(prev) > GAP_MS;
                  const isLastInGroup = !next || next.senderId !== message.senderId || ts(next) - ts(message) > GAP_MS;
                  return (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      currentUserId={userData?.uid || ''}
                      currentUserName={userData?.name || ''}
                      replyTarget={message.replyTo ? messages.find((mm) => mm.id === message.replyTo) || null : null}
                      onReply={setReplyingTo}
                      onToggleReaction={toggleReaction}
                      onDelete={deleteMessage}
                      onImageClick={(url) => setLightboxUrl(url)}
                      formatTime={formatTime}
                      isFirstInGroup={isFirstInGroup}
                      isLastInGroup={isLastInGroup}
                    />
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
              <MessageComposer
                threadId={selectedThread.id}
                teamId={selectedTeamId}
                members={teamMembers}
                replyingTo={replyingTo}
                onCancelReply={() => setReplyingTo(null)}
                onSend={(c, atts) => sendMessage(c, atts)}
                rows={2}
                safeAreaInsetBottom={kbInset === 0}
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

                  {/* Channel scope — club admins can create cross-team
                      channels. Regular coaches only get team scope. */}
                  {isUserClubAdmin && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Visible to
                      </label>
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
            <h2 className="text-lg font-semibold text-gray-900">Team Chat</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsDMPickerOpen(true)}
                className="bg-violet-600 hover:bg-violet-700 text-white p-2 rounded-lg transition-colors"
                title="Direct message"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </button>
              <button
                onClick={() => setIsCreatingThread(true)}
                className="bg-cyan-600 hover:bg-cyan-700 text-white p-2 rounded-lg transition-colors"
                title="New thread"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
              </button>
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
                    {thread.isPinned && (
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
                
                {isCoach && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePinThread(thread);
                    }}
                    className={`ml-2 p-1 rounded transition-colors ${
                      thread.isPinned ? 'text-yellow-500 hover:text-yellow-600' : 'text-gray-400 hover:text-gray-600'
                    }`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                    </svg>
                  </button>
                )}
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
                    {selectedThread.isPinned && (
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
              style={{ overscrollBehavior: 'contain' }}
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
                  <MessageBubble
                    key={message.id}
                    message={message}
                    currentUserId={userData?.uid || ''}
                    currentUserName={userData?.name || ''}
                    replyTarget={message.replyTo ? messages.find((mm) => mm.id === message.replyTo) || null : null}
                    onReply={setReplyingTo}
                    onToggleReaction={toggleReaction}
                    onDelete={deleteMessage}
                    onImageClick={(url) => setLightboxUrl(url)}
                    formatTime={formatTime}
                    isFirstInGroup={isFirstInGroup}
                    isLastInGroup={isLastInGroup}
                  />
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
                onSend={(c, atts) => sendMessage(c, atts)}
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