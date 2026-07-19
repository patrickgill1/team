import type { GameStat, Player } from '../types';

/**
 * Team-records + season-leaders aggregation. Pure functions over the
 * `stats` collection (one row per player per game per stat kind).
 * No writes, no side-effects — the same rows already power the
 * player-card totals; we just slice them differently here.
 *
 * Design notes
 * ────────────
 * • Season boundary is by `seasonId`. `null` means "no season stamped"
 *   which is the legacy path — treat as its own bucket rather than
 *   dropping the row (there's real data on those).
 * • `game_stats.gameId` prefixes to watch: `clip_` (parent-tagged
 *   clip credit, not a real game — always excluded from single-game
 *   records) and `adjust_` (manual correction — excluded from BOTH
 *   single-game AND leaderboard aggregation because the row is a
 *   signed delta, not a real appearance). The player card totals
 *   already handle these; we mirror that logic here.
 * • Single-game record rows carry the specific game context —
 *   opponent, date — so the UI can show "vs Sandy Ridge on 3/12".
 */

const isSyntheticGameId = (gid: unknown): boolean => {
  if (typeof gid !== 'string') return false;
  return gid.startsWith('clip_') || gid.startsWith('adjust_');
};

export type LeaderStat = 'goals' | 'assists' | 'saves' | 'yellowCards' | 'redCards';

export interface LeaderRow {
  playerId: string;
  playerName: string;
  jerseyNumber?: number | null;
  total: number;
}

export interface SingleGameRecord {
  stat: LeaderStat;
  value: number;
  playerId: string;
  playerName: string;
  jerseyNumber?: number | null;
  opponent: string;
  gameId: string;
  gameDate: Date;
}

export interface TeamRecordsResult {
  leaders: Record<LeaderStat, LeaderRow[]>;
  singleGame: Record<LeaderStat, SingleGameRecord | null>;
  fastestGoal: FastestGoalRecord | null;
  gamesCounted: number;
}

export interface FastestGoalRecord {
  seconds: number;
  playerId: string;
  playerName: string;
  jerseyNumber?: number | null;
  opponent: string;
  gameId: string;
  gameDate: Date;
}

export interface AggregationOptions {
  /** Restrict leaderboards to players whose primary position is
   *  goalkeeper. Used for the "Goalkeepers only" saves filter. */
  goalkeepersOnly?: boolean;
  /** How many entries per leaderboard. Default 5. */
  topN?: number;
}

const isGoalkeeper = (p: Player | undefined | null): boolean => {
  if (!p) return false;
  const positions = Array.isArray((p as any).positions) ? (p as any).positions as string[] : [];
  const primary = (positions[0] || (p as any).position || '').toString().toLowerCase();
  return primary.includes('goalkeeper') || primary === 'gk';
};

const initLeaderMap = (): Record<LeaderStat, Record<string, number>> => ({
  goals: {},
  assists: {},
  saves: {},
  yellowCards: {},
  redCards: {},
});

const asDate = (v: any): Date => {
  if (!v) return new Date(0);
  if (v instanceof Date) return v;
  if (typeof v?.toDate === 'function') return v.toDate();
  return new Date(v);
};

/**
 * Filter a stats row-set to the caller's scope. Kept separate so
 * the same row set can drive multiple scopes (current / last / all-
 * time) without re-fetching from Firestore.
 */
export function filterStatsBySeason(
  rows: GameStat[],
  seasonId: string | null | undefined,
  opts?: { includeTrips?: boolean; tripId?: string | null },
): GameStat[] {
  // Trip scoping (2026-07-19). Season leaders + team single-game
  // records default to "regulation-only" — trip-tagged rows are their
  // own bucket. Callers who explicitly want the trip view (tournament
  // leaders card) pass `tripId`. Callers who want the raw union pass
  // `includeTrips: true`.
  let out = seasonId == null ? rows : rows.filter((r) => ((r as any).seasonId || null) === seasonId);
  if (opts?.tripId) {
    out = out.filter((r) => (r as any).tripId === opts.tripId);
  } else if (!opts?.includeTrips) {
    out = out.filter((r) => !(r as any).tripId);
  }
  return out;
}

