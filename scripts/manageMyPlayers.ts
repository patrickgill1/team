// List + manage Patrick's linked players. Solves three problems:
//   1. Showing both Hunters (with enough detail to tell them apart)
//   2. Soft-deleting the wrong one (isActive=false per the
//      soft-delete pattern — never destructive)
//   3. Manually firing a streak milestone wall post for a SPECIFIC
//      player by id (the auto-pick logic in postStreakMilestone.ts
//      may have picked the wrong one)
//
// Usage:
//   npx tsx scripts/manageMyPlayers.ts                       (list)
//   npx tsx scripts/manageMyPlayers.ts delete <playerId>     (soft-delete)
//   npx tsx scripts/manageMyPlayers.ts post-streak <playerId> [milestone=5]
//
// Requires scripts/demo-service-account.json (Firebase Admin key).

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const candidates = ['demo-service-account.json', 'firebase-service-account.json'];
let serviceAccountPath: string | null = null;
for (const c of candidates) {
  const p = path.resolve(__dirname, c);
  if (fs.existsSync(p)) { serviceAccountPath = p; break; }
}
if (!serviceAccountPath) {
  console.error('Missing scripts/demo-service-account.json (Firebase Admin key).');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))),
});
const db = admin.firestore();
const auth = admin.auth();

// Either a Firebase Auth UID (preferred — works regardless of how
// the account was created) or an email Firebase Auth can resolve.
// Apple sign-in stores a private relay address that won't match
// your "regular" email, which is what blew up before. Find your
// UID in Firebase Console → Authentication → Users.
async function resolveUid(): Promise<string> {
  const uidFlag = process.argv.find(a => a.startsWith('--uid='));
  if (uidFlag) return uidFlag.slice('--uid='.length);
  if (process.env.PATRICK_UID) return process.env.PATRICK_UID;

  const emailFlag = process.argv.find(a => a.startsWith('--email='));
  const email = emailFlag ? emailFlag.slice('--email='.length) : process.env.PATRICK_EMAIL;
  if (email) {
    try {
      const u = await auth.getUserByEmail(email);
      return u.uid;
    } catch (err: any) {
      console.error(`Could not find a Firebase Auth user with email ${email}.`);
      console.error('If you signed in with Apple, your Auth email is a private relay');
      console.error('address (xxxxx@privaterelay.appleid.com), not your real email.');
      console.error('');
      console.error('Easier path — go to Firebase Console → Authentication → Users,');
      console.error('find your row, copy the User UID, then re-run with --uid=<uid>.');
      process.exit(1);
    }
  }

  console.error('No account identifier provided.');
  console.error('Preferred: --uid=<your-firebase-auth-uid>');
  console.error('  Find it: Firebase Console → Authentication → Users → your row');
  console.error('OR:       --email=<the-email-firebase-auth-has-on-file>');
  process.exit(1);
}

const headingFor = (n: number) =>
  n >= 100 ? '## Century streak' :
  n >= 50  ? '## Half-century streak' :
  n >= 25  ? '## On a roll' :
             '## On fire';

async function loadLinkedPlayers(uid: string) {
  // The app links a parent to a player via TWO possible fields:
  //   parentIds: [uid, ...]  (new — array, multi-parent support)
  //   parentId: uid           (legacy — singular, older docs)
  // Older Hunter records may still use the singular field, which
  // is why the duplicate Hunter showing up in the More-sheet
  // selector wasn't appearing in my first query. Union both.
  const [byArray, byLegacy] = await Promise.all([
    db.collection('players').where('parentIds', 'array-contains', uid).get(),
    db.collection('players').where('parentId', '==', uid).get(),
  ]);
  const docsById = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  for (const d of byArray.docs) docsById.set(d.id, d);
  for (const d of byLegacy.docs) docsById.set(d.id, d);
  const rows = await Promise.all(Array.from(docsById.values()).map(async d => {
    const data = d.data() as any;
    let teamName = '(unknown team)';
    if (data.teamId) {
      try {
        const t = await db.collection('teams').doc(data.teamId).get();
        if (t.exists) teamName = (t.data() as any).name || data.teamId;
      } catch { /* ignore */ }
    }
    // Count active plans
    let planCount = 0;
    try {
      const plans = await db.collection('development_plans')
        .where('playerId', '==', d.id)
        .where('status', '==', 'active')
        .get();
      planCount = plans.size;
    } catch { /* ignore */ }
    return {
      id: d.id,
      name: data.name || '(no name)',
      teamId: data.teamId,
      teamName,
      isActive: data.isActive !== false,
      currentStreakDays: data.currentStreakDays || 0,
      jerseyNumber: data.jerseyNumber,
      position: data.position,
      activePlans: planCount,
      createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString().slice(0, 10) : null,
    };
  }));
  return rows;
}

