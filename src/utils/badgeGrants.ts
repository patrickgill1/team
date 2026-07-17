import { doc, updateDoc, serverTimestamp, increment } from 'firebase/firestore';
import { db } from './firebase';
import { BadgeSlug, badgeXp } from './badgeMeta';
import { isXpSourceEnabled, XpSourceKey } from './xpSource';
import type { Team } from '../types';

// Badge grant helpers. Every grant fires ONLY on the crossing action
// from ship-forward — never retroactively from historical stats.
//
// Contract: a grant only writes badges.{slug} when the READ-AT-THE-
// MOMENT-OF-WRITE existing counter is < threshold AND the WRITE result
// is >= threshold. A player with 3 pre-existing POTMs but no badge
// entry does NOT get first_potm because the check is "does the badge
// entry exist?", not "have they ever done this?". Similarly, streak
// badges look at priorStreak → newStreak crossings only.
//
// Every grant is idempotent — safe to call multiple times.
//
// XP GATE (Ship 2, 2026-07-17): each grant now gates on the team's
// per-source key via isXpSourceEnabled(team, <key>). Callers pass the
// `team` object in ctx; a missing team fails-closed (no grants). If
// per-source keys are absent, the resolver falls back to Ship 1's
// coarse `participation` / `badges` keys. If the coach hasn't opted
// the team into XP (team.xpConfig.enabled !== true), grants short-
// circuit to a no-op. This closes
// the "zombie writes" hole where auto-grants kept firing on stat
// writes and streak crossings even for teams that never turned XP on
// — silently accumulating player.xp / player.badges that would jump
// out suddenly the moment the coach flipped it on.
//
// Behavior with the gate ON:
//  - New player joins a team where xpConfig is off: nothing accrues.
//    xp stays 0, badges stays empty.
//  - Coach later enables xpConfig: forward grants fire from ship-
//    forward. A player with 12 goals already scored will NOT get
//    first_goal from THIS file — the 0→N crossing already happened
//    while grants were silenced. Retroactive credit is handled by
//    the one-shot worker sweep at POST /xp/backfill-commit (see
//    worker/src/xpBackfill.ts), not from the client. That sweep
//    reads career-total denorms + match_votings + dev-plan history
//    and mints deterministic-id player_xp_events so a re-run is a
//    Firestore 409 no-op. Client helpers here stay ship-forward
//    only — the retro path is server-only by design.
//  - Multi-team player: grants gate on the team where the ACTION
//    fired. Action on Team A (xp off) → skip. Action on Team B (xp
//    on) → grant. player.xp accumulates across all xp-on teams.

interface BadgePayload {
  earnedAt: any;
  seasonId?: string;
  context?: string;
}

function makeBadge(context?: string, seasonId?: string): BadgePayload {
  const payload: BadgePayload = { earnedAt: serverTimestamp() };
  if (seasonId) payload.seasonId = seasonId;
  if (context) payload.context = context;
  return payload;
}

/** Grant the "first_X" stat badges when a stat count crosses 0→N.
 *  Called from the primary stat-write sites (GameDay finalize,
 *  StatsTracker, clip-credit reconcile). Only the FIRST goal/assist/
 *  save fires the badge — subsequent games don't re-trigger.
 *
 *  prev is the state Firestore had before this write. next is what
 *  we're about to persist. If prev.X === 0 and next.X > 0, badge lands.
 *  Also handles clean sheet — prev.cleanSheets === 0 && next.cleanSheets > 0. */
export async function maybeGrantFirstStatBadges(
  playerId: string,
  prev: { goals?: number; assists?: number; saves?: number; cleanSheets?: number } | null | undefined,
  next: { goals?: number; assists?: number; saves?: number; cleanSheets?: number },
  ctx: { team?: Team | null; existingBadges?: Record<string, any>; context?: string; seasonId?: string } = {},
): Promise<void> {
  if (!playerId) return;
  // XP gate: no-op unless the team has master XP + at least one of the
  // four first-stat sources enabled. Individual badges are gated below
  // so the coach can silence one milestone without disabling the rest.
  const team = ctx.team ?? null;
  if (!team) return;
  const gate = (k: XpSourceKey) => isXpSourceEnabled(team, k);
  const prevG = prev?.goals || 0;
  const prevA = prev?.assists || 0;
  const prevS = prev?.saves || 0;
  const prevC = prev?.cleanSheets || 0;
  const nextG = next.goals || 0;
  const nextA = next.assists || 0;
  const nextS = next.saves || 0;
  const nextC = next.cleanSheets || 0;

  const existing = ctx.existingBadges || {};
  const patch: Record<string, any> = {};
  let xpAwarded = 0;

  if (gate('firstGoal') && prevG === 0 && nextG > 0 && !existing.first_goal) {
    patch['badges.first_goal'] = makeBadge(ctx.context, ctx.seasonId);
    xpAwarded += badgeXp('first_goal');
  }
  if (gate('firstAssist') && prevA === 0 && nextA > 0 && !existing.first_assist) {
    patch['badges.first_assist'] = makeBadge(ctx.context, ctx.seasonId);
    xpAwarded += badgeXp('first_assist');
  }
  if (gate('firstSave') && prevS === 0 && nextS > 0 && !existing.first_save) {
    patch['badges.first_save'] = makeBadge(ctx.context, ctx.seasonId);
    xpAwarded += badgeXp('first_save');
  }
  if (gate('firstCleanSheet') && prevC === 0 && nextC > 0 && !existing.first_clean_sheet) {
    patch['badges.first_clean_sheet'] = makeBadge(ctx.context, ctx.seasonId);
    xpAwarded += badgeXp('first_clean_sheet');
  }

  if (Object.keys(patch).length === 0) return;
  if (xpAwarded > 0) {
    // Increment aggregates in the same write so the parent whisper /
    // XP card render doesn't temporarily show badge earned but XP
    // untouched. player_xp_events audit doc is worker-only (rules
    // deny client create) — the badge entry itself is the durable
    // audit trail for auto-earned badges.
    patch.xp = increment(xpAwarded);
    patch.xpCareer = increment(xpAwarded);
  }
  try {
    await updateDoc(doc(db, 'players', playerId), patch);
  } catch (err) {
    console.warn('[badges] grant first-stat failed', playerId, err);
  }
}

