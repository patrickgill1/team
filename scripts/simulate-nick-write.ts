// @ts-nocheck
// Read Nick's userDoc + Pride U13 teamDoc fresh, then dry-simulate the rule.
import * as admin from 'firebase-admin';
import * as path from 'path';
admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();

const NICK = 'yQ0NYA9N7MfdfGq5mv5KuH2PUzU2';
const TEAM = 'tFsSqJuCqSg2s9kg12WT';

(async () => {
  const [uSnap, tSnap] = await Promise.all([
    db.doc(`users/${NICK}`).get(),
    db.doc(`teams/${TEAM}`).get(),
  ]);
  const u: any = uSnap.data();
  const t: any = tSnap.data();
  console.log('User:');
  console.log('  role:', u.role);
  console.log('  teamIds:', JSON.stringify(u.teamIds));
  console.log('  coverageSource:', u.coverageSource);
  console.log('  subscriptionActive:', u.subscriptionActive);
  console.log('  isClubAdmin:', u.isClubAdmin);
  console.log('  disabled/deleted?:', u.isActive, u.disabled);
  console.log('\nTeam:');
  console.log('  name:', t.name);
  console.log('  clubId:', t.clubId || '(none)');
  console.log('  coachIds:', JSON.stringify(t.coachIds || []));
  console.log('  memberIds:', JSON.stringify(t.memberIds || []));
  console.log('  isActive:', t.isActive);

  const onTeam = Array.isArray(u.teamIds) && u.teamIds.includes(TEAM);
  const source = 'youtube';
  const inAllowlist = ['youtube','vimeo','trace'].includes(source);
  console.log('\nSimulated rule eval for player_media CREATE:');
  console.log('  isAuthed:                                 TRUE');
  console.log('  onTeam(request.resource.data.teamId):    ', onTeam ? 'TRUE' : 'FALSE');
  console.log('  source in [youtube,vimeo,trace]:         ', inAllowlist ? 'TRUE' : 'FALSE');
  console.log('  → CREATE allowed:                        ', (onTeam && inAllowlist) ? 'YES' : 'NO');

  // Any recent successful writes in player_media from Nick?
  const recent = await db.collection('player_media').where('uploadedBy','==',NICK).limit(3).get();
  console.log(`\nExisting player_media docs uploaded by Nick: ${recent.size}`);
  recent.forEach(d => console.log(`  ${d.id}: source=${d.get('source')} teamId=${d.get('teamId')} createdAt=${d.get('createdAt')?.toDate?.() || d.get('createdAt')}`));

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
