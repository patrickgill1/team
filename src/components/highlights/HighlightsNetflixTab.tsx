// Netflix-style body for the Highlights tab on the Media page.
//
// Data model: everything is derived from the ALREADY-LOADED team media
// + events + players lists passed down from PlayerMediaPage. No new
// Firestore queries, no new composite indexes.
//
// Row order is FIXED (see design doc). Parent view starts with the
// hero on their kid; coach view starts with the newest team clip,
// preferring an unclassified "needs credit" clip when one exists.
// Every row silent-hides on zero clips.
//
// The filter sheet, when active, collapses the row stack into a
// single flat grid of matching clips so the picker "does something."
//
// Card taps navigate to /highlights?clip=<id> so the vertical Reel
// opens on that exact clip — unifies tab-consumption + reel-
// consumption per spec.

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Player, PlayerMedia as PlayerMediaType, Team } from '../../types';
import { getActiveSeasonForTeam } from '../../utils/seasons';
import { mediaBelongsToPlayer } from '../../utils/mediaAttribution';
import HighlightHero from './HighlightHero';
import HighlightRow from './HighlightRow';
import HighlightCardLite from './HighlightCardLite';
import HighlightFilterSheet, {
  EMPTY_FILTER,
  FilterState,
  isFilterActive,
} from './HighlightFilterSheet';

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

const DAY_MS = 24 * 3600 * 1000;

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
// anything (no moment, no scorer, no assist). Broad reading per spec
// note — captures the whole curation queue. Own goals still exempt
// (they're explicitly classified even without a scorer).
function needsCredit(m: PlayerMediaType): boolean {
  if (m.type !== 'video') return false;
  if (m.isOwnGoal) return false;
  if (m.momentType) return false;
  if (m.goalScorerId) return false;
  if (Array.isArray(m.assistByIds) && m.assistByIds.length > 0) return false;
  return true;
}

interface RowInput {
  key: string;
  title: string;
  subtitle?: string;
  clips: PlayerMediaType[];
}

// ────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────

const MAX_ROW_CLIPS = 24;

