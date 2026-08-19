// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();

const query = process.argv[2] || '';
if (!query) { console.error('usage: tsx scripts/inspect-user.ts <name-fragment-or-email>'); process.exit(1); }

(async () => {
  const q = query.toLowerCase();
  const snap = await db.collection('users').get();
  const matches = snap.docs.filter(d => {
    const u = d.data();
    return String(u.name || '').toLowerCase().includes(q)
      || String(u.email || '').toLowerCase().includes(q);
  });
  console.log(`${matches.length} match(es) for "${query}"\n`);
  for (const doc of matches) {
    const u: any = doc.data();
    console.log(`  uid=${doc.id}`);
    console.log(`    name=${u.name}  email=${u.email}`);
    console.log(`    role=${u.role}  coverageSource=${u.coverageSource ?? '(unset)'}  coverageClubId=${u.coverageClubId ?? '(unset)'}`);
    console.log(`    teamIds=${JSON.stringify(u.teamIds || [])}`);
    console.log(`    subscription=${JSON.stringify(u.subscription || null)}`);
    console.log(`    trialEndsAt=${u.trialEndsAt || '(none)'}`);
    for (const teamId of (u.teamIds || [])) {
      const t = await db.collection('teams').doc(teamId).get();
      if (!t.exists) { console.log(`      team ${teamId} → MISSING`); continue; }
      const td: any = t.data();
      const inCoachIds = Array.isArray(td.coachIds) && td.coachIds.includes(doc.id);
      const clubId = td.clubId || '';
      let clubName = '(no club)', isSolo = false;
      if (clubId) {
        const c = await db.collection('clubs').doc(clubId).get();
        if (c.exists) { clubName = c.data()?.name || clubId; isSolo = c.data()?.isDefaultSoloClub === true; }
      }
      console.log(`      team ${td.name} (${teamId}) → clubId=${clubId} ${clubName}${isSolo ? ' [SOLO]' : ''}  inCoachIds=${inCoachIds}`);
    }
    console.log('');
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
