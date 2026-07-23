// Retro XP backfill — pure computation.
//
// Single source of truth used by both /xp/backfill-preview (dry-run)
// AND /xp/backfill-commit (writes). Same function both places
// guarantees preview-vs-apply can never drift: if the coach saw a
// plan, that's exactly what gets written.
//
// v1 scope (all XP amounts pulled from client BADGE_META, mirrored
// here to avoid a src/ import from the worker):
//   - first_goal / first_assist / first_save / first_clean_sheet
//   - first_potm
//   - streak_5 / streak_10 / streak_25 / streak_50 based on the
//     player's HISTORICAL PEAK streak (not currentStreakDays)
//   - perfect_attendance for any completed season with attended ==
//     total events (min 5 events)
//
// Explicitly deferred to v2 pending amount decisions:
//   - Per-instance goal / assist XP (no BADGE_META entry)
//   - team_win (no amount defined)
//   - Per-log dev_plan_log +5 (would flood a prolific kid's history)
//
// Deterministic doc IDs: every emitted event gets id shape
//   backfill-{playerId}-{source}-{sourceRefSafe}
// so re-hitting /xp/backfill-commit is a 409 ALREADY_EXISTS no-op
// per event (see firestore.ts:AlreadyExistsError).

import type { ServiceAccount } from './fcm';
import { getDocument, runQuery } from './firestore';

// Mirror of src/utils/badgeMeta.ts constants. Kept small because v1
// only backfills 10 slugs. If either side drifts, tests catch it.
const BADGE_XP: Record<string, number> = {
  first_goal: 100,
  first_assist: 100,
  first_save: 100,
  first_clean_sheet: 100,
  first_potm: 150,
  perfect_attendance: 200,
  streak_5: 50,
  streak_10: 100,
  streak_25: 200,
  streak_50: 400,
};

const BADGE_LABEL: Record<string, string> = {
  first_goal: 'First goal',
  first_assist: 'First assist',
  first_save: 'First save',
  first_clean_sheet: 'First clean sheet',
  first_potm: 'First POTM',
  perfect_attendance: 'Perfect attendance',
  streak_5: '5-day streak',
  streak_10: '10-day streak',
  streak_25: '25-day streak',
  streak_50: '50-day streak',
};

// Position eligibility gates. Keepers get first_save; keepers and
// defenders get first_clean_sheet; everything else is universal.
const KEEPER_SLUGS: ReadonlySet<string> = new Set(['first_save']);
const KEEPER_OR_D_SLUGS: ReadonlySet<string> = new Set(['first_clean_sheet']);

// Streak-milestone thresholds. Grant for every threshold <= peak.
const STREAK_THRESHOLDS = [5, 10, 25, 50] as const;

// XP source for each backfill badge. Kept explicit so
// PlayerXpHistoryFeed's SOURCE_LABEL renders the right copy per row
// (e.g. "First goal" instead of a generic "XP backfill" line).
type XpSource =
  | 'goal' | 'assist' | 'save' | 'clean_sheet'
  | 'potm'
  | 'streak_milestone'
  | 'attendance';

const BADGE_SOURCE: Record<string, XpSource> = {
  first_goal: 'goal',
  first_assist: 'assist',
  first_save: 'save',
  first_clean_sheet: 'clean_sheet',
  first_potm: 'potm',
  perfect_attendance: 'attendance',
  streak_5: 'streak_milestone',
  streak_10: 'streak_milestone',
  streak_25: 'streak_milestone',
  streak_50: 'streak_milestone',
};

export interface ComputedBadge {
  slug: string;
  xp: number;
  source: XpSource;
  sourceRef: string;
  earnedAtMs: number;
  label: string;
}

export interface PlayerLine {
  playerId: string;
  playerName: string;
  playerPhotoUrl?: string | null;
  xpDelta: number;
  badges: ComputedBadge[];
}

export interface BackfillPlan {
  teamId: string;
  computedAtMs: number;
  lines: PlayerLine[];
  totals: { xp: number; badges: number; players: number };
  alreadyBackfilled: boolean;
}