const HighlightsNetflixTab: React.FC<Props> = ({
  media,
  players,
  events,
  isUserCoach,
  selectedTeam,
  parentKidPlayerId,
}) => {
  const navigate = useNavigate();
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [seasonStart, setSeasonStart] = useState<Date | null>(null);
  const [seasonId, setSeasonId] = useState<string | null>(null);

  // Resolve the active season for the team once per team change. Used
  // for the "This Season" and season-scoped rows (belt-and-suspenders:
  // match by seasonId OR fall back to createdAt >= seasonStart so pre-
  // withSeasonId clips still surface).
  useEffect(() => {
    let cancelled = false;
    const teamId = selectedTeam?.id;
    if (!teamId) {
      setSeasonStart(null);
      setSeasonId(null);
      return;
    }
    (async () => {
      try {
        const season = await getActiveSeasonForTeam(teamId);
        if (cancelled) return;
        if (season) {
          setSeasonId(season.id);
          setSeasonStart(season.startDate instanceof Date ? season.startDate : new Date(season.startDate));
        } else {
          // No season configured — fall back to a rolling 6-month
          // window (mirrors the legacy "seasonStart" heuristic on
          // PlayerMediaPage).
          setSeasonId(null);
          const d = new Date();
          d.setMonth(d.getMonth() - 6);
          setSeasonStart(d);
        }
      } catch {
        if (!cancelled) {
          setSeasonId(null);
          const d = new Date();
          d.setMonth(d.getMonth() - 6);
          setSeasonStart(d);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeam?.id]);

  // Media pre-conditioned: normalize createdAt to a Date and filter
  // out anything without a URL (dead placeholder). Sorted newest-
  // first so all downstream slices inherit the order.
  const clips = useMemo(() => {
    return media
      .filter(m => !!m.url || !!m.streamUid)
      .map(m => ({ ...m, createdAt: toDate(m.createdAt) as any } as PlayerMediaType))
      .sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime());
  }, [media]);

  // Season predicate. Clip counts as in-season if it has the active
  // seasonId stamped OR (no seasonId AND createdAt >= seasonStart).
  const inSeason = React.useCallback((m: PlayerMediaType): boolean => {
    if (seasonId && (m as any).seasonId === seasonId) return true;
    if (!(m as any).seasonId && seasonStart && toDate(m.createdAt) >= seasonStart) return true;
    return false;
  }, [seasonId, seasonStart]);

  // ── Row: Hero ─────────────────────────────────────────────────────
  const heroInfo = useMemo(() => {
    if (isUserCoach) {
      // Coach: prefer a needs-credit clip so the queue surfaces at eye
      // level. Fall back to the newest team video.
      const needy = clips.find(needsCredit);
      if (needy) return { clip: needy, label: 'Needs your caption', tone: 'attention' as const };
      const newest = clips.find(m => m.type === 'video');
      return { clip: newest || clips[0] || null, label: newest ? 'Newest' : undefined, tone: 'default' as const };
    }
    // Parent view: hero is the newest clip credited to their kid; if
    // none, the newest team video overall; if only photos exist, the
    // newest photo.
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

  const heroClipId = heroInfo.clip?.id || null;

  // ── Row: Kid's This Season / Coach's This Week ────────────────────
  const primaryPlayerRow = useMemo<RowInput | null>(() => {
    if (isUserCoach) {
      const cutoff = Date.now() - 7 * DAY_MS;
      const items = clips
        .filter(m => m.type === 'video' && toDate(m.createdAt).getTime() >= cutoff)
        .filter(m => m.id !== heroClipId)
        .slice(0, MAX_ROW_CLIPS);
      return { key: 'this-week', title: 'This Week', clips: items };
    }
    if (!parentKidPlayerId) return null;
    const kid = players.find(p => p.id === parentKidPlayerId);
    const first = kid?.name?.split(' ')[0] || 'Your kid';
    const items = clips
      .filter(m => isKidClip(m, parentKidPlayerId) && inSeason(m))
      .filter(m => m.id !== heroClipId)
      .slice(0, MAX_ROW_CLIPS);
    return { key: 'kid-season', title: `${first} This Season`, clips: items };
  }, [isUserCoach, clips, parentKidPlayerId, players, heroClipId, inSeason]);

  // ── Row: Last Match ───────────────────────────────────────────────
  const lastMatchRow = useMemo<RowInput | null>(() => {
    if (!selectedTeam?.id) return null;
    const now = Date.now();
    const games = (events || [])
      .filter(e => e && e.teamId === selectedTeam.id && e.type === 'game' && e.isActive !== false)
      .map(e => ({ id: e.id, date: toDate(e.date), opponent: e.opponent || e.title || 'Game' }))
      .filter(g => g.date instanceof Date && !isNaN(g.date.getTime()) && g.date.getTime() <= now)
      .sort((a, b) => b.date.getTime() - a.date.getTime());
    const game = games[0];
    if (!game) return null;
    const items = clips
      .filter(m => m.gameId === game.id)
      .filter(m => m.id !== heroClipId)
      .slice(0, MAX_ROW_CLIPS);
    return {
      key: 'last-match',
      title: `Last Match: vs ${game.opponent}`,
      subtitle: game.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      clips: items,
    };
  }, [events, selectedTeam?.id, clips, heroClipId]);

  // ── Row: Needs Credit (coach-only) ────────────────────────────────
  const needsCreditRow = useMemo<RowInput | null>(() => {
    if (!isUserCoach) return null;
    const items = clips
      .filter(needsCredit)
      .filter(m => m.id !== heroClipId)
      .slice(0, MAX_ROW_CLIPS);
    return { key: 'needs-credit', title: 'Needs Credit', subtitle: 'Tap to add a scorer, assister, or moment tag', clips: items };
  }, [isUserCoach, clips, heroClipId]);

  // ── Rows: Most Liked / Viewed / Downloaded (season-scoped) ────────
  const mostLikedRow = useMemo<RowInput>(() => {
    const items = clips
      .filter(m => inSeason(m) && (m.likeCount || 0) > 0)
      .slice()
      .sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0))
      .slice(0, 15);
    return { key: 'most-liked', title: 'Most Liked', clips: items };
  }, [clips, inSeason]);

  const mostViewedRow = useMemo<RowInput>(() => {
    const items = clips
      .filter(m => inSeason(m) && (m.viewCount || 0) > 0)
      .slice()
      .sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0))
      .slice(0, 15);
    return { key: 'most-viewed', title: 'Most Viewed', clips: items };
  }, [clips, inSeason]);

  const mostDownloadedRow = useMemo<RowInput>(() => {
    const items = clips
      .filter(m => inSeason(m) && (m.downloadCount || 0) > 0)
      .slice()
      .sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0))
      .slice(0, 15);
    return { key: 'most-downloaded', title: 'Most Downloaded', clips: items };
  }, [clips, inSeason]);

  // ── Filtered flat list (when the sheet has an active filter) ──────
  const filteredClips = useMemo(() => {
    if (!isFilterActive(filter)) return clips;
    const cutoff7 = Date.now() - 7 * DAY_MS;
    const cutoff30 = Date.now() - 30 * DAY_MS;
    const q = filter.searchQuery.trim().toLowerCase();
    return clips.filter(m => {
      if (filter.playerId && !mediaBelongsToPlayer(m, filter.playerId)) return false;
      switch (filter.contentType) {
        case 'goal':
          if (m.momentType !== 'goal') return false;
          break;
        case 'assist':
          if (m.momentType !== 'assist') return false;
          break;
        case 'big_play':
          if (m.momentType !== 'big_play') return false;
          break;
        case 'highlight':
          if (!m.momentType) return false;
          break;
        case 'photo':
          if (m.type !== 'photo') return false;
          break;
        case 'all':
        default:
          break;
      }
      const created = toDate(m.createdAt).getTime();
      switch (filter.dateRange) {
        case '7d':  if (created < cutoff7)  return false; break;
        case '30d': if (created < cutoff30) return false; break;
        case 'season':
          if (!inSeason(m)) return false;
          break;
        case 'all':
        default:
          break;
      }
      if (q) {
        const hay = [
          m.caption,
          m.playerName,
          m.fileName,
          ...(m.tags || []),
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [clips, filter, inSeason]);

  const openClip = (clipId: string) => {
    navigate(`/highlights?clip=${encodeURIComponent(clipId)}`);
  };

  const filterActive = isFilterActive(filter);
  const activeCount =
    (filter.playerId ? 1 : 0) +
    (filter.contentType !== 'all' ? 1 : 0) +
    (filter.dateRange !== 'all' ? 1 : 0) +
    (filter.searchQuery.trim() ? 1 : 0);

  // ── Ordered row list ──────────────────────────────────────────────
  const orderedRows: RowInput[] = useMemo(() => {
    const rows: (RowInput | null)[] = isUserCoach
      ? [primaryPlayerRow, lastMatchRow, needsCreditRow, mostLikedRow, mostViewedRow, mostDownloadedRow]
      : [primaryPlayerRow, lastMatchRow, mostLikedRow, mostViewedRow, mostDownloadedRow];
    return rows.filter((r): r is RowInput => !!r && r.clips.length > 0);
  }, [isUserCoach, primaryPlayerRow, lastMatchRow, needsCreditRow, mostLikedRow, mostViewedRow, mostDownloadedRow]);

  // Empty-state: no media at all on the team. Warm coach vs parent
  // copy — mirrors what the legacy page did but stripped of chrome.
  const totalClips = clips.length;

  return (
    <div className="relative">
      {/* Top chrome: single Filter button. Absolute right — sits above
          the hero corner without eating vertical space. */}
      <div className="flex items-center justify-between mb-4">
        <div className="min-w-0">
          {filterActive && (
            <p className="text-xs text-ink-secondary">
              {filteredClips.length} match{filteredClips.length === 1 ? '' : 'es'} for your filter
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setFilterOpen(true)}
          className="relative w-11 h-11 rounded-xl bg-surface-elevated border border-line-default/20 text-ink-primary hover:bg-line-default/10 flex items-center justify-center shadow-sm"
          aria-label="Filter highlights"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 5h18l-7 9v6l-4-2v-4z" />
          </svg>
          {filterActive && (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-brand-primary text-white text-[10px] font-black flex items-center justify-center ring-2 ring-surface-base">
              {activeCount}
            </span>
          )}
        </button>
      </div>

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
      ) : filterActive ? (
        <div>
          {filteredClips.length === 0 ? (
            <div className="text-center py-16 bg-surface-elevated rounded-2xl border border-line-default/10">
              <p className="text-ink-primary font-bold">No clips match those filters.</p>
              <button
                type="button"
                onClick={() => setFilter(EMPTY_FILTER)}
                className="mt-3 text-sm font-bold text-brand-primary-soft hover:text-ink-primary"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredClips.map(clip => (
                <HighlightCardLite
                  key={clip.id}
                  clip={clip}
                  players={players}
                  onOpen={() => openClip(clip.id)}
                  fullWidth
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          <HighlightHero
            clip={heroInfo.clip}
            players={players}
            onOpen={() => heroInfo.clip && openClip(heroInfo.clip.id)}
            label={heroInfo.label}
            labelTone={heroInfo.tone}
          />
          {orderedRows.map(row => (
            <HighlightRow
              key={row.key}
              title={row.title}
              subtitle={row.subtitle}
              clips={row.clips}
              players={players}
              onCardTap={openClip}
            />
          ))}
        </>
      )}

      <HighlightFilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        players={players}
        media={clips}
        value={filter}
        onChange={setFilter}
        matchCount={filteredClips.length}
      />
    </div>
  );
};

export default HighlightsNetflixTab;
