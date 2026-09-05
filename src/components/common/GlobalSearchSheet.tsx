import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';

// Cross-surface search for the current team. Opens from a header
// magnifying-glass icon and matches across:
//   - Players (roster by name)
//   - Events (past + upcoming by title/opponent)
//   - Wall posts (recent by content)
//
// Deliberately not searching chat messages here — that lives inside
// TeamChat as GlobalChatSearch, which scans per-thread subcollections
// and is expensive without a worker index. Wall + events + players
// cover the "where's that thing" ask 90% of the time; chat search
// stays on the Chat tab where the results can deep-link to a specific
// message.
//
// Data path: fetches a small window per collection when the sheet
// opens (not on every keystroke), then filters in-memory as the user
// types. Trades staleness (~1 minute at worst) for latency (results
// appear the instant you type). All queries are team-scoped so no
// cross-team leak.

interface Props {
  open: boolean;
  onClose: () => void;
  teamId: string | null;
  teamName?: string;
}

interface PlayerHit {
  id: string;
  name: string;
  jerseyNumber?: number;
  position?: string;
  profilePhotoUrl?: string;
  isActive: boolean;
}
interface EventHit {
  id: string;
  title: string;
  date: Date;
  type?: string;
  opponent?: string;
}
interface WallHit {
  id: string;
  content: string;
  senderName?: string;
  timestamp?: Date;
  postedFrom?: string;
}

const FETCH_LIMIT = 100;

