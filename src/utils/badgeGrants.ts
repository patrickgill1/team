import { doc, updateDoc, serverTimestamp, increment } from 'firebase/firestore';
import { db } from './firebase';
import { BadgeSlug, badgeXp } from './badgeMeta';

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
  ctx: { existingBadges?: Record<string, any>; context?: string; seasonId?: string } = {},
): Promise<void> {
  if (!playerId) return;
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

  if (prevG === 0 && nextG > 0 && !existing.first_goal) {
    patch['badges.first_goal'] = makeBadge(ctx.context, ctx.seasonId);
    xpAwarded += badgeXp('first_goal');
  }
  if (prevA === 0 && nextA > 0 && !existing.first_assist) {
    patch['badges.first_assist'] = makeBadge(ctx.context, ctx.seasonId);
    xpAwarded += badgeXp('first_assist');
  }
  if (prevS === 0 && nextS > 0 && !existing.first_save) {
    patch['badges.first_save'] = makeBadge(ctx.context, ctx.seasonId);
    xpAwarded += badgeXp('first_save');
  }
  if (prevC === 0 && nextC > 0 && !existing.first_clean_sheet) {
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
  ctx: { seasonId?: string; playerName?: string } = {},
): Record<string, any> {
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

/** Grant first_potm when a player wins their first Player of the
 *  Match. Idempotent — returns undefined if the badge already exists.
 *  Caller merges the returned patch into the winner's updateDoc. */
export function computeFirstPotmPatch(
  existingBadges: Record<string, any> | null | undefined,
  ctx: { gameTitle?: string; seasonId?: string } = {},
): Record<string, any> | null {
  const existing = existingBadges || {};
  if (existing.first_potm) return null;
  const xp = badgeXp('first_potm');
  return {
    'badges.first_potm': makeBadge(ctx.gameTitle, ctx.seasonId),
    xp: increment(xp),
    xpCareer: increment(xp),
  };
}
