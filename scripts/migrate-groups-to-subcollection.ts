#!/usr/bin/env tsx
/**
 * Group-chat subcollection migration (2026-07-21, Option 1 sign-off).
 *
 * Moves every group thread out of the shared chat_threads /
 * chat_messages collections into a dedicated collection with the
 * messages nested underneath:
 *
 *   chat_threads/{gid}                    (isGroup==true)
 *     → chat_group_threads/{gid}
 *   chat_messages/{mid} where threadId==gid
 *     → chat_group_threads/{gid}/messages/{mid}
 *
 * Doc ids are preserved so every deep link, mention hydration, and
 * cached id keeps working.
 *
 * ORDER of operations (deploy sequence, single-source-of-truth is
 * the design doc):
 *   1. Ship client + functions (adds subscribeToChatGroups against
 *      the new collection, addGroupMessage/updateGroupThread wrappers,
 *      onGroupChatMessageCreate trigger).
 *   2. Run this script with --apply against production Firestore.
 *   3. Run this script with --check to confirm zero stragglers.
 *   4. Deploy tightened firestore.rules (participants-only on
 *      chat_group_threads, chat_threads reverts to authed).
 *
 * Rollback: the source chat_threads/{gid} + chat_messages docs are
 * preserved via a soft delete (isActive:false + migratedTo pointer)
 * so we can flip them back on if the new collection develops issues.
 * Hard-delete of the source is a separate follow-up after 30 days of
 * clean production traffic.
 *
 * Idempotent: rerunnable. Skips any group already mirrored.
 *
 * Usage:
 *   npx tsx scripts/migrate-groups-to-subcollection.ts           # dry-run
 *   npx tsx scripts/migrate-groups-to-subcollection.ts --apply   # write
 *   npx tsx scripts/migrate-groups-to-subcollection.ts --check   # pre-rules-deploy gate
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const APPLY = process.argv.includes('--apply');
const CHECK = process.argv.includes('--check');
const tag = CHECK ? 'CHECK' : APPLY ? 'APPLY' : 'DRY  ';

const SA_PATH = path.resolve(__dirname, 'firebase-service-account.json');
if (!fs.existsSync(SA_PATH)) {
  console.error('Service account JSON not found at', SA_PATH);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(SA_PATH) });
const db = admin.firestore();

interface SourceThread {
  id: string;
  data: FirebaseFirestore.DocumentData;
}

async function loadSourceGroups(): Promise<SourceThread[]> {
  const snap = await db
    .collection('chat_threads')
    .where('isGroup', '==', true)
    .get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

async function loadTeamClubId(teamId: string, cache: Map<string, string | null>): Promise<string | null> {
  if (!teamId) return null;
  if (cache.has(teamId)) return cache.get(teamId) ?? null;
  try {
    const teamSnap = await db.collection('teams').doc(teamId).get();
    if (teamSnap.exists) {
      const t: any = teamSnap.data();
      const clubId: string | null = typeof t?.clubId === 'string' && t.clubId ? t.clubId : null;
      cache.set(teamId, clubId);
      return clubId;
    }
  } catch (err) {
    console.warn(`[${tag}] teams/${teamId} lookup failed`, err);
  }
  cache.set(teamId, null);
  return null;
}

async function main() {
  const groups = await loadSourceGroups();
  console.log(`Found ${groups.length} isGroup==true chat_threads doc(s).`);

  if (CHECK) {
    // Gate: every source doc MUST be either mirrored (isActive:false
    // + migratedTo set) or absent. Any straggler that still looks
    // like a live group in the old collection means the migration
    // isn't complete and the tightened rule set is unsafe to ship.
    const stragglers = groups.filter((g) => {
      const migratedTo = (g.data as any)?.migratedTo;
      const isActive = (g.data as any)?.isActive;
      return !migratedTo || isActive !== false;
    });
    if (stragglers.length > 0) {
      console.error(
        `\n[${tag}] FAIL: ${stragglers.length} group thread(s) in ` +
        `chat_threads have not been migrated. Re-run --apply.`
      );
      stragglers.slice(0, 10).forEach((g) => {
        const t: any = g.data;
        console.error(`  - chat_threads/${g.id}  title="${t?.title || ''}"  migratedTo="${t?.migratedTo || ''}"  isActive=${t?.isActive}`);
      });
      if (stragglers.length > 10) console.error(`  ...and ${stragglers.length - 10} more`);
      process.exit(2);
    }
    console.log(`\n[${tag}] PASS: every source group thread has been migrated. Safe to deploy chat_group_threads rules.`);
    process.exit(0);
  }

  let migrated = 0;
  let skipped = 0;
  let messageCount = 0;
  const teamClubCache = new Map<string, string | null>();

  for (const g of groups) {
    const gid = g.id;
    const src: any = g.data;

    // Idempotency: if the destination doc already exists, treat this
    // thread as migrated. We still copy any messages we missed (set
    // with merge on the child docs), then re-stamp the source's
    // migratedTo/isActive marker to be safe.
    const destRef = db.collection('chat_group_threads').doc(gid);
    const destSnap = await destRef.get();
    const alreadyMigrated = destSnap.exists;

    // Prefer the pre-privacy-fix originTeamId (real originating team)
    // over the current teamId, which the 2026-07-21 backfill blanked
    // to '' for privacy. Fall back to teamId if originTeamId is
    // missing (should only be legacy pre-backfill docs).
    const teamId: string = (typeof src.originTeamId === 'string' && src.originTeamId)
      ? src.originTeamId
      : (typeof src.teamId === 'string' ? src.teamId : '');
    const clubId = await loadTeamClubId(teamId, teamClubCache);

    const now = admin.firestore.FieldValue.serverTimestamp();

    // Build the new thread payload. Preserve every field the client
    // reads (title, participants, lastMessage, unreadCount, pinned,
    // mutedByUids, typingBy) and stamp first-class teamId/clubId so
    // the demo-team push guard works without an originTeamId fallback.
    const newThread: any = {
      id: gid,
      title: src.title || 'Group chat',
      teamId,
      clubId: clubId || null,
      createdBy: src.createdBy || '',
      createdByName: src.createdByName || '',
      participants: Array.isArray(src.participants) ? src.participants : [],
      createdAt: src.createdAt || now,
      updatedAt: src.updatedAt || src.lastActivity || now,
      lastActivity: src.lastActivity || src.updatedAt || now,
      isActive: true,
      isPinned: !!src.isPinned,
      unreadCount: src.unreadCount || {},
      lastMessage: src.lastMessage || null,
      mutedByUids: Array.isArray(src.mutedByUids) ? src.mutedByUids : [],
      pinnedMessageIds: Array.isArray(src.pinnedMessageIds) ? src.pinnedMessageIds : [],
      typingBy: src.typingBy || {},
      tags: Array.isArray(src.tags) ? src.tags : ['group'],
    };

    if (!alreadyMigrated) {
      console.log(`[${tag}] chat_threads/${gid} -> chat_group_threads/${gid}  title="${newThread.title}"  participants=${newThread.participants.length}`);
      if (APPLY) {
        await destRef.set(newThread);
      }
    } else {
      console.log(`[${tag}] chat_group_threads/${gid} already exists — verifying children only`);
    }

    // Walk every source message and copy it into the subcollection.
    // Paginated to keep memory bounded even if a group has many
    // thousands of messages.
    const PAGE = 500;
    let lastDocId: string | null = null;
    // Simple deterministic paginate via id ordering — Firestore
    // supports startAfter on a doc snapshot; we iterate one page at
    // a time by holding the last-doc reference.
    let lastDocSnap: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    let localCount = 0;
    let pageIdx = 0;

    while (true) {
      let q = db.collection('chat_messages')
        .where('threadId', '==', gid)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(PAGE);
      if (lastDocSnap) q = q.startAfter(lastDocSnap);
      const msgs = await q.get();
      if (msgs.empty) break;
      pageIdx += 1;

      for (const doc of msgs.docs) {
        const mid = doc.id;
        const mdata: any = doc.data();
        // Path is authoritative — strip threadId + teamId from the
        // stored payload so future queries can't hit stale-copy
        // mismatches.
        const { threadId: _t, teamId: _tm, id: _id, ...rest } = mdata;
        const childRef = destRef.collection('messages').doc(mid);
        if (APPLY) {
          await childRef.set(rest, { merge: true });
        }
        localCount += 1;
      }
      lastDocSnap = msgs.docs[msgs.docs.length - 1];
      lastDocId = lastDocSnap.id;
      if (msgs.size < PAGE) break;
    }
    console.log(`[${tag}]   copied ${localCount} message(s) across ${pageIdx} page(s) (last id: ${lastDocId})`);
    messageCount += localCount;

    // Soft-delete the source thread so the sidebar drops it (all
    // three subscription surfaces already filter isActive !== false).
    // Preserve migratedTo/migratedAt for rollback + audit.
    if (APPLY) {
      await db.collection('chat_threads').doc(gid).update({
        migratedTo: `chat_group_threads/${gid}`,
        migratedAt: admin.firestore.FieldValue.serverTimestamp(),
        isActive: false,
      });
    }

    if (alreadyMigrated) skipped += 1; else migrated += 1;
  }

  console.log(`\nDone. migrated=${migrated} already-mirrored=${skipped} messages=${messageCount}`);

  if (APPLY) {
    // Post-apply verification — same query as --check.
    const verify = await loadSourceGroups();
    const remaining = verify.filter((g) => {
      const t: any = g.data;
      return !t?.migratedTo || t?.isActive !== false;
    });
    if (remaining.length > 0) {
      console.error(`\nWARN: ${remaining.length} source group thread(s) still un-migrated. Re-run --apply.`);
      process.exit(2);
    }
    console.log('Verify: every source group carries migratedTo + isActive:false. Safe to deploy firestore rules.');
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
