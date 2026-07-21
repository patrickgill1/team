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
 *   npx tsx scripts/backfill-group-thread-teamid.ts --check    # gate before rule deploy
 *
 * --check exits with code 0 only if every isGroup==true doc has
 * teamId=''. Wire it into the deploy pipeline as a hard gate before
 * `firebase deploy --only firestore` so the tightened read rule can
 * never land ahead of the backfill.
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

(async () => {
  const snap = await db
    .collection('chat_threads')
    .where('isGroup', '==', true)
    .get();
  console.log(`Found ${snap.size} isGroup==true chat_threads.`);

  // --check: hard gate for CI/deploy. Non-zero exit if any legacy
  // group thread still has teamId set, so the tightened firestore
  // rule cannot deploy ahead of the backfill and 403 non-participant
  // team subscriptions.
  if (CHECK) {
    const stragglers = snap.docs.filter((d) => {
      const t = (d.data() as any)?.teamId;
      return typeof t === 'string' && t !== '';
    });
    if (stragglers.length > 0) {
      console.error(
        `\n[${tag}] FAIL: ${stragglers.length} group thread(s) still ` +
        `carry a non-empty teamId. Run --apply before deploying the ` +
        `tightened chat_threads read rule.`
      );
      stragglers.slice(0, 10).forEach((d) => {
        const data: any = d.data();
        console.error(`  - chat_threads/${d.id}  teamId="${data?.teamId}"  title="${data?.title || ''}"`);
      });
      if (stragglers.length > 10) console.error(`  ...and ${stragglers.length - 10} more`);
      process.exit(2);
    }
    console.log(`\n[${tag}] PASS: 0 group threads still carry teamId. Safe to deploy firestore rules.`);
    process.exit(0);
  }

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

  // Post-apply verification so a partial write (network flake, quota)
  // is caught before ops moves on to the rule deploy.
  if (APPLY) {
    const verify = await db
      .collection('chat_threads')
      .where('isGroup', '==', true)
      .get();
    const remaining = verify.docs.filter((d) => {
      const t = (d.data() as any)?.teamId;
      return typeof t === 'string' && t !== '';
    });
    if (remaining.length > 0) {
      console.error(`\nWARN: ${remaining.length} group thread(s) still carry teamId. Re-run --apply.`);
      process.exit(2);
    }
    console.log('Verify: 0 stragglers. Safe to deploy firestore rules.');
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
