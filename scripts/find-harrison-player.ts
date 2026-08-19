// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, '/Users/patrickgill/dev/team/scripts/firebase-service-account.json')) });
const db = admin.firestore();
(async () => {
  const snap = await db.collection('players').get();
  const hits = snap.docs.filter(d => /harrison/i.test(String(d.data()?.name || '')));
  console.log(`Players matching 'Harrison': ${hits.length}`);
  for (const d of hits) {
    const p: any = d.data();
    console.log(`  id=${d.id}  name=${p.name}  teamId=${p.teamId}  isActive=${p.isActive}  stats=${JSON.stringify(p.stats)}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