// Deterministic doc-id safety: strip anything that isn't safe in a
// Firestore doc id path. Preserves alnum + dash + underscore.
export function safeRef(s: string): string {
  return String(s || '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'unknown';
}

/** Build the deterministic player_xp_events doc id for one backfill
 *  event. Any re-run hits the same id and Firestore rejects the
 *  duplicate write with ALREADY_EXISTS. */
export function backfillEventId(playerId: string, source: XpSource, sourceRef: string): string {
  return `backfill-${safeRef(playerId)}-${source}-${safeRef(sourceRef)}`;
}

// ─────────────────────────────────────────────────────────────
// Streak-history reconstruction (peak, not current)
// ─────────────────────────────────────────────────────────────

/** America/Denver YYYY-MM-DD key so streak spans behave the same as
 *  the client's computeStreakDays. Denver is the standing timezone
 *  anchor for the whole worker (feedback_worker_timezone.md). */
function dayKeyDenver(msOrDate: number | Date): string {
  const d = typeof msOrDate === 'number' ? new Date(msOrDate) : msOrDate;
  // en-CA yields "YYYY-MM-DD" which is what we want as a bucket key.
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

/** Day-of-week in Denver time, Sunday=0. */
function dayOfWeekDenver(msOrDate: number | Date): number {
  const d = typeof msOrDate === 'number' ? new Date(msOrDate) : msOrDate;
  const wk = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    weekday: 'short',
  }).format(d);
  return ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as any)[wk] ?? 0;
}

/**
 * Compute the maximum streak this player ever hit, plus the ms
 * timestamp of the day each threshold was crossed.
 *
 * Streak rules match client computeStreakDays:
 *   - A day counts when it appears in the practiceLog day-set.
 *   - The rest day (Sunday by default, per streakConfig.restDayOfWeek)
 *     is BRIDGED: an unlogged rest day between two logged days does
 *     NOT reset the streak.
 *   - Any other missed day resets to 0.
 *
 * Returns:
 *   maxStreak — the longest consecutive run this kid ever hit
 *   thresholdCrossings — { 5: msWhen5, 10: msWhen10, ... }, only
 *     populated for thresholds actually reached
 */
export function computeStreakHistory(
  logDayKeys: string[],
  restDayOfWeek: number,
): { maxStreak: number; thresholdCrossings: Record<number, number> } {
  if (logDayKeys.length === 0) return { maxStreak: 0, thresholdCrossings: {} };

  // Normalize to sorted unique day-key list.
  const daySet = new Set(logDayKeys);
  const days = Array.from(daySet).sort();

  // Walk the range from earliest to latest logged day counting
  // consecutive-with-bridge-through-rest-days. Reset on any missing
  // non-rest day.
  const startKey = days[0];
  const endKey = days[days.length - 1];
  const startDate = new Date(startKey + 'T12:00:00-06:00'); // noon Denver-ish, avoids DST edge
  const endDate = new Date(endKey + 'T12:00:00-06:00');

  let run = 0;
  let max = 0;
  const crossings: Record<number, number> = {};

  for (let d = new Date(startDate); d.getTime() <= endDate.getTime(); d.setDate(d.getDate() + 1)) {
    const key = dayKeyDenver(d);
    const dow = dayOfWeekDenver(d);
    const logged = daySet.has(key);

    if (logged) {
      run += 1;
      if (run > max) max = run;
      for (const t of STREAK_THRESHOLDS) {
        if (run === t && crossings[t] === undefined) {
          crossings[t] = d.getTime();
        }
      }
    } else if (dow === restDayOfWeek) {
      // Rest day bridges — do not increment, do not reset.
    } else {
      run = 0;
    }
  }
  return { maxStreak: max, thresholdCrossings: crossings };
}

// ─────────────────────────────────────────────────────────────
// Main plan builder
// ─────────────────────────────────────────────────────────────

interface RosterMember {
  id: string;
  data: any;
}

async function loadRoster(projectId: string, teamId: string, sa: ServiceAccount): Promise<RosterMember[]> {
  const rows = await runQuery(
    projectId,
    'players',
    [{ field: 'teamIds', op: 'ARRAY_CONTAINS', value: teamId }],
    sa,
    500,
  );
  // Filter soft-deleted. Also drop entries with no aggregate stats
  // AND no badge slugs earned pre-existing — nothing to backfill.
  return rows
    .filter(r => (r.data as any).isActive !== false)
    .map(r => ({ id: r.id, data: r.data }));
}

