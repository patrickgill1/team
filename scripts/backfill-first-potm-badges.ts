#!/usr/bin/env tsx
/**
 * Scan match_votings for closed POTMs (winners field non-empty).
 * For each winner who doesn't yet have the first_potm badge AND
 * whose team has XP enabled, stamp badges.first_potm + bump
 * player.xp + player.xpCareer + create a player_xp_events audit
 * row. Grants only the EARLIEST POTM per player (once-ever).
 *
 * Why this backfill exists: the client-side maybeGrantFirstPotm
 * flow (added 2026-07-24) has been silently no-op'ing for every
 * closed POTM since — audit found ZERO first_potm events in the
 * db despite 20 recent closed votings across XP-enabled teams.
 * Root cause is still under investigation; the backfill unblocks
 * families NOW while I keep tracing.
 *
 * USAGE
 *   tsx scripts/backfill-first-potm-badges.ts               # dry-run
 *   tsx scripts/backfill-first-potm-badges.ts --apply       # write
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

interface Grant {
  playerId: string;
  playerName: string;
  teamId: string;
  teamName: string;
  gameTitle: string;
  earnedAt: Date;
  votingId: string;
  xpEnabled: boolean;
}

(async () => {
  const votings = await db.collection('match_votings').where('isActive', '==', false).get();
  console.log(`Closed match_votings: ${votings.size}`);

  // Cache team xpConfig lookups.
  const teamCache = new Map<string, any>();
  const loadTeam = async (id: string) => {
    if (teamCache.has(id)) return teamCache.get(id);
    const doc = await db.collection('teams').doc(id).get();
    const data = doc.exists ? doc.data() : null;
    teamCache.set(id, data);
    return data;
  };

  // Gather every (player, closedAt, voting) triple for winners.
  const rows: Grant[] = [];
  for (const d of votings.docs) {
    const v: any = d.data();
    const winners: any[] = Array.isArray(v.winners) ? v.winners
      : (v.winner ? [v.winner] : []);
    if (winners.length === 0) continue;
    const closedAt = v.closedAt?.toDate?.() || (v.closedAt instanceof Date ? v.closedAt : null);
    const gameTitle = String(v.gameTitle || 'Match');
    for (const w of winners) {
      if (!w?.playerId) continue;
      const pDoc = await db.collection('players').doc(w.playerId).get();
      if (!pDoc.exists) continue;
      const p: any = pDoc.data();
      const team = await loadTeam(p.teamId);
      const xpEnabled = !!team?.xpConfig?.enabled;
      rows.push({
        playerId: w.playerId,
        playerName: String(w.playerName || p.name || 'Player'),
        teamId: p.teamId,
        teamName: String(team?.name || ''),
        gameTitle,
        earnedAt: closedAt || new Date(),
        votingId: d.id,
        xpEnabled,
      });
    }
  }
  console.log(`Total winner rows: ${rows.length}`);

  // Sort by earnedAt asc so we keep the EARLIEST POTM per player.
  rows.sort((a, b) => a.earnedAt.getTime() - b.earnedAt.getTime());

  // Load current badges once per unique player.
  const uniquePids = Array.from(new Set(rows.map(r => r.playerId)));
  const badgeState = new Map<string, any>();
  for (const pid of uniquePids) {
    const p = await db.collection('players').doc(pid).get();
    badgeState.set(pid, p.exists ? (p.data() as any)?.badges || {} : {});
  }

  const grantable: Grant[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (badgeState.get(r.playerId)?.first_potm) continue; // already earned via prior path
    if (seen.has(r.playerId)) continue; // dedup — earliest wins
    seen.add(r.playerId);
    grantable.push(r);
  }

  console.log(`\nPlayers already with first_potm badge:  ${uniquePids.length - grantable.length - (uniquePids.length - seen.size)}`);
  console.log(`Unique players to badge:                ${grantable.length}\n`);

  for (const g of grantable) {
    console.log(`  ${g.playerName.padEnd(24)}  team=${g.teamName.padEnd(22)}  xp=${g.xpEnabled ? 'ON ' : 'off'}  earnedAt=${g.earnedAt.toISOString().slice(0, 10)}  vs ${g.gameTitle}`);
  }

  if (!apply) {
    console.log(`\nDRY-RUN. Re-run with --apply to grant.`);
    process.exit(0);
  }
  if (grantable.length === 0) { console.log('\nNothing to do.'); process.exit(0); }

  console.log(`\n=== Applying ===`);
  let ok = 0, fail = 0;
  for (const g of grantable) {
    try {
      // Stamp the badge on the player doc.
      await db.collection('players').doc(g.playerId).update({
        'badges.first_potm': {
          earnedAt: g.earnedAt,
          xp: g.xpEnabled ? 150 : 0,
        },
      });
      // Bump XP + write audit row only if the team has XP enabled.
      if (g.xpEnabled) {
        await db.collection('players').doc(g.playerId).update({
          xp: admin.firestore.FieldValue.increment(150),
          xpCareer: admin.firestore.FieldValue.increment(150),
        });
        // Deterministic id so re-runs are idempotent.
        const eventId = `first-first_potm-${g.playerId}`;
        await db.collection('player_xp_events').doc(eventId).set({
          playerId: g.playerId,
          playerName: g.playerName,
          teamId: g.teamId,
          xp: 150,
          source: 'first_potm',
          sourceRef: eventId,
          awardedBy: 'backfill-script',
          awardedByRole: 'coach',
          awardedByName: 'Backfill',
          awardedByAvatarUrl: null,
          note: g.gameTitle,
          createdAt: g.earnedAt,
          occurredAt: g.earnedAt,
        });
      }
      ok++;
      console.log(`  ok  ${g.playerName}`);
    } catch (err: any) {
      fail++;
      console.error(`  fail  ${g.playerName} -> ${err?.message}`);
    }
  }
  console.log(`\nDone: ${ok} granted / ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
