// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();
(async () => {
  const teams = ['ojptEkCBpiI24QHR2h8e', 'tFsSqJuCqSg2s9kg12WT']; // Fire FC U10 PG + Pride U13
  for (const tid of teams) {
    const t = await db.collection('teams').doc(tid).get();
    if (!t.exists) { console.log(`${tid}: not found`); continue; }
    const d: any = t.data();
    console.log(`\n${d.name} (${tid})`);
    console.log(`  xpConfig.enabled:  ${d.xpConfig?.enabled}`);
    console.log(`  xpConfig.sources:  ${JSON.stringify(d.xpConfig?.sources || {}, null, 2)}`);
  }
  process.exit(0);
})();
