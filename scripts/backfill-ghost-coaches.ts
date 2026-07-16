#!/usr/bin/env tsx
/**
 * Backfill "ghost coaches" onto teams/{teamId}.assistantCoachIds.
 *
 * Why: applyMembership() in worker/src/writeGuards.ts historically
 * wrote the newly-promoted uid onto team.coachIds only, but the
 * Staff page (src/pages/StaffManagement.tsx) reads headCoachId +
 * assistantCoachIds + managerIds and never coachIds. Every
 * /claim/invite + /claim/coach-invite promotion silently produced
 * a coach who counted for Firestore security rules but was
 * invisible on the head coach's staff panel — no permissions
 * editor, no remove button.
 *
 * The worker fix (this ship) closes new writes. This script cleans
 * up the existing drift so head coaches see the real staff on their
 * page today.
 *
 * Behavior:
 *   For every teams/{teamId} document, compute:
 *     ghosts = coachIds \ (assistantCoachIds ∪ managerIds ∪ {headCoachId})
 *   and arrayUnion each ghost onto assistantCoachIds. Default role
 *   for a legacy coach is 'assistant' — the head coach can promote
 *   or remove them from the Staff page like any other assistant.
 *
 * Idempotent: re-running produces the same result. arrayUnion is
 * already idempotent, and the ghost-computation excludes anyone
 * already accounted for, so a second run finds zero patches.
 *
 * Usage:
 *   npx tsx scripts/backfill-ghost-coaches.ts            # dry-run
 *   npx tsx scripts/backfill-ghost-coaches.ts --apply    # write
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? 'APPLY' : 'DRY  ';

const SA_PATH = path.resolve(__dirname, 'firebase-service-account.json');
if (!fs.existsSync(SA_PATH)) {
  console.error('Service account JSON not found at', SA_PATH);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(SA_PATH) });
const db = admin.firestore();

(async () => {
  const snap = await db.collection('teams').get();
  console.log(`Found ${snap.size} team docs.`);

  let teamsPatched = 0;
  let uidsAdded = 0;
  let teamsClean = 0;

  for (const teamSnap of snap.docs) {
    const teamId = teamSnap.id;
    const data: any = teamSnap.data() || {};
    const coachIds: string[] = Array.isArray(data.coachIds) ? data.coachIds : [];
    if (coachIds.length === 0) {
      teamsClean++;
      continue;
    }
    const assistantIds: string[] = Array.isArray(data.assistantCoachIds) ? data.assistantCoachIds : [];
    const managerIds: string[] = Array.isArray(data.managerIds) ? data.managerIds : [];
    const headCoachId: string | undefined = data.headCoachId || undefined;

    const accounted = new Set<string>([
      ...assistantIds,
      ...managerIds,
      ...(headCoachId ? [headCoachId] : []),
    ]);

    const ghosts = coachIds.filter((u) => typeof u === 'string' && u && !accounted.has(u));
    if (ghosts.length === 0) {
      teamsClean++;
      continue;
    }

    console.log(`[${tag}] teams/${teamId} name="${data.name || '(unnamed)'}" ghosts=${ghosts.length}`);
    for (const uid of ghosts) {
      console.log(`  + ${uid} -> assistantCoachIds`);
    }
    uidsAdded += ghosts.length;
    teamsPatched++;

    if (APPLY) {
      await teamSnap.ref.update({
        assistantCoachIds: admin.firestore.FieldValue.arrayUnion(...ghosts),
      });
    }
  }

  console.log(`\nDone. teamsPatched=${teamsPatched} uidsAdded=${uidsAdded} teamsClean=${teamsClean}`);
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