/** Grant streak badges when prior → new crosses a threshold. Called
 *  from recomputeAndPersistPlayerStreak. Returns a patch object the
 *  caller can merge into its existing updateDoc payload (so we don't
 *  make an extra Firestore write per tap).
 *
 *  Semantics: award streak_N when priorStreak < N && newStreak >= N.
 *  A kid who already had streak >= N pre-ship doesn't get retroactive
 *  credit — only actual crossings from this ship forward. Multiple
 *  badges can fire in one call (a 0→25 jump lands 5/10/25 together). */
export function computeStreakBadgePatch(
  priorStreak: number,
  newStreak: number,
  existingBadges: Record<string, any> | null | undefined,
  ctx: { seasonId?: string; playerName?: string; team?: Team | null } = {},
): Record<string, any> {
  // XP gate: return an empty patch so the caller's outer streak-days
  // write still commits, but no badge/XP side-effects fire.
  if (!isXpSourceEnabled(ctx.team ?? null, 'streaks')) return {};
  const thresholds: Array<[number, BadgeSlug]> = [
    [5, 'streak_5'],
    [10, 'streak_10'],
    [25, 'streak_25'],
    [50, 'streak_50'],
  ];
  const existing = existingBadges || {};
  const patch: Record<string, any> = {};
  let xpAwarded = 0;
  for (const [n, slug] of thresholds) {
    if (priorStreak < n && newStreak >= n && !existing[slug]) {
      patch[`badges.${slug}`] = makeBadge(
        ctx.playerName ? `${n}-day streak` : undefined,
        ctx.seasonId,
      );
      xpAwarded += badgeXp(slug);
    }
  }
  if (xpAwarded > 0) {
    patch.xp = increment(xpAwarded);
    patch.xpCareer = increment(xpAwarded);
  }
  return patch;
}

/** Grant perfect_attendance when a player has attended every
 *  completed team event so far this season. Called from event write
 *  paths where attendance is updated (AttendanceTracker save, kid
 *  RSVP set-to-going flows).
 *
 *  Guardrails:
 *   - Requires MIN_EVENTS completed events attended so a kid with 1
 *     event doesn't degenerate to "perfect."
 *   - Only fires the FIRST time the crossing hits 100% — idempotent
 *     via the existing badge check.
 *   - Skipped when the existing badge is already present.
 *
 *  Caller passes {attended, total} counts computed over the same
 *  event window (completed team events, past 6-12 months typical).
 *  We check attended === total && total >= MIN_EVENTS. */
const PERFECT_ATTENDANCE_MIN_EVENTS = 5;
export async function maybeGrantPerfectAttendance(
  playerId: string,
  attended: number,
  total: number,
  ctx: { team?: Team | null; existingBadges?: Record<string, any>; context?: string; seasonId?: string } = {},
): Promise<void> {
  if (!playerId) return;
  if (!isXpSourceEnabled(ctx.team ?? null, 'perfectAttendance')) return;
  const existing = ctx.existingBadges || {};
  if (existing.perfect_attendance) return;
  if (total < PERFECT_ATTENDANCE_MIN_EVENTS) return;
  if (attended !== total) return;
  const xp = badgeXp('perfect_attendance');
  try {
    await updateDoc(doc(db, 'players', playerId), {
      'badges.perfect_attendance': makeBadge(
        ctx.context || `Perfect attendance across ${total} events`,
        ctx.seasonId,
      ),
      xp: increment(xp),
      xpCareer: increment(xp),
    });
  } catch (err) {
    console.warn('[badges] grant perfect_attendance failed', playerId, err);
  }
}

/** Grant first_potm when a player wins their first Player of the
 *  Match. Idempotent — returns undefined if the badge already exists.
 *  Caller merges the returned patch into the winner's updateDoc. */
export function computeFirstPotmPatch(
  existingBadges: Record<string, any> | null | undefined,
  ctx: { gameTitle?: string; seasonId?: string; team?: Team | null } = {},
): Record<string, any> | null {
  if (!isXpSourceEnabled(ctx.team ?? null, 'firstPotm')) return null;
  const existing = existingBadges || {};
  if (existing.first_potm) return null;
  const xp = badgeXp('first_potm');
  return {
    'badges.first_potm': makeBadge(ctx.gameTitle, ctx.seasonId),
    xp: increment(xp),
    xpCareer: increment(xp),
  };
}
