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
import { Link } from 'react-router-dom';
import type { Player, PlayerMedia as PlayerMediaType, Team } from '../../types';
import { mediaBelongsToPlayer } from '../../utils/mediaAttribution';
import HighlightHero from './HighlightHero';
import HighlightTopThreeRow from './HighlightTopThreeRow';
import HighlightRow from './HighlightRow';
import HighlightCardLite from './HighlightCardLite';
import PlayerAvatarRow from './PlayerAvatarRow';
import { SortKey } from './SortPill';
import NeedsCreditChip from './NeedsCreditChip';
import { GameFilterOption } from './GameFilterSheet';

interface Props {
  media: PlayerMediaType[];
  players: Player[];
  events: any[];
  /** Full-game recordings for the team. Rendered as a "Full Game"
   *  tile prepended to each per-game section whose opponent+date
   *  matches. Fuzzy match (opponent case-insensitive equal, date
   *  within 24h) since full_games doesn't carry an explicit
   *  eventId — a proper join would need a schema migration. */
  fullGames?: any[];
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

// Initial cap on the main grid. Parent-brain scans stall past ~10
// tiles, so we cut hard here and expose a full-expand "View all"
// button below the last card. Once expanded, we render every clip
// and the button vanishes — no incremental paging.
const GRID_INITIAL = 10;

// ────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────

const HighlightsNetflixTab: React.FC<Props> = ({
  media,
  players,
  events,
  fullGames,
  isUserCoach,
  selectedTeam,
  parentKidPlayerId,
  onFeatureClip,
  onOpenLightbox,
}) => {
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | 'all'>('all');
  const [selectedGameId, setSelectedGameId] = useState<string | 'all'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('recent');
  const [creditFilter, setCreditFilter] = useState(false);
  const [gridExpanded, setGridExpanded] = useState(false);
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

  // ── Game filter options ───────────────────────────────────────────
  // Derived from clips: any gameId a clip carries becomes a picker
  // row (if the event exists in `events` and is a real game). Sorted
  // by event date desc. If no clip has a gameId, the picker chip is
  // silent-hidden — an empty dropdown is useless.
  const gameOptions = useMemo<GameFilterOption[]>(() => {
    const clipGameIds = new Set<string>();
    for (const c of clips) {
      const gid = (c as any).gameId;
      if (typeof gid === 'string' && gid) clipGameIds.add(gid);
    }
    if (clipGameIds.size === 0) return [];
    const eventById = new Map<string, any>();
    for (const e of events || []) {
      if (e && e.id) eventById.set(e.id, e);
    }
    const out: GameFilterOption[] = [];
    // Array.from to sidestep the ts target's Set-iterator lint.
    for (const gid of Array.from(clipGameIds)) {
      const ev = eventById.get(gid);
      if (!ev) continue;
      // Games only (per PlayerMediaPage the events prop is already
      // filtered to game|event; tournaments come in as 'event' with
      // a non-empty opponent, so we accept those too).
      if (ev.type !== 'game' && ev.type !== 'tournament' && ev.type !== 'event') continue;
      const date: Date = ev.date instanceof Date ? ev.date : (ev.date?.toDate ? ev.date.toDate() : new Date(ev.date));
      if (!(date instanceof Date) || isNaN(date.getTime())) continue;
      // Skip 'event' rows that have no opponent — those are banquets /
      // team dinners, not something a parent would filter clips by.
      const opponent = String(ev.opponent || '').trim();
      if (ev.type !== 'game' && !opponent) continue;
      out.push({
        gameId: gid,
        opponent,
        title: String(ev.title || '').trim() || (opponent ? `vs ${opponent}` : 'Game'),
        date,
      });
    }
    out.sort((a, b) => b.date.getTime() - a.date.getTime());
    return out;
  }, [clips, events]);

  const selectedGame = useMemo(() => {
    if (selectedGameId === 'all') return null;
    return gameOptions.find(g => g.gameId === selectedGameId) || null;
  }, [gameOptions, selectedGameId]);

  // ── Needs-credit count (coach chip) ───────────────────────────────
  const needsCreditCount = useMemo(() => {
    if (!isUserCoach) return 0;
    let n = 0;
    for (const m of clips) if (needsCredit(m)) n++;
    return n;
  }, [clips, isUserCoach]);

  // ── Filter + sort logic for the main grid ─────────────────────────
  // Filters intersect: creditFilter (coach-only) short-circuits the
  // player filter (it's a mutex chip in the header), but the game
  // filter always applies on top so a coach can hunt for "unlabeled
  // clips from the Utah Rush game" without losing either lens.
  const gridClips = useMemo(() => {
    let list = clips;
    if (creditFilter && isUserCoach) {
      list = list.filter(needsCredit);
    } else if (selectedPlayerId !== 'all') {
      list = list.filter(m => mediaBelongsToPlayer(m, selectedPlayerId));
    }
    if (selectedGameId !== 'all') {
      list = list.filter(m => (m as any).gameId === selectedGameId);
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
  }, [clips, selectedPlayerId, selectedGameId, sortKey, creditFilter, isUserCoach]);

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
    setGridExpanded(false);
    if (id !== 'all') revealGrid();
  };

  const handleSelectGame = (id: string | 'all') => {
    setSelectedGameId(id);
    setGridExpanded(false);
    if (id !== 'all') revealGrid();
  };

  const selectedPlayer = useMemo(() => {
    if (selectedPlayerId === 'all') return null;
    return players.find(p => p.id === selectedPlayerId) || null;
  }, [players, selectedPlayerId]);

  const totalClips = clips.length;
  const visibleGrid = gridExpanded ? gridClips : gridClips.slice(0, GRID_INITIAL);
  const canExpand = gridClips.length > visibleGrid.length;

  // ── Game grouping ─────────────────────────────────────────────────
  // When we're in the default view (no player filter, no needs-credit
  // filter, no explicit game pick), chunk the clip wall into one
  // section per game. Rationale (2026-09-13, Patrick): a flat grid of
  // 28+ tiles reads as overwhelming on a phone; game sections let
  // parents scan "vs La Roca · 6 clips" then tap in. See all N → link
  // deep-links to the game event page's own Highlights section.
  //
  // gameId → {opponent, date, title, clips[]}. Falls back to "Other
  // clips" bucket for anything without a linked game (keeps them
  // reachable instead of silently dropping).
  const shouldGroupByGame = !creditFilter && selectedPlayerId === 'all' && selectedGameId === 'all' && sortKey === 'recent';
  const gameGroups = useMemo(() => {
    if (!shouldGroupByGame) return null;
    const byId = new Map<string, GameFilterOption>();
    for (const g of gameOptions) byId.set(g.gameId, g);
    const groups: Array<{
      key: string;
      meta: GameFilterOption | null;
      clips: PlayerMediaType[];
    }> = [];
    const groupIndex = new Map<string, number>();
    for (const clip of gridClips) {
      const gid = String((clip as any).gameId || '');
      const key = gid && byId.has(gid) ? gid : '__other__';
      let idx = groupIndex.get(key);
      if (idx == null) {
        idx = groups.length;
        groups.push({ key, meta: byId.get(key) || null, clips: [] });
        groupIndex.set(key, idx);
      }
      groups[idx].clips.push(clip);
    }
    // Order groups by most-recent game date; "Other" always last.
    groups.sort((a, b) => {
      if (a.key === '__other__') return 1;
      if (b.key === '__other__') return -1;
      const ad = a.meta?.date?.getTime() ?? 0;
      const bd = b.meta?.date?.getTime() ?? 0;
      return bd - ad;
    });
    return groups;
  }, [shouldGroupByGame, gridClips, gameOptions]);

  // Per-game display cap. Beyond this the group shows a "See all N →"
  // link that navigates to the game event's own Highlights section
  // (EventDetail.tsx renders EventHighlights on type='game' events).
  const GAME_GROUP_CAP = 6;

  // Match a game event to a full-game recording. full_games has
  // teamId + opponent + gameDate but no explicit eventId, so we
  // fuzzy-match on opponent (case-insensitive equal) + date within
  // 24h. Good enough for the common one-recording-per-game case;
  // false positives would require a coach to have TWO recordings
  // for the same opponent on the same day. Returns the first match.
  const fullGameForEvent = React.useMemo(() => {
    const list = fullGames || [];
    if (list.length === 0) return () => null;
    // Precompute the exact eventId → fullGame map. Preferred join when
    // the coach picked "Link to game event" on the Full Games form
    // (writes eventId on the doc). Fuzzy fallback below covers legacy
    // full_games written before the eventId field existed.
    const byEventId = new Map<string, any>();
    for (const fg of list) {
      const eid = String((fg as any).eventId || '');
      if (eid) byEventId.set(eid, fg);
    }
    return (ev: GameFilterOption | null): any | null => {
      if (!ev) return null;
      const exact = byEventId.get(ev.gameId);
      if (exact) return exact;
      const opp = String(ev.opponent || '').trim().toLowerCase();
      const eventMs = ev.date.getTime();
      const DAY_MS = 24 * 60 * 60 * 1000;
      for (const fg of list) {
        // Skip anything explicitly linked to a DIFFERENT event —
        // avoids fuzzy-hijacking a coach's explicit pick.
        if ((fg as any).eventId && (fg as any).eventId !== ev.gameId) continue;
        const fgOpp = String(fg.opponent || '').trim().toLowerCase();
        const fgDate: Date = fg.gameDate instanceof Date ? fg.gameDate : new Date(fg.gameDate);
        if (isNaN(fgDate.getTime())) continue;
        if (!opp && !fgOpp) {
          if (Math.abs(fgDate.getTime() - eventMs) < DAY_MS) return fg;
          continue;
        }
        if (opp && fgOpp && opp === fgOpp && Math.abs(fgDate.getTime() - eventMs) < DAY_MS) {
          return fg;
        }
      }
      return null;
    };
  }, [fullGames]);

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
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 mb-3">
              <div className="min-w-0 flex items-center gap-2 flex-wrap">
                <svg className="w-4 h-4 text-brand-primary shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <line x1="8" y1="4" x2="8" y2="20" />
                  <line x1="16" y1="4" x2="16" y2="20" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                </svg>
                {/* Header text reflects both filters when active. Pattern:
                    "PLAYER vs OPPONENT · N CLIPS", "vs OPPONENT · N CLIPS",
                    "PLAYER · N CLIPS", or "ALL CLIPS · N CLIPS". */}
                <span className="text-xs font-black uppercase tracking-widest text-brand-primary-soft truncate">
                  {(() => {
                    const parts: string[] = [];
                    if (selectedPlayer) parts.push(selectedPlayer.name || 'Player');
                    if (selectedGame) parts.push(`vs ${selectedGame.opponent || selectedGame.title}`);
                    if (parts.length === 0) return 'All clips';
                    return parts.join(' ');
                  })()}
                </span>
                <span aria-hidden className="text-xs font-bold text-brand-primary-soft/60">·</span>
                <span className="text-xs font-black uppercase tracking-widest text-brand-primary-soft/80 tabular-nums">
                  {(selectedPlayer || selectedGame)
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
              {/* Game filter dropdown + Sort dropdown removed 2026-09-13.
                  Game filtering is handled by the per-game groupings
                  below; recent is the only sort that matters on the
                  default view. Individual game / different sort still
                  reachable by picking a player (flat grid takes over). */}
            </div>

            {/* Main clip grid — sits IMMEDIATELY below the header so
                the count you just read matches the cards you scroll into.
                Layout branches on shouldGroupByGame: default view
                chunks by game (2026-09-13 mobile UX pass), any active
                filter falls back to the flat grid. */}
            {visibleGrid.length === 0 ? (
              <div className="text-center py-14 bg-surface-elevated rounded-xl border border-line-default/10">
                <p className="text-ink-primary font-bold">No clips match this view.</p>
                <button
                  type="button"
                  onClick={() => { setSelectedPlayerId('all'); setSelectedGameId('all'); setCreditFilter(false); setGridExpanded(false); }}
                  className="mt-3 text-sm font-bold text-brand-primary-soft hover:text-ink-primary"
                >
                  Show all clips
                </button>
              </div>
            ) : shouldGroupByGame && gameGroups && gameGroups.some(g => g.key !== '__other__') ? (
              <div className="space-y-5">
                {gameGroups.map(group => {
                  const shown = group.clips.slice(0, GAME_GROUP_CAP);
                  const overflow = group.clips.length - shown.length;
                  const isOther = group.key === '__other__';
                  const dateLabel = group.meta?.date
                    ? group.meta.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                    : '';
                  const opponentLabel = isOther
                    ? 'Other clips'
                    : `vs ${group.meta?.opponent || group.meta?.title || 'Opponent'}`;
                  // Full-game recording for this section (fuzzy match
                  // on opponent + date within 24h). Prepended as a
                  // wider hero-style tile so parents see "the whole
                  // game" before the individual moments.
                  const fg = !isOther ? fullGameForEvent(group.meta) : null;
                  const fgPoster = fg
                    ? (fg.youtubeId
                        ? `https://i.ytimg.com/vi/${fg.youtubeId}/hqdefault.jpg`
                        : (fg.videoUrl && (fg.videoUrl as string).endsWith('.jpg')) ? fg.videoUrl : '')
                    : '';
                  return (
                    <div key={group.key}>
                      {/* Section header: opponent · date · count. Reads
                          at a glance on a phone and gives each cluster
                          a mental anchor ("the La Roca game"). */}
                      <div className="flex items-baseline justify-between gap-2 mb-2 px-0.5">
                        <div className="min-w-0 flex items-baseline gap-1.5 flex-wrap">
                          <span className="text-sm font-black text-ink-primary truncate">{opponentLabel}</span>
                          {dateLabel && (
                            <span className="text-[11px] font-bold text-ink-primary/55 tabular-nums">· {dateLabel}</span>
                          )}
                          <span className="text-[11px] font-bold text-ink-primary/55 tabular-nums">
                            · {group.clips.length} {group.clips.length === 1 ? 'clip' : 'clips'}
                          </span>
                          {fg?.result && (
                            <span className="text-[11px] font-black text-brand-primary tabular-nums">· {fg.result}</span>
                          )}
                        </div>
                        {!isOther && group.meta && overflow > 0 && (
                          <Link
                            to={`/event/${group.key}`}
                            className="shrink-0 inline-flex items-center gap-0.5 text-[11px] font-black text-brand-primary hover:brightness-110 whitespace-nowrap"
                            aria-label={`See all ${group.clips.length} clips from ${opponentLabel}`}
                          >
                            See all {group.clips.length}
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <polyline points="9 6 15 12 9 18" />
                            </svg>
                          </Link>
                        )}
                      </div>
                      {/* Full-game tile: only when we matched a
                          full_games recording. Bigger + full-width so
                          it visually anchors the section — parents
                          see "the whole game" before individual clips. */}
                      {fg && (
                        <Link
                          to={`/full-games?game=${fg.id}`}
                          className="group block relative w-full aspect-video rounded-xl overflow-hidden bg-black ring-1 ring-brand-primary/40 mb-3 shadow-lg shadow-brand-primary/10 theme-ok"
                          aria-label={`Play full game vs ${fg.opponent || opponentLabel}`}
                        >
                          {fgPoster ? (
                            <img
                              src={fgPoster}
                              alt=""
                              aria-hidden
                              loading="lazy"
                              className="absolute inset-0 w-full h-full object-cover"
                            />
                          ) : (
                            <div className="absolute inset-0 bg-gradient-to-br from-brand-primary-dim to-black theme-ok" />
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-black/40 theme-ok" />
                          {/* Play glyph */}
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className="w-14 h-14 rounded-full bg-brand-primary flex items-center justify-center shadow-2xl ring-4 ring-white/20 group-hover:scale-105 transition theme-ok">
                              <svg className="w-6 h-6 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                                <polygon points="7 4 21 12 7 20 7 4" />
                              </svg>
                            </div>
                          </div>
                          {/* Top-left badge */}
                          <span className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-brand-primary text-white text-[10px] font-black uppercase tracking-widest ring-1 ring-white/25 theme-ok">
                            Full Game
                          </span>
                          {/* Bottom title */}
                          <div className="absolute inset-x-0 bottom-0 p-3">
                            <div className="text-white font-black text-sm truncate drop-shadow theme-ok">
                              {fg.title || `vs ${fg.opponent || opponentLabel}`}
                            </div>
                          </div>
                        </Link>
                      )}
                      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                        {shown.map(clip => (
                          <HighlightCardLite
                            key={clip.id}
                            clip={clip}
                            players={players}
                            onOpen={() => openClip(clip.id)}
                            fullWidth
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
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
                {canExpand && (
                  <button
                    type="button"
                    onClick={() => setGridExpanded(true)}
                    className="mt-4 w-full py-3 rounded-xl bg-surface-elevated ring-1 ring-line-default/20 text-sm font-black text-ink-primary hover:bg-line-default/10 focus:outline-none focus:ring-2 focus:ring-brand-primary/60 transition"
                  >
                    View all {gridClips.length} clips
                  </button>
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
                  setGridExpanded(false);
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
