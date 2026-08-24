import { BadgeSlug, badgeXp } from './badgeMeta';
import { isXpSourceEnabled, XpSourceKey } from './xpSource';
import { awardMicroXp } from './microXp';
import type { Team } from '../types';

// Badge grant helpers. Every grant fires ONLY on the crossing action
// from ship-forward — never retroactively from historical stats.
//
// 2026-07-24 rewire: every write here now routes through the worker
// via awardMicroXp → POST /xp/log-grant. Client no longer touches
// player.xp / player.badges directly — the audit event row, XP
// increment, and badge stamp all land as a single service-account
// commit. Deterministic sourceRefs make retries + backfill safe:
// hitting the same slug for the same player is a 409 ALREADY_EXISTS
// no-op on the second call.
//
// Contract: a grant only fires when the READ-AT-CALL-TIME existing
// badge entry is missing AND the ctx says the underlying stat/streak
// crossed 0 → N. A player with 3 pre-existing POTMs but no badge
// entry does NOT get first_potm because the check is "does the badge
// entry exist?", not "have they ever done this?". Similarly, streak
// badges look at priorStreak → newStreak crossings only.
//
// XP GATE: each grant gates on the team's per-source key via
// isXpSourceEnabled(team, <key>). Callers pass the `team` object in
// ctx; a missing team fails-closed (no grants). If per-source keys
// are absent, the resolver falls back to Ship 1's coarse
// `participation` / `badges` keys. Master `team.xpConfig.enabled` off
// short-circuits every helper to a no-op.
//
// Backfill of pre-XP-config history is a SEPARATE worker sweep at
// POST /xp/backfill-commit. Client helpers here stay ship-forward only.

/** ISO string for "now" — used as the earnedAt stamp on badges. The
 *  worker mirrors this into the badge doc on the player. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Grant the "first_X" stat badges when a stat count crosses 0→N.
 *  Called from the primary stat-write sites (GameDay finalize,
 *  StatsTracker, clip-credit reconcile). Only the FIRST goal/assist/
 *  save/clean-sheet fires the badge — subsequent games don't re-trigger.
 *
 *  Under the hood: for each triggered badge, fires awardMicroXp with
 *  alsoStampBadge so the badge + audit + XP land atomically on the
 *  worker. Deterministic sourceRef 'first-{slug}-{playerId}' means a
 *  retry (network hiccup, offline replay, backfill) is idempotent. */
export async function maybeGrantFirstStatBadges(
  playerId: string,
  prev: { goals?: number; assists?: number; saves?: number; cleanSheets?: number } | null | undefined,
  next: { goals?: number; assists?: number; saves?: number; cleanSheets?: number },
  ctx: { team?: Team | null; existingBadges?: Record<string, any>; context?: string; seasonId?: string } = {},
): Promise<void> {
  if (!playerId) return;
  const team = ctx.team ?? null;
  if (!team) return;
  const teamId = (team as any)?.id;
  if (!teamId) return;
  // Master gate: cheap short-circuit before we start pinging the worker.
  if ((team as any)?.xpConfig?.enabled !== true) return;

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
  const earnedAt = nowIso();

  type Grant = { slug: BadgeSlug; source: string };
  const grants: Grant[] = [];
  if (gate('firstGoal') && prevG === 0 && nextG > 0 && !existing.first_goal) {
    grants.push({ slug: 'first_goal', source: 'first_goal' });
  }
  if (gate('firstAssist') && prevA === 0 && nextA > 0 && !existing.first_assist) {
    grants.push({ slug: 'first_assist', source: 'first_assist' });
  }
  if (gate('firstSave') && prevS === 0 && nextS > 0 && !existing.first_save) {
    grants.push({ slug: 'first_save', source: 'first_save' });
  }
  if (gate('firstCleanSheet') && prevC === 0 && nextC > 0 && !existing.first_clean_sheet) {
    grants.push({ slug: 'first_clean_sheet', source: 'first_clean_sheet' });
  }
  if (grants.length === 0) return;

  await Promise.all(grants.map(g => awardMicroXp({
    playerId,
    teamId,
    source: g.source,
    xp: badgeXp(g.slug),
    sourceRef: `first-${g.slug}-${playerId}`,
    alsoStampBadge: { slug: g.slug, earnedAt },
    note: ctx.context,
    xpEnabled: true,
  }).catch(err => {
    console.warn('[badges] grant first-stat failed', playerId, g.slug, err);
    return { ok: false } as const;
  })));
}

