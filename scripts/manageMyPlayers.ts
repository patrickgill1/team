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

const PATRICK_EMAIL = 'patrick.gill@zfpmail.org';

const headingFor = (n: number) =>
  n >= 100 ? '## Century streak' :
  n >= 50  ? '## Half-century streak' :
  n >= 25  ? '## On a roll' :
             '## On fire';

async function loadLinkedPlayers(uid: string) {
  const snap = await db.collection('players')
    .where('parentIds', 'array-contains', uid)
    .get();
  const rows = await Promise.all(snap.docs.map(async d => {
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
  console.log(`\nFound ${rows.length} player record(s) linked to ${PATRICK_EMAIL}:\n`);
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

async function cmdPostStreak(playerId: string, milestoneArg?: string) {
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

  const patrick = await auth.getUserByEmail(PATRICK_EMAIL);
  const content = [
    headingFor(milestone),
    `**${player.name}** just hit a **${milestone}-day** practice streak.`,
  ].join('\n');

  const ref = await db.collection('wall_posts').add({
    teamId: player.teamId,
    content,
    senderId: patrick.uid,
    senderName: 'Patrick Gill',
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
}

(async () => {
  const [cmd, arg1, arg2] = process.argv.slice(2);

  if (!cmd || cmd === 'list') {
    const patrick = await auth.getUserByEmail(PATRICK_EMAIL);
    await cmdList(patrick.uid);
  } else if (cmd === 'delete') {
    if (!arg1) { console.error('Usage: delete <playerId>'); process.exit(1); }
    await cmdDelete(arg1);
  } else if (cmd === 'post-streak') {
    if (!arg1) { console.error('Usage: post-streak <playerId> [milestone=5]'); process.exit(1); }
    await cmdPostStreak(arg1, arg2);
  } else {
    console.error(`Unknown command: ${cmd}`);
    console.error('Commands: list, delete <id>, post-streak <id> [milestone]');
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
