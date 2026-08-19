// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();
(async () => {
  const BID = 'fR94cql3ou6jyyGyLHUg';
  const p = await db.collection('players').doc(BID).get();
  console.log(`Boone player.stats:`, JSON.stringify(p.data()?.stats, null, 2));
  console.log(`Boone teamId=${p.data()?.teamId}  isActive=${p.data()?.isActive}\n`);

  const per = await db.collection('stats').where('playerId','==',BID).get();
  console.log(`Per-team 'stats' rows for Boone: ${per.size}`);
  for (const d of per.docs) {
    const s: any = d.data();
    console.log(`  ${d.id} gameId=${s.gameId} goals=${s.goals} assists=${s.assists} opponent=${s.opponent} teamId=${s.teamId} at=${s.createdAt?.toDate?.() || s.createdAt}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
