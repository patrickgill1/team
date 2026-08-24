// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();
(async () => {
  const p = await db.collection('players').doc('HccbgeBlmtaZD1zWeQSX').get();
  const d: any = p.data();
  console.log(`Logan Larsen:`);
  console.log(`  stats.goals: ${d.stats?.goals}`);
  console.log(`  badges keys: ${Object.keys(d.badges || {}).join(', ')}`);
  console.log(`  badges full: ${JSON.stringify(d.badges, null, 2)}`);
  process.exit(0);
})();
