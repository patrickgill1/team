// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();

(async () => {
  const snap = await db.collection('player_media').where('playerName', '>=', 'Harrison').where('playerName', '<=', 'Harrison~').get();
  console.log(`Found ${snap.size} clips for Harrison-name-prefix:\n`);
  const rows = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))
    .sort((a: any, b: any) => {
      const at = a.createdAt?.toDate?.()?.getTime() || 0;
      const bt = b.createdAt?.toDate?.()?.getTime() || 0;
      return bt - at;
    });
  for (const m of rows.slice(0, 8)) {
    console.log(`  ${m.id}`);
    console.log(`    playerName=${m.playerName}  playerId=${m.playerId?.slice(0,10)}`);
    console.log(`    type=${m.type}  source=${m.source || '(native)'}  createdAt=${m.createdAt?.toDate?.() || m.createdAt}`);
    console.log(`    gameId=${m.gameId || '(unlinked)'}  countsForStats=${m.countsForStats}`);
    console.log(`    goalScorerId=${m.goalScorerId?.slice(0,10) || '(none)'}  assistByIds=${JSON.stringify(m.assistByIds || [])}`);
    console.log(`    statsCredited=${m.statsCredited}  statsCreditedAssistIds=${JSON.stringify(m.statsCreditedAssistIds || [])}`);
    console.log(`    isActive=${m.isActive}  isOwnGoal=${m.isOwnGoal}\n`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