async function loadTeam(projectId: string, teamId: string, sa: ServiceAccount): Promise<any | null> {
  const doc = await getDocument(projectId, `teams/${teamId}`, sa);
  return doc?.data || null;
}

/** First-instance date for a stat kind. Reads the stats collection
 *  filtered by playerId + the relevant kind counter > 0. Skips
 *  synthetic rows (clip_*, adjust_*). Returns { gameId, gameDateMs }
 *  of the earliest qualifying row, or null when nothing qualifies. */
async function firstStatDate(
  projectId: string,
  sa: ServiceAccount,
  playerId: string,
  statKind: 'goals' | 'assists' | 'saves' | 'cleanSheets',
): Promise<{ gameId: string; ms: number } | null> {
  // runQuery doesn't compose orderBy + range filters cleanly in the
  // worker's minimal wrapper, so pull all this player's stats rows
  // (typically well under 100) and scan client-side. Cheaper than
  // adding a specialized query path just for backfill.
  const rows = await runQuery(
    projectId,
    'stats',
    [{ field: 'playerId', op: 'EQUAL', value: playerId }],
    sa,
    500,
  );
  let bestMs = Infinity;
  let bestId = '';
  for (const r of rows) {
    const gameId = String(r.id);
    if (gameId.startsWith('clip_') || gameId.startsWith('adjust_')) continue;
    const raw: any = (r.data as any)[statKind];
    const n = typeof raw === 'number' ? raw : Number(raw) || 0;
    if (statKind === 'cleanSheets') {
      // cleanSheets on GameStat is written as boolean cleanSheet in
      // some paths and cleanSheets integer in others. Normalize.
      const csBool = (r.data as any).cleanSheet === true;
      if (!(n > 0) && !csBool) continue;
    } else {
      if (!(n > 0)) continue;
    }
    const gd: any = (r.data as any).gameDate;
    const ms = gd?.toMillis?.() ?? (gd?.seconds ? gd.seconds * 1000 : Number(gd) || 0);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    if (ms < bestMs) { bestMs = ms; bestId = gameId; }
  }
  if (!bestId) return null;
  return { gameId: bestId, ms: bestMs };
}

/** Earliest POTM win for this player across ALL match_votings docs
 *  (teamId filter dropped so a renamed team doesn't drop the past
 *  history — matches the parent-side 3.9.242 fix). */
async function firstPotmWin(
  projectId: string,
  sa: ServiceAccount,
  playerId: string,
): Promise<{ votingId: string; ms: number } | null> {
  // No efficient way to array-contains on a nested playerId inside
  // winners[]. Pull the whole match_votings collection (small — one
  // doc per closed game across the club) and filter in memory.
  const rows = await runQuery(projectId, 'match_votings', [], sa, 500);
  let bestMs = Infinity;
  let bestId = '';
  for (const r of rows) {
    const d: any = r.data;
    const winners: any[] = Array.isArray(d.winners) ? d.winners : [];
    const singleWinner: any = d.winner;
    const matches = winners.some(w => w?.playerId === playerId)
      || singleWinner?.playerId === playerId;
    if (!matches) continue;
    const closed = d.closedAt?.toMillis?.() ?? (d.closedAt?.seconds ? d.closedAt.seconds * 1000 : 0);
    if (!Number.isFinite(closed) || closed <= 0) continue;
    if (closed < bestMs) { bestMs = closed; bestId = String(r.id); }
  }
  if (!bestId) return null;
  return { votingId: bestId, ms: bestMs };
}

/** All practice-log day keys (Denver TZ) across ALL of a player's
 *  development plans, active or archived. Streak-history needs the
 *  full picture, not just active plans. */
