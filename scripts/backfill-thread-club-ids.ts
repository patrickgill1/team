#!/usr/bin/env tsx
/**
 * Stamp clubId onto every club-scope chat thread (scope in
 * {coaches, club, admins}) that's missing it. Source-of-truth for
 * the clubId is the createdBy user's clubId (if set), else the
 * teamId's clubId (if the thread is teamId-anchored).
 *
 * Why: the new TeamChat filter requires thread.clubId === selectedTeam.
 * clubId for club-scope threads to be visible. Without this backfill,
 * existing 'Coaches, Managers and Staff' threads would vanish from
 * every team's chat list. Patrick 2026-06-25: 'so what about
 * coaches/club channels only?'
 *
 * Idempotent. Dry-run by default.
 *
 * Usage:
 *   npx tsx scripts/backfill-thread-club-ids.ts            # dry-run
 *   npx tsx scripts/backfill-thread-club-ids.ts --apply    # write
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

const CLUB_SCOPES = new Set(['coaches', 'club', 'admins']);

async function lookupClubId(threadData: any): Promise<string | null> {
  // 1. teamId on the thread itself -> read the team's clubId
  const teamId: string | undefined = threadData?.teamId || undefined;
  if (teamId) {
    try {
      const t = await db.collection('teams').doc(teamId).get();
      if (t.exists) {
        const c = (t.data() as any)?.clubId;
        if (c) return String(c);
      }
    } catch { /* ignore */ }
  }
  // 2. createdBy user's clubId
  const createdBy: string | undefined = threadData?.createdBy || undefined;
  if (createdBy) {
    try {
      const u = await db.collection('users').doc(createdBy).get();
      if (u.exists) {
        const data: any = u.data();
        if (data?.clubId) return String(data.clubId);
        if (Array.isArray(data?.clubIds) && data.clubIds[0]) return String(data.clubIds[0]);
      }
    } catch { /* ignore */ }
  }
  return null;
}

(async () => {
  const snap = await db.collection('chat_threads').get();
  console.log(`Walking ${snap.size} chat_threads.`);
  let stamped = 0, skipped = 0, unresolved = 0, irrelevant = 0;

  for (const doc of snap.docs) {
    const data: any = doc.data();
    const scope: string = data?.scope || 'team';
    if (!CLUB_SCOPES.has(scope)) { irrelevant++; continue; }
    if (data?.clubId) { skipped++; continue; }

    const clubId = await lookupClubId(data);
    if (!clubId) {
      unresolved++;
      console.log(`[${tag}] chat_threads/${doc.id}  UNRESOLVED  scope=${scope} title="${data?.title || ''}"`);
      continue;
    }
    console.log(`[${tag}] chat_threads/${doc.id}  -> clubId=${clubId}  scope=${scope} title="${data?.title || ''}"`);
    if (APPLY) {
      await doc.ref.update({ clubId });
    }
    stamped++;
  }
  console.log(`\nDone. stamped=${stamped} skipped=${skipped} (already had clubId) unresolved=${unresolved} irrelevant=${irrelevant} (non-club scope)`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
