#!/usr/bin/env tsx
/**
 * One-time migration: merge duplicate DM threads.
 *
 * BACKGROUND
 *   getOrCreateDMThread historically fell through to CREATE on any
 *   lookup error (network blip, transient rules denial during auth
 *   refresh, missing index). Result: same two participants ended up
 *   with multiple DM threads, each tagged with whichever team was
 *   selected at the moment the duplicate was spawned. Patrick saw
 *   the symptom 2026-06-21: 'on the android simulator, it will show
 *   all the messages on one team, but if I go to that dm from
 *   another team, there are no messages.'
 *
 * WHAT THIS DOES
 *   1. Reads every chat_threads doc with isDM == true.
 *   2. Groups by sorted participant pair (so order doesn't matter).
 *   3. For each pair that has > 1 thread:
 *        a. Picks the OLDEST (smallest createdAt) as canonical.
 *        b. For each duplicate:
 *             - Rewrites every chat_messages doc whose threadId
 *               matches the duplicate to point at the canonical
 *               threadId instead.
 *             - Marks the duplicate thread `isActive: false` and
 *               sets `mergedIntoThreadId` to the canonical id so we
 *               can audit later. Soft-delete per the project's
 *               soft-delete-pattern memory; PITR isn't enabled so we
 *               never deleteDocument on user-facing records.
 *        c. Refreshes the canonical thread's messageCount +
 *           lastActivity to match its NEW total message set.
 *   4. Print a detailed report; --apply actually writes.
 *
 * SAFETY
 *   - Dry-run by default. Prints what WOULD happen.
 *   - Idempotent: re-running after a successful --apply finds no
 *     duplicates and exits cleanly.
 *   - Soft-delete only — no destructive operations.
 *   - Per-batch Firestore writes capped at 400 (well under the 500
 *     limit) so partial failures don't poison-pill an entire pair.
 *
 * USAGE
 *   npx tsx scripts/merge-duplicate-dms.ts                # dry run
 *   npx tsx scripts/merge-duplicate-dms.ts --apply        # execute
 *
 * REQUIRES
 *   ./scripts/firebase-service-account.json (gitignored).
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const APPLY = process.argv.includes('--apply');

const saPath = path.resolve(__dirname, 'firebase-service-account.json');
if (!fs.existsSync(saPath)) {
  console.error('Missing scripts/firebase-service-account.json — see header.');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
const db = admin.firestore();

interface DMThread {
  id: string;
  participants: string[];
  createdAt: Date;
  lastActivity: Date;
  messageCount: number;
  teamId?: string;
  isActive?: boolean;
}

function pairKey(participants: string[]): string | null {
  if (!Array.isArray(participants) || participants.length !== 2) return null;
  return [...participants].sort().join('|');
}

async function main() {
  console.log(`\n${APPLY ? 'APPLY' : 'DRY-RUN'} merge-duplicate-dms\n`);

  // 1. Read all DM threads.
  const snap = await db.collection('chat_threads').where('isDM', '==', true).get();
  console.log(`Found ${snap.size} isDM threads total.\n`);

  // 2. Group by sorted participant pair.
  const groups = new Map<string, DMThread[]>();
  for (const doc of snap.docs) {
    const data = doc.data() as any;
    // Skip threads already merged in a prior run.
    if (data.isActive === false) continue;
    const key = pairKey(data.participants);
    if (!key) continue;
    const thread: DMThread = {
      id: doc.id,
      participants: data.participants,
      createdAt: (data.createdAt?.toDate?.() || new Date(data.createdAt || 0)) as Date,
      lastActivity: (data.lastActivity?.toDate?.() || new Date(data.lastActivity || 0)) as Date,
      messageCount: data.messageCount || 0,
      teamId: data.teamId,
      isActive: data.isActive !== false,
    };
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(thread);
  }

  const dupPairs = Array.from(groups.entries()).filter(([, threads]) => threads.length > 1);
  console.log(`${dupPairs.length} participant pairs have duplicate DMs.\n`);

  if (dupPairs.length === 0) {
    console.log('Nothing to merge. Exiting.');
    return;
  }

  let totalThreadsToMerge = 0;
  let totalMessagesToRewrite = 0;

  // 3. Process each duplicate group.
  for (const [key, threads] of dupPairs) {
    // Sort oldest first; canonical = oldest. Rationale: messages
    // sent before the lookup-failure split landed in the original
    // thread; keeping the oldest preserves the most history under
    // the same id and never invalidates external references (push
    // deep-links, notification threadIds) to the original.
    threads.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const canonical = threads[0];
    const duplicates = threads.slice(1);

    console.log(`Pair ${key}`);
    console.log(`  canonical:  ${canonical.id} (teamId=${canonical.teamId || '?'}, ${canonical.messageCount} msgs, created ${canonical.createdAt.toISOString()})`);
    for (const d of duplicates) {
      console.log(`  duplicate: ${d.id} (teamId=${d.teamId || '?'}, ${d.messageCount} msgs, created ${d.createdAt.toISOString()})`);
    }

    // Find messages for each duplicate and rewrite their threadId.
    for (const dup of duplicates) {
      totalThreadsToMerge++;
      const msgs = await db.collection('chat_messages').where('threadId', '==', dup.id).get();
      totalMessagesToRewrite += msgs.size;
      console.log(`    ${dup.id}: ${msgs.size} messages → rewire to canonical`);

      if (!APPLY) continue;

      // Batch writes in chunks of 400 (under the 500 hard limit, with
      // room for the thread soft-delete write at the end).
      const chunks: admin.firestore.QueryDocumentSnapshot[][] = [];
      for (let i = 0; i < msgs.docs.length; i += 400) {
        chunks.push(msgs.docs.slice(i, i + 400));
      }
      for (const chunk of chunks) {
        const batch = db.batch();
        for (const m of chunk) {
          batch.update(m.ref, { threadId: canonical.id });
        }
        await batch.commit();
      }

      // Soft-delete the duplicate thread.
      await db.collection('chat_threads').doc(dup.id).update({
        isActive: false,
        mergedIntoThreadId: canonical.id,
        mergedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // Refresh canonical's messageCount + lastActivity to match the
    // combined message set.
    if (APPLY) {
      const allMsgs = await db.collection('chat_messages').where('threadId', '==', canonical.id).get();
      const latest = allMsgs.docs.reduce((max, d) => {
        const t = d.data().timestamp?.toDate?.() || new Date(d.data().timestamp || 0);
        return t.getTime() > max.getTime() ? t : max;
      }, new Date(0));
      await db.collection('chat_threads').doc(canonical.id).update({
        messageCount: allMsgs.size,
        lastActivity: latest,
      });
      console.log(`    canonical refreshed: ${allMsgs.size} total messages, lastActivity=${latest.toISOString()}`);
    }

    console.log();
  }

  console.log('---');
  console.log(`${APPLY ? 'Applied' : 'Would apply'}: ${totalThreadsToMerge} duplicate threads merged, ${totalMessagesToRewrite} messages rewired.`);
  if (!APPLY) {
    console.log('\nRun again with --apply to execute.');
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
