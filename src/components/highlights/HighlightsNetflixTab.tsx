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
// Card taps open the inline lightbox on PlayerMediaPage (video/photo
// plays in a fixed-inset overlay, close x or tap-outside dismisses
// back to the Media page with scroll preserved). The vertical Reel is
// reached ONLY via the ReelKickr tab-bar entry on PlayerMediaPage;
// there is no card-to-Reel navigation from this tab.

import React, { useMemo, useRef, useState } from 'react';
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
  // Coach-only: flip featuredByCoach on a clip so it surfaces in the
  // "From Your Coach" rail. Wired by PlayerMediaPage to updateDocument
  // + optimistic setMedia. Rendered as a small ghost pill on eligible
  // grid cards so the coach doesn't have to dig into the lightbox
  // editor to promote a clip.
  onFeatureClip?: (clipId: string) => Promise<void> | void;
  // Card taps route through here so PlayerMediaPage can open its
  // existing inline lightbox (video/photo overlay + tag editor +
  // coach controls). Card taps never navigate to the vertical Reel;
  // that surface has its own tab-bar entry point.
  onOpenLightbox: (clipId: string) => void;
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
  onFeatureClip,
  onOpenLightbox,
}) => {
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
  // v6 change: hard-curated. The rail pulls ONLY clips where the coach
  // explicitly toggled featuredByCoach in the clip's edit menu. Legacy
  // clips without the field are silently excluded (no backfill; the
  // coach curates going forward). Ordered by featuredByCoachAt desc so
  // "pin this one now" pops to the front, with created-at as a
  // tiebreaker for the pre-timestamp trickle.
  //
  // The coachUidSet below is still computed because the coach-only
  // "Feature this" affordance on the main grid needs to know which
  // clips a coach uploaded (only those get the ghost prompt).
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
    const featured = clips.filter(m => (m as any).featuredByCoach === true);
    featured.sort((a, b) => {
      const at = toDate((a as any).featuredByCoachAt).getTime();
      const bt = toDate((b as any).featuredByCoachAt).getTime();
      const aValid = !isNaN(at);
      const bValid = !isNaN(bt);
      if (aValid && bValid && at !== bt) return bt - at;
      if (bValid && !aValid) return 1;
      if (aValid && !bValid) return -1;
      return toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime();
    });
    // Curated feed: bump from 5 to 8 since the coach hand-picks these.
    return featured.slice(0, 8);
  }, [clips]);

  // Coach-uploaded clip ids that are NOT yet featured. Used to render
  // a small "Feature this" ghost affordance on those cards for coach
  // viewers only — surfaces the mechanism without asking the coach to
  // hunt through the lightbox editor.
  const coachUnfeaturedIdSet = useMemo(() => {
    const s = new Set<string>();
    if (!isUserCoach) return s;
    for (const m of clips) {
      if ((m as any).featuredByCoach === true) continue;
      const role = (m as any).uploadedByRole;
      const isCoachClip = role === 'coach' || (!!m.uploadedBy && coachUidSet.has(m.uploadedBy));
      if (isCoachClip) s.add(m.id);
    }
    return s;
  }, [clips, coachUidSet, isUserCoach]);

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
    onOpenLightbox(clipId);
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

          {/* 3. Main-grid zone. Wrapped as a self-contained section so
              the "All clips / <player name>" surface reads as a distinct
              room the eye can land on when scrolling. Brand-red header
              bar spans full width; the grid itself sits on the plain
              base surface inside the zone so cards stay chrome-light. */}
          <section
            ref={gridSectionRef}
            className="rounded-2xl bg-brand-primary/[0.05] ring-1 ring-brand-primary/20 p-3 sm:p-4 mb-6"
          >
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="min-w-0 flex items-center gap-2 flex-wrap">
                <svg className="w-4 h-4 text-brand-primary shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <line x1="8" y1="4" x2="8" y2="20" />
                  <line x1="16" y1="4" x2="16" y2="20" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                </svg>
                <span className="text-xs font-black uppercase tracking-widest text-brand-primary-soft truncate">
                  {selectedPlayer ? (selectedPlayer.name || 'Player') : 'All clips'}
                </span>
                <span aria-hidden className="text-xs font-bold text-brand-primary-soft/60">·</span>
                <span className="text-xs font-black uppercase tracking-widest text-brand-primary-soft/80 tabular-nums">
                  {selectedPlayer
                    ? `${gridClips.length} ${gridClips.length === 1 ? 'clip' : 'clips'}`
                    : `${totalClips} ${totalClips === 1 ? 'clip' : 'clips'}`}
                </span>
                {selectedPlayer && (
                  <button
                    type="button"
                    onClick={() => handleSelectPlayer('all')}
                    className="inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-widest text-brand-primary-soft hover:text-ink-primary focus:outline-none focus:underline"
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
              {!creditFilter && (
                <div className="shrink-0">
                  <SortPill value={sortKey} onChange={(k) => { setSortKey(k); setGridLimit(GRID_PAGE); }} />
                </div>
              )}
            </div>

            {/* Main clip grid — sits IMMEDIATELY below the header so
                the count you just read matches the cards you scroll into. */}
            {visibleGrid.length === 0 ? (
              <div className="text-center py-14 bg-surface-elevated rounded-xl border border-line-default/10">
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
                  {visibleGrid.map(clip => {
                    // Coach-only ghost affordance: only render onFeature
                    // when the viewer is a coach, the parent wired the
                    // callback in, and this specific clip is coach-
                    // uploaded but not yet featured. Parents see nothing.
                    const showFeatureAffordance =
                      isUserCoach && !!onFeatureClip && coachUnfeaturedIdSet.has(clip.id);
                    return (
                      <HighlightCardLite
                        key={clip.id}
                        clip={clip}
                        players={players}
                        onOpen={() => openClip(clip.id)}
                        fullWidth
                        onFeature={showFeatureAffordance ? () => onFeatureClip!(clip.id) : undefined}
                      />
                    );
                  })}
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
          </section>

          {/* 4. Top 3 clips this season (silent-hide when < 3). Amber
              wash-card + trophy header signals the season-leaderboard
              tone. Distinct "room" from the main grid so the eye
              registers a section break without reading the label. */}
          {showTop3 && (
            <section className="rounded-2xl bg-amber-500/[0.07] ring-1 ring-amber-500/25 p-3 sm:p-4 mb-6">
              <div className="flex items-center gap-2 mb-3">
                <svg className="w-4 h-4 text-amber-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M8 21h8" />
                  <path d="M12 17v4" />
                  <path d="M7 4h10v4a5 5 0 0 1-10 0V4z" />
                  <path d="M17 6h2a2 2 0 0 1 0 4h-2.5" />
                  <path d="M7 6H5a2 2 0 0 0 0 4h2.5" />
                </svg>
                <span className="text-xs font-black uppercase tracking-widest text-amber-600 dark:text-amber-400">
                  Season highlights
                </span>
                <span aria-hidden className="text-xs font-bold text-amber-600/60 dark:text-amber-400/60">·</span>
                <span className="text-[11px] font-black uppercase tracking-widest text-amber-600/80 dark:text-amber-400/80 tabular-nums">
                  Top 3
                </span>
              </div>
              <HighlightTopThreeRow
                key="top3"
                clips={top3}
                players={players}
                onCardTap={openClip}
                title=""
              />
            </section>
          )}

          {/* 5. From Your Coach — cyan wash-card + whistle header
              separates coach-curated clips from the season
              leaderboard. Silent-hide when no coach has uploaded yet. */}
          {coachClips.length > 0 && (
            <section className="rounded-2xl bg-cyan-500/[0.07] ring-1 ring-cyan-500/25 p-3 sm:p-4 mb-6">
              <div className="flex items-center gap-2 mb-3">
                <svg className="w-4 h-4 text-cyan-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="10" cy="14" r="6" />
                  <path d="M16 8l4-4" />
                  <path d="M14 4h6v6" />
                </svg>
                <span className="text-xs font-black uppercase tracking-widest text-cyan-600 dark:text-cyan-400">
                  From your coach
                </span>
                <span aria-hidden className="text-xs font-bold text-cyan-600/60 dark:text-cyan-400/60">·</span>
                <span className="text-[11px] font-black uppercase tracking-widest text-cyan-600/80 dark:text-cyan-400/80 tabular-nums">
                  Curated
                </span>
              </div>
              <HighlightRow
                title=""
                clips={coachClips}
                players={players}
                onCardTap={openClip}
              />
            </section>
          )}

          {/* 7. Coach-only needs-credit chip banner. Kept last so the
              consumer-facing sections lead. */}
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
        </>
      )}
    </div>
  );
};

export default HighlightsNetflixTab;
