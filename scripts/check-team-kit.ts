// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();
const teamId = process.argv[2];
if (!teamId) { console.error('usage: tsx scripts/check-team-kit.ts <teamId>'); process.exit(1); }
(async () => {
  const t = await db.collection('teams').doc(teamId).get();
  if (!t.exists) { console.log('team not found'); process.exit(0); }
  const d: any = t.data();
  console.log(`Team: ${d.name} (${teamId})`);
  console.log(`  homeKitColor: ${JSON.stringify(d.homeKitColor)}`);
  console.log(`  awayKitColor: ${JSON.stringify(d.awayKitColor)}`);
  process.exit(0);
})();
