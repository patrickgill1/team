// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();
(async () => {
  const snap = await db.collection('player_media').orderBy('createdAt', 'desc').limit(5).get();
  console.log(`Newest 5 clips:\n`);
  for (const d of snap.docs) {
    const m: any = d.data();
    const created = m.createdAt?.toDate?.() || m.createdAt;
    console.log(`  ${d.id}  ${created}`);
    console.log(`    playerName=${m.playerName}  playerId=${m.playerId}`);
    console.log(`    type=${m.type}  source=${m.source || '(native)'}  countsForStats=${m.countsForStats}`);
    console.log(`    gameId=${m.gameId || '(unlinked)'}`);
    console.log(`    goalScorerId=${m.goalScorerId || '(none)'}  assistByIds=${JSON.stringify(m.assistByIds || [])}`);
    console.log(`    statsCredited=${m.statsCredited}  statsCreditedAssistIds=${JSON.stringify(m.statsCreditedAssistIds || [])}`);
    if (m.goalScorerId) {
      const pDoc = await db.collection('players').doc(m.goalScorerId).get();
      if (pDoc.exists) {
        const p: any = pDoc.data();
        console.log(`    → scorer.stats: goals=${p.stats?.goals}  assists=${p.stats?.assists}  gamesPlayed=${p.stats?.gamesPlayed}`);
      }
    }
    if (m.gameId) {
      const g = await db.collection('live_games').doc(m.gameId).get();
      if (g.exists) {
        const gd: any = g.data();
        console.log(`    → linked game: status=${gd.status}  countsToStats=${gd.countsToStats}`);
      } else {
        console.log(`    → linked game: NO live_games doc (scheduled/never-started)`);
      }
    }
    console.log('');
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
