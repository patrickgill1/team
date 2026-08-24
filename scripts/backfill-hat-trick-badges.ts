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
  const snap = await db.collection('stats').get();
  console.log(`Scanned ${snap.size} stats rows`);

  // Aggregate goals by (playerId, gameId), skipping synthetic ids.
  type Bucket = { goals: number; teamId: string; playerName: string; opponent?: string; lastAt?: Date };
  const bucket = new Map<string, Bucket>();
  for (const d of snap.docs) {
    const r: any = d.data();
    const pid = String(r.playerId || '');
    const gid = String(r.gameId || '');
    if (!pid || !gid) continue;
    if (gid.startsWith('clip_') || gid.startsWith('adjust_')) continue;
    if ((r.goals || 0) <= 0) continue;
    const key = `${pid}::${gid}`;
    const cur = bucket.get(key) || {
      goals: 0,
      teamId: String(r.teamId || ''),
      playerName: String(r.playerName || ''),
      opponent: r.opponent,
      lastAt: undefined,
    };
    cur.goals += r.goals || 0;
    if (r.teamId) cur.teamId = String(r.teamId);
    if (r.playerName && !cur.playerName) cur.playerName = String(r.playerName);
    if (r.opponent && !cur.opponent) cur.opponent = String(r.opponent);
    const at = r.createdAt?.toDate?.() || (r.createdAt instanceof Date ? r.createdAt : null);
    if (at && (!cur.lastAt || at.getTime() > cur.lastAt.getTime())) cur.lastAt = at;
    bucket.set(key, cur);
  }

  // Filter for hat tricks (3+ goals in one game).
  const hits: HatTrickHit[] = [];
  for (const [key, b] of bucket.entries()) {
    if (b.goals < 3) continue;
    const [playerId, gameId] = key.split('::');
    hits.push({
      playerId,
      playerName: b.playerName,
      teamId: b.teamId,
      gameId,
      goals: b.goals,
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