/** Grant streak badges when prior → new crosses a threshold.
 *
 *  DEPRECATED 2026-07-24: streak-milestone badges are now granted
 *  server-side inside POST /xp/log-tap as part of the atomic streak
 *  recompute. This helper is retained for signature compatibility with
 *  any external callers and returns an empty patch — merging {} into
 *  a caller's updateDoc is a safe no-op.
 *
 *  If a new client caller wants to grant streak badges directly, use
 *  awardMicroXp({ source: 'streak_milestone', sourceRef: `streak-{pid}-{N}`,
 *  alsoStampBadge: { slug: `streak_${N}`, earnedAt } }) instead. */
export function computeStreakBadgePatch(
  _priorStreak: number,
  _newStreak: number,
  _existingBadges: Record<string, any> | null | undefined,
  _ctx: { seasonId?: string; playerName?: string; team?: Team | null } = {},
): Record<string, any> {
  return {};
}

/** Grant perfect_attendance when a player has attended every completed
 *  team event so far this season (with a min-event guardrail).
 *
 *  Guardrails:
 *   - Requires MIN_EVENTS completed events attended so a kid with 1
 *     event doesn't degenerate to "perfect."
 *   - Only fires the FIRST time the crossing hits 100% — idempotent
 *     via the deterministic sourceRef.
 *   - Skipped when the existing badge is already present. */
const PERFECT_ATTENDANCE_MIN_EVENTS = 5;
export async function maybeGrantPerfectAttendance(
  playerId: string,
  attended: number,
  total: number,
  ctx: { team?: Team | null; existingBadges?: Record<string, any>; context?: string; seasonId?: string } = {},
): Promise<void> {
  if (!playerId) return;
  const team = ctx.team ?? null;
  if (!team) return;
  const teamId = (team as any)?.id;
  if (!teamId) return;
  if (!isXpSourceEnabled(team, 'perfectAttendance')) return;
  const existing = ctx.existingBadges || {};
  if (existing.perfect_attendance) return;
  if (total < PERFECT_ATTENDANCE_MIN_EVENTS) return;
  if (attended !== total) return;

  const seasonSuffix = ctx.seasonId || 'all';
  const note = ctx.context || `Perfect attendance across ${total} events`;
  await awardMicroXp({
    playerId,
    teamId,
    source: 'perfect_attendance',
    xp: badgeXp('perfect_attendance'),
    sourceRef: `pa-${playerId}-${seasonSuffix}`,
    alsoStampBadge: { slug: 'perfect_attendance', earnedAt: nowIso() },
    note,
    xpEnabled: true,
  }).catch(err => {
    console.warn('[badges] grant perfect_attendance failed', playerId, err);
  });
}

/** Grant first_potm when a player wins their first Player of the
 *  Match. Idempotent via the deterministic sourceRef 'first-first_potm-{playerId}'
 *  — a re-tap on the same player is a 409 ALREADY_EXISTS no-op on the worker.
 *
 *  Renamed from computeFirstPotmPatch on 2026-07-24: the helper used to
 *  return a merge patch that the caller spread into a client updateDoc
 *  against players/{id}. That leaked the "XP + badge in one write"
 *  atomicity contract into the caller. New shape hands the whole grant
 *  to the worker via awardMicroXp so the audit row + player.xp
 *  increment + badges.first_potm stamp land as one commit. */
export async function maybeGrantFirstPotm(
  playerId: string,
  ctx: {
    team?: Team | null;
    teamId?: string;
    existingBadges?: Record<string, any>;
    gameTitle?: string;
    seasonId?: string;
  } = {},
): Promise<void> {
  if (!playerId) return;
  const team = ctx.team ?? null;
  if (!team) return;
  const teamId = ctx.teamId || (team as any)?.id;
  if (!teamId) return;
  if (!isXpSourceEnabled(team, 'firstPotm')) return;
  const existing = ctx.existingBadges || {};
  if (existing.first_potm) return;

  await awardMicroXp({
    playerId,
    teamId,
    source: 'first_potm',
    xp: badgeXp('first_potm'),
    sourceRef: `first-first_potm-${playerId}`,
    alsoStampBadge: { slug: 'first_potm', earnedAt: nowIso() },
    note: ctx.gameTitle,
    xpEnabled: true,
  }).catch(err => {
    console.warn('[badges] grant first_potm failed', playerId, err);
  });
}

