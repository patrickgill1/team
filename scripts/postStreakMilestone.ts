// Manually fire a streak-milestone wall post for one of Patrick's
// linked players — useful when the milestone was missed due to an
// earlier race condition.
//
// Usage:
//   npx tsx scripts/postStreakMilestone.ts          (defaults to 5)
//   npx tsx scripts/postStreakMilestone.ts 10
//
// Requires scripts/demo-service-account.json (Firebase Admin key,
// same one the seed script uses).
//
// Safe to re-run: checks for an existing devplan-milestone post on
// the same teamId within the last hour and bails if found.

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const candidates = [
  'demo-service-account.json',
  'firebase-service-account.json',
];
let serviceAccountPath: string | null = null;
for (const c of candidates) {
  const p = path.resolve(__dirname, c);
  if (fs.existsSync(p)) { serviceAccountPath = p; break; }
}
if (!serviceAccountPath) {
  console.error('Missing service-account JSON in scripts/. Drop yours at scripts/demo-service-account.json');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))),
});
const db = admin.firestore();
const auth = admin.auth();

const PATRICK_EMAIL = 'patrick.gill@zfpmail.org';
const MILESTONE = parseInt(process.argv[2] || '5', 10);

const headingFor = (n: number) =>
  n >= 100 ? '## Century streak' :
  n >= 50  ? '## Half-century streak' :
  n >= 25  ? '## On a roll' :
             '## On fire';

(async () => {
  console.log('Milestone:', MILESTONE);
  const patrick = await auth.getUserByEmail(PATRICK_EMAIL);
  console.log('Patrick uid:', patrick.uid);

  const snap = await db.collection('players')
    .where('parentIds', 'array-contains', patrick.uid)
    .where('isActive', '==', true)
    .get();

  const cands = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
  if (cands.length === 0) {
    console.error('No active players linked to Patrick. Aborting.');
    process.exit(1);
  }
  console.log('\nLinked active players:');
  for (const c of cands) {
    console.log(`  ${c.name} · ${c.id} · streak=${c.currentStreakDays || 0} · teamId=${c.teamId}`);
  }

  // Prefer a player whose current streak matches the milestone exactly;
  // fall back to the highest streak >= milestone.
  let target = cands.find(c => (c.currentStreakDays || 0) === MILESTONE);
  if (!target) {
    target = cands
      .filter(c => (c.currentStreakDays || 0) >= MILESTONE)
      .sort((a, b) => (b.currentStreakDays || 0) - (a.currentStreakDays || 0))[0];
  }
  if (!target) {
    console.error(`\nNo linked player has currentStreakDays >= ${MILESTONE}. Aborting.`);
    process.exit(1);
  }
  console.log(`\nTargeting: ${target.name} (${target.id}) — streak ${target.currentStreakDays || 0}, teamId ${target.teamId}`);

  // Idempotency check — bail if a devplan milestone post for this
  // team already exists in the last hour. (Avoids accidental
  // duplicates on re-runs.)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await db.collection('wall_posts')
    .where('teamId', '==', target.teamId)
    .where('postedFrom', '==', 'devplan')
    .where('timestamp', '>=', oneHourAgo)
    .get();
  if (!recent.empty) {
    console.log(`\nA devplan post already landed in the last hour (${recent.docs[0].id}). Bailing — re-run after 1h if you really want another.`);
    process.exit(0);
  }

  const content = [
    headingFor(MILESTONE),
    `**${target.name}** just hit a **${MILESTONE}-day** practice streak.`,
  ].join('\n');

  const ref = await db.collection('wall_posts').add({
    teamId: target.teamId,
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

  console.log(`\nPosted: wall_posts/${ref.id}`);
  console.log('Open the app → Wall to see it.');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
