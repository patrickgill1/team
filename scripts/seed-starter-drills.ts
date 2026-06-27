#!/usr/bin/env tsx
/**
 * One-time seed: write the 11 starter drills that used to live as a
 * hardcoded DRILL_LIBRARY constant inside PracticePlanBuilder.tsx
 * into the real `drills` collection.
 *
 * The starter drills are scoped to one specific team (Patrick's main
 * team by default — override with --teamId=<id>) and flipped to
 * shareToLibrary=true so other coaches see them in the cross-club
 * catalog and can Save into their own libraries.
 *
 * Idempotent: re-running won't create duplicates — checks for an
 * existing drill with the same title + same teamId first.
 *
 * Usage:
 *   npx tsx scripts/seed-starter-drills.ts                                       # dry-run, default team
 *   npx tsx scripts/seed-starter-drills.ts --apply                               # write to default team
 *   npx tsx scripts/seed-starter-drills.ts --apply --teamId=<id>                 # write to a specific team
 *   npx tsx scripts/seed-starter-drills.ts --apply --teamId=<id> --uid=<uid>     # also set createdBy
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? 'APPLY' : 'DRY  ';

function flag(name: string): string | null {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
}

const SA_PATH = path.resolve(__dirname, 'firebase-service-account.json');
if (!fs.existsSync(SA_PATH)) {
  console.error('Service account JSON not found at', SA_PATH);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(SA_PATH) });
const db = admin.firestore();

// Default team — Patrick's Fire FC U10 PG. Override via --teamId.
// If you don't know the id, run `--teamId=` empty to see the script
// list available teams and exit.
const DEFAULT_TEAM_ID = 'XW3jrXejq9MnIrqJfm6X';
const TEAM_ID = flag('teamId') || DEFAULT_TEAM_ID;
const SEED_UID = flag('uid') || 'system-seed';
const SEED_NAME = 'GoalKickr';

// Starter drills — the 11 that used to be hardcoded in
// PracticePlanBuilder. Mapped from the builder's local Drill shape
// (name/durationMin/category/notes) to the real Drill schema
// (title/durationMinutes/category/topic/ageBand/useCase/focus).
// 'Both' useCase for most so they show in Team AND Extra Reps
// filters; cooldown/warmup stay team-only.
const STARTERS = [
  { title: 'Dynamic Warm-up',         durationMinutes: 10, topic: 'fitness',   category: 'physical',  useCase: 'team', focus: 'Skips, lunges, leg swings, arm circles' },
  { title: 'Rondo (4v1)',             durationMinutes: 10, topic: 'passing',   category: 'technical', useCase: 'team', focus: 'Quick passes, one-touch focus' },
  { title: 'Passing Lanes',           durationMinutes: 12, topic: 'passing',   category: 'technical', useCase: 'team', focus: 'Triangles, overlaps' },
  { title: '1v1 Defending',           durationMinutes: 10, topic: 'defending', category: 'tactical',  useCase: 'both', focus: 'Approach angle, body shape' },
  { title: 'Possession Game (5v5+1)', durationMinutes: 15, topic: 'tactical',  category: 'tactical',  useCase: 'team', focus: 'Switch fields, find the +1' },
  { title: 'Shooting Reps',           durationMinutes: 12, topic: 'shooting',  category: 'technical', useCase: 'both', focus: 'Both feet, far post' },
  { title: 'Set Pieces',              durationMinutes: 10, topic: 'tactical',  category: 'tactical',  useCase: 'team', focus: 'Corners + free kicks' },
  { title: 'Small-sided Scrimmage',   durationMinutes: 20, topic: 'tactical',  category: 'tactical',  useCase: 'team', focus: '4v4 or 5v5, 2 touches' },
  { title: 'Full Scrimmage',          durationMinutes: 25, topic: 'tactical',  category: 'tactical',  useCase: 'team', focus: 'Full numbers if possible' },
  { title: 'Sprint Ladder',           durationMinutes: 8,  topic: 'fitness',   category: 'physical',  useCase: 'both', focus: '4 sets of 6 sprints' },
  { title: 'Stretch & Cool-down',     durationMinutes: 8,  topic: 'fitness',   category: 'physical',  useCase: 'team', focus: 'Hamstrings, calves, hips' },
];

(async () => {
  // Validate the team exists. Bad teamId would silently write into a
  // collection nobody reads.
  const teamSnap = await db.collection('teams').doc(TEAM_ID).get();
  if (!teamSnap.exists) {
    console.error(`Team ${TEAM_ID} does not exist. Run with --teamId=<existing-id>.`);
    console.error('First few teams:');
    const teamsSnap = await db.collection('teams').limit(10).get();
    teamsSnap.docs.forEach(d => console.error(`  ${d.id}  ${(d.data() as any).name || ''}`));
    process.exit(1);
  }
  console.log(`[${tag}] Seeding ${STARTERS.length} starter drills into team ${TEAM_ID} (${(teamSnap.data() as any).name}).`);

  // Existing-title check so the script is safe to re-run.
  const existingSnap = await db.collection('drills').where('teamId', '==', TEAM_ID).get();
  const existingTitles = new Set(existingSnap.docs.map(d => String((d.data() as any).title || '').trim().toLowerCase()));

  let created = 0;
  let skipped = 0;
  const now = admin.firestore.FieldValue.serverTimestamp();
  for (const seed of STARTERS) {
    if (existingTitles.has(seed.title.toLowerCase())) {
      console.log(`  [${tag}] SKIP (exists): ${seed.title}`);
      skipped++;
      continue;
    }
    const doc: any = {
      teamId: TEAM_ID,
      title: seed.title,
      topic: seed.topic,
      category: seed.category,
      useCase: seed.useCase,
      ageBand: 'all',
      focus: seed.focus,
      durationMinutes: seed.durationMinutes,
      source: 'imported',
      createdBy: SEED_UID,
      createdByName: SEED_NAME,
      createdAt: now,
      updatedAt: now,
      isActive: true,
      assignmentCount: 0,
      // Share into the cross-club library so other coaches see them.
      shareToLibrary: true,
      sharedAt: now,
      saveCount: 0,
      ratingCount: 0,
      ratingSum: 0,
      averageRating: 0,
    };
    if (APPLY) {
      const ref = await db.collection('drills').add(doc);
      console.log(`  [${tag}] +${seed.title}  →  ${ref.id}`);
    } else {
      console.log(`  [${tag}] +${seed.title}  (would create)`);
    }
    created++;
  }

  console.log(`\n[${tag}] Done. Created: ${created}. Skipped (existing): ${skipped}.`);
  if (!APPLY) console.log('Re-run with --apply to actually write.');
  process.exit(0);
})().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
