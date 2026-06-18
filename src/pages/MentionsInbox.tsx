import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
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
    const q = query(
      collection(db, 'chat_messages'),
      where('mentions', 'array-contains', userData.uid),
      orderBy('timestamp', 'desc'),
      limit(100),
    );
    const unsub = onSnapshot(q, (snap) => {
      const next = snap.docs.map(d => {
        const data = d.data() as any;
        return {
          ...data,
          id: d.id,
          timestamp: data.timestamp?.toDate?.() || new Date(data.timestamp || Date.now()),
        } as ChatMessage;
      });
      setMessages(next);
      setLoading(false);
    }, (err) => {
      void import('../utils/firestoreLogger').then(({ logFirestoreError }) =>
        logFirestoreError('subscribe', 'chat_messages?mentions', err, { op: 'MentionsInbox' })
      );
      setLoading(false);
    });
    return () => unsub();
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
      <header className="bg-gradient-to-b from-charcoal-950 to-charcoal-900 px-4 sm:px-6 py-5 border-b border-crimson-500/15">
        <div className="max-w-3xl mx-auto">
          <Link to="/dashboard" className="inline-flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase text-crimson-400 hover:text-bone mb-2">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Dashboard
          </Link>
          <h1 className="text-2xl sm:text-3xl font-black text-white leading-tight flex items-center gap-2">
            <svg className="w-6 h-6 text-crimson-400" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="4" />
              <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" />
            </svg>
            Mentions
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">Every @ you've gotten across every chat.</p>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5">
        {loading ? (
          <div className="text-center text-sm text-slate-400 py-12">Loading mentions…</div>
        ) : messages.length === 0 ? (
          <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-10 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-crimson-50 ring-1 ring-crimson-100 flex items-center justify-center text-crimson-600 mb-3">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" /></svg>
            </div>
            <p className="text-sm font-semibold text-slate-700">No mentions yet</p>
            <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
              When someone @-mentions you in any chat, the message will appear here. Old messages without a structured mention won't show — only new ones from now on.
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
                            <span className="text-[11px] text-crimson-700 font-semibold">in {threadTitles[m.threadId]}</span>
                          )}
                          <span className="text-[10px] text-slate-400 ml-auto">
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
