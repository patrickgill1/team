// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
const SA = path.resolve('/Users/patrickgill/dev/team/scripts/firebase-service-account.json');
admin.initializeApp({ credential: admin.credential.cert(SA) });
const db = admin.firestore();

const TEAM_ID = 'ojptEkCBpiI24QHR2h8e';
const COACH_UID = 'Leek1JUyr2dWaUAw7Uem6XY61v22';

(async () => {
  const players = await db.collection('players').where('teamIds', 'array-contains', TEAM_ID).get();
  const parentToKids = new Map<string, string[]>();
  for (const p of players.docs) {
    const d = p.data() as any;
    if (d.isActive === false) continue;
    const parentIds: string[] = Array.isArray(d.parentIds) ? d.parentIds : [];
    for (const uid of parentIds) {
      if (!uid || uid === COACH_UID) continue;
      const list = parentToKids.get(uid) || [];
      list.push(String(d.name || 'Player'));
      parentToKids.set(uid, list);
    }
  }

  const noTokens: any[] = [];
  const muted: any[] = [];
  for (const [uid, kids] of parentToKids.entries()) {
    const u = (await db.collection('users').doc(uid).get()).data() as any;
    if (!u || u.isActive === false) continue;
    const prefs = u.pushPreferences || {};
    const tokens: string[] = (Array.isArray(u.fcmTokens) ? u.fcmTokens : []).filter((t: any) => typeof t === 'string' && t.length > 10);
    if (prefs.broadcast === false) {
      muted.push({ name: u.name || '(no name)', email: u.email || '(no email)', kids });
    } else if (tokens.length === 0) {
      noTokens.push({ name: u.name || '(no name)', email: u.email || '(no email)', kids });
    }
  }

  console.log('=== 5 parents with NO push tokens (never enabled push) ===');
  for (const p of noTokens) {
    console.log(`  ${p.name.padEnd(24)} kid: ${p.kids.join(', ').padEnd(20)} ${p.email}`);
  }
  console.log(`\n=== 1 parent with broadcast MUTED (opted out of announcements) ===`);
  for (const p of muted) {
    console.log(`  ${p.name.padEnd(24)} kid: ${p.kids.join(', ').padEnd(20)} ${p.email}`);
  }
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
