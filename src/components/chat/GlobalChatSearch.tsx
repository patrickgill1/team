import React, { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import type { ChatMessage, ChatThread } from '../../types';

// Cross-thread chat search. Loads the most recent N messages from each
// of the user's accessible threads (capped to keep reads cheap), then
// filters client-side by substring on content. Results are grouped by
// thread with a small snippet around the match.
//
// Why client-side: Firestore doesn't support free-text search. A real
// solution at scale is Algolia or Meilisearch, but for typical
// chat sizes (a few thousand messages per club) loading the recent
// window into memory is fast and free, and the search runs across
// every thread at once.

interface Props {
  threads: ChatThread[];
  /** Tap a result → switch to the thread and scroll to the message. */
  onResult: (threadId: string, messageId: string) => void;
  onClose: () => void;
  /** Optional: title display helper for a thread (DM / group naming). */
  getThreadTitle: (t: ChatThread) => string;
}

interface IndexedMessage {
  id: string;
  threadId: string;
  content: string;
  senderName: string;
  timestamp: Date;
}

const PER_THREAD_LIMIT = 60; // recent messages indexed per thread

const GlobalChatSearch: React.FC<Props> = ({ threads, onResult, onClose, getThreadTitle }) => {
  const [q, setQ] = useState('');
  const [indexed, setIndexed] = useState<IndexedMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState({ done: 0, total: 0 });

  // Build the index when the search panel opens. Idempotent — only
  // runs once per mount. Could be cached longer in a future pass.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadProgress({ done: 0, total: threads.length });
    (async () => {
      const all: IndexedMessage[] = [];
      let done = 0;
      // Limit concurrent reads so we don't spike the network on slow
      // connections — process threads in batches of 4.
      const CONCURRENCY = 4;
      const batches: ChatThread[][] = [];
      for (let i = 0; i < threads.length; i += CONCURRENCY) {
        batches.push(threads.slice(i, i + CONCURRENCY));
      }
      for (const batch of batches) {
        if (cancelled) return;
        await Promise.all(batch.map(async (t) => {
          try {
            const snap = await getDocs(query(
              collection(db, 'chat_messages'),
              where('threadId', '==', t.id),
              orderBy('timestamp', 'desc'),
              limit(PER_THREAD_LIMIT),
            ));
            snap.docs.forEach(d => {
              const data = d.data() as any;
              if (!data.content) return;
              all.push({
                id: d.id,
                threadId: t.id,
                content: data.content,
                senderName: data.senderName || 'Member',
                timestamp: data.timestamp?.toDate?.() || new Date(data.timestamp || Date.now()),
              });
            });
          } catch {
            /* skip thread on error */
          }
          done += 1;
          if (!cancelled) setLoadProgress({ done, total: threads.length });
        }));
      }
      if (!cancelled) {
        setIndexed(all);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [threads]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const matches = indexed.filter(m => m.content.toLowerCase().includes(needle));
    // Group by thread, sort threads by most-recent match.
    const byThread = new Map<string, IndexedMessage[]>();
    for (const m of matches) {
      const arr = byThread.get(m.threadId) || [];
      arr.push(m);
      byThread.set(m.threadId, arr);
    }
    const grouped = Array.from(byThread.entries()).map(([threadId, msgs]) => {
      const thread = threads.find(t => t.id === threadId);
      const sortedMsgs = msgs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      return { thread, messages: sortedMsgs };
    });
    grouped.sort((a, b) => {
      const aMax = a.messages[0]?.timestamp.getTime() || 0;
      const bMax = b.messages[0]?.timestamp.getTime() || 0;
      return bMax - aMax;
    });
    return grouped;
  }, [q, indexed, threads]);

  // Highlight the matched substring inside the snippet.
  const renderSnippet = (content: string, needle: string) => {
    const lc = content.toLowerCase();
    const idx = lc.indexOf(needle);
    if (idx === -1) return content.slice(0, 120);
    const start = Math.max(0, idx - 24);
    const end = Math.min(content.length, idx + needle.length + 80);
    const before = (start > 0 ? '…' : '') + content.slice(start, idx);
    const match = content.slice(idx, idx + needle.length);
    const after = content.slice(idx + needle.length, end) + (end < content.length ? '…' : '');
    return (
      <>
        {before}
        <mark className="bg-amber-200 text-slate-900 rounded px-0.5">{match}</mark>
        {after}
      </>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute inset-x-0 top-0 max-h-[90vh] overflow-y-auto bg-white rounded-b-3xl shadow-2xl animate-sheet-up safe-top"
      >
        <div className="sticky top-0 z-10 bg-white border-b border-slate-100 px-4 py-3">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search every chat…"
              className="flex-1 bg-transparent text-base focus:outline-none placeholder:text-slate-400"
              style={{ fontSize: '16px' }}
            />
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-700 text-xs font-bold uppercase tracking-widest px-2"
            >
              Cancel
            </button>
          </div>
          {loading && (
            <div className="mt-2 text-[11px] text-slate-400">
              Indexing {loadProgress.done}/{loadProgress.total} conversations…
            </div>
          )}
        </div>

        {!q.trim() ? (
          <div className="px-6 py-12 text-center text-sm text-slate-500">
            Type any word or phrase to search across every chat thread you're in.
          </div>
        ) : results.length === 0 ? (
          loading ? (
            <div className="px-6 py-10 text-center text-sm text-slate-500">Searching…</div>
          ) : (
            <div className="px-6 py-12 text-center text-sm text-slate-500">
              No matches for "{q.trim()}".
            </div>
          )
        ) : (
          <ul className="divide-y divide-slate-100">
            {results.map(({ thread, messages }) => (
              <li key={thread?.id || messages[0]?.threadId}>
                <div className="px-4 pt-3 pb-1.5 text-[10px] font-extrabold uppercase tracking-widest text-cyan-700">
                  {thread ? getThreadTitle(thread) : 'Conversation'}
                  <span className="text-slate-400 ml-2 normal-case tracking-normal font-bold">{messages.length} match{messages.length === 1 ? '' : 'es'}</span>
                </div>
                <ul>
                  {messages.slice(0, 5).map(m => (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => onResult(m.threadId, m.id)}
                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 active:bg-slate-100"
                      >
                        <div className="flex items-baseline gap-2 mb-0.5">
                          <span className="text-xs font-bold text-slate-900">{m.senderName}</span>
                          <span className="text-[10px] text-slate-400">
                            {m.timestamp.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: m.timestamp.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined })}
                            {' · '}
                            {m.timestamp.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                          </span>
                        </div>
                        <div className="text-sm text-slate-700 break-words line-clamp-3">
                          {renderSnippet(m.content, q.trim().toLowerCase())}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default GlobalChatSearch;