/** Grant hat_trick when a player racks up 3+ goals in a single real
 *  game. Once-ever semantic (matches every other badge). Called from
 *  the three sites that write goal counts:
 *    - GameDay finalize (live-tapped goals)
 *    - PlayerMediaPage clip credit (retroactive goal via linked clip)
 *    - StatsTracker (manual coach entry)
 *
 *  Callers pass the running goal count for THIS PLAYER in THIS GAME
 *  (post-write). Helper checks the threshold and grants once. If the
 *  callers can't cheaply compute the count, they can pass `null` and
 *  we'll query the stats collection ourselves.
 *
 *  Skips when:
 *    - Player has already earned hat_trick (once-ever)
 *    - XP source `hatTrick` disabled on the team
 *    - gameId is a synthetic clip_ / adjust_ id (not a real game)
 *    - Fewer than 3 goals in the game
 */
export async function maybeGrantHatTrick(
  playerId: string,
  gameId: string,
  goalsInGame: number | null,
  ctx: {
    team?: Team | null;
    teamId?: string;
    existingBadges?: Record<string, any>;
    gameTitle?: string;
  } = {},
): Promise<void> {
  if (!playerId || !gameId) return;
  // Synthetic gameIds don't represent a real match.
  if (gameId.startsWith('clip_') || gameId.startsWith('adjust_')) return;
  const team = ctx.team ?? null;
  if (!team) return;
  const teamId = ctx.teamId || (team as any)?.id;
  if (!teamId) return;
  if (!isXpSourceEnabled(team, 'hatTrick')) return;
  const existing = ctx.existingBadges || {};
  if (existing.hat_trick) return;

  // If the caller didn't pass a count, compute it from BOTH sources
  // and take the max (avoids double-count when both are populated):
  //
  //   - live_games/{gameId}.timeline — source of truth GameDay
  //     finalize uses. Captures live taps AND source='clip' entries
  //     added by attachClipCreditsToGame for live/halftime/final games.
  //
  //   - player_media where goalScorerId==playerId && gameId==this-game
  //     — catches clip credits linked to a SCHEDULED game (my
  //     3.9.419 fix skips the timeline attach for scheduled games to
  //     avoid double-count if the coach later plays the game live).
  //     The clip's own doc still stamps gameId though, so we count
  //     them by grouping player_media directly.
  //
  // Stats collection can't be used: clip credits land with synthetic
  // gameIds (`clip_${ts}_${pid}`) so 3 clip goals linked to the same
  // real game don't group by gameId in stats.
  let goals = goalsInGame;
  if (goals == null) {
    try {
      const { doc, getDoc, collection, query, where, getDocs } = await import('firebase/firestore');
      const { db } = await import('./firebase');
      // Single-field query on gameId (existing index) — filter the
      // scorerId client-side. Adding a composite index just for this
      // one grant path isn't worth it; clip volume per game is small.
      const [gameSnap, mediaSnap] = await Promise.all([
        getDoc(doc(db, 'live_games', gameId)),
        getDocs(query(
          collection(db, 'player_media'),
          where('gameId', '==', gameId),
        )),
      ]);
      let timelineGoals = 0;
      if (gameSnap.exists()) {
        const timeline: any[] = Array.isArray((gameSnap.data() as any)?.timeline)
          ? (gameSnap.data() as any).timeline
          : [];
        timelineGoals = timeline.filter(t => t?.kind === 'goal' && t?.playerId === playerId).length;
      }
      let mediaGoals = 0;
      mediaSnap.forEach(d => {
        const m: any = d.data();
        // Filter scorer client-side (see note above).
        if (m?.goalScorerId !== playerId) return;
        // Skip clips explicitly opted out or soft-deleted.
        if (m?.countsForStats === false) return;
        if (m?.isActive === false) return;
        mediaGoals += 1;
      });
      goals = Math.max(timelineGoals, mediaGoals);
    } catch (err) {
      console.warn('[badges] hat_trick goal-count query failed', playerId, gameId, err);
      return;
    }
  }
  if ((goals || 0) < 3) return;

  await awardMicroXp({
    playerId,
    teamId,
    source: 'hat_trick',
    xp: badgeXp('hat_trick'),
    // Include the gameId so a hat trick in a DIFFERENT game doesn't
    // collide on the once-ever sourceRef — but the client-side
    // existing-badges check upstream still blocks any 2nd grant.
    sourceRef: `hat_trick-${playerId}-${gameId}`,
    alsoStampBadge: { slug: 'hat_trick', earnedAt: nowIso() },
    note: ctx.gameTitle || 'Hat trick',
    xpEnabled: true,
  }).catch(err => {
    console.warn('[badges] grant hat_trick failed', playerId, err);
  });
}
