import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collection, collectionGroup, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import type { ChatMessage } from '../types';

// Mentions inbox — every @-mention you've received across every
// thread, in one chronological list. Tap any item → jump straight to
// that message in chat (via the deep-link pendingScrollMsgId path).
//
// Subscribes to chat_messages where mentions array-contains current
// uid. Limited to 100 most recent so the page is fast; pagination
// can be added later.

const MentionsInbox: React.FC = () => {
  const { userData } = useAuth();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Array<ChatMessage & { __threadTitle?: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [threadTitles, setThreadTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!userData?.uid) return;
    // Two parallel streams. Team + DM + club + coach mentions live in
    // top-level `chat_messages`. Group mentions live in the
    // `chat_group_threads/*/messages` subcollection, so collectionGroup
    // ('messages') is the only way to reach them by mention.
    const topQ = query(
      collection(db, 'chat_messages'),
      where('mentions', 'array-contains', userData.uid),
      orderBy('timestamp', 'desc'),
      limit(100),
    );
    const subQ = query(
      collectionGroup(db, 'messages'),
      where('mentions', 'array-contains', userData.uid),
      orderBy('timestamp', 'desc'),
      limit(100),
    );
    let topList: ChatMessage[] = [];
    let subList: ChatMessage[] = [];
    const publish = () => {
      const merged = [...topList, ...subList]
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 100);
      setMessages(merged);
    };
    const mapDoc = (d: any, threadIdFromPath?: string): ChatMessage => {
      const data = d.data() as any;
      return {
        ...data,
        id: d.id,
        threadId: data.threadId || threadIdFromPath || '',
        timestamp: data.timestamp?.toDate?.() || new Date(data.timestamp || Date.now()),
      } as ChatMessage;
    };
    const unsubTop = onSnapshot(topQ, (snap) => {
      topList = snap.docs.map(d => mapDoc(d));
      publish();
      setLoading(false);
    }, (err) => {
      void import('../utils/firestoreLogger').then(({ logFirestoreError }) =>
        logFirestoreError('subscribe', 'chat_messages?mentions', err, { op: 'MentionsInbox' })
      );
      setLoading(false);
    });
    const unsubSub = onSnapshot(subQ, (snap) => {
      subList = snap.docs
        // collectionGroup('messages') will match any subcollection
        // named "messages" anywhere in the DB. Guard to just the
        // group-chat path so a future collision can't leak here.
        .filter(d => d.ref.parent?.parent?.parent?.id === 'chat_group_threads')
        .map(d => mapDoc(d, d.ref.parent?.parent?.id));
      publish();
    }, (err) => {
      void import('../utils/firestoreLogger').then(({ logFirestoreError }) =>
        logFirestoreError('subscribe', 'messages?mentions', err, { op: 'MentionsInbox:group' })
      );
    });
    return () => { unsubTop(); unsubSub(); };
  }, [userData?.uid]);

  // Fetch thread titles for the threads we've got hits in.
  useEffect(() => {
    const threadIds = Array.from(new Set(messages.map(m => m.threadId).filter(Boolean)));
    const missing = threadIds.filter(id => !threadTitles[id]);
    if (missing.length === 0) return;
    (async () => {
      const { getDoc, doc: fsDoc } = await import('firebase/firestore');
      const fetched: Record<string, string> = {};
      await Promise.all(missing.map(async (id) => {
        try {
          const snap = await getDoc(fsDoc(db, 'chat_threads', id));
          if (snap.exists()) {
            const data = snap.data() as any;
            fetched[id] = data.title || 'Chat';
            return;
          }
          // Groups moved to their own collection in the 2026-07-21
          // subcollection migration. Fall back so mentions in group
          // chats still get a proper thread title in the inbox.
          const gSnap = await getDoc(fsDoc(db, 'chat_group_threads', id));
          if (gSnap.exists()) {
            const data = gSnap.data() as any;
            fetched[id] = data.title || 'Group chat';
          }
        } catch {
          /* ignore */
        }
      }));
      if (Object.keys(fetched).length > 0) {
        setThreadTitles(prev => ({ ...prev, ...fetched }));
      }
    })();
  }, [messages, threadTitles]);

  const grouped = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const groups: Array<{ label: string; items: typeof messages }> = [
      { label: 'Today', items: [] },
      { label: 'Yesterday', items: [] },
      { label: 'Earlier', items: [] },
    ];
    for (const m of messages) {
      const d = new Date(m.timestamp);
      d.setHours(0, 0, 0, 0);
      if (d.getTime() === today.getTime()) groups[0].items.push(m);
      else if (d.getTime() === yesterday.getTime()) groups[1].items.push(m);
      else groups[2].items.push(m);
    }
    return groups.filter(g => g.items.length > 0);
  }, [messages]);

  const openMessage = (m: ChatMessage) => {
    navigate(`/chat?thread=${encodeURIComponent(m.threadId)}&message=${encodeURIComponent(m.id)}`);
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 sm:px-6 py-5 border-b border-brand-primary/15">
        <div className="max-w-3xl mx-auto">
          <Link to="/dashboard" className="inline-flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase text-brand-primary-soft hover:text-ink-primary mb-2">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Team HQ
          </Link>
          <h1 className="text-2xl sm:text-3xl font-black text-ink-primary leading-tight flex items-center gap-2">
            <svg className="w-6 h-6 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="4" />
              <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" />
            </svg>
            Mentions
          </h1>
          <p className="text-sm text-ink-primary/60 mt-0.5">Every @ you've gotten across every chat.</p>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5">
        {loading ? (
          <div className="text-center text-sm text-ink-primary/60 py-12">Loading mentions…</div>
        ) : messages.length === 0 ? (
          <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-10 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-brand-primary-soft ring-1 ring-brand-primary-soft flex items-center justify-center text-brand-primary mb-3">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" /></svg>
            </div>
            <p className="text-sm font-semibold text-ink-primary">Nothing to catch up on</p>
            <p className="text-xs text-ink-primary/60 mt-1 max-w-xs mx-auto">
              When a teammate @-mentions you in any chat, it lands here so nothing important slips by.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {grouped.map(group => (
              <section key={group.label}>
                <div className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500 mb-2 px-1">
                  {group.label}
                </div>
                <ul className="bg-white rounded-2xl ring-1 ring-slate-200 divide-y divide-slate-100 overflow-hidden">
                  {group.items.map(m => (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => openMessage(m)}
                        className="w-full text-left px-4 py-3 hover:bg-slate-50 active:bg-slate-100 transition-colors"
                      >
                        <div className="flex items-baseline gap-2 mb-1">
                          <span className="text-sm font-bold text-slate-900">{m.senderName}</span>
                          {threadTitles[m.threadId] && (
                            <span className="text-[11px] text-brand-primary font-semibold">in {threadTitles[m.threadId]}</span>
                          )}
                          <span className="text-[10px] text-ink-primary/60 ml-auto">
                            {m.timestamp.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                          </span>
                        </div>
                        <p className="text-sm text-slate-700 break-words line-clamp-3 whitespace-pre-wrap">{m.content}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default MentionsInbox;
