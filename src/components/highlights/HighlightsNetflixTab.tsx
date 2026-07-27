// Body of the Highlights tab on the Media page.
//
// Trimmed 2026-07-25 (was Netflix-rows v1): only the hero, a browse-
// by-player avatar row, a Top-3 season row, an optional coach chip,
// a sort dropdown, and a single main grid remain. All the redundant
// "Most X" strips + "This Week" + "Last Match" + "Kid This Season"
// rows are gone — the avatar row filters per-player and the sort
// pill handles the rankings.
//
// Every mutation is derived from the already-loaded team media +
// players. No new Firestore queries, no new composite indexes.
//
// Card taps navigate to /highlights?clip=<id> so the vertical Reel
// opens on that exact clip — unifies tab-consumption and reel-
// consumption per spec.

import React, { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Player, PlayerMedia as PlayerMediaType, Team } from '../../types';
import { mediaBelongsToPlayer } from '../../utils/mediaAttribution';
import HighlightHero from './HighlightHero';
import HighlightTopThreeRow from './HighlightTopThreeRow';
import HighlightRow from './HighlightRow';
import HighlightCardLite from './HighlightCardLite';
import PlayerAvatarRow from './PlayerAvatarRow';
import SortPill, { SortKey } from './SortPill';
import NeedsCreditChip from './NeedsCreditChip';

interface Props {
  media: PlayerMediaType[];
  players: Player[];
  events: any[];
  canManageMedia: boolean;
  isUserCoach: boolean;
  selectedTeam: Team | null;
  // Parent's linked player id (auto-derived by PlayerMediaPage). Null
  // for coaches, admin views, or parents whose kid isn't on this team.
  parentKidPlayerId: string | null;
}

// ────────────────────────────────────────────────────────────────────
// Small helpers (kept local; the file is the only consumer)
// ────────────────────────────────────────────────────────────────────

function toDate(v: any): Date {
  if (!v) return new Date(NaN);
  if (v instanceof Date) return v;
  if (v?.toDate) return v.toDate();
  return new Date(v);
}

function isKidClip(m: PlayerMediaType, kidId: string): boolean {
  return mediaBelongsToPlayer(m, kidId);
}

// "Needs credit" = an unclassified video the coach hasn't tagged with
// anything (no moment, no scorer, no assist). Own goals stay exempt
// (explicitly classified even without a scorer).
function needsCredit(m: PlayerMediaType): boolean {
  if (m.type !== 'video') return false;
  if (m.isOwnGoal) return false;
  if (m.momentType) return false;
  if (m.goalScorerId) return false;
  if (Array.isArray(m.assistByIds) && m.assistByIds.length > 0) return false;
  return true;
}

const GRID_PAGE = 60;

// ────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────

