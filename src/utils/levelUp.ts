// @ts-nocheck
// Level-up parent whispers — the "grandma-text" moment.
//
// When a kid's XP crosses a level threshold, we drop a parent_whispers
// doc so parents see the milestone the next time PlayerProfile mounts.
// Cheap, powerful retention lever: grandma sees the notice, texts the
// kid, kid feels seen, kid keeps showing up.
//
// Contract
// --------
//   * Fail-closed on team.xpConfig.enabled. If the coach hasn't opted
//     in, no whispers are written.
//   * Fire-and-forget from the caller (void checkLevelUpAndWhisper).
//     All errors are logged and swallowed.
//   * Idempotent via a deterministic doc id (level_up-{playerId}-
//     {level}). A retry recomputing the same crossing is a no-op.
//   * Multi-level jumps write one whisper per level crossed.
//
// Why we don't read-back the player doc after Firestore's increment
// -----------------------------------------------------------------
// badgeGrants.ts + microXp.ts use FieldValue.increment sentinels so
// the post-write player.xp isn't visible client-side without a
// getDoc. Per-grant round-trip is expensive. Caller reads player.xp
// ONCE at grant time (priorXp) and passes newXp = priorXp + amount.
// Doc-id dedupe protects against wrong-level writes under concurrent
// grants; the NEXT grant whose read observes the updated value
// produces the missing whisper.
//
// Peer visibility (Track E from the design workflow) is deferred to a
// worker-side write path. wall_posts.create rule requires senderId
// == auth.uid, so a proper system message needs the service account.
// Batch parents-only ships now; wall broadcast lands when we build
// a worker /xp/levelup-fanout endpoint.

import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { computeXpLevel } from './xpLevel';

export interface LevelUpCtx {
  /** Optional pre-fetched player metadata. Skips the players/{id}
   *  read when the caller already has it in hand. */
  playerData?: {
    name?: string;
    parentIds?: string[];
    clubId?: string | null;
  } | null;
  /** Optional pre-computed team.xpConfig.enabled flag. Skips the
   *  teams/{id} read. */
  xpEnabled?: boolean;
}

export async function checkLevelUpAndWhisper(
  playerId: string,
  priorXp: number,
  newXp: number,
  teamId: string,
  ctx: LevelUpCtx = {},
): Promise<void> {
  try {
    if (!playerId || !teamId) return;
    const safePrior = Math.max(0, Math.floor(Number(priorXp) || 0));
    const safeNew = Math.max(0, Math.floor(Number(newXp) || 0));
    if (safeNew <= safePrior) return;

    const priorLevel = computeXpLevel(safePrior).level;
    const newLevel = computeXpLevel(safeNew).level;
    if (newLevel <= priorLevel) return;

    let xpEnabled = ctx.xpEnabled;
    if (xpEnabled == null) {
      try {
        const teamSnap = await getDoc(doc(db, 'teams', teamId));
        xpEnabled = teamSnap.exists() && (teamSnap.data() as any)?.xpConfig?.enabled === true;
      } catch (err) {
        console.warn('[levelUp] team xpConfig read failed', teamId, err);
        return;
      }
    }
    if (xpEnabled !== true) return;

    let playerName = ctx.playerData?.name || '';
    let clubId: string | null = ctx.playerData?.clubId ?? null;
    let parentIds: string[] = Array.isArray(ctx.playerData?.parentIds)
      ? [...(ctx.playerData!.parentIds as string[])]
      : [];
    if (!ctx.playerData) {
      try {
        const snap = await getDoc(doc(db, 'players', playerId));
        if (snap.exists()) {
          const data = snap.data() as any;
          playerName = data?.name || playerName;
          if (Array.isArray(data?.parentIds)) parentIds = [...data.parentIds];
          if (typeof data?.clubId === 'string') clubId = data.clubId;
        }
      } catch (err) {
        console.warn('[levelUp] player read failed', playerId, err);
        return;
      }
    }

    for (let level = priorLevel + 1; level <= newLevel; level++) {
      const whisperId = `level_up-${playerId}-${level}`;
      const ref = doc(db, 'parent_whispers', whisperId);
      try {
        const existing = await getDoc(ref);
        if (existing.exists()) continue;
        await setDoc(ref, {
          playerId,
          playerName: playerName || '',
          teamId,
          clubId,
          kind: 'level_up',
          level,
          previousLevel: level - 1,
          xp: safeNew,
          parentIds,
          // Populate message + coachName so if any downstream reader
          // forgets the kind filter, the row still reads sensibly
          // instead of showing as an empty "Coach" whisper.
          message: `${playerName || 'Player'} leveled up to Lvl ${level}!`,
          coachName: 'GoalKickr',
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        console.warn('[levelUp] whisper write failed', playerId, level, err);
      }
    }
  } catch (err) {
    console.warn('[levelUp] checkLevelUpAndWhisper failed', playerId, err);
  }
}
