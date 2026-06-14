import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useTeam } from '../../contexts/TeamContext';
import type { WallPost } from '../../types';

// Always-visible Wall affordance in the top header. Tapping it slides
// down a drawer of the most recent posts so the wall is discoverable
// from anywhere in the app — no longer needs a bottom-tab slot.
//
// A small red dot rides on the megaphone when there are posts the
// user hasn't seen since their last open (tracked per-team in
// localStorage so DM unreads don't bleed into Wall unreads).

const lastSeenKey = (teamId: string | null) => `wall.lastSeen.${teamId || 'none'}`;

const WallHeaderButton: React.FC = () => {
  const { selectedTeamId } = useTeam();
  const [open, setOpen] = useState(false);
  const [posts, setPosts] = useState<WallPost[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  // Subscribe to the 5 most recent wall posts for the team. Cheap and
  // keeps the unread badge live.
  useEffect(() => {
    if (!selectedTeamId) { setPosts([]); return; }
    const q = query(
      collection(db, 'wall_posts'),
      where('teamId', '==', selectedTeamId),
      orderBy('timestamp', 'desc'),
      limit(5),
    );
    const unsub = onSnapshot(q, (snap) => {
      const next: WallPost[] = snap.docs.map(d => {
        const data = d.data() as any;
        return {
          id: d.id,
          teamId: data.teamId,
          content: data.content || '',
          senderId: data.senderId,
          senderName: data.senderName || 'Coach',
          senderRole: data.senderRole,
          timestamp: data.timestamp?.toDate?.() || new Date(data.timestamp || Date.now()),
          attachments: Array.isArray(data.attachments) ? data.attachments : undefined,
          reactions: Array.isArray(data.reactions) ? data.reactions : [],
          wallPinnedTop: data.wallPinnedTop ?? null,
          postedFrom: data.postedFrom,
          isPublic: data.isPublic,
        };
      });
      setPosts(next);
      try {
        const lastSeenRaw = localStorage.getItem(lastSeenKey(selectedTeamId));
        const lastSeen = lastSeenRaw ? parseInt(lastSeenRaw, 10) : 0;
        setUnreadCount(next.filter(p => p.timestamp.getTime() > lastSeen).length);
      } catch { /* ignore */ }
    });
    return () => unsub();
  }, [selectedTeamId]);

  // Mark all visible posts as seen when the drawer opens.
  const markSeen = () => {
    try {
      const latest = posts.reduce((max, p) => Math.max(max, p.timestamp.getTime()), 0);
      if (latest > 0) localStorage.setItem(lastSeenKey(selectedTeamId), String(latest));
      setUnreadCount(0);
    } catch { /* ignore */ }
  };

  const handleOpen = () => {
    void import('../../utils/nativeShell').then(m => m.tapHaptic('light'));
    setOpen(true);
    markSeen();
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        aria-label="Wall"
        className="relative h-9 w-9 rounded-full flex items-center justify-center text-white/85 hover:text-white hover:bg-white/10 transition"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-rose-500 ring-2 ring-fire-950" />
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm animate-fade-in"
          onClick={() => setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-0 top-0 max-h-[85vh] overflow-y-auto bg-white rounded-b-3xl shadow-2xl animate-sheet-up safe-top"
          >
            <div className="sticky top-0 z-10 bg-gradient-to-b from-slate-950 to-slate-900 px-4 py-3 flex items-center justify-between border-b border-white/10">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-cyan-300" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
                <span className="text-xs font-extrabold tracking-widest uppercase text-cyan-300">The Wall</span>
              </div>
              <Link
                to="/wall"
                onClick={() => setOpen(false)}
                className="text-[11px] font-bold uppercase tracking-widest text-cyan-300 hover:text-white"
              >
                View all →
              </Link>
            </div>

            {posts.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <div className="mx-auto w-12 h-12 rounded-full bg-cyan-50 ring-1 ring-cyan-100 flex items-center justify-center text-cyan-600 mb-3">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                </div>
                <p className="text-sm font-semibold text-slate-700">Nothing posted yet</p>
                <p className="text-xs text-slate-500 mt-0.5">Coach announcements will land here.</p>
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {posts.map(p => (
                  <li key={p.id}>
                    <Link
                      to="/wall"
                      onClick={() => setOpen(false)}
                      className="block px-4 py-3 hover:bg-slate-50 active:bg-slate-100 transition-colors"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-bold text-slate-900">{p.senderName}</span>
                        {p.senderRole === 'coach' && (
                          <span className="text-[9px] font-bold uppercase tracking-wider text-cyan-700 bg-cyan-50 ring-1 ring-cyan-200 px-1.5 py-0.5 rounded">Coach</span>
                        )}
                        <span className="text-[11px] text-slate-400 ml-auto">
                          {p.timestamp.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </div>
                      <p className="text-sm text-slate-700 line-clamp-3 whitespace-pre-wrap break-words">
                        {p.content.replace(/[*#>`_~-]/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]')}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default WallHeaderButton;
