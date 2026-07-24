#!/usr/bin/env tsx
/**
 * Backfill: reconstruct player_xp_events history from source
 * collections since 2026-07-10 (or a caller-supplied --since date).
 *
 * WHY. The XP + badges system shipped 2026-07-10 as a mostly
 * fire-and-forget client bundle: coach whispers, kudos conversions,
 * badge auto-grants, and dev-plan taps each wrote through their own
 * path, and the audit-trail rail (player_xp_events) was only written
 * on a subset of them (coach_live, coach_whisper, kudos_coach_convert).
 * Attendance, effort bonus, dev-plan taps, badges, and streak
 * crossings never emitted an event doc — the numbers moved on
 * player.xp / player.badges but the "why" was silent, so the coach's
 * audit surface + the kid's XP-log timeline are both under-counted
 * relative to the player-doc totals.
 *
 * The worker refactor (POST /xp/log-grant) makes every grant emit
 * an event row from ship-forward. This script is the one-shot pass
 * that rebuilds the history from the underlying source docs so the
 * timeline matches the totals for anything that landed BETWEEN the
 * ship date and the refactor. Deterministic doc ids paired with
 * Firestore .create() make it idempotent: re-running is a no-op
 * (Firestore ALREADY_EXISTS on the second write) rather than a
 * double-count.
 *
 * SOURCES AND DETERMINISTIC IDS.
 *   practice_attendance     attn-{eventId}-{playerId}       +10  (from events.playerRsvps.{pid}.attendanceXpAwardedAt)
 *   game_attendance         attn-{eventId}-{playerId}       +15
 *   effort_bonus            effort-{eventId}-{playerId}     +5   (from events.playerRsvps.{pid}.effortBonusAwardedAt)
 *   dev_plan_log            devlog-{playerId}-{dayKey}      +5   (from players/{pid}/dev_checkins/*  +  development_plans.goals[].practiceLog)
 *   first_goal              first-first_goal-{playerId}     +100 (from player.badges.first_goal.earnedAt)
 *   first_assist            first-first_assist-{playerId}   +100
 *   first_save              first-first_save-{playerId}     +100
 *   first_clean_sheet       first-first_clean_sheet-{playerId} +100
 *   first_potm              first-first_potm-{playerId}     +150
 *   perfect_attendance      pa-{playerId}-{seasonSuffix}    +200 (seasonSuffix = activeSeasonId || 'all'; matches src/utils/badgeGrants.ts:161 live-write id so an apply-run is idempotent)
 *   streak_milestone (5)    streak-{playerId}-5             +50
 *   streak_milestone (10)   streak-{playerId}-10            +100
 *   streak_milestone (25)   streak-{playerId}-25            +200
 *   streak_milestone (50)   streak-{playerId}-50            +400
 *   rsvp_going              rsvp-{eventId}-{playerId}       +10  (from events.playerRsvps.{pid}.rsvpXpAwardedAt; skipped whole when the field is absent from prod data)
 *   coach_whisper           {whisperId}                     +50  (matches live handleXpAwardWhisper sourceRef; ALREADY_EXISTS dedups instead of a ±window heuristic)
 *   kudos_coach_convert     kudos-{kudosId}                 =kudos.xpAwarded  (matches live-write id; ALREADY_EXISTS dedups)
 *
 * LOCKED DECISIONS (from coach, encoded here):
 *   - dev_plan_log kid-actor undercount: accept flat +5 for every
 *     backfilled row. No attempt to recover the +10 kid-mode split;
 *     live code keeps the +5/+10 going forward.
 *   - xp-off retro-grants: SKIPPED per source row. For every team we
 *     compute effectiveEnabledAt = team.xpConfig.enabledAt (fallback
 *     team.xpConfig.updatedAt). Every candidate row is filtered to
 *     createdAt >= effectiveEnabledAt. A team with no enabledAt AND
 *     no updatedAt is treated as "never enabled" and skipped whole.
 *   - NEVER touches player.xp. Audit rows only. If the sum of events
 *     ends up under player.xp, that's a separate reconciliation job.
 *
 * FLAGS.
 *   --apply             Perform writes. Default is dry-run.
 *   --team=<id>         Restrict to a single team. Default: every
 *                       active team with xpConfig.enabled === true.
 *   --since=YYYY-MM-DD  Window start. Default 2026-07-10.
 *   --source=<key>      Replay one source only (e.g. --source=coach_whisper).
 *                       Default: all sources in SOURCE_ENUM.
 *   --verify            Read-only diff: for each player, compare
 *                       sum(events.xp within window) vs player.xp.
 *                       No writes, no other output beyond the diff.
 *
 * Usage.
 *   npx tsx scripts/backfill-player-xp-events.ts                             # dry-run all sources
 *   npx tsx scripts/backfill-player-xp-events.ts --apply                     # write all sources
 *   npx tsx scripts/backfill-player-xp-events.ts --team=abc123 --apply       # single team
 *   npx tsx scripts/backfill-player-xp-events.ts --source=coach_whisper --apply
 *   npx tsx scripts/backfill-player-xp-events.ts --verify                    # sanity diff
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

// ────────────────────────────────────────────────────────────────
// Flags
// ────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');
const TEAM_ONLY = (() => {
  const arg = process.argv.find(a => a.startsWith('--team='));
  return arg ? arg.slice('--team='.length) : null;
})();
const SINCE_ARG = (() => {
  const arg = process.argv.find(a => a.startsWith('--since='));
  return arg ? arg.slice('--since='.length) : '2026-07-10';
})();
const SOURCE_ONLY = (() => {
  const arg = process.argv.find(a => a.startsWith('--source='));
  return arg ? arg.slice('--source='.length) : null;
})();

const tag = VERIFY ? 'VERIFY' : APPLY ? 'APPLY ' : 'DRY   ';

const SINCE = new Date(`${SINCE_ARG}T00:00:00.000Z`);
if (Number.isNaN(SINCE.getTime())) {
  console.error(`Bad --since value: ${SINCE_ARG}. Expected YYYY-MM-DD.`);
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────
// Firebase Admin init (mirrors backfill-player-streak.ts)
// ────────────────────────────────────────────────────────────────

const SA_PATH = path.resolve(__dirname, 'firebase-service-account.json');
if (!fs.existsSync(SA_PATH)) {
  console.error('Service account JSON not found at', SA_PATH);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(SA_PATH) });
const db = admin.firestore();

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

// Canonical SOURCE_ENUM per the /xp/log-grant contract. Matches
// src/types/index.ts PlayerXpEvent.source (with the new stamps the
// worker refactor is adding: practice_attendance, game_attendance,
// effort_bonus, rsvp_going, first_*, perfect_attendance,
// streak_milestone). coach_recognition is legacy read-only — no new
// writes and this backfill never emits it.
const SOURCE_ENUM = new Set<string>([
  'coach_live', 'coach_whisper', 'kudos_coach_convert',
  'dev_plan_log', 'practice_attendance', 'game_attendance',
  'effort_bonus', 'rsvp_going',
  'first_goal', 'first_assist', 'first_save', 'first_clean_sheet',
  'first_potm', 'perfect_attendance', 'streak_milestone',
  'coach_recognition',
]);

if (SOURCE_ONLY && !SOURCE_ENUM.has(SOURCE_ONLY)) {
  console.error(`--source=${SOURCE_ONLY} is not in SOURCE_ENUM. See src/types PlayerXpEvent.source.`);
  process.exit(1);
}

// Flat XP amounts. Attendance / effort / whisper / dev-log are the
// hard-coded worker values; badges use the badgeMeta table below.
const PRACTICE_ATTENDANCE_XP = 10;
const GAME_ATTENDANCE_XP     = 15;
const EFFORT_BONUS_XP        = 5;
const RSVP_GOING_XP          = 10;  // KidDashboard kid-in-app rate (base +5 was never persisted with a stamp)
const DEV_PLAN_LOG_XP        = 5;   // locked flat; no +10 kid-mode recovery
const COACH_WHISPER_XP       = 50;

// Mirrors src/utils/badgeMeta.ts BADGE_META.xp. Inlined so this
// script has no src/* import path — matches the pattern in
// backfill-player-streak.ts (self-contained + Admin SDK only).
const BADGE_XP: Record<string, number> = {
  first_goal:         100,
  first_assist:       100,
  first_save:         100,
  first_clean_sheet:  100,
  first_potm:         150,
  perfect_attendance: 200,
  streak_5:            50,
  streak_10:          100,
  streak_25:          200,
  streak_50:          400,
};

// Badge slug → PlayerXpEvent.source mapping. Streak badges collapse
// to the shared 'streak_milestone' source; everything else is 1:1.
const BADGE_SOURCE: Record<string, string> = {
  first_goal: 'first_goal',
  first_assist: 'first_assist',
  first_save: 'first_save',
  first_clean_sheet: 'first_clean_sheet',
  first_potm: 'first_potm',
  perfect_attendance: 'perfect_attendance',
  streak_5: 'streak_milestone',
  streak_10: 'streak_milestone',
  streak_25: 'streak_milestone',
  streak_50: 'streak_milestone',
};

const STREAK_THRESHOLDS: Array<[number, string]> = [
  [5,  'streak_5'],
  [10, 'streak_10'],
  [25, 'streak_25'],
  [50, 'streak_50'],
];

// perfect_attendance is emitted OUT-of-band from this list — its
// live-code sourceRef is 'pa-{playerId}-{seasonSuffix}' (see
// src/utils/badgeGrants.ts:161), not the 'first-*' pattern the other
// slugs share. Keeping it in the loop would produce a second doc id
// that never matches the live-write's id and duplicate on every re-run.
const FIRST_BADGE_SLUGS = [
  'first_goal', 'first_assist', 'first_save', 'first_clean_sheet',
  'first_potm',
] as const;

// ────────────────────────────────────────────────────────────────
// Denver day key. Matches src/utils/devPlanActions.ts denverKeyOfDate
// AND the worker + the streak backfill so dev-plan taps bucket to
// the same "YYYY-MM-DD" everywhere.
// ────────────────────────────────────────────────────────────────

function denverKeyOfDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

// ────────────────────────────────────────────────────────────────
// Date coercion. Mirrors coerceLogDate from backfill-player-streak
// so a Firestore Timestamp, a plain Date, an epoch ms/ISO string,
// and the legacy {seconds, nanoseconds} map (pre-3.2.57
// cleanFirestoreData bug) all resolve to a real Date.
// ────────────────────────────────────────────────────────────────

function coerceDate(raw: any): Date | null {
  if (!raw) return null;
  if (typeof raw.toDate === 'function') {
    try { return raw.toDate(); } catch { /* fall through */ }
  }
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'number' || typeof raw === 'string') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw.seconds === 'number') {
    const ms = raw.seconds * 1000 + Math.floor((raw.nanoseconds || 0) / 1e6);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// Row shape emitted into player_xp_events.
// ────────────────────────────────────────────────────────────────

interface RowSeed {
  docId: string;
  playerId: string;
  playerName: string;
  teamId: string;
  clubId: string | null;
  source: string;
  xp: number;
  awardedBy: string | null;
  awardedByRole: 'coach' | 'team_manager' | 'system';
  awardedByName: string | null;
  awardedByAvatarUrl: string | null;
  seasonId: string | null;
  createdAt: Date;
  occurredAt: Date;
  note: string | null;
  sourceRef: string;
}

interface AmbiguousNote {
  playerId: string;
  playerName: string;
  reason: string;
  detail: string;
}

interface TeamSummary {
  teamId: string;
  teamName: string;
  skipped: number;   // ALREADY_EXISTS on create
  newRows: number;   // successful create (or dry-run "would create")
  errors: number;
  ambiguous: AmbiguousNote[];
  playerBreakdown: Array<{
    playerId: string;
    playerName: string;
    rowsWritten: number;
    bySource: Record<string, number>;
  }>;
}

// ────────────────────────────────────────────────────────────────
// Season lookup. We fetch every season for the team once and map
// each row's occurredAt to the season whose [startDate, endDate]
// contains it. Falls back to the current active season (isActive
// == true) if no window matches — matches the worker convention.
// ────────────────────────────────────────────────────────────────

interface SeasonWindow {
  id: string;
  startMs: number;
  endMs: number;
  isActive: boolean;
}

async function loadSeasonWindows(teamId: string): Promise<{ windows: SeasonWindow[]; activeId: string | null }> {
  const snap = await db.collection('seasons').where('teamId', '==', teamId).get();
  const windows: SeasonWindow[] = [];
  let activeId: string | null = null;
  for (const d of snap.docs) {
    const v: any = d.data();
    const start = coerceDate(v.startDate);
    const end = coerceDate(v.endDate);
    const w: SeasonWindow = {
      id: d.id,
      startMs: start ? start.getTime() : Number.NEGATIVE_INFINITY,
      endMs: end ? end.getTime() : Number.POSITIVE_INFINITY,
      isActive: !!v.isActive,
    };
    windows.push(w);
    if (w.isActive && !activeId) activeId = d.id;
  }
  return { windows, activeId };
}

function resolveSeasonId(
  windows: SeasonWindow[],
  activeId: string | null,
  occurredAt: Date,
): string | null {
  const ms = occurredAt.getTime();
  for (const w of windows) {
    if (ms >= w.startMs && ms <= w.endMs) return w.id;
  }
  return activeId;
}

// ────────────────────────────────────────────────────────────────
// User lookup helper. We denorm awardedByName / avatar so the
// backfilled rows render identically to live-written rows. Cached
// per-run to keep the read count sane on teams with a few dozen
// distinct coach/parent authors.
// ────────────────────────────────────────────────────────────────

const userCache = new Map<string, { name: string | null; avatar: string | null }>();

async function lookupUser(uid: string | null | undefined): Promise<{ name: string | null; avatar: string | null }> {
  if (!uid) return { name: null, avatar: null };
  if (userCache.has(uid)) return userCache.get(uid)!;
  try {
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) {
      const empty = { name: null, avatar: null };
      userCache.set(uid, empty);
      return empty;
    }
    const d: any = snap.data() || {};
    const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : null;
    const avatar = typeof d.photoURL === 'string' && d.photoURL
      ? d.photoURL
      : typeof d.profilePhotoUrl === 'string' && d.profilePhotoUrl
        ? d.profilePhotoUrl
        : null;
    const entry = { name, avatar };
    userCache.set(uid, entry);
    return entry;
  } catch {
    const empty = { name: null, avatar: null };
    userCache.set(uid, empty);
    return empty;
  }
}