async function loadPracticeLogDayKeys(
  projectId: string,
  sa: ServiceAccount,
  playerId: string,
): Promise<string[]> {
  const rows = await runQuery(
    projectId,
    'development_plans',
    [{ field: 'playerId', op: 'EQUAL', value: playerId }],
    sa,
    100,
  );
  const keys: string[] = [];
  for (const r of rows) {
    const goals: any[] = Array.isArray((r.data as any).goals) ? (r.data as any).goals : [];
    for (const g of goals) {
      const log: any[] = Array.isArray(g.practiceLog) ? g.practiceLog : [];
      for (const entry of log) {
        const raw = entry?.date ?? entry?.at ?? entry;
        const ms = raw?.toMillis?.() ?? (raw?.seconds ? raw.seconds * 1000 : Number(raw));
        if (!Number.isFinite(ms) || ms <= 0) continue;
        keys.push(dayKeyDenver(ms));
      }
    }
  }
  return keys;
}

function positionsForPlayer(data: any): string[] {
  const p = (data.positions as string[]) || (data.position ? [data.position] : []);
  return Array.isArray(p) ? p : [];
}

function isEligible(slug: string, positions: string[]): boolean {
  if (KEEPER_SLUGS.has(slug)) {
    if (positions.length === 0) return true; // aspirational default
    return positions.includes('Goalkeeper');
  }
  if (KEEPER_OR_D_SLUGS.has(slug)) {
    if (positions.length === 0) return true;
    return positions.some(p => p === 'Goalkeeper' || p === 'Defender');
  }
  return true;
}

export interface ComputeBackfillPlanOpts {
  teamId: string;
  projectId: string;
  sa: ServiceAccount;
}

/** Compute the plan. NO WRITES. Both /xp/backfill-preview and
 *  /xp/backfill-commit call this — commit calls it a second time
 *  right before writing so the coach's confirmation is validated
 *  against the current state. */
export async function computeBackfillPlan(opts: ComputeBackfillPlanOpts): Promise<BackfillPlan> {
  const { teamId, projectId, sa } = opts;
  const team = await loadTeam(projectId, teamId, sa);
  const alreadyBackfilled = !!team?.xpConfig?.backfilledAt;
  const restDayOfWeek: number = Number(team?.streakConfig?.restDayOfWeek ?? 0); // Sunday default

  const roster = await loadRoster(projectId, teamId, sa);

  const lines: PlayerLine[] = [];
  let totalXp = 0;
  let totalBadges = 0;
  let totalPlayers = 0;

  for (const p of roster) {
    const data = p.data;
    const badges: Record<string, any> = data.badges || {};
    const stats: any = data.stats || {};
    const positions = positionsForPlayer(data);
    const playerName: string = data.name || 'Player';
    const photo: string | null = data.profilePhotoUrl || null;

    const earned: ComputedBadge[] = [];

    // ── First-stat badges. Gate on career-total counter > 0 (the
    //     denorm on the player doc) + badge not yet stamped +
    //     position-eligible. Resolve historical date via one stats
    //     query per stat kind.
    const statMap: Array<[keyof typeof BADGE_XP, 'goals' | 'assists' | 'saves' | 'cleanSheets']> = [
      ['first_goal', 'goals'],
      ['first_assist', 'assists'],
      ['first_save', 'saves'],
      ['first_clean_sheet', 'cleanSheets'],
    ];
    for (const [slug, key] of statMap) {
      if (badges[slug]) continue;
      if (!isEligible(slug, positions)) continue;
      const denormCount = Number((stats as any)[key]) || 0;
      if (denormCount <= 0) continue;
      const first = await firstStatDate(projectId, sa, p.id, key);
      if (!first) continue; // denorm > 0 but no queryable row (data mismatch — skip)
      earned.push({
        slug,
        xp: BADGE_XP[slug],
        source: BADGE_SOURCE[slug],
        sourceRef: first.gameId,
        earnedAtMs: first.ms,
        label: BADGE_LABEL[slug],
      });
    }

    // ── First POTM.
    if (!badges.first_potm) {
      const potm = await firstPotmWin(projectId, sa, p.id);
      if (potm) {
        earned.push({
          slug: 'first_potm',
          xp: BADGE_XP.first_potm,
          source: BADGE_SOURCE.first_potm,
          sourceRef: potm.votingId,
          earnedAtMs: potm.ms,
          label: BADGE_LABEL.first_potm,
        });
      }
    }

    // ── Streak milestones. Historical peak, granted for every
    //     threshold reached that the kid hasn't already got.
    const logKeys = await loadPracticeLogDayKeys(projectId, sa, p.id);
    if (logKeys.length > 0) {
      const { maxStreak, thresholdCrossings } = computeStreakHistory(logKeys, restDayOfWeek);
      for (const t of STREAK_THRESHOLDS) {
        const slug = `streak_${t}`;
        if (badges[slug]) continue;
        if (maxStreak < t) continue;
        earned.push({
          slug,
          xp: BADGE_XP[slug],
          source: 'streak_milestone',
          sourceRef: String(t),
          earnedAtMs: thresholdCrossings[t] || Date.now(),
          label: BADGE_LABEL[slug],
        });
      }
    }

    // ── Perfect attendance. Season-scoped: check every completed
    //     season for total >= 5 && attended === total. First
    //     qualifying season wins; subsequent qualifying seasons are
    //     ignored in v1 (badge is a boolean, not counted).
    if (!badges.perfect_attendance) {
      const perfect = await firstPerfectAttendanceSeason(projectId, sa, teamId, p.id);
      if (perfect) {
        earned.push({
          slug: 'perfect_attendance',
          xp: BADGE_XP.perfect_attendance,
          source: 'attendance',
          sourceRef: perfect.seasonId,
          earnedAtMs: perfect.ms,
          label: BADGE_LABEL.perfect_attendance,
        });
      }
    }

    if (earned.length === 0) continue;
    const xpDelta = earned.reduce((s, b) => s + b.xp, 0);
    lines.push({
      playerId: p.id,
      playerName,
      playerPhotoUrl: photo,
      xpDelta,
      badges: earned,
    });
    totalXp += xpDelta;
    totalBadges += earned.length;
    totalPlayers += 1;
  }

  // Sort xpDelta desc so the modal preview leads with the biggest
  // wins. Coach reads the top of the list first.
  lines.sort((a, b) => b.xpDelta - a.xpDelta);

  return {
    teamId,
    computedAtMs: Date.now(),
    lines,
    totals: { xp: totalXp, badges: totalBadges, players: totalPlayers },
    alreadyBackfilled,
  };
}

