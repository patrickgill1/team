// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();
(async () => {
  const HPID = 'W4MJK3n7x6kS1nV2jE7T';
  const TEAM = 'ojptEkCBpiI24QHR2h8e';
  const p = await db.collection('players').doc(HPID).get();
  console.log(`Harrison player.stats:`, JSON.stringify(p.data()?.stats, null, 2));

  const perTeamStats = await db.collection('stats').where('playerId','==',HPID).get();
  console.log(`\nPer-team 'stats' rows for Harrison: ${perTeamStats.size}`);
  for (const d of perTeamStats.docs) {
    const s: any = d.data();
    console.log(`  ${d.id} gameId=${s.gameId} goals=${s.goals} assists=${s.assists} opponent=${s.opponent} teamId=${s.teamId} at=${s.createdAt?.toDate?.() || s.createdAt}`);
  }

  const clip = await db.collection('player_media').doc('zHDNIee3EdQJlakO9832').get();
  const c: any = clip.data();
  console.log(`\nClip full field dump:`);
  console.log(`  goalScorerId=${c.goalScorerId}  (${c.goalScorerId?.length} chars)`);
  console.log(`  statsCredited=${c.statsCredited}`);
  console.log(`  countsForStats=${c.countsForStats}`);
  console.log(`  createdAt=${c.createdAt?.toDate?.()}`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
