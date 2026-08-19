// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();
(async () => {
  const snap = await db.collection('players').get();
  const hits = snap.docs.filter(d => /Ruston|Anakin/i.test(String(d.data()?.name || '')));
  for (const d of hits) {
    const p: any = d.data();
    console.log(`\n${p.name} (${d.id}):`);
    console.log(`  profilePhotoUrl:  ${p.profilePhotoUrl || '(missing)'}`);
    console.log(`  photoURL:         ${p.photoURL || '(missing)'}`);
    console.log(`  photo:            ${p.photo || '(missing)'}`);
    console.log(`  avatarUrl:        ${p.avatarUrl || '(missing)'}`);
    const allKeys = Object.keys(p).filter(k => /photo|avatar|image|pic/i.test(k));
    console.log(`  photo-ish keys:   ${JSON.stringify(allKeys)}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
