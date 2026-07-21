import { doc, getDoc, increment, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { denverKeyOfDate } from './devPlanActions';

// Micro-XP grants — the "everyday tap" side of the XP economy.
//
// Existing accrual paths (worker coach recognition, first-stat 0->N,
// streak milestones, first POTM, perfect_attendance) are all threshold
// rewards. Those are lumpy by design but they don't reinforce the
// day-to-day behaviors we actually want repeated (log a practice,
// RSVP going, send a chat message). Micro-XP fills that gap in small
// amounts on kid-driven actions.
//
// Gates + guarantees:
//   - Fail-closed on team.xpConfig.enabled. Passing xpEnabled=false or
//     omitting it is a silent no-op — same pattern as badgeGrants.
//   - Every grant writes BOTH player.xp and player.xpCareer via
//     FieldValue.increment so the season rail and the career total
//     move in lockstep.
//   - Idempotent from the caller's perspective: safe to call multiple
//     times on the same action. Daily-cap actions rate-limit through
//     player.xpDailyCount; uncapped actions rely on the caller gating
//     the transition (e.g. RSVP only grants when flipping into 'going'
//     from a non-going state).
//   - No worker round-trip. All writes are client-side against
//     players/{playerId} using fields the rules already allow parents
//     to mutate on their own kids.
//
// player.xpDailyCount shape (owned here — not touched elsewhere):
//   {
//     yyyymmdd: 'YYYY-MM-DD',           // local-day key for the bucket
//     counts:   { [actionKey]: number } // XP granted per action today
//   }
// The whole map is replaced when the day rolls over. Same-day
// increments use a dot-path so concurrent taps within a day compose
// via the Firestore server-side counter instead of racing on a full
// map overwrite.

export interface AwardMicroXpOpts {
  /** Team.xpConfig.enabled. Fail-closed: anything other than true is
   *  a no-op. Caller derives this from the player's team doc. */
  xpEnabled: boolean;
  /** Max XP this action may grant per calendar day (kid-local time).
   *  When set, awardMicroXp reads the player doc first to check the
   *  running count. Undefined = no cap (single write, no read). */
  dailyCap?: number;
  /** Bucket key for the dailyCap counter. Defaults to 'default' when
   *  only one capped action exists per player; pass something like
   *  'chat_message' when multiple capped actions share the doc. */
  actionKey?: string;
}

/** Grant a small XP amount for a kid-driven action.
 *
 *  Contract:
 *    - No-op unless opts.xpEnabled === true.
 *    - No-op if amount <= 0.
 *    - When dailyCap is set: reads the player doc, computes remaining
 *      cap for today, and only writes if remaining > 0. Amount is
 *      clamped to `remaining`.
 *    - Failures are logged (console.warn) and swallowed so the
 *      primary action's UX is not blocked by an XP hiccup.
 */
export async function awardMicroXp(
  playerId: string,
  amount: number,
  opts: AwardMicroXpOpts,
): Promise<void> {
  if (!playerId || amount <= 0) return;
  if (opts.xpEnabled !== true) return;

  const cap = opts.dailyCap && opts.dailyCap > 0 ? opts.dailyCap : null;
  const key = opts.actionKey || 'default';
  const today = todayKey();

  let grant = amount;
  let sameDay = false;
  // Snapshot player doc data for the level-up whisper. When capped
  // we already read the player doc; when uncapped we do NOT add a
  // second read (level-up trigger becomes a no-op — the streak /
  // badge write paths handle level crossings on their own reads).
  let priorXp = 0;
  let teamId: string | null = null;
  let playerName: string | undefined;
  let parentIds: string[] | undefined;
  let priorXpKnown = false;

  if (cap != null) {
    try {
      const snap = await getDoc(doc(db, 'players', playerId));
      if (snap.exists()) {
        const data: any = snap.data();
        priorXp = Number(data?.xp) || 0;
        priorXpKnown = true;
        teamId = typeof data?.teamId === 'string' ? data.teamId : null;
        playerName = typeof data?.name === 'string' ? data.name : undefined;
        parentIds = Array.isArray(data?.parentIds) ? data.parentIds : undefined;
        const bucket = data?.xpDailyCount;
        if (bucket && bucket.yyyymmdd === today) {
          sameDay = true;
          const already = Number(bucket?.counts?.[key] ?? 0) | 0;
          const remaining = Math.max(0, cap - already);
          if (remaining <= 0) return;
          grant = Math.min(amount, remaining);
        }
      }
    } catch (err) {
      // Fail-closed: if we can't verify the cap, don't grant. Better
      // to miss a tick than double-count a spammy day.
      console.warn('[microXp] daily-cap read failed', playerId, err);
      return;
    }
  }

  const patch: Record<string, any> = {
    xp: increment(grant),
    xpCareer: increment(grant),
  };
  if (cap != null) {
    if (sameDay) {
      patch[`xpDailyCount.counts.${key}`] = increment(grant);
    } else {
      patch.xpDailyCount = { yyyymmdd: today, counts: { [key]: grant } };
    }
  }

  try {
    await updateDoc(doc(db, 'players', playerId), patch);
    // Level-up parent whisper — only for capped actions where we
    // already have priorXp + teamId from the pre-write read. Uncapped
    // paths (RSVP, I did it) piggyback on other level-up triggers
    // (streak crossings, badge grants) so we don't pay an extra read.
    if (priorXpKnown && teamId && grant > 0) {
      try {
        const { checkLevelUpAndWhisper } = await import('./levelUp');
        void checkLevelUpAndWhisper(playerId, priorXp, priorXp + grant, teamId, {
          xpEnabled: true,
          playerData: { name: playerName, parentIds },
        });
      } catch { /* dynamic import failure; whisper is a nice-to-have */ }
    }
  } catch (err) {
    console.warn('[microXp] write failed', playerId, amount, err);
  }
}

/** Same-write variant: returns a patch object callers can spread into
 *  their own updateDoc against players/{playerId}. Use when the
 *  primary action is ALREADY writing to the player doc and no other
 *  xp/xpCareer increment sentinel is in the outgoing patch (see
 *  composeMicroXpIntoPatch for the badge-grant collision case).
 *
 *  Fails closed. Uncapped — pass through awardMicroXp when you need
 *  rate limiting. */
export function microXpPatch(amount: number, xpEnabled: boolean): Record<string, any> {
  if (!xpEnabled || amount <= 0) return {};
  return {
    xp: increment(amount),
    xpCareer: increment(amount),
  };
}

/** Compose micro-XP INTO an existing badge patch that may already
 *  contain xp/xpCareer increment sentinels.
 *
 *  Firestore's FieldValue.increment does not stack within a single
 *  updateDoc: two increments on the same field means the second one
 *  wins. To piggyback micro-XP onto a badge grant in the same write
 *  we recompute the badge XP amount from the badge slugs the patch
 *  touched (via badgeMeta.badgeXp) and sum.
 *
 *  Mutates and returns `basePatch` for caller convenience. Safe to
 *  call with an empty patch. */
export async function composeMicroXpIntoPatch(
  basePatch: Record<string, any>,
  microAmount: number,
  xpEnabled: boolean,
): Promise<Record<string, any>> {
  if (!xpEnabled || microAmount <= 0) return basePatch;
  let badgeXpSum = 0;
  try {
    const { badgeXp } = await import('./badgeMeta');
    for (const key of Object.keys(basePatch)) {
      if (key.startsWith('badges.')) {
        const slug = key.slice('badges.'.length);
        badgeXpSum += badgeXp(slug) || 0;
      }
    }
  } catch (err) {
    console.warn('[microXp] badgeXp import failed', err);
    return basePatch;
  }
  const total = badgeXpSum + microAmount;
  basePatch.xp = increment(total);
  basePatch.xpCareer = increment(total);
  return basePatch;
}

// -- day-key helper -------------------------------------------------
//
// Denver-anchored to match the worker + backfill + streak paths. A
// parent tapping at 22:30 MT from an ET-configured device previously
// bucketed to the ET day (already past midnight ET) and reset the
// dailyCap counter — so a same-MT-day tap from the coach's Denver
// phone treated the counter as fresh and double-awarded XP. Sharing
// the same Denver key with everyone else that touches xp state closes
// that race. See feedback_worker_timezone memory.

function todayKey(): string {
  return denverKeyOfDate(new Date());
}