async function cmdList(uid: string) {
  const rows = await loadLinkedPlayers(uid);
  console.log(`\nFound ${rows.length} player record(s) linked to uid ${uid}:\n`);
  for (const r of rows) {
    const marker = r.isActive ? '●' : '○';
    console.log(`${marker} ${r.name} ${r.jerseyNumber ? `#${r.jerseyNumber} ` : ''}(${r.position || 'no pos'})`);
    console.log(`    id:           ${r.id}`);
    console.log(`    team:         ${r.teamName} (${r.teamId})`);
    console.log(`    isActive:     ${r.isActive}`);
    console.log(`    streak:       ${r.currentStreakDays} days`);
    console.log(`    active plans: ${r.activePlans}`);
    console.log(`    created:      ${r.createdAt}`);
    console.log('');
  }
  console.log('To soft-delete one:    npx tsx scripts/manageMyPlayers.ts delete <id>');
  console.log('To post a streak post: npx tsx scripts/manageMyPlayers.ts post-streak <id> [milestone=5]');
}

// Diagnostic: find ALL player docs by name (no parent filter), and
// print their raw parentIds / parentId values so we can see why one
// surface lists them and another doesn't. Use when a duplicate kid
// shows up in the app but not in our parent-filtered query.
async function cmdFind(nameSubstring: string, uid: string) {
  const snap = await db.collection('players').get();
  const matches = snap.docs.filter(d => {
    const name = ((d.data() as any).name || '').toLowerCase();
    return name.includes(nameSubstring.toLowerCase());
  });
  console.log(`\nFound ${matches.length} player(s) whose name contains "${nameSubstring}":\n`);
  for (const d of matches) {
    const data = d.data() as any;
    const inParentIds = Array.isArray(data.parentIds) && data.parentIds.includes(uid);
    const inLegacy = data.parentId === uid;
    let teamName = '(unknown)';
    if (data.teamId) {
      try {
        const t = await db.collection('teams').doc(data.teamId).get();
        if (t.exists) teamName = (t.data() as any).name || data.teamId;
      } catch { /* ignore */ }
    }
    console.log(`${data.isActive === false ? '○' : '●'} ${data.name} ${data.jerseyNumber ? `#${data.jerseyNumber} ` : ''}(${data.position || 'no pos'})`);
    console.log(`    id:        ${d.id}`);
    console.log(`    team:      ${teamName} (${data.teamId || 'no teamId'})`);
    console.log(`    isActive:  ${data.isActive !== false}`);
    console.log(`    streak:    ${data.currentStreakDays || 0} days`);
    console.log(`    parentIds: ${JSON.stringify(data.parentIds)}`);
    console.log(`    parentId:  ${JSON.stringify(data.parentId)}`);
    console.log(`    matches your uid via parentIds[]: ${inParentIds}`);
    console.log(`    matches your uid via parentId:    ${inLegacy}`);
    console.log('');
  }
}

async function cmdDelete(playerId: string) {
  const ref = db.collection('players').doc(playerId);
  const snap = await ref.get();
  if (!snap.exists) {
    console.error(`No such player: ${playerId}`);
    process.exit(1);
  }
  const data = snap.data() as any;
  console.log(`Soft-deleting: ${data.name} (${playerId}) — isActive will be set to false.`);
  console.log('(Per the soft-delete pattern. The record stays in Firestore so anything that referenced it — old chat threads, wall posts, stats — keeps working.)');
  await ref.update({ isActive: false, deactivatedAt: new Date() });
  console.log('Done.');
}

async function cmdPostStreak(senderUid: string, playerId: string, milestoneArg?: string) {
  const milestone = parseInt(milestoneArg || '5', 10);
  if (![5, 10, 25, 50, 100].includes(milestone)) {
    console.error(`Milestone must be one of 5/10/25/50/100 (got ${milestone}).`);
    process.exit(1);
  }

  const playerSnap = await db.collection('players').doc(playerId).get();
  if (!playerSnap.exists) {
    console.error(`No such player: ${playerId}`);
    process.exit(1);
  }
  const player = playerSnap.data() as any;
  if (!player.teamId) {
    console.error(`Player ${playerId} has no teamId — cannot post.`);
    process.exit(1);
  }

  // Pull the sender's display name from the user doc so the wall
  // post is attributed correctly even when we only have the uid.
  let senderName = 'Coach';
  try {
    const u = await db.collection('users').doc(senderUid).get();
    if (u.exists) senderName = (u.data() as any).name || senderName;
  } catch { /* ignore */ }

  const content = [
    headingFor(milestone),
    `**${player.name}** just hit a **${milestone}-day** practice streak.`,
  ].join('\n');

  const ref = await db.collection('wall_posts').add({
    teamId: player.teamId,
    content,
    senderId: senderUid,
    senderName,
    senderRole: 'coach',
    timestamp: new Date(),
    attachments: null,
    reactions: [],
    wallPinnedTop: null,
    postedFrom: 'devplan',
    category: 'announcement',
    isPublic: false,
  });

  console.log(`Posted: wall_posts/${ref.id}`);
  console.log(`Team: ${player.teamId}`);
  console.log(`Player: ${player.name}`);
  console.log(`Milestone: ${milestone}-day`);
  console.log(`Posted by: ${senderName} (${senderUid})`);
}

(async () => {
  // Strip flags from positional args so they don't get mis-parsed
  // as player ids.
  const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const [cmd, arg1, arg2] = positional;

  const uid = await resolveUid();

  if (!cmd || cmd === 'list') {
    await cmdList(uid);
  } else if (cmd === 'find') {
    if (!arg1) { console.error('Usage: find <name-substring>'); process.exit(1); }
    await cmdFind(arg1, uid);
  } else if (cmd === 'delete') {
    if (!arg1) { console.error('Usage: delete <playerId>'); process.exit(1); }
    await cmdDelete(arg1);
  } else if (cmd === 'post-streak') {
    if (!arg1) { console.error('Usage: post-streak <playerId> [milestone=5]'); process.exit(1); }
    await cmdPostStreak(uid, arg1, arg2);
  } else {
    console.error(`Unknown command: ${cmd}`);
    console.error('Commands: list, find <name>, delete <id>, post-streak <id> [milestone]');
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