/**
 * Compute season leaders (per-stat top-N) + single-game records +
 * fastest goal, all in one pass. Callers pass in the pre-filtered
 * rows (see `filterStatsBySeason`) so the same UI can toggle scopes
 * cheaply.
 */
export function computeTeamRecords(
  rows: GameStat[],
  players: Player[],
  opts: AggregationOptions = {},
): TeamRecordsResult {
  const topN = opts.topN ?? 5;
  const byId = new Map<string, Player>();
  players.forEach((p) => byId.set(p.id, p));

  const leaders = initLeaderMap();
  const singleGame: Record<LeaderStat, SingleGameRecord | null> = {
    goals: null, assists: null, saves: null, yellowCards: null, redCards: null,
  };

  const keeperOnly = opts.goalkeepersOnly === true;
  const gameIds = new Set<string>();

  for (const r of rows) {
    const gid = (r as any).gameId;
    if (isSyntheticGameId(gid)) continue;
    const pid = r.playerId;
    if (!pid) continue;
    const player = byId.get(pid);
    // For a keeper-only view of Saves, we filter on the CREDITED
    // player's position. Other stats still surface any player.
    const applyKeeperFilter = keeperOnly && !isGoalkeeper(player);

    if (typeof gid === 'string' && gid) gameIds.add(gid);

    (['goals', 'assists', 'saves', 'yellowCards', 'redCards'] as LeaderStat[]).forEach((stat) => {
      const val = (r as any)[stat] || 0;
      if (val <= 0) return;
      if (stat === 'saves' && applyKeeperFilter) return;
      leaders[stat][pid] = (leaders[stat][pid] || 0) + val;

      const prev = singleGame[stat];
      if (!prev || val > prev.value) {
        singleGame[stat] = {
          stat,
          value: val,
          playerId: pid,
          playerName: r.playerName || player?.name || 'Player',
          jerseyNumber: player?.jerseyNumber ?? null,
          opponent: r.opponent || 'Opponent',
          gameId: gid,
          gameDate: asDate(r.gameDate),
        };
      }
    });
  }

  const toRows = (m: Record<string, number>): LeaderRow[] =>
    Object.entries(m)
      .map(([playerId, total]) => {
        const p = byId.get(playerId);
        return {
          playerId,
          playerName: p?.name || 'Player',
          jerseyNumber: p?.jerseyNumber ?? null,
          total,
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, topN);

  return {
    leaders: {
      goals: toRows(leaders.goals),
      assists: toRows(leaders.assists),
      saves: toRows(leaders.saves),
      yellowCards: toRows(leaders.yellowCards),
      redCards: toRows(leaders.redCards),
    },
    singleGame,
    // Fastest-goal detection requires the per-game timeline, which
    // `stats` rows don't carry. Deferred to a follow-up when we can
    // read live_games directly. Placeholder returns null; UI hides
    // the row gracefully.
    fastestGoal: null,
    gamesCounted: gameIds.size,
  };
}

/**
 * Compute a delta vs the prior scope for the same player. Returns
 * `total_now - total_prior`. Used to render "▲ 3 from last season"
 * badges next to leaderboard rows.
 */
export function leaderDelta(
  currentRows: LeaderRow[],
  priorRows: LeaderRow[] | null,
): Map<string, number> {
  if (!priorRows) return new Map();
  const priorById = new Map<string, number>();
  priorRows.forEach((r) => priorById.set(r.playerId, r.total));
  const out = new Map<string, number>();
  currentRows.forEach((r) => {
    out.set(r.playerId, r.total - (priorById.get(r.playerId) || 0));
  });
  return out;
}

// Presentation-layer labels for stats used across records UI. Kept
// here so the records section and future recap-card ribbon speak the
// same vocabulary without importing the whole i18n module.
export const STAT_LABELS: Record<LeaderStat, { plural: string; single: string; icon: string }> = {
  goals:       { plural: 'Goals',   single: 'Goal',   icon: '⚽' },
  assists:     { plural: 'Assists', single: 'Assist', icon: '🎯' },
  saves:       { plural: 'Saves',   single: 'Save',   icon: '🧤' },
  yellowCards: { plural: 'Yellows', single: 'Yellow', icon: '🟨' },
  redCards:    { plural: 'Reds',    single: 'Red',    icon: '🟥' },
};
