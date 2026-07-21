#!/usr/bin/env tsx
/**
 * Group-chat privacy backfill (2026-07-21).
 *
 * Every chat_threads doc with isGroup==true is rewritten so that
 * teamId=''. The old teamId (whichever team the coach was viewing
 * when the group was created) is preserved on originTeamId for
 * future UI hints.
 *
 * WHY. Groups shipped with teamId=<selectedTeamId>. The team-scope
 * subscription (`where teamId in [...]`) streamed group thread docs
 * — title, last-message snippet, participants — to every member of
 * the team, including non-participants. The dashboard "Recent chats"
 * card rendered those previews without any participant filter, so
 * every parent on the team saw the group's snippet in their sidebar.
 * The rule-layer fix (participants-only read on isGroup==true) needs
 * the team subscription to NOT return groups any more, or the whole
 * snapshot 403s. Clearing teamId achieves that with one field write
 * per group instead of a full-collection re-shape.
 *
 * ORDER of operations:
 *   1. Deploy new client code (adds subscribeToChatGroups and its
 *      wiring in Dashboard, NotificationsHeaderBar, ChatHeaderButton,
 *      useDashboardActivity, TeamChat). New groups are already
 *      created with teamId=''.
 *   2. Run this script with --apply against production Firestore.
 *   3. Deploy the tightened firestore.rules for chat_threads.
 *
 * Step 2 must complete before step 3 or existing group threads with
 * teamId set will 403 the team subscription for non-participants who
 * share a team with the group.
 *
 * Idempotent. Dry-run by default.
 *
 * Usage:
 *   npx tsx scripts/backfill-group-thread-teamid.ts            # dry-run
 *   npx tsx scripts/backfill-group-thread-teamid.ts --apply    # write
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
  const snap = await db
    .collection('chat_threads')
    .where('isGroup', '==', true)
    .get();
  console.log(`Found ${snap.size} isGroup==true chat_threads.`);
  let updated = 0, skipped = 0;

  for (const doc of snap.docs) {
    const data: any = doc.data();
    const currentTeam: string = typeof data?.teamId === 'string' ? data.teamId : '';
    if (currentTeam === '') { skipped++; continue; }
    console.log(
      `[${tag}] chat_threads/${doc.id}  teamId="${currentTeam}" -> ""  ` +
      `originTeamId="${currentTeam}" title="${data?.title || ''}"`
    );
    if (APPLY) {
      const patch: any = { teamId: '' };
      if (!data?.originTeamId) patch.originTeamId = currentTeam;
      await doc.ref.update(patch);
    }
    updated++;
  }
  console.log(`\nDone. updated=${updated} skipped=${skipped} (already teamId='')`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
