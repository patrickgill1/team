#!/usr/bin/env tsx
/**
 * Scan the stats/ collection for any player who racked up 3+ goals
 * in a single REAL game (skips clip_ and adjust_ synthetic gameIds)
 * and doesn't yet have the hat_trick badge. Grant it.
 *
 * The main-app code was shipped with hat_trick support wired in on
 * 2026-08-24. Everything from that point forward auto-grants at
 * GameDay finalize / clip credit / manual stat entry. This backfill
 * covers historical games where a player earned it before the badge
 * even existed.
 *
 * USAGE
 *   tsx scripts/backfill-hat-trick-badges.ts               # dry-run
 *   tsx scripts/backfill-hat-trick-badges.ts --apply       # write
 */

// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';

admin.initializeApp({
  credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')),
});
const db = admin.firestore();

const apply = process.argv.includes('--apply');
console.log(`Mode: ${apply ? 'APPLY (will write)' : 'DRY-RUN (read-only)'}\n`);

interface HatTrickHit {
  playerId: string;
  playerName: string;
  teamId: string;
  gameId: string;
  goals: number;
  opponent?: string;
  earnedAtCandidate?: Date;
}

(async () => {
  // Source #1: stats collection, real gameIds only (skip clip_/adjust_).
  // Catches manual entries + GameDay finalize rows.
  const statsSnap = await db.collection('stats').get();
  console.log(`Scanned ${statsSnap.size} stats rows`);

  // Two goal-count sources per (player, game): the stats collection
  // (finalize + manual entry) and the player_media collection (linked
  // clip credits). A game where finalize ran AFTER clips were linked
  // will show goals in BOTH sources for the same real game — summing
  // would double-count. Take the MAX per (player, game) instead.
  type Bucket = { statsGoals: number; mediaGoals: number; teamId: string; playerName: string; opponent?: string; lastAt?: Date };
  const bucket = new Map<string, Bucket>();
  const bump = (pid: string, gid: string, goals: number, teamId: string, playerName: string, opponent?: string, at?: Date | null, source: 'stats' | 'media' = 'stats') => {
    const key = `${pid}::${gid}`;
    const cur = bucket.get(key) || {
      statsGoals: 0, mediaGoals: 0, teamId, playerName, opponent, lastAt: undefined,
    };
    if (source === 'stats') cur.statsGoals += goals;
    else cur.mediaGoals += goals;
    if (teamId) cur.teamId = teamId;
    if (playerName && !cur.playerName) cur.playerName = playerName;
    if (opponent && !cur.opponent) cur.opponent = opponent;
    if (at && (!cur.lastAt || at.getTime() > cur.lastAt.getTime())) cur.lastAt = at;
    bucket.set(key, cur);
  };
  for (const d of statsSnap.docs) {
    const r: any = d.data();
    const pid = String(r.playerId || '');
    const gid = String(r.gameId || '');
    if (!pid || !gid) continue;
    if (gid.startsWith('clip_') || gid.startsWith('adjust_')) continue;
    if ((r.goals || 0) <= 0) continue;
    const at = r.createdAt?.toDate?.() || (r.createdAt instanceof Date ? r.createdAt : null);
    bump(pid, gid, r.goals, String(r.teamId || ''), String(r.playerName || ''), r.opponent, at, 'stats');
  }

  // Source #2: player_media docs that stamped goalScorerId + a real
  // gameId. Coach's clip credits go here — the stats collection rows
  // for these clips have synthetic clip_${ts} ids so they don't group
  // by real game. Group them here directly by (goalScorerId, gameId).
  // Only counts credits that ACTUALLY bumped stats (statsCredited=true
  // or countsForStats !== false) to avoid counting "display-only" clips.
  const mediaSnap = await db.collection('player_media').get();
  let mediaGoalRows = 0;
  for (const d of mediaSnap.docs) {
    const m: any = d.data();
    if (!m.goalScorerId) continue;
    if (!m.gameId) continue;
    const gid = String(m.gameId);
    if (gid.startsWith('clip_') || gid.startsWith('adjust_')) continue;
    // Skip clips explicitly opted out of stats.
    if (m.countsForStats === false) continue;
    if (m.isActive === false) continue;
    mediaGoalRows++;
    const at = m.createdAt?.toDate?.() || (m.createdAt instanceof Date ? m.createdAt : null);
    bump(
      String(m.goalScorerId),
      gid,
      1,
      String(m.teamId || ''),
      String(m.playerName || ''),
      undefined,
      at,
      'media',
    );
  }
  console.log(`Scanned ${mediaSnap.size} player_media docs, ${mediaGoalRows} carry a linked real-game goal`);

  // Filter for hat tricks (3+ goals in one game). Take MAX across
  // sources to avoid double-count when both stats + media have data.
  const hits: HatTrickHit[] = [];
  for (const [key, b] of bucket.entries()) {
    const totalGoals = Math.max(b.statsGoals, b.mediaGoals);
    if (totalGoals < 3) continue;
    const [playerId, gameId] = key.split('::');
    hits.push({
      playerId,
      playerName: b.playerName,
      teamId: b.teamId,
      gameId,
      goals: totalGoals,
      opponent: b.opponent,
      earnedAtCandidate: b.lastAt,
    });
  }
  console.log(`Found ${hits.length} hat-trick game(s) across all teams.\n`);

  // Load player docs in chunks + filter to those without the badge yet.
  const uniquePlayerIds = Array.from(new Set(hits.map(h => h.playerId)));
  const badgeState = new Map<string, any>();
  const chunk = <T>(a: T[], n: number) => {
    const out: T[][] = [];
    for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
    return out;
  };
  for (const ch of chunk(uniquePlayerIds, 10)) {
    const snaps = await Promise.all(ch.map(id => db.collection('players').doc(id).get()));
    for (const s of snaps) {
      if (s.exists) badgeState.set(s.id, (s.data() as any)?.badges || {});
    }
  }

  const grantable = hits.filter(h => !badgeState.get(h.playerId)?.hat_trick);
  const alreadyEarned = hits.length - grantable.length;
  console.log(`Already have hat_trick badge:  ${alreadyEarned}`);
  console.log(`Would grant:                   ${grantable.length}`);

  // Dedup: award only the FIRST hat trick per player (once-ever badge).
  const seenPlayers = new Set<string>();
  const toGrant: HatTrickHit[] = [];
  grantable
    .sort((a, b) => (a.earnedAtCandidate?.getTime() || 0) - (b.earnedAtCandidate?.getTime() || 0))
    .forEach(h => {
      if (seenPlayers.has(h.playerId)) return;
      seenPlayers.add(h.playerId);
      toGrant.push(h);
    });
  console.log(`Unique players to badge:       ${toGrant.length}\n`);

  for (const h of toGrant) {
    console.log(`  ${h.playerName.padEnd(24)}  ${h.goals}G vs ${h.opponent || '?'}  game=${h.gameId.slice(0, 10)}  earnedAt=${h.earnedAtCandidate?.toISOString?.().slice(0, 10) || '(unknown)'}`);
  }

  if (!apply) {
    console.log(`\nDRY-RUN. Re-run with --apply to grant.`);
    process.exit(0);
  }
  if (toGrant.length === 0) { console.log('\nNothing to do.'); process.exit(0); }

  console.log(`\n=== Applying ===`);
  let ok = 0, fail = 0;
  for (const h of toGrant) {
    try {
      const earnedAt = h.earnedAtCandidate || new Date();
      const patch: any = {
        'badges.hat_trick': {
          earnedAt,
          context: h.opponent ? `vs ${h.opponent}` : 'Hat trick',
        },
      };
      await db.collection('players').doc(h.playerId).update(patch);
      // XP mirror: bump player.xp / xpCareer by 150 to match the badge
      // grant path (BADGE_META.hat_trick.xp = 150). Skipped when the
      // team doesn't have XP enabled — we don't fabricate XP for teams
      // that opted out.
      if (h.teamId) {
        const teamSnap = await db.collection('teams').doc(h.teamId).get();
        const xpEnabled = teamSnap.exists && ((teamSnap.data() as any)?.xpConfig?.enabled === true);
        if (xpEnabled) {
          await db.collection('players').doc(h.playerId).update({
            xp: admin.firestore.FieldValue.increment(150),
            xpCareer: admin.firestore.FieldValue.increment(150),
          });
        }
      }
      ok++;
      console.log(`  ok  ${h.playerName}`);
    } catch (err: any) {
      fail++;
      console.error(`  fail  ${h.playerName} → ${err?.message}`);
    }
  }
  console.log(`\nDone: ${ok} granted / ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