/** Find the earliest completed season on this team where the player
 *  hit total >= 5 events && attended === total. Returns { seasonId,
 *  ms } of that season's end date, or null if no season qualifies. */
async function firstPerfectAttendanceSeason(
  projectId: string,
  sa: ServiceAccount,
  teamId: string,
  playerId: string,
): Promise<{ seasonId: string; ms: number } | null> {
  const seasons = await runQuery(
    projectId,
    'seasons',
    [{ field: 'teamId', op: 'EQUAL', value: teamId }],
    sa,
    50,
  );
  const completed = seasons
    .map(s => ({ id: s.id, data: s.data }))
    .filter(s => (s.data as any).isActive === false)
    .sort((a, b) => {
      const am = (a.data as any).endDate?.toMillis?.() ?? 0;
      const bm = (b.data as any).endDate?.toMillis?.() ?? 0;
      return am - bm;
    });

  for (const s of completed) {
    const evs = await runQuery(
      projectId,
      'events',
      [
        { field: 'teamId', op: 'EQUAL', value: teamId },
        { field: 'seasonId', op: 'EQUAL', value: s.id },
      ],
      sa,
      500,
    );
    let total = 0;
    let attended = 0;
    for (const e of evs) {
      const d: any = e.data;
      if (d.isCancelled === true) continue;
      // Soft-deleted (tombstoned) events must not count toward
      // perfect-attendance XP — coach silently deleted them, so
      // they shouldn't inflate a season's total-events denominator.
      if (d.isActive === false) continue;
      const typ = String(d.type || '');
      if (typ !== 'game' && typ !== 'practice') continue;
      total += 1;
      const rsvps: any = d.playerRsvps || {};
      const status = rsvps?.[playerId]?.status;
      if (status === 'going') attended += 1;
    }
    if (total >= 5 && attended === total) {
      const endMs = (s.data as any).endDate?.toMillis?.() ?? Date.now();
      return { seasonId: s.id, ms: endMs };
    }
  }
  return null;
}