const GlobalSearchSheet: React.FC<Props> = ({ open, onClose, teamId, teamName }) => {
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [players, setPlayers] = useState<PlayerHit[]>([]);
  const [events, setEvents] = useState<EventHit[]>([]);
  const [wall, setWall] = useState<WallHit[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Fetch team-scoped data windows when the sheet opens. Re-run when
  // the team changes so a switch mid-open sees the new team's data.
  useEffect(() => {
    if (!open || !teamId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [pSnap, eSnap, wSnap] = await Promise.all([
          getDocs(query(
            collection(db, 'players'),
            where('teamIds', 'array-contains', teamId),
            limit(FETCH_LIMIT),
          )).catch(() => null),
          getDocs(query(
            collection(db, 'events'),
            where('teamId', '==', teamId),
            orderBy('date', 'desc'),
            limit(FETCH_LIMIT),
          )).catch(() => null),
          getDocs(query(
            collection(db, 'wall_posts'),
            where('teamId', '==', teamId),
            orderBy('timestamp', 'desc'),
            limit(FETCH_LIMIT),
          )).catch(() => null),
        ]);
        if (cancelled) return;
        setPlayers((pSnap?.docs || []).map((d) => {
          const v: any = d.data();
          return {
            id: d.id,
            name: String(v.name || 'Player'),
            jerseyNumber: typeof v.jerseyNumber === 'number' ? v.jerseyNumber : undefined,
            position: v.position,
            profilePhotoUrl: v.profilePhotoUrl,
            isActive: v.isActive !== false,
          };
        }));
        setEvents((eSnap?.docs || []).map((d) => {
          const v: any = d.data();
          return {
            id: d.id,
            title: String(v.title || 'Event'),
            date: v.date?.toDate ? v.date.toDate() : new Date(v.date),
            type: v.type,
            opponent: v.opponent,
          };
        }));
        setWall((wSnap?.docs || []).map((d) => {
          const v: any = d.data();
          return {
            id: d.id,
            content: String(v.content || v.title || ''),
            senderName: v.senderName,
            timestamp: v.timestamp?.toDate ? v.timestamp.toDate() : (v.timestamp ? new Date(v.timestamp) : undefined),
            postedFrom: v.postedFrom,
          };
        }));
      } catch (err) {
        console.warn('[search] fetch failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, teamId]);

  // Auto-focus the input when the sheet opens.
  useEffect(() => {
    if (open && inputRef.current) {
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Reset query when the sheet closes so re-opening starts fresh.
  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return { players: [], events: [], wall: [], total: 0 };
    const playerHits = players
      .filter((p) => p.isActive)
      .filter((p) => p.name.toLowerCase().includes(needle) || String(p.jerseyNumber || '').includes(needle))
      .slice(0, 10);
    const eventHits = events
      .filter((e) =>
        (e.title || '').toLowerCase().includes(needle)
        || (e.opponent || '').toLowerCase().includes(needle)
      )
      .slice(0, 10);
    const wallHits = wall
      .filter((w) => (w.content || '').toLowerCase().includes(needle))
      .slice(0, 10);
    return {
      players: playerHits,
      events: eventHits,
      wall: wallHits,
      total: playerHits.length + eventHits.length + wallHits.length,
    };
  }, [q, players, events, wall]);

  if (!open || typeof document === 'undefined') return null;

  const highlight = (text: string) => {
    const needle = q.trim();
    if (!needle) return text;
    const idx = text.toLowerCase().indexOf(needle.toLowerCase());
    if (idx < 0) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-brand-primary/25 text-ink-primary rounded px-0.5">
          {text.slice(idx, idx + needle.length)}
        </mark>
        {text.slice(idx + needle.length)}
      </>
    );
  };

  const snippet = (text: string, len = 80) => {
    const clean = (text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const needle = q.trim().toLowerCase();
    if (!needle) return clean.slice(0, len);
    const idx = clean.toLowerCase().indexOf(needle);
    if (idx < 0) return clean.slice(0, len);
    const start = Math.max(0, idx - 20);
    const end = Math.min(clean.length, idx + needle.length + len);
    return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '');
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 backdrop-blur-sm animate-fade-in" /* theme-ok: modal backdrop */
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="mt-safe-or-4 w-full sm:max-w-lg mx-2 sm:mx-0 bg-surface-elevated rounded-2xl ring-1 ring-line-default/15 shadow-2xl overflow-hidden animate-slide-down"
        style={{ marginTop: 'max(env(safe-area-inset-top), 16px)' }}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line-default/10">
          <svg className="w-5 h-5 text-ink-primary/45 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={teamName ? `Search ${teamName}` : 'Search this team'}
            className="flex-1 bg-transparent text-ink-primary placeholder:text-ink-primary/40 text-base font-medium outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] font-black uppercase tracking-widest text-ink-primary/50 hover:text-ink-primary"
          >
            Close
          </button>
        </div>

        {/* Results */}
        <div className="max-h-[70vh] overflow-y-auto">
          {!q.trim() && (
            <div className="px-5 py-10 text-center">
              <p className="text-sm text-ink-primary/60">
                Search across players, events, and Team Wall.
              </p>
              <p className="text-xs text-ink-primary/40 mt-2">
                Type a name, opponent, or a keyword.
              </p>
            </div>
          )}
          {q.trim() && loading && results.total === 0 && (
            <div className="px-5 py-8 text-center">
              <p className="text-xs text-ink-primary/45">Loading team…</p>
            </div>
          )}
          {q.trim() && !loading && results.total === 0 && (
            <div className="px-5 py-10 text-center">
              <p className="text-sm text-ink-primary/60">No matches on this team.</p>
              <p className="text-xs text-ink-primary/40 mt-1">
                Chat messages live in the Chat tab's own search.
              </p>
            </div>
          )}

          {results.players.length > 0 && (
            <SearchSection label="Players">
              {results.players.map((p) => (
                <Link
                  key={p.id}
                  to={`/player/${p.id}`}
                  onClick={onClose}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-line-default/[0.05] transition"
                >
                  {p.profilePhotoUrl ? (
                    <img src={p.profilePhotoUrl} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-line-default/15 text-ink-primary/60 text-xs font-bold flex items-center justify-center shrink-0">
                      {p.name.charAt(0)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink-primary truncate">
                      {highlight(p.name)}
                    </p>
                    {(p.jerseyNumber !== undefined || p.position) && (
                      <p className="text-[11px] text-ink-primary/50 truncate">
                        {p.jerseyNumber !== undefined ? `#${p.jerseyNumber}` : ''}
                        {p.jerseyNumber !== undefined && p.position ? ' · ' : ''}
                        {p.position || ''}
                      </p>
                    )}
                  </div>
                </Link>
              ))}
            </SearchSection>
          )}

          {results.events.length > 0 && (
            <SearchSection label="Events">
              {results.events.map((e) => (
                <Link
                  key={e.id}
                  to={`/events/${e.id}`}
                  onClick={onClose}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-line-default/[0.05] transition"
                >
                  <span className="w-8 h-8 rounded-lg bg-brand-primary/15 text-brand-primary-soft flex items-center justify-center shrink-0">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <rect x="3" y="4" width="18" height="18" rx="2" />
                      <line x1="16" y1="2" x2="16" y2="6" />
                      <line x1="8" y1="2" x2="8" y2="6" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink-primary truncate">
                      {highlight(e.title)}
                    </p>
                    <p className="text-[11px] text-ink-primary/50 truncate">
                      {e.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                    </p>
                  </div>
                </Link>
              ))}
            </SearchSection>
          )}

          {results.wall.length > 0 && (
            <SearchSection label="Team Wall">
              {results.wall.map((w) => (
                <Link
                  key={w.id}
                  to={`/wall?post=${encodeURIComponent(w.id)}`}
                  onClick={onClose}
                  className="flex items-start gap-3 px-4 py-2.5 hover:bg-line-default/[0.05] transition"
                >
                  <span className="mt-0.5 w-8 h-8 rounded-lg bg-brand-primary/15 text-brand-primary-soft flex items-center justify-center shrink-0">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <path d="M4 22V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16" />
                      <line x1="4" y1="10" x2="20" y2="10" />
                      <line x1="10" y1="4" x2="10" y2="22" />
                    </svg>
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-ink-primary line-clamp-2 leading-snug">
                      {highlight(snippet(w.content, 90))}
                    </p>
                    {(w.senderName || w.timestamp) && (
                      <p className="text-[11px] text-ink-primary/50 truncate mt-0.5">
                        {w.senderName || ''}
                        {w.senderName && w.timestamp ? ' · ' : ''}
                        {w.timestamp ? w.timestamp.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}
                      </p>
                    )}
                  </div>
                </Link>
              ))}
            </SearchSection>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

const SearchSection: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <div className="px-4 pt-3 pb-1 text-[10px] font-black uppercase tracking-widest text-ink-primary/45">
      {label}
    </div>
    <ul className="divide-y divide-line-default/5">
      {children}
    </ul>
  </div>
);

export default GlobalSearchSheet;
