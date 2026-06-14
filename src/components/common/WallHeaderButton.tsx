import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useTeam } from '../../contexts/TeamContext';
import { RichContent } from '../../pages/Wall';
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

  // Lock the body from scrolling while the drawer is open. Without
  // this, iOS lets the page behind the dim scroll on touch — Patrick
  // flagged it as "you can still scroll the page behind it". Restore
  // on close.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    const prevTouch = (document.body.style as any).touchAction || '';
    document.body.style.overflow = 'hidden';
    (document.body.style as any).touchAction = 'none';
    return () => {
      document.body.style.overflow = prevOverflow;
      (document.body.style as any).touchAction = prevTouch;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        aria-label="Posts"
        title="Posts"
        className="relative inline-flex items-center justify-center w-9 h-9 rounded-full text-white/85 hover:text-white hover:bg-white/10 transition"
      >
        {/* Newspaper / feed icon — replaces the megaphone. The
            megaphone ("sound icon") was being read as "audio/volume"
            by parents, not "team announcements". A feed glyph is the
            common, plainly-readable affordance for "stream of posts"
            (Instagram, X, Facebook, Threads). */}
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="7" y1="9" x2="17" y2="9" />
          <line x1="7" y1="13" x2="17" y2="13" />
          <line x1="7" y1="17" x2="13" y2="17" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute top-0 right-0 w-2.5 h-2.5 rounded-full bg-rose-500 ring-2 ring-fire-950" aria-label={`${unreadCount} new posts`} />
        )}
      </button>

      {open && createPortal(
        <div
          className="fixed inset-0 z-50 bg-slate-950/85 animate-fade-in"
          style={{ left: 0, right: 0, top: 0, bottom: 0, width: '100vw' }}
          onClick={() => setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute top-0 bottom-0 overflow-y-auto bg-white animate-sheet-up safe-top overscroll-contain"
            style={{ left: 0, right: 0, width: '100vw', paddingBottom: 'env(safe-area-inset-bottom)' }}
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
              <div className="flex items-center gap-3">
                <Link
                  to="/wall"
                  onClick={() => setOpen(false)}
                  className="text-[11px] font-bold uppercase tracking-widest text-cyan-300 hover:text-white"
                >
                  View all →
                </Link>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
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
                    <WallDrawerPost post={p} onNavigate={() => setOpen(false)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

// Renders a single post in the wall drawer with collapse/expand for
// long content. Without this a single big pinned post can hide every
// other post in the drawer behind it.
const COLLAPSED_MAX_PX = 240;

const WallDrawerPost: React.FC<{ post: WallPost; onNavigate: () => void }> = ({ post: p, onNavigate }) => {
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [needsCollapse, setNeedsCollapse] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setNeedsCollapse(el.scrollHeight > COLLAPSED_MAX_PX + 24);
  }, [p.content]);

  return (
    <article className="block px-4 sm:px-5 py-4 hover:bg-slate-50/60 transition-colors">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-sm font-bold text-slate-900">{p.senderName}</span>
        {p.senderRole === 'coach' && (
          <span className="text-[9px] font-bold uppercase tracking-wider text-cyan-700 bg-cyan-50 ring-1 ring-cyan-200 px-1.5 py-0.5 rounded">Coach</span>
        )}
        <span className="text-[11px] text-slate-400 ml-auto">
          {p.timestamp.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </span>
      </div>
      <div className="relative">
        <div
          ref={bodyRef}
          className="text-[15px] text-slate-800 break-words"
          style={!expanded && needsCollapse ? { maxHeight: COLLAPSED_MAX_PX, overflow: 'hidden' } : undefined}
        >
          <RichContent text={p.content} />
        </div>
        {!expanded && needsCollapse && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white to-transparent"
          />
        )}
      </div>
      {needsCollapse && (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="mt-2 text-[11px] font-bold uppercase tracking-widest text-cyan-700 hover:text-cyan-900"
        >
          {expanded ? 'Show less' : 'Read more'}
        </button>
      )}
      {p.attachments && p.attachments.length > 0 && (
        <div className={`mt-3 grid gap-1.5 ${p.attachments.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {p.attachments.slice(0, 4).map((a, i) => (
            <img
              key={i}
              src={a.url}
              alt={a.name || ''}
              loading="lazy"
              className={`rounded-lg object-cover w-full ring-1 ring-slate-200 ${p.attachments!.length === 1 ? 'max-h-72' : 'h-32'}`}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          ))}
        </div>
      )}
      <div className="mt-3">
        <Link
          to="/wall"
          onClick={onNavigate}
          className="inline-flex items-center gap-1 text-xs font-bold tracking-widest uppercase text-cyan-700 hover:text-cyan-900"
        >
          Open on the wall →
        </Link>
      </div>
    </article>
  );
};

export default WallHeaderButton;