// ────────────────────────────────────────────────────────────────
// Filter helpers
// ────────────────────────────────────────────────────────────────

function sourceAllowed(source: string): boolean {
  if (!SOURCE_ENUM.has(source)) return false;
  if (SOURCE_ONLY && SOURCE_ONLY !== source) return false;
  return true;
}

function inWindow(occurredAt: Date, effectiveStart: Date): boolean {
  const ms = occurredAt.getTime();
  return ms >= effectiveStart.getTime() && ms <= Date.now();
}

// ────────────────────────────────────────────────────────────────
// --verify mode. For each player on the team, sum every
// player_xp_events.xp with createdAt >= SINCE and compare against
// player.xp. Print a one-line diff per player. No writes.
// ────────────────────────────────────────────────────────────────

async function verifyTeam(teamDoc: FirebaseFirestore.DocumentSnapshot): Promise<void> {
  const team: any = teamDoc.data() || {};
  const teamName = String(team.name || teamDoc.id);
  const playerIds: string[] = Array.isArray(team.playerIds) ? team.playerIds : [];

  console.log(`\n[${tag}] team=${teamDoc.id} (${teamName}) players=${playerIds.length}`);
  if (playerIds.length === 0) return;

  for (const pid of playerIds) {
    try {
      const pSnap = await db.collection('players').doc(pid).get();
      if (!pSnap.exists) continue;
      const p: any = pSnap.data() || {};
      if (p.isActive === false) continue;

      const eventsSnap = await db.collection('player_xp_events')
        .where('playerId', '==', pid)
        .where('createdAt', '>=', SINCE)
        .get();
      let sum = 0;
      for (const e of eventsSnap.docs) {
        const v: any = e.data() || {};
        if (typeof v.xp === 'number' && v.xp > 0) sum += v.xp;
      }
      const cur = Number(p.xp) || 0;
      const diff = cur - sum;
      const flag = diff === 0 ? 'OK  ' : diff > 0 ? 'UNDR' : 'OVER';
      console.log(
        `  [${flag}] ${pid} (${p.name || 'unnamed'})  ` +
        `player.xp=${cur}  sum(events)=${sum}  diff=${diff >= 0 ? '+' : ''}${diff}  ` +
        `(events=${eventsSnap.size})`
      );
    } catch (err) {
      console.warn(`  [ERR ] ${pid}`, (err as Error).message);
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Per-team backfill.
// ────────────────────────────────────────────────────────────────

async function backfillTeam(teamDoc: FirebaseFirestore.DocumentSnapshot): Promise<TeamSummary | null> {
  const team: any = teamDoc.data() || {};
  const teamId = teamDoc.id;
  const teamName = String(team.name || teamId);
  const clubId: string | null = typeof team.clubId === 'string' && team.clubId ? team.clubId : null;

  const xpConfig: any = team.xpConfig;
  if (!xpConfig || xpConfig.enabled !== true) {
    console.log(`[${tag}] skip team=${teamId} (${teamName}) — xpConfig.enabled !== true`);
    return null;
  }

  const enabledAt = coerceDate(xpConfig.enabledAt);
  const updatedAt = coerceDate(xpConfig.updatedAt) || coerceDate(team.updatedAt);
  const effectiveEnabledAt = enabledAt || updatedAt;
  if (!effectiveEnabledAt) {
    // xp is on but we have no timestamp for when it flipped on. Per
    // LOCKED DECISION: skip the whole team rather than accidentally
    // credit a stretch when xp was off.
    console.log(`[${tag}] skip team=${teamId} (${teamName}) — xpConfig.enabled but no enabledAt/updatedAt stamp`);
    return null;
  }
  const effectiveStart = new Date(Math.max(SINCE.getTime(), effectiveEnabledAt.getTime()));

  console.log(`\n[${tag}] team=${teamId} (${teamName}) window=${effectiveStart.toISOString()} .. now  clubId=${clubId || '(none)'}`);

  const summary: TeamSummary = {
    teamId,
    teamName,
    skipped: 0,
    newRows: 0,
    errors: 0,
    ambiguous: [],
    playerBreakdown: [],
  };

  const playerIds: string[] = Array.isArray(team.playerIds) ? team.playerIds : [];
  if (playerIds.length === 0) return summary;

  // Load players by id and index them so we can look up name / kids-only
  // rows without a second read.
  const playersById = new Map<string, any>();
  for (const pid of playerIds) {
    try {
      const snap = await db.collection('players').doc(pid).get();
      if (snap.exists) playersById.set(pid, { id: pid, ...(snap.data() as any) });
    } catch (err) {
      summary.errors++;
      console.warn(`  [err] player fetch ${pid}:`, (err as Error).message);
    }
  }

  const activePlayers = Array.from(playersById.values()).filter(p => p.isActive !== false);
  if (activePlayers.length === 0) return summary;

  const { windows: seasonWindows, activeId: activeSeasonId } = await loadSeasonWindows(teamId);

  // Deterministic-id seed map. Union-dedup across sources ensures a
  // dry-run's "would create" count matches an apply-run's actual
  // create count (both dev_checkins AND development_plans.practiceLog
  // hit the same devlog-{playerId}-{dayKey} slot).
  const seedsByDocId = new Map<string, RowSeed>();

  function enqueue(seed: RowSeed) {
    if (!sourceAllowed(seed.source)) return;
    if (!inWindow(seed.occurredAt, effectiveStart)) return;
    if (!seedsByDocId.has(seed.docId)) seedsByDocId.set(seed.docId, seed);
  }

  // ── (a, b) Attendance + effort bonus from events ──────────────
  //
  // Fetch every past team event of type practice/game, then walk
  // playerRsvps for each player and emit an attendance row when
  // attendanceXpAwardedAt is set + in window, and an effort row
  // when effortBonusAwardedAt is set + in window. The two rows are
  // independent — a player can be marked attended without an effort
  // bonus and vice versa.
  //
  // Firestore can't query nested-map fields, so we do the filter in
  // memory. The per-team event count is small enough (hundreds
  // typical) that a single get() beats N per-player queries.
  if (
    sourceAllowed('practice_attendance') ||
    sourceAllowed('game_attendance') ||
    sourceAllowed('effort_bonus') ||
    sourceAllowed('rsvp_going')
  ) {
    // Track whether the KidDashboard rsvpXpAwardedAt stamp exists on
    // ANY rsvp for this team. If we finish the whole events scan
    // without seeing it, log the skip note explaining that historical
    // rsvp_going grants aren't recoverable (KidDashboard fires
    // awardMicroXp but never persists a timestamp on the rsvp entry).
    let sawRsvpStamp = false;
    try {
      const evSnap = await db.collection('events')
        .where('teamId', '==', teamId)
        .get();
      for (const evDoc of evSnap.docs) {
        const ev: any = evDoc.data() || {};
        const type = ev.type;
        if (type !== 'practice' && type !== 'game') continue;
        if (ev.isActive === false) continue;
        const rsvps = ev.playerRsvps || {};
        const eventDate = coerceDate(ev.date) || new Date();
        for (const pid of Object.keys(rsvps)) {
          const player = playersById.get(pid);
          if (!player || player.isActive === false) continue;
          const rsvp: any = rsvps[pid] || {};
          const byUid: string | null = typeof rsvp.byUid === 'string' && rsvp.byUid ? rsvp.byUid : null;
          const byName: string | null = typeof rsvp.byName === 'string' && rsvp.byName ? rsvp.byName : null;
          const byAvatar: string | null = typeof rsvp.byPhotoUrl === 'string' && rsvp.byPhotoUrl ? rsvp.byPhotoUrl : null;

          const attnAt = coerceDate(rsvp.attendanceXpAwardedAt);
          if (attnAt && inWindow(attnAt, effectiveStart)) {
            const source = type === 'practice' ? 'practice_attendance' : 'game_attendance';
            const xp = type === 'practice' ? PRACTICE_ATTENDANCE_XP : GAME_ATTENDANCE_XP;
            enqueue({
              docId: `attn-${evDoc.id}-${pid}`,
              playerId: pid,
              playerName: String(player.name || ''),
              teamId,
              clubId,
              source,
              xp,
              awardedBy: byUid,
              awardedByRole: 'coach',
              awardedByName: byName,
              awardedByAvatarUrl: byAvatar,
              seasonId: resolveSeasonId(seasonWindows, activeSeasonId, attnAt),
              createdAt: attnAt,
              occurredAt: attnAt,
              note: ev.title ? String(ev.title) : null,
              sourceRef: `attn-${evDoc.id}-${pid}`,
            });
          }

          const effortAt = coerceDate(rsvp.effortBonusAwardedAt);
          if (effortAt && inWindow(effortAt, effectiveStart)) {
            enqueue({
              docId: `effort-${evDoc.id}-${pid}`,
              playerId: pid,
              playerName: String(player.name || ''),
              teamId,
              clubId,
              source: 'effort_bonus',
              xp: EFFORT_BONUS_XP,
              awardedBy: byUid,
              awardedByRole: 'coach',
              awardedByName: byName,
              awardedByAvatarUrl: byAvatar,
              seasonId: resolveSeasonId(seasonWindows, activeSeasonId, effortAt),
              createdAt: effortAt,
              occurredAt: effortAt,
              note: ev.title ? String(ev.title) : null,
              sourceRef: `effort-${evDoc.id}-${pid}`,
            });
          }

          // rsvp_going: KidDashboard fires awardMicroXp on the
          // crossing into 'going', but does not stamp a timestamp
          // onto the rsvp entry. If a future ship starts persisting
          // rsvpXpAwardedAt, this reconstruction picks up
          // automatically and lands the deterministic doc id
          // 'rsvp-{eventId}-{playerId}' — identical to the live
          // sourceRef in KidDashboard.tsx:701, so an apply-run
          // ALREADY_EXISTS-dedups against the live row.
          const rsvpAt = coerceDate(rsvp.rsvpXpAwardedAt);
          if (rsvpAt) {
            sawRsvpStamp = true;
            if (sourceAllowed('rsvp_going') && inWindow(rsvpAt, effectiveStart)) {
              enqueue({
                docId: `rsvp-${evDoc.id}-${pid}`,
                playerId: pid,
                playerName: String(player.name || ''),
                teamId,
                clubId,
                source: 'rsvp_going',
                xp: RSVP_GOING_XP,
                awardedBy: byUid,
                awardedByRole: 'system',
                awardedByName: byName,
                awardedByAvatarUrl: byAvatar,
                seasonId: resolveSeasonId(seasonWindows, activeSeasonId, rsvpAt),
                createdAt: rsvpAt,
                occurredAt: rsvpAt,
                note: ev.title ? String(ev.title) : null,
                sourceRef: `rsvp-${evDoc.id}-${pid}`,
              });
            }
          }
        }
      }
      if (sourceAllowed('rsvp_going') && !sawRsvpStamp) {
        console.log(
          `  [${tag}] rsvp_going has no persisted timestamp; skipping — historical KidDashboard RSVP grants are unrecoverable ` +
          `(team=${teamId})`
        );
      }
    } catch (err) {
      summary.errors++;
      console.warn('  [err] attendance/effort/rsvp scan:', (err as Error).message);
    }
  }

  // ── (c) Dev-plan log — from dev_checkins subcollection ────────
  //
  // Every check-in doc lands one +5 row keyed by
  // devlog-{playerId}-{dayKey}. Same-day multiple taps collapse via
  // the deterministic id. dev_checkins is the source of truth from
  // 2026-07-21 onward; older data comes from the practiceLog union
  // below.
  if (sourceAllowed('dev_plan_log')) {
    for (const player of activePlayers) {
      const pid = player.id;
      try {
        const snap = await db.collection('players').doc(pid).collection('dev_checkins').get();
        for (const cSnap of snap.docs) {
          const c: any = cSnap.data() || {};
          if (c.voided === true) continue;
          const when = coerceDate(c.date);
          if (!when) continue;
          const dayKey =
            typeof c.dayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.dayKey)
              ? c.dayKey
              : (/^\d{4}-\d{2}-\d{2}$/.test(cSnap.id) ? cSnap.id : denverKeyOfDate(when));
          const loggedBy: string | null = typeof c.loggedBy === 'string' && c.loggedBy ? c.loggedBy : null;
          const loggedByName: string | null = typeof c.loggedByName === 'string' && c.loggedByName ? c.loggedByName : null;
          enqueue({
            docId: `devlog-${pid}-${dayKey}`,
            playerId: pid,
            playerName: String(player.name || ''),
            teamId,
            clubId,
            source: 'dev_plan_log',
            xp: DEV_PLAN_LOG_XP,
            awardedBy: loggedBy,
            awardedByRole: 'system',
            awardedByName: loggedByName,
            awardedByAvatarUrl: null,
            seasonId: resolveSeasonId(seasonWindows, activeSeasonId, when),
            createdAt: when,
            occurredAt: when,
            note: typeof c.goalTitle === 'string' && c.goalTitle ? c.goalTitle : null,
            sourceRef: `devlog-${pid}-${dayKey}`,
          });
        }
      } catch (err) {
        summary.errors++;
        console.warn(`  [err] dev_checkins ${pid}:`, (err as Error).message);
      }
    }
  }

  // ── (c-legacy) Dev-plan log — union with development_plans practiceLog ─
  //
  // Legacy pre-worker taps stored on development_plans.goals[].practiceLog
  // never wrote a dev_checkins doc. Same dayKey → same deterministic id
  // → the enqueue dedup collapses this into a no-op when the check-in
  // already exists. When it does NOT (older plan-only tap), this is
  // the only path that recovers the row.
  if (sourceAllowed('dev_plan_log')) {
    try {
      const activePlayerIds = new Set(activePlayers.map(p => p.id));
      // Chunk into 30-id 'in' queries per Firestore's max clause size.
      const idsArr = Array.from(activePlayerIds);
      for (let i = 0; i < idsArr.length; i += 30) {
        const chunk = idsArr.slice(i, i + 30);
        const plansSnap = await db.collection('development_plans')
          .where('playerId', 'in', chunk)
          .get();
        for (const planDoc of plansSnap.docs) {
          const plan: any = planDoc.data() || {};
          const pid: string = plan.playerId;
          const player = playersById.get(pid);
          if (!player || player.isActive === false) continue;
          const goals: any[] = Array.isArray(plan.goals) ? plan.goals : [];
          for (const g of goals) {
            const logs: any[] = Array.isArray(g.practiceLog) ? g.practiceLog : [];
            for (const entry of logs) {
              const when = coerceDate(entry?.date);
              if (!when) continue;
              const dayKey = denverKeyOfDate(when);
              const loggedBy: string | null = typeof entry?.loggedBy === 'string' && entry.loggedBy ? entry.loggedBy : null;
              const loggedByName: string | null = typeof entry?.loggedByName === 'string' && entry.loggedByName ? entry.loggedByName : null;
              enqueue({
                docId: `devlog-${pid}-${dayKey}`,
                playerId: pid,
                playerName: String(player.name || ''),
                teamId,
                clubId,
                source: 'dev_plan_log',
                xp: DEV_PLAN_LOG_XP,
                awardedBy: loggedBy,
                awardedByRole: 'system',
                awardedByName: loggedByName,
                awardedByAvatarUrl: null,
                seasonId: resolveSeasonId(seasonWindows, activeSeasonId, when),
                createdAt: when,
                occurredAt: when,
                note: typeof g.title === 'string' && g.title ? g.title : null,
                sourceRef: `devlog-${pid}-${dayKey}`,
              });
            }
          }
        }
      }
    } catch (err) {
      summary.errors++;
      console.warn('  [err] development_plans union scan:', (err as Error).message);
    }
  }

  // ── (d, e) Badges from player.badges map ──────────────────────
  //
  // Every stamped badge with earnedAt in the window emits one row
  // in the source that matches its slug. Streak_N badges route to
  // the shared 'streak_milestone' source with the per-threshold XP.
  for (const player of activePlayers) {
    const pid = player.id;
    const badges: Record<string, any> = (player.badges && typeof player.badges === 'object') ? player.badges : {};

    for (const slug of FIRST_BADGE_SLUGS) {
      const b: any = badges[slug];
      if (!b) continue;
      const when = coerceDate(b.earnedAt);
      if (!when) continue;
      const source = BADGE_SOURCE[slug];
      const xp = BADGE_XP[slug] || 0;
      if (!source || xp <= 0) continue;
      enqueue({
        docId: `first-${slug}-${pid}`,
        playerId: pid,
        playerName: String(player.name || ''),
        teamId,
        clubId,
        source,
        xp,
        awardedBy: null,
        awardedByRole: 'system',
        awardedByName: null,
        awardedByAvatarUrl: null,
        seasonId: typeof b.seasonId === 'string' && b.seasonId
          ? b.seasonId
          : resolveSeasonId(seasonWindows, activeSeasonId, when),
        createdAt: when,
        occurredAt: when,
        note: typeof b.context === 'string' && b.context ? b.context : null,
        sourceRef: `first-${slug}-${pid}`,
      });
    }

    // perfect_attendance: LIVE-CODE PATH DIVERGES.
    //
    // src/utils/badgeGrants.ts:161 keys the audit row at
    // 'pa-{playerId}-{seasonSuffix}' where seasonSuffix = ctx.seasonId
    // (typically the active season for the team) || 'all'. Every other
    // first-* badge uses 'first-{slug}-{playerId}'. To keep re-runs
    // idempotent AND avoid duplicating whatever live grants already
    // landed, backfill emits perfect_attendance with the pa-* pattern
    // using the currently-active season for the team (or 'all' if none).
    // The seasonSuffix is fixed per team per backfill run, so re-runs
    // ALREADY_EXISTS on the same doc id.
    {
      const b: any = badges['perfect_attendance'];
      if (b) {
        const when = coerceDate(b.earnedAt);
        const xp = BADGE_XP['perfect_attendance'] || 0;
        if (when && xp > 0) {
          const seasonSuffix = activeSeasonId || 'all';
          enqueue({
            docId: `pa-${pid}-${seasonSuffix}`,
            playerId: pid,
            playerName: String(player.name || ''),
            teamId,
            clubId,
            source: 'perfect_attendance',
            xp,
            awardedBy: null,
            awardedByRole: 'system',
            awardedByName: null,
            awardedByAvatarUrl: null,
            seasonId: typeof b.seasonId === 'string' && b.seasonId
              ? b.seasonId
              : resolveSeasonId(seasonWindows, activeSeasonId, when),
            createdAt: when,
            occurredAt: when,
            note: typeof b.context === 'string' && b.context ? b.context : null,
            sourceRef: `pa-${pid}-${seasonSuffix}`,
          });
        }
      }
    }

    for (const [n, slug] of STREAK_THRESHOLDS) {
      const b: any = badges[slug];
      if (!b) continue;
      const when = coerceDate(b.earnedAt);
      if (!when) continue;
      const xp = BADGE_XP[slug] || 0;
      if (xp <= 0) continue;
      enqueue({
        docId: `streak-${pid}-${n}`,
        playerId: pid,
        playerName: String(player.name || ''),
        teamId,
        clubId,
        source: 'streak_milestone',
        xp,
        awardedBy: null,
        awardedByRole: 'system',
        awardedByName: null,
        awardedByAvatarUrl: null,
        seasonId: typeof b.seasonId === 'string' && b.seasonId
          ? b.seasonId
          : resolveSeasonId(seasonWindows, activeSeasonId, when),
        createdAt: when,
        occurredAt: when,
        note: `${n}-day streak`,
        sourceRef: `streak-${pid}-${n}`,
      });
    }
  }

  // ── (f) Coach whispers ────────────────────────────────────────
  //
  // parent_whispers rows with kind=='whisper' and xp>0 in the
  // window. The live worker path (handleXpAwardWhisper in
  // worker/src/writeGuards.ts:4137) writes player_xp_events with
  // sourceRef = whisperId RAW (no prefix), which the shared
  // writeXpGrant helper turns into the doc id
  // player_xp_events/{whisperId}. Backfill mirrors that exact id so
  // the .create() call ALREADY_EXISTS-dedups against the live row —
  // no ±60s createdAt window heuristic required, and no
  // ambiguous-match branch to sort out.
  if (sourceAllowed('coach_whisper')) {
    try {
      const wSnap = await db.collection('parent_whispers')
        .where('teamId', '==', teamId)
        .where('kind', '==', 'whisper')
        .get();
      for (const wDoc of wSnap.docs) {
        const w: any = wDoc.data() || {};
        const pid: string = w.playerId;
        const player = pid ? playersById.get(pid) : null;
        if (!player || player.isActive === false) continue;
        const when = coerceDate(w.createdAt);
        if (!when || !inWindow(when, effectiveStart)) continue;
        const xp = Number(w.xp);
        if (!(xp > 0)) continue;

        const coachUid: string | null = typeof w.coachUid === 'string' && w.coachUid ? w.coachUid : null;
        const coachName: string | null = typeof w.coachName === 'string' && w.coachName ? w.coachName : null;
        const coachAvatar: string | null = typeof w.coachAvatarUrl === 'string' && w.coachAvatarUrl ? w.coachAvatarUrl : null;
        enqueue({
          docId: wDoc.id,
          playerId: pid,
          playerName: String(player.name || ''),
          teamId,
          clubId,
          source: 'coach_whisper',
          xp: xp > 0 ? Math.round(xp) : COACH_WHISPER_XP,
          awardedBy: coachUid,
          awardedByRole: 'coach',
          awardedByName: coachName,
          awardedByAvatarUrl: coachAvatar,
          seasonId: resolveSeasonId(seasonWindows, activeSeasonId, when),
          createdAt: when,
          occurredAt: when,
          note: typeof w.message === 'string' && w.message ? String(w.message).slice(0, 500) : null,
          sourceRef: wDoc.id,
        });
      }
    } catch (err) {
      summary.errors++;
      console.warn('  [err] parent_whispers scan:', (err as Error).message);
    }
  }

  // ── (g) Kudos conversions ─────────────────────────────────────
  //
  // kudos with xpAwarded > 0. The live conversion path already
  // creates player_xp_events with an id matching what we would
  // enqueue here (kudos-{kudosId}) via /xp/convert-kudos, so an
  // apply-run against an already-live kudos is a Firestore
  // ALREADY_EXISTS no-op. Only orphaned rows (network flake between
  // kudos.xpAwarded write and event write) land new rows.
  if (sourceAllowed('kudos_coach_convert')) {
    try {
      const kSnap = await db.collection('kudos')
        .where('teamId', '==', teamId)
        .get();
      for (const kDoc of kSnap.docs) {
        const k: any = kDoc.data() || {};
        const pid: string = k.playerId;
        const player = pid ? playersById.get(pid) : null;
        if (!player || player.isActive === false) continue;
        const xp = Number(k.xpAwarded);
        if (!(xp > 0)) continue;
        const when = coerceDate(k.xpAwardedAt) || coerceDate(k.createdAt);
        if (!when || !inWindow(when, effectiveStart)) continue;
        const coachUid: string | null = typeof k.xpAwardedBy === 'string' && k.xpAwardedBy ? k.xpAwardedBy : null;
        const coachInfo = coachUid ? await lookupUser(coachUid) : { name: null, avatar: null };
        const coachName = coachInfo.name || (typeof k.xpAwardedByName === 'string' ? k.xpAwardedByName : null);
        enqueue({
          docId: `kudos-${kDoc.id}`,
          playerId: pid,
          playerName: String(player.name || ''),
          teamId,
          clubId,
          source: 'kudos_coach_convert',
          xp: Math.round(xp),
          awardedBy: coachUid,
          awardedByRole: 'coach',
          awardedByName: coachName,
          awardedByAvatarUrl: coachInfo.avatar,
          seasonId: typeof k.seasonId === 'string' && k.seasonId
            ? k.seasonId
            : resolveSeasonId(seasonWindows, activeSeasonId, when),
          createdAt: when,
          occurredAt: when,
          note: typeof k.xpNote === 'string' && k.xpNote ? k.xpNote : (typeof k.note === 'string' ? k.note.slice(0, 500) : null),
          sourceRef: `kudos-${kDoc.id}`,
        });
      }
    } catch (err) {
      summary.errors++;
      console.warn('  [err] kudos scan:', (err as Error).message);
    }
  }

  // ── Write phase. Per-player rows first so the breakdown map is
  // easy to accumulate. Use .create() so ALREADY_EXISTS is a
  // deterministic error we can count as 'skipped'.
  const perPlayer = new Map<string, { player: any; rows: RowSeed[] }>();
  for (const seed of seedsByDocId.values()) {
    if (!perPlayer.has(seed.playerId)) {
      perPlayer.set(seed.playerId, { player: playersById.get(seed.playerId), rows: [] });
    }
    perPlayer.get(seed.playerId)!.rows.push(seed);
  }

  for (const [pid, { player, rows }] of perPlayer) {
    const bySource: Record<string, number> = {};
    let rowsWritten = 0;

    for (const seed of rows) {
      const payload: Record<string, any> = {
        playerId: seed.playerId,
        playerName: seed.playerName,
        teamId: seed.teamId,
        source: seed.source,
        xp: seed.xp,
        awardedBy: seed.awardedBy,
        awardedByRole: seed.awardedByRole,
        awardedByName: seed.awardedByName,
        awardedByAvatarUrl: seed.awardedByAvatarUrl,
        createdAt: seed.createdAt,
        occurredAt: seed.occurredAt,
        sourceRef: seed.sourceRef,
        backfilled: true,
      };
      if (seed.clubId) payload.clubId = seed.clubId;
      if (seed.seasonId) payload.seasonId = seed.seasonId;
      if (seed.note) payload.note = seed.note;

      if (!APPLY) {
        console.log(
          `  [${tag}] would create player_xp_events/${seed.docId}  ` +
          `player=${seed.playerId} source=${seed.source} xp=${seed.xp} ` +
          `occurredAt=${seed.occurredAt.toISOString()}`
        );
        summary.newRows++;
        rowsWritten++;
        bySource[seed.source] = (bySource[seed.source] || 0) + 1;
        continue;
      }

      try {
        await db.collection('player_xp_events').doc(seed.docId).create(payload);
        summary.newRows++;
        rowsWritten++;
        bySource[seed.source] = (bySource[seed.source] || 0) + 1;
        console.log(
          `  [${tag}] created player_xp_events/${seed.docId}  ` +
          `player=${seed.playerId} source=${seed.source} xp=${seed.xp}`
        );
      } catch (err: any) {
        // Firestore Admin surfaces ALREADY_EXISTS as code 6.
        const code = err?.code;
        const msg = String(err?.message || err);
        if (code === 6 || msg.includes('ALREADY_EXISTS') || msg.includes('Already exists')) {
          summary.skipped++;
          // Silent success; deterministic id is doing its job.
        } else {
          summary.errors++;
          console.warn(`  [err] create ${seed.docId}:`, msg);
        }
      }
    }

    summary.playerBreakdown.push({
      playerId: pid,
      playerName: String(player?.name || ''),
      rowsWritten,
      bySource,
    });
  }

  return summary;
}

// ────────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────────

(async () => {
  const teams: FirebaseFirestore.DocumentSnapshot[] = [];
  if (TEAM_ONLY) {
    const t = await db.collection('teams').doc(TEAM_ONLY).get();
    if (!t.exists) {
      console.error(`Team ${TEAM_ONLY} not found.`);
      process.exit(1);
    }
    teams.push(t);
  } else {
    // Fetch every team, then filter to xpConfig.enabled === true in
    // memory. We can't chain .where('xpConfig.enabled', '==', true)
    // with .where('isActive', '!=', false) without a composite index
    // AND some legacy teams omit isActive entirely, so a full scan
    // is cheaper than the tri-state gymnastics.
    const snap = await db.collection('teams').get();
    for (const t of snap.docs) {
      const d: any = t.data() || {};
      if (d.isActive === false) continue;
      if (!d.xpConfig || d.xpConfig.enabled !== true) continue;
      teams.push(t);
    }
  }

  console.log(
    `[${tag}] backfill-player-xp-events  since=${SINCE.toISOString()}  ` +
    `teams=${teams.length}  source=${SOURCE_ONLY || 'all'}  apply=${APPLY}  verify=${VERIFY}`
  );

  if (VERIFY) {
    for (const t of teams) {
      await verifyTeam(t);
    }
    console.log(`\n[${tag}] done.`);
    process.exit(0);
  }

  const summaries: TeamSummary[] = [];
  for (const t of teams) {
    try {
      const s = await backfillTeam(t);
      if (s) summaries.push(s);
    } catch (err) {
      console.warn(`[${tag}] team ${t.id} failed:`, (err as Error).message);
    }
  }

  // Roll-up. Per-team summary first, then a totals line so a quick
  // scroll to the bottom is enough for a post-run gut-check.
  let totNew = 0, totSkip = 0, totErr = 0, totAmbig = 0;
  for (const s of summaries) {
    totNew += s.newRows;
    totSkip += s.skipped;
    totErr += s.errors;
    totAmbig += s.ambiguous.length;
    console.log(
      `\n[SUMMARY] team=${s.teamId} (${s.teamName})  ` +
      `new=${s.newRows}  skipped=${s.skipped}  ambiguous=${s.ambiguous.length}  errors=${s.errors}`
    );
    for (const pb of s.playerBreakdown) {
      if (pb.rowsWritten === 0) continue;
      const parts = Object.entries(pb.bySource)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      console.log(`    ${pb.playerId} (${pb.playerName}) rows=${pb.rowsWritten}  ${parts}`);
    }
    for (const a of s.ambiguous) {
      console.log(`    [ambig] player=${a.playerId} (${a.playerName}) reason=${a.reason} detail=${a.detail}`);
    }
  }

  console.log(
    `\n[${tag}] done. teams=${summaries.length}  new=${totNew}  ` +
    `skipped=${totSkip}  ambiguous=${totAmbig}  errors=${totErr}`
  );
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
