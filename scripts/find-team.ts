// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();
const q = (process.argv[2] || '').toLowerCase();
if (!q) { console.error('usage: tsx scripts/find-team.ts <name-fragment>'); process.exit(1); }
(async () => {
  const snap = await db.collection('teams').get();
  const hits = snap.docs.filter(d => String(d.data()?.name || '').toLowerCase().includes(q));
  console.log(`${hits.length} match(es) for "${q}":`);
  for (const d of hits) {
    console.log(`  id=${d.id}  name=${d.data()?.name}  club=${d.data()?.clubId}  isActive=${d.data()?.isActive}`);
  }
  process.exit(0);
})();
