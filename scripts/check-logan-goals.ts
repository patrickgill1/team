// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();
(async () => {
  const players = await db.collection('players').get();
  const logans = players.docs.filter(d => /logan.*larsen/i.test(String(d.data()?.name || '')));
  console.log(`Logans found: ${logans.length}`);
  for (const p of logans) {
    console.log(`\n${p.data()?.name}  id=${p.id}  team=${p.data()?.teamId}`);
    console.log(`  stats:`, JSON.stringify(p.data()?.stats));
    console.log(`  badges:`, JSON.stringify(p.data()?.badges || {}));
    const stats = await db.collection('stats').where('playerId','==',p.id).get();
    console.log(`  stats rows: ${stats.size}`);
    // Group by gameId
    const byGame = new Map();
    for (const s of stats.docs) {
      const r = s.data();
      const gid = r.gameId || '(none)';
      const cur = byGame.get(gid) || { goals: 0, rows: 0, opponent: r.opponent, isClip: gid.startsWith('clip_'), isAdjust: gid.startsWith('adjust_') };
      cur.goals += r.goals || 0;
      cur.rows += 1;
      byGame.set(gid, cur);
    }
    for (const [gid, info] of byGame.entries()) {
      const flag = info.isClip ? 'CLIP' : info.isAdjust ? 'ADJUST' : 'REAL';
      console.log(`    ${gid.slice(0,20).padEnd(22)}  ${flag.padEnd(8)}  goals=${info.goals}  rows=${info.rows}  opp=${info.opponent}`);
    }
  }
  process.exit(0);
})();
