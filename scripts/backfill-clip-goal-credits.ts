#!/usr/bin/env tsx
/**
 * Backfill goal/assist credit for player_media clips that were linked
 * to a game but never got their season stat bump.
 *
 * WHY
 *   Before 3.9.419, uploading a clip with (goalScorerId, gameId) where
 *   the linked game's live_games doc was in status 'scheduled' would
 *   attach the goal to the game's timeline but defer the stat bump to
 *   finalize. Games that never finalize left the credit stuck.
 *
 * ELIGIBILITY
 *   A clip qualifies if ALL of:
 *     - player_media.goalScorerId is set (or assistByIds non-empty)
 *     - player_media.countsForStats !== false
 *     - player_media.statsCredited !== true
 *     - player_media.gameId is set (linked-to-game path)
 *
 *   The fix is the same diff a fresh upload would apply now, so it's
 *   safe to re-run: idempotent via the statsCredited flag.
 *
 * USAGE
 *   tsx scripts/backfill-clip-goal-credits.ts               # dry-run
 *   tsx scripts/backfill-clip-goal-credits.ts --apply       # write
 *   tsx scripts/backfill-clip-goal-credits.ts --team <id> --apply
 */

// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();

const apply = process.argv.includes('--apply');
const teamFilter = (() => {
  const i = process.argv.indexOf('--team');
  return i >= 0 ? process.argv[i + 1] : '';
})();
console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}${teamFilter ? `  team=${teamFilter}` : ''}\n`);

interface Candidate {
  mediaId: string;
  teamId: string;
  playerId: string;
  playerName: string;
  scorerId: string;
  scorerName: string;
  assistIds: string[];
  gameId: string;
  createdAt: string;
}

(async () => {
  let q: FirebaseFirestore.Query = db.collection('player_media');
  if (teamFilter) q = q.where('teamId', '==', teamFilter);
  const snap = await q.get();

  const candidates: Candidate[] = [];
  const playerNameCache = new Map<string, string>();
  const loadPlayerName = async (pid: string) => {
    if (playerNameCache.has(pid)) return playerNameCache.get(pid)!;
    const doc = await db.collection('players').doc(pid).get();
    const name = doc.exists ? String(doc.data()?.name || '') : '';
    playerNameCache.set(pid, name);
    return name;
  };

  for (const d of snap.docs) {
    const m: any = d.data();
    if (m.statsCredited === true) continue;
    if (m.countsForStats === false) continue;
    if (!m.gameId) continue;
    const scorerId = String(m.goalScorerId || '');
    const assistIds: string[] = Array.isArray(m.assistByIds) ? m.assistByIds.filter((x: any) => typeof x === 'string' && x) : [];
    if (!scorerId && assistIds.length === 0) continue;
    if (m.isActive === false) continue;

    const scorerName = scorerId ? await loadPlayerName(scorerId) : '';
    candidates.push({
      mediaId: d.id,
      teamId: String(m.teamId || ''),
      playerId: String(m.playerId || ''),
      playerName: String(m.playerName || ''),
      scorerId,
      scorerName,
      assistIds,
      gameId: String(m.gameId),
      createdAt: (m.createdAt?.toDate?.() || m.createdAt || '').toString(),
    });
  }

  console.log(`Scanned ${snap.size} clips. Candidates: ${candidates.length}\n`);
  for (const c of candidates) {
    const bits = [];
    if (c.scorerId) bits.push(`goal → ${c.scorerName || c.scorerId.slice(0, 8)}`);
    if (c.assistIds.length) bits.push(`assists → ${c.assistIds.length}`);
    console.log(`  ${c.mediaId}  team=${c.teamId.slice(0, 8)}…  game=${c.gameId.slice(0, 8)}…  clip="${c.playerName}"  ${bits.join(', ')}  (${c.createdAt.slice(0, 24)})`);
  }

  if (!apply) {
    console.log(`\nDRY-RUN. Re-run with --apply to bump.`);
    process.exit(0);
  }
  if (candidates.length === 0) { console.log(`\nNothing to do.`); process.exit(0); }

  console.log(`\n=== Applying ===`);
  let ok = 0, fail = 0;
  for (const c of candidates) {
    try {
      // 1) Bump players.stats.goals / assists (season aggregate)
      if (c.scorerId) {
        const pRef = db.collection('players').doc(c.scorerId);
        await db.runTransaction(async t => {
          const p = await t.get(pRef);
          const cur = (p.exists ? (p.data() as any).stats : null) || { goals: 0, assists: 0 };
          t.update(pRef, { 'stats.goals': (cur.goals || 0) + 1 } as any);
        });
      }
      for (const aid of c.assistIds) {
        const pRef = db.collection('players').doc(aid);
        await db.runTransaction(async t => {
          const p = await t.get(pRef);
          const cur = (p.exists ? (p.data() as any).stats : null) || { goals: 0, assists: 0 };
          t.update(pRef, { 'stats.assists': (cur.assists || 0) + 1 } as any);
        });
      }
      // 2) Write per-team 'stats' record so per-team aggregator picks it up
      if (c.teamId && (c.scorerId || c.assistIds.length)) {
        const playerName = c.scorerId ? c.scorerName : '';
        await db.collection('stats').add({
          playerId: c.scorerId || c.playerId,
          playerName,
          gameId: `clip_backfill_${Date.now()}_${c.mediaId.slice(0, 6)}`,
          gameDate: new Date(),
          opponent: 'Clip credit (backfill)',
          minutesPlayed: 0,
          goals: c.scorerId ? 1 : 0,
          assists: c.assistIds.length,
          yellowCards: 0,
          redCards: 0,
          saves: 0,
          teamId: c.teamId,
          createdAt: new Date(),
        });
      }
      // 3) Mark the clip as credited so it's never bumped twice
      await db.collection('player_media').doc(c.mediaId).update({
        statsCredited: !!c.scorerId,
        statsCreditedAssistIds: c.assistIds,
      });
      ok++;
      console.log(`  ok  ${c.mediaId}`);
    } catch (err: any) {
      fail++;
      console.error(`  fail  ${c.mediaId} → ${err?.message}`);
    }
  }
  console.log(`\nDone: ${ok} ok / ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
