import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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
          <span className="absolute top-0 right-0 w-2.5 h-2.5 rounded-full bg-rose-500 ring-2 ring-charcoal-950" aria-label={`${unreadCount} new posts`} />
        )}
      </button>

      {open && createPortal(
        <div
          className="fixed inset-0 z-50 bg-charcoal-950/85 animate-fade-in"
          style={{ left: 0, right: 0, top: 0, bottom: 0, width: '100vw' }}
          onClick={() => setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            // Safe-area paddings live inside the strips below so they
            // paint behind notch + home indicator. Body is charcoal-950
            // to match the rest of the app's dark theme — was bg-white
            // pre-rebrand and read as a 'separate light page' to
            // parents (Patrick 2026-06-21: 'still has a white page,
            // also it is busy').
            className="absolute top-0 bottom-0 overflow-y-auto bg-charcoal-950 animate-sheet-up overscroll-contain flex flex-col"
            style={{ left: 0, right: 0, width: '100vw' }}
          >
            <div
              className="sticky top-0 z-10 bg-gradient-to-b from-charcoal-950 to-charcoal-900 px-4 flex items-center justify-between border-b border-white/10"
              style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)', paddingBottom: '0.75rem' }}
            >
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-crimson-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
                <span className="text-xs font-extrabold tracking-widest uppercase text-crimson-400">The Wall</span>
              </div>
              <div className="flex items-center gap-3">
                <Link
                  to="/wall"
                  onClick={() => setOpen(false)}
                  className="text-[11px] font-bold uppercase tracking-widest text-crimson-400 hover:text-white"
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

            <div className="flex-1">
              {posts.length === 0 ? (
                <div className="px-6 py-10 text-center">
                  <div className="mx-auto w-12 h-12 rounded-full bg-crimson-500/15 ring-1 ring-crimson-500/25 flex items-center justify-center text-crimson-300 mb-3">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                  </div>
                  <p className="text-sm font-semibold text-bone/85">Nothing posted yet</p>
                  <p className="text-xs text-bone/55 mt-0.5">Coach announcements will land here.</p>
                </div>
              ) : (
                // Dashboard-density rule: single-line previews, tap to
                // navigate to the actual wall. We were rendering the
                // entire post with attachments + reactions + collapse
                // expander, which read as 'reading the wall inside a
                // drawer' to parents. Now: sender, one-line snippet,
                // chevron. Wall is the source of truth.
                <ul className="divide-y divide-white/5">
                  {posts.map(p => (
                    <li key={p.id}>
                      <WallDrawerRow post={p} onNavigate={() => setOpen(false)} />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Dark-navy footer to match the rest of the app's chrome
                (chat action sheet, post cards, emoji picker, composer
                modal). Gives the drawer a polished bookend rather than
                a giant white area below the last post — Patrick:
                "footer bar on the drawer, not the wall page". */}
            <div
              className="bg-gradient-to-b from-charcoal-950 to-charcoal-900 px-4 flex items-center justify-between flex-shrink-0"
              style={{ paddingTop: '0.75rem', paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
            >
              <span className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-400/70">
                {posts.length === 0 ? 'No posts yet' : `${posts.length} recent post${posts.length === 1 ? '' : 's'}`}
              </span>
              <Link
                to="/wall"
                onClick={() => setOpen(false)}
                className="text-[11px] font-extrabold tracking-widest uppercase text-crimson-400 hover:text-white inline-flex items-center gap-1"
              >
                Open the wall
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
              </Link>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

// Single-line preview row. Per the dashboard density memory
// (~36-line row, strip markdown, sender + snippet + chevron),
// the drawer is a discovery surface for the wall, not a place
// to read full posts. Tap navigates to /wall where the actual
// reading happens.
const WallDrawerRow: React.FC<{ post: WallPost; onNavigate: () => void }> = ({ post: p, onNavigate }) => {
  // Strip markdown / image refs / links so the snippet is just
  // the prose. Otherwise a post that starts with an image markup
  // shows '![](https://...)' as the preview.
  const snippet = React.useMemo(() => {
    const raw = (p.content || '').trim();
    return raw
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')   // ![alt](url) images
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) links → text
      .replace(/[#*_`>~]+/g, '')               // md punctuation
      .replace(/\s+/g, ' ')                    // collapse whitespace
      .trim();
  }, [p.content]);

  const stamp = p.timestamp.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  return (
    <Link
      to="/wall"
      onClick={onNavigate}
      className="block px-4 py-3 hover:bg-white/[0.04] active:bg-white/[0.08] transition-colors"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-bold text-bone truncate">{p.senderName}</span>
            <span className="text-[11px] text-bone/45 shrink-0">{stamp}</span>
          </div>
          <p className="text-[13px] text-bone/70 truncate">
            {snippet || '(no text)'}
          </p>
        </div>
        <svg className="w-4 h-4 text-bone/40 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </div>
    </Link>
  );
};

export default WallHeaderButton;
