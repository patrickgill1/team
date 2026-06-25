#!/usr/bin/env tsx
/**
 * Backfill: every parent gets teamIds[] equal to the UNION of all
 * teams their players are on.
 *
 * Why: firestore.rules onTeam(teamId) gates team reads on the user
 * doc's teamIds[]. When a coach adds a player to a second team, the
 * player doc updates but the parents' user docs DON'T. Result: a
 * parent of a multi-team player gets locked out of the team they
 * weren't originally invited through.
 *
 * Idempotent — uses arrayUnion semantics, never removes.
 *
 * Usage:
 *   npx tsx scripts/backfill-parent-team-ids.ts                  # dry-run
 *   npx tsx scripts/backfill-parent-team-ids.ts --apply          # write
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
  const playersSnap = await db.collection('players').get();
  console.log(`Walking ${playersSnap.size} player docs.`);

  // Build: uid -> Set<teamId>
  const parentTeamIds = new Map<string, Set<string>>();
  for (const p of playersSnap.docs) {
    const data: any = p.data();
    if (data?.isActive === false) continue;
    const tIds: string[] = Array.isArray(data.teamIds) && data.teamIds.length
      ? data.teamIds
      : (data.teamId ? [data.teamId] : []);
    if (tIds.length === 0) continue;
    const parents: string[] = Array.isArray(data.parentIds) ? data.parentIds : [];
    for (const uid of parents) {
      if (!uid) continue;
      if (!parentTeamIds.has(uid)) parentTeamIds.set(uid, new Set());
      const set = parentTeamIds.get(uid)!;
      for (const t of tIds) set.add(t);
    }
  }
  console.log(`Built team-membership map for ${parentTeamIds.size} parents.`);

  let stamped = 0, skipped = 0, missing = 0;
  for (const [uid, teamSet] of parentTeamIds.entries()) {
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      missing++;
      continue;
    }
    const u: any = userSnap.data();
    const current: string[] = Array.isArray(u.teamIds) ? u.teamIds : (u.teamId ? [u.teamId] : []);
    const desired = Array.from(new Set([...current, ...teamSet]));
    if (desired.length === current.length && desired.every((id) => current.includes(id))) {
      skipped++;
      continue;
    }
    const added = desired.filter((id) => !current.includes(id));
    console.log(`[${tag}] users/${uid}  +${added.length} team(s): ${added.join(', ')}`);
    if (APPLY) {
      await userRef.update({ teamIds: desired });
    }
    stamped++;
  }
  console.log(`\nDone. stamped=${stamped} skipped=${skipped} (no-change) missing=${missing} (orphan parentIds)`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
