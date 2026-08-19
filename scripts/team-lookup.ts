// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();
(async () => {
  const t1 = await db.collection('teams').doc('ojptEkCBpiI24QHR2h8e').get();
  console.log(`Team ojptEkCBpiI24QHR2h8e:`, t1.data()?.name, 'clubId:', t1.data()?.clubId);

  // Which teams contain "U10 PG"?
  const all = await db.collection('teams').get();
  const hits = all.docs.filter(d => /U10 PG/i.test(String(d.data()?.name || '')));
  console.log(`\nTeams matching "U10 PG":`);
  for (const d of hits) console.log(`  ${d.id}  ${d.data()?.name}  club=${d.data()?.clubId}`);

  // Fire FC U10 PG's stats rows
  const teamId = hits[0]?.id;
  if (teamId) {
    console.log(`\nMost recent stats rows for teamId=${teamId}:`);
    const stats = await db.collection('stats').where('teamId','==',teamId).limit(20).get();
    for (const d of stats.docs) {
      const s: any = d.data();
      console.log(`  ${d.id} player=${s.playerName} goals=${s.goals} assists=${s.assists} gameId=${s.gameId?.slice(0,20)} opponent=${s.opponent} seasonId=${s.seasonId || '(NONE)'}`);
    }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
