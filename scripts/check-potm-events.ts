// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();
(async () => {
  const snap = await db.collection('player_xp_events').where('source','==','first_potm').limit(20).get();
  console.log(`first_potm xp events: ${snap.size}`);
  for (const d of snap.docs) {
    const e: any = d.data();
    console.log(`  ${d.id.slice(0,12)}...  player=${e.playerName}  team=${e.teamId?.slice(0,10)}  xp=${e.xp}  at=${e.createdAt?.toDate?.()}`);
  }
  // Any XP grant on any source in the last 7 days?
  const cutoff = new Date(Date.now() - 7*24*3600*1000);
  const recent = await db.collection('player_xp_events').where('createdAt','>=',cutoff).orderBy('createdAt','desc').limit(10).get();
  console.log(`\nRecent XP events (any source, last 7 days): ${recent.size}`);
  for (const d of recent.docs) {
    const e: any = d.data();
    console.log(`  ${e.createdAt?.toDate?.()}  ${e.source.padEnd(20)}  player=${e.playerName?.padEnd(20)}  +${e.xp} xp`);
  }
  process.exit(0);
})();
