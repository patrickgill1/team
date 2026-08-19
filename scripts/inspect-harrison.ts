// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();

(async () => {
  const [pSnap, gSnap] = await Promise.all([
    db.collection('players').doc('W4MJK3n7x6').get(),
    db.collection('live_games').doc('JQGOVeCadktWG4LBA0oo').get(),
  ]);
  if (pSnap.exists) {
    const p: any = pSnap.data();
    console.log(`Player Harrison (W4MJK3n7x6):`);
    console.log(`  name=${p.name}  teamId=${p.teamId}  isActive=${p.isActive}`);
    console.log(`  stats:`, JSON.stringify(p.stats, null, 2));
  } else {
    console.log(`Player Harrison doc W4MJK3n7x6 NOT FOUND`);
  }
  console.log('');
  if (gSnap.exists) {
    const g: any = gSnap.data();
    console.log(`Game JQGOVeCadktWG4LBA0oo:`);
    console.log(`  status=${g.status}  countsToStats=${g.countsToStats}  ourScore=${g.ourScore} oppScore=${g.oppScore}`);
    console.log(`  teamId=${g.teamId}`);
    console.log(`  timeline entries:`, (g.timeline || []).length);
    for (const t of (g.timeline || [])) {
      console.log(`    - kind=${t.kind} playerId=${t.playerId?.slice(0,10)} source=${t.source} clipMediaId=${t.clipMediaId?.slice(0,10) || '-'}`);
    }
  } else {
    console.log(`Game JQGOVeCadktWG4LBA0oo NOT FOUND (never started as live game)`);
  }
  const statsForPlayer = await db.collection('stats').where('playerId','==','W4MJK3n7x6').get();
  console.log(`\nPer-team stats rows for Harrison: ${statsForPlayer.size}`);
  for (const d of statsForPlayer.docs) {
    const s: any = d.data();
    console.log(`  ${d.id} gameId=${s.gameId} goals=${s.goals} assists=${s.assists} opponent=${s.opponent}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
