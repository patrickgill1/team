// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();
(async () => {
  // Recent closed POTMs
  const snap = await db.collection('match_votings').where('isActive','==',false).limit(20).get();
  console.log(`Closed POTMs found: ${snap.size}\n`);
  for (const d of snap.docs) {
    const v: any = d.data();
    const winners = v.winners || (v.winner ? [v.winner] : []);
    if (winners.length === 0) continue;
    for (const w of winners) {
      const p = await db.collection('players').doc(w.playerId).get();
      if (!p.exists) continue;
      const pd: any = p.data();
      const hasBadge = pd.badges?.first_potm?.earnedAt;
      const teamDoc = await db.collection('teams').doc(pd.teamId).get();
      const xpEnabled = teamDoc.exists && (teamDoc.data() as any)?.xpConfig?.enabled === true;
      console.log(`  ${(w.playerName || pd.name).padEnd(24)}  team=${(teamDoc.data() as any)?.name?.padEnd(24)}  xp=${xpEnabled ? 'ON' : 'off'}  first_potm=${hasBadge ? '✓' : 'MISSING'}  game="${v.gameTitle || '?'}"`);
    }
  }
  process.exit(0);
})();
