#!/usr/bin/env tsx
/**
 * One-off seed: stamp the existing Fire FC team-store config onto
 * clubs/firefc so the new per-club TeamStore page keeps showing the
 * same gear shop after the hardcoded URL was removed from the
 * component. Also reports / optionally backfills clubId=firefc onto
 * any team that doesn't already have a clubId.
 *
 * Idempotent.
 *
 * Usage:
 *   npx tsx scripts/seed-firefc-store.ts                       # dry-run, report only
 *   npx tsx scripts/seed-firefc-store.ts --apply               # write clubs/firefc only
 *   npx tsx scripts/seed-firefc-store.ts --apply --backfill    # also stamp clubId=firefc on teams missing a clubId
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const APPLY = process.argv.includes('--apply');
const BACKFILL = process.argv.includes('--backfill');

const SA_PATH = path.resolve(__dirname, 'firebase-service-account.json');
if (!fs.existsSync(SA_PATH)) {
  console.error('Service account JSON not found at', SA_PATH);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(SA_PATH) });
const db = admin.firestore();

const tag = APPLY ? 'APPLY' : 'DRY  ';

const CLUB_ID = 'firefc';
const CLUB_FIELDS = {
  name: 'Fire FC',
  storeUrl: 'https://team.wegotsoccer.com/firefc',
  storeDiscountCode: 'FIREFCREWARDS',
};

(async () => {
  // 1. Ensure clubs/firefc exists with the right store fields.
  const ref = db.collection('clubs').doc(CLUB_ID);
  const snap = await ref.get();
  if (!snap.exists) {
    console.log(`[${tag}] clubs/${CLUB_ID} does not exist — will create with`, CLUB_FIELDS);
    if (APPLY) await ref.set({ ...CLUB_FIELDS, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  } else {
    const data = snap.data() || {};
    const patch: Record<string, any> = {};
    for (const [k, v] of Object.entries(CLUB_FIELDS)) {
      if (data[k] === undefined) patch[k] = v;
    }
    if (Object.keys(patch).length === 0) {
      console.log(`[${tag}] clubs/${CLUB_ID} already has store fields — nothing to do`);
    } else {
      console.log(`[${tag}] clubs/${CLUB_ID} — patching`, patch);
      if (APPLY) await ref.update(patch);
    }
  }

  // 2. Audit teams for clubId. Report missing; optionally backfill.
  const teamsSnap = await db.collection('teams').get();
  const missing: { id: string; name?: string }[] = [];
  teamsSnap.forEach(d => {
    const data: any = d.data();
    if (!data?.clubId) missing.push({ id: d.id, name: data?.name });
  });
  console.log(`\nteams w/o clubId: ${missing.length} of ${teamsSnap.size}`);
  missing.forEach(t => console.log(`  - ${t.id}  ${t.name || ''}`));
  if (BACKFILL && missing.length) {
    // Only stamp teams whose name clearly belongs to Fire FC.
    // Saturday Skills, St George pickup, etc. stay personal (no
    // clubId) — they're separate organizations, not Fire FC teams.
    const candidates = missing.filter(t => /^fire ?fc/i.test(t.name || ''));
    const skipped = missing.filter(t => !candidates.includes(t));
    if (skipped.length) {
      console.log(`\n[${tag}] skipping ${skipped.length} non-Fire-FC teams (stay clubId-less):`);
      skipped.forEach(t => console.log(`    - ${t.id}  ${t.name || ''}`));
    }
    if (!APPLY) {
      console.log(`\n[${tag}] would stamp clubId='${CLUB_ID}' on ${candidates.length} teams (rerun with --apply --backfill):`);
      candidates.forEach(t => console.log(`    + ${t.id}  ${t.name || ''}`));
    } else {
      console.log(`\n[${tag}] stamping clubId='${CLUB_ID}' on ${candidates.length} Fire FC teams...`);
      const writer = db.bulkWriter();
      for (const t of candidates) {
        writer.update(db.collection('teams').doc(t.id), { clubId: CLUB_ID });
      }
      await writer.close();
      console.log('done.');
    }
  } else if (missing.length && !BACKFILL) {
    console.log('\n(re-run with --backfill to stamp clubId=firefc on Fire FC teams; non-matching names are skipped automatically)');
  }
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
