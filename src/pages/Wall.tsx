import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { ChatThread } from '../types';
import { isCoach } from '../utils/helpers';
import AppIcon from '../components/common/AppIcon';

interface WallPost {
  id: string;
  threadId: string;
  threadTitle: string;
  content: string;
  senderName: string;
  senderRole?: string;
  timestamp: Date;
  attachments?: Array<{ url: string; type?: string; name?: string }>;
}

// Render URLs in plain text as tappable links. Plain-loop variant so
// we don't need the matchAll iterator target.
function linkify(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /(https?:\/\/[^\s]+)/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <a
        key={`l-${i++}`}
        href={m[0]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-cyan-600 underline break-all"
      >
        {m[0]}
      </a>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const Wall: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const { subscribeToChatThreads, updateChatThread, addChatMessage } = useFirestore() as any;
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [posts, setPosts] = useState<WallPost[]>([]);
  const [loading, setLoading] = useState(true);
  const canUnpin = userData ? (isCoach(userData.role) || (userData as any).isClubAdmin) : false;
  // Coaches + club admins post directly to the wall from this page —
  // no detour through chat. Under the hood we write a ChatMessage to
  // the team's primary thread + pin it, matching the chat composer's
  // "Post to wall" toggle path so it shows up identically everywhere.
  const canPost = canUnpin;
  const [composer, setComposer] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  // Subscribe to the team's chat threads so we always have current
  // pinnedMessageIds. The wall is just a different projection of the
  // same data the chat tab serves.
  useEffect(() => {
    if (!selectedTeamId) { setThreads([]); setLoading(false); return; }
    const unsub = subscribeToChatThreads(selectedTeamId, (data) => {
      setThreads(data as ChatThread[]);
    });
    return () => { unsub && unsub(); };
  }, [selectedTeamId, subscribeToChatThreads]);

  // Fetch chat_messages docs for every pinned id across the team's
  // threads. Chunked by 30 to stay under Firestore's "in" cap.
  useEffect(() => {
    if (!selectedTeamId) return;
    const idToThread = new Map<string, { id: string; title: string }>();
    for (const t of threads) {
      const ids: string[] = ((t as any).pinnedMessageIds || []) as string[];
      for (const id of ids) {
        if (id && !idToThread.has(id)) idToThread.set(id, { id: t.id, title: t.title || 'Chat' });
      }
    }
    if (idToThread.size === 0) { setPosts([]); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const { collection, getDocs, query, where, documentId } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const ids = Array.from(idToThread.keys());
        const fetched: any[] = [];
        for (let i = 0; i < ids.length; i += 30) {
          const slice = ids.slice(i, i + 30);
          const snap = await getDocs(query(
            collection(db, 'chat_messages'),
            where(documentId(), 'in', slice),
          ));
          snap.docs.forEach(d => fetched.push({ id: d.id, ...(d.data() as any) }));
        }
        if (cancelled) return;
        const next = fetched
          .filter(m => m.content || (Array.isArray(m.attachments) && m.attachments.length > 0))
          .map(m => {
            const tr = idToThread.get(m.id) || { id: m.threadId || '', title: 'Chat' };
            return {
              id: m.id,
              threadId: tr.id,
              threadTitle: tr.title,
              content: (m.content as string) || '',
              senderName: m.senderName as string,
              senderRole: m.senderRole as string | undefined,
              timestamp: m.timestamp?.toDate?.() || new Date(m.timestamp || Date.now()),
              attachments: m.attachments,
            } as WallPost;
          })
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        setPosts(next);
        setLoading(false);
      } catch (err) {
        console.warn('wall load failed', err);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId, threads]);

  const unpin = async (post: WallPost) => {
    if (!canUnpin) return;
    if (!window.confirm('Remove this from the wall? The original message stays in chat.')) return;
    const thread = threads.find(t => t.id === post.threadId);
    if (!thread) return;
    const current = ((thread as any).pinnedMessageIds || []) as string[];
    const next = current.filter(id => id !== post.id);
    try {
      await updateChatThread(thread.id, { pinnedMessageIds: next } as any);
      setPosts(prev => prev.filter(p => p.id !== post.id));
    } catch (err) {
      console.error('unpin failed', err);
      alert('Failed to unpin — try again.');
    }
  };

  // Post directly to the wall. Picks the team's primary chat thread
  // (preferring a non-DM, non-private team-scoped one), writes a new
  // ChatMessage, and pins it. Same data path as the chat composer's
  // "Post to wall" toggle.
  const handlePost = async () => {
    const content = composer.trim();
    if (!content || !userData || !selectedTeamId || posting) return;
    setPosting(true);
    setPostError(null);
    try {
      // Pick the best thread to post into. Preference order:
      //   1. A non-DM, non-private thread on this team with most recent activity
      //   2. The first team-scoped thread we find
      const teamThreads = threads.filter(t => !t.isDM && !t.isPrivate && t.teamId === selectedTeamId);
      const target = teamThreads.sort((a, b) => {
        const aTs = (a.lastActivity as any)?.toDate?.()?.getTime?.() || new Date(a.lastActivity || 0).getTime();
        const bTs = (b.lastActivity as any)?.toDate?.()?.getTime?.() || new Date(b.lastActivity || 0).getTime();
        return bTs - aTs;
      })[0];
      if (!target) {
        setPostError("No team chat thread to post into yet — create one in Chat first.");
        return;
      }
      const messageId = await addChatMessage({
        threadId: target.id,
        teamId: selectedTeamId,
        content,
        senderId: userData.uid,
        senderName: userData.name || 'Coach',
        senderRole: isCoach(userData.role) || (userData as any).isClubAdmin ? 'coach' : 'parent',
        timestamp: new Date(),
      });
      // Pin it so it shows up on the wall immediately.
      const existing = Array.isArray(target.pinnedMessageIds) ? target.pinnedMessageIds : [];
      await updateChatThread(target.id, {
        pinnedMessageIds: [...existing, messageId],
      } as any);
      setComposer('');
    } catch (err: any) {
      console.error('wall post failed', err);
      setPostError(err?.message || 'Post failed — try again.');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="min-h-screen bg-fire-50">
      <section className="bg-gradient-to-b from-slate-950 to-slate-900 px-4 sm:px-6 py-4 border-b border-cyan-500/10">
        <div className="max-w-3xl mx-auto">
          <Link to="/dashboard" className="inline-flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase text-cyan-300 hover:text-cyan-200 mb-2">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Dashboard
          </Link>
          <h1 className="text-2xl sm:text-3xl font-black text-white leading-tight flex items-center gap-2">
            <AppIcon name="news" className="w-6 h-6 text-cyan-300" />
            Team Wall
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">
            {selectedTeam?.name ? `${selectedTeam.name} — ` : ''}announcements, links, and pinned messages
          </p>
        </div>
      </section>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 space-y-4">
        {canPost && (
          <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-3">
            <textarea
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              placeholder="Share an announcement, link, or update with the team…"
              rows={3}
              className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-cyan-400 text-sm leading-relaxed resize-none"
              style={{ fontSize: '16px' }}
            />
            {postError && <div className="mt-2 text-[11px] text-rose-700">{postError}</div>}
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[10px] text-slate-500">
                Posts to the team's main chat thread and pins it here.
              </span>
              <button
                type="button"
                onClick={handlePost}
                disabled={!composer.trim() || posting}
                className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 via-violet-500 to-fuchsia-500 hover:from-cyan-400 hover:via-violet-400 hover:to-fuchsia-400 text-white text-xs font-extrabold uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {posting ? 'Posting…' : 'Post to wall'}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-center py-16 text-slate-400 text-sm">Loading…</div>
        ) : posts.length === 0 ? (
          <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-8 text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-cyan-50 ring-1 ring-cyan-200 flex items-center justify-center">
              <AppIcon name="news" className="w-5 h-5 text-cyan-600" />
            </div>
            <p className="text-sm font-semibold text-slate-700 mb-1">Nothing on the wall yet.</p>
            <p className="text-xs text-slate-500 max-w-xs mx-auto">
              {canPost
                ? 'Type your first announcement above. You can also pin any existing chat message via the ⋯ menu.'
                : 'Coaches post announcements and important links here.'}
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {posts.map(p => (
              <li key={p.id} className="bg-white rounded-2xl ring-1 ring-slate-200 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                  <span className="text-sm font-bold text-slate-900">{p.senderName}</span>
                  {p.senderRole === 'coach' && (
                    <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-700 bg-cyan-50 ring-1 ring-cyan-200 px-1.5 py-0.5 rounded">Coach</span>
                  )}
                  <span className="text-[11px] text-slate-400 ml-auto">
                    {p.timestamp.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </span>
                </div>
                <div className="px-4 py-3 text-[15px] leading-relaxed text-slate-800 whitespace-pre-wrap break-words">
                  {linkify(p.content)}
                </div>
                {p.attachments && p.attachments.length > 0 && (
                  <div className="px-4 pb-3 grid grid-cols-2 gap-1">
                    {p.attachments.slice(0, 4).map((a, i) => (
                      <img
                        key={i}
                        src={a.url}
                        alt={a.name || 'attachment'}
                        loading="lazy"
                        className="rounded-lg object-cover w-full h-32"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                    ))}
                  </div>
                )}
                <div className="px-4 py-2 border-t border-slate-100 flex items-center justify-between bg-slate-50">
                  <Link
                    to={`/chat?thread=${encodeURIComponent(p.threadId)}&message=${encodeURIComponent(p.id)}`}
                    className="text-xs font-bold tracking-widest uppercase text-cyan-700 hover:text-cyan-900"
                  >
                    Open in chat →
                  </Link>
                  {canUnpin && (
                    <button
                      onClick={() => unpin(p)}
                      className="text-xs font-bold tracking-widest uppercase text-rose-600 hover:text-rose-800"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default Wall;
