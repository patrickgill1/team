// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();
(async () => {
  const snap = await db.collection('player_media').limit(3).get();
  for (const d of snap.docs) {
    const m: any = d.data();
    console.log(`  ${d.id}  team=${m.teamId?.slice(0,10)}  player=${m.playerName}  isActive=${m.isActive}`);
  }
  process.exit(0);
})();