const HighlightsNetflixTab: React.FC<Props> = ({
  media,
  players,
  isUserCoach,
  selectedTeam,
  parentKidPlayerId,
}) => {
  const navigate = useNavigate();
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | 'all'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('recent');
  const [creditFilter, setCreditFilter] = useState(false);
  const [gridLimit, setGridLimit] = useState(GRID_PAGE);
  // Ref to the grid section so we can smooth-scroll to it after a
  // player is picked from the avatar row. Without this the filter
  // takes effect way below the fold and reads as "nothing happened".
  const gridSectionRef = useRef<HTMLDivElement | null>(null);

  // Media pre-conditioned: normalize createdAt to a Date and drop
  // dead placeholders. Sorted newest-first as the default order.
  const clips = useMemo(() => {
    return media
      .filter(m => !!m.url || !!m.streamUid)
      .map(m => ({ ...m, createdAt: toDate(m.createdAt) as any } as PlayerMediaType))
      .sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime());
  }, [media]);

  // ── Hero ──────────────────────────────────────────────────────────
  const heroInfo = useMemo(() => {
    if (isUserCoach) {
      const needy = clips.find(needsCredit);
      if (needy) return { clip: needy, label: 'Needs your caption', tone: 'attention' as const };
      const newest = clips.find(m => m.type === 'video');
      return { clip: newest || clips[0] || null, label: newest ? 'Newest' : undefined, tone: 'default' as const };
    }
    if (parentKidPlayerId) {
      const kidClip = clips.find(m => m.type === 'video' && isKidClip(m, parentKidPlayerId));
      if (kidClip) return { clip: kidClip, label: 'Newest', tone: 'default' as const };
      const kidAny = clips.find(m => isKidClip(m, parentKidPlayerId));
      if (kidAny) return { clip: kidAny, label: 'Newest', tone: 'default' as const };
    }
    const teamVid = clips.find(m => m.type === 'video');
    if (teamVid) return { clip: teamVid, label: 'Newest', tone: 'default' as const };
    return { clip: clips[0] || null, label: undefined, tone: 'default' as const };
  }, [clips, isUserCoach, parentKidPlayerId]);

  // ── Top 3 this season (by view count) ─────────────────────────────
  // View count is the most stable engagement metric — likes are lower-
  // volume, downloads are heavily-skewed by parent-of-featured-kid.
  // Silent-hide when fewer than 3 clips have any views.
  const top3 = useMemo(() => {
    const withViews = clips.filter(m => (m.viewCount || 0) > 0);
    withViews.sort((a, b) => {
      const va = a.viewCount || 0;
      const vb = b.viewCount || 0;
      if (vb !== va) return vb - va;
      return toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime();
    });
    return withViews.slice(0, 3);
  }, [clips]);
  const showTop3 = top3.length >= 3;

  // ── From Your Coach strip (available to every viewer) ────────────
  // Set of uids treated as "coach" for uploader-attribution. Includes
  // coachIds, headCoachId (mirrored into coachIds elsewhere but check
  // both defensively), and assistantCoachIds so an assistant's clips
  // still land in the row.
  const coachUidSet = useMemo(() => {
    const s = new Set<string>();
    const t = selectedTeam as any;
    if (!t) return s;
    if (Array.isArray(t.coachIds)) for (const u of t.coachIds) if (u) s.add(u);
    if (Array.isArray(t.assistantCoachIds)) for (const u of t.assistantCoachIds) if (u) s.add(u);
    if (t.headCoachId) s.add(t.headCoachId);
    return s;
  }, [selectedTeam]);

  const coachClips = useMemo(() => {
    if (coachUidSet.size === 0) return [];
    const list = clips.filter(m => {
      const role = (m as any).uploadedByRole;
      if (role === 'coach') return true;
      return !!m.uploadedBy && coachUidSet.has(m.uploadedBy);
    });
    // Already newest-first from `clips` sort; slice to the top 5 so
    // the strip stays scannable and doesn't recreate the full grid.
    return list.slice(0, 5);
  }, [clips, coachUidSet]);

  // ── Needs-credit count (coach chip) ───────────────────────────────
  const needsCreditCount = useMemo(() => {
    if (!isUserCoach) return 0;
    let n = 0;
    for (const m of clips) if (needsCredit(m)) n++;
    return n;
  }, [clips, isUserCoach]);

  // ── Filter + sort logic for the main grid ─────────────────────────
  const gridClips = useMemo(() => {
    let list = clips;
    if (creditFilter && isUserCoach) {
      list = list.filter(needsCredit);
    } else if (selectedPlayerId !== 'all') {
      list = list.filter(m => mediaBelongsToPlayer(m, selectedPlayerId));
    }
    const sorted = list.slice();
    switch (sortKey) {
      case 'liked':
        sorted.sort((a, b) => {
          const d = (b.likeCount || 0) - (a.likeCount || 0);
          if (d !== 0) return d;
          return toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime();
        });
        break;
      case 'viewed':
        sorted.sort((a, b) => {
          const d = (b.viewCount || 0) - (a.viewCount || 0);
          if (d !== 0) return d;
          return toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime();
        });
        break;
      case 'downloaded':
        sorted.sort((a, b) => {
          const d = (b.downloadCount || 0) - (a.downloadCount || 0);
          if (d !== 0) return d;
          return toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime();
        });
        break;
      case 'recent':
      default:
        sorted.sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime());
        break;
    }
    return sorted;
  }, [clips, selectedPlayerId, sortKey, creditFilter, isUserCoach]);

  const openClip = (clipId: string) => {
    navigate(`/highlights?clip=${encodeURIComponent(clipId)}`);
  };

  // Player-tap feedback: bring the grid into view so the user sees
  // the filter actually applied. Skips the scroll when the grid is
  // already comfortably in the viewport (avoids jarring jumps when
  // toggling between adjacent avatars on a large screen).
  const revealGrid = () => {
    const el = gridSectionRef.current;
    if (!el) return;
    // rAF so the state update + chip re-render commit before we
    // measure the grid's new top position.
    requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      // "Comfortably visible" = top edge is somewhere in the upper
      // 60% of the viewport. Anywhere below that and the user won't
      // see the chip flash in without a scroll.
      const alreadyVisible = rect.top >= 0 && rect.top < vh * 0.6;
      if (alreadyVisible) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const handleSelectPlayer = (id: string | 'all') => {
    setSelectedPlayerId(id);
    setCreditFilter(false);
    setGridLimit(GRID_PAGE);
    if (id !== 'all') revealGrid();
  };

  const selectedPlayer = useMemo(() => {
    if (selectedPlayerId === 'all') return null;
    return players.find(p => p.id === selectedPlayerId) || null;
  }, [players, selectedPlayerId]);

  const totalClips = clips.length;
  const visibleGrid = gridClips.slice(0, gridLimit);
  const canLoadMore = gridClips.length > visibleGrid.length;

  return (
    <div className="relative">
      {totalClips === 0 ? (
        <div className="relative overflow-hidden text-center py-12 sm:py-16 bg-surface-elevated rounded-2xl border border-line-default/10 shadow-sm">
          <div aria-hidden className="absolute -top-16 -right-16 w-48 h-48 bg-brand-primary/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 text-brand-primary-soft flex items-center justify-center mb-4">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
            </div>
            <h3 className="text-lg font-black text-ink-primary">
              {isUserCoach ? 'The team highlight reel starts here' : 'Photos and clips will land here'}
            </h3>
            <p className="text-sm text-ink-primary/60 mt-1.5 max-w-xs mx-auto leading-snug">
              {isUserCoach
                ? 'Drop in photos or short clips. Parents get a notification the moment their kid shows up in one.'
                : 'Your coach will start sharing clips. Every one that features your kid gets pushed to you.'}
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* 1. Hero */}
          <HighlightHero
            clip={heroInfo.clip}
            players={players}
            onOpen={() => heroInfo.clip && openClip(heroInfo.clip.id)}
            label={heroInfo.label}
            labelTone={heroInfo.tone}
          />

          {/* 2. Player avatar row (also the primary filter for the grid) */}
          <PlayerAvatarRow
            players={players}
            media={clips}
            selectedPlayerId={selectedPlayerId}
            onSelect={handleSelectPlayer}
          />

          {/* 2b. Selected-player section header — sits directly under
              the avatars so the current filter is obvious without the
              old sticky chip clobbering scroll. When "All" is active
              this is a lightweight all-clips label. */}
          <div className="flex items-center justify-between gap-3 mb-4 px-1">
            <div className="min-w-0 flex items-baseline gap-2 truncate">
              <span className="text-xs font-black uppercase tracking-widest text-ink-primary truncate">
                {selectedPlayer ? (selectedPlayer.name || 'Player') : 'All clips'}
              </span>
              <span aria-hidden className="text-xs font-bold text-ink-secondary/70">·</span>
              <span className="text-xs font-black uppercase tracking-widest text-ink-secondary/80 tabular-nums">
                {selectedPlayer
                  ? `${gridClips.length} ${gridClips.length === 1 ? 'clip' : 'clips'}`
                  : `${totalClips} ${totalClips === 1 ? 'clip' : 'clips'}`}
              </span>
            </div>
            {selectedPlayer && (
              <button
                type="button"
                onClick={() => handleSelectPlayer('all')}
                className="shrink-0 inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-widest text-brand-primary-soft hover:text-ink-primary focus:outline-none focus:underline"
                aria-label="Clear player filter"
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                <span>Show all</span>
              </button>
            )}
          </div>

          {/* 3. Top 3 clips this season (silent-hide when < 3) */}
          {showTop3 && (
            <HighlightTopThreeRow
              key="top3"
              clips={top3}
              players={players}
              onCardTap={openClip}
            />
          )}

          {/* 3b. From Your Coach — the 5 most-recent clips uploaded by
              a coach on this team. Silent-hide when there are none
              (parent-only teams, or before any coach has uploaded). */}
          {coachClips.length > 0 && (
            <HighlightRow
              title="From Your Coach"
              clips={coachClips}
              players={players}
              onCardTap={openClip}
            />
          )}

          {/* 4. Coach-only needs-credit chip banner */}
          {isUserCoach && needsCreditCount > 0 && (
            <div className="mb-3">
              <NeedsCreditChip
                count={needsCreditCount}
                active={creditFilter}
                onTap={() => {
                  setCreditFilter(v => !v);
                  setGridLimit(GRID_PAGE);
                }}
              />
            </div>
          )}

          {/* 5. Sort pill (right-aligned) — hidden while credit filter
              is active because sort is meaningless for that queue. */}
          {!creditFilter && (
            <div className="flex items-center justify-end mb-3 px-1">
              <SortPill value={sortKey} onChange={(k) => { setSortKey(k); setGridLimit(GRID_PAGE); }} />
            </div>
          )}

          {/* 6. Main clip grid (with a sticky "you filtered to X" chip
              at its top edge so the user sees the filter took hold as
              soon as the scroll lands them here). */}
          <div ref={gridSectionRef}>
          {/* Sticky "you filtered to X" chip removed 2026-07-26 — the
              section header directly under the avatar row now carries
              the same information without hijacking scroll. */}
          {visibleGrid.length === 0 ? (
            <div className="text-center py-14 bg-surface-elevated rounded-2xl border border-line-default/10">
              <p className="text-ink-primary font-bold">No clips match this view.</p>
              <button
                type="button"
                onClick={() => { setSelectedPlayerId('all'); setCreditFilter(false); }}
                className="mt-3 text-sm font-bold text-brand-primary-soft hover:text-ink-primary"
              >
                Show all clips
              </button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                {visibleGrid.map(clip => (
                  <HighlightCardLite
                    key={clip.id}
                    clip={clip}
                    players={players}
                    onOpen={() => openClip(clip.id)}
                    fullWidth
                  />
                ))}
              </div>
              {canLoadMore && (
                <div className="flex justify-center mt-6">
                  <button
                    type="button"
                    onClick={() => setGridLimit(n => n + GRID_PAGE)}
                    className="px-4 py-2 rounded-full bg-surface-elevated ring-1 ring-line-default/20 text-sm font-bold text-ink-primary hover:bg-line-default/10"
                  >
                    Load more
                  </button>
                </div>
              )}
            </>
          )}
          </div>
        </>
      )}
    </div>
  );
};

export default HighlightsNetflixTab;
