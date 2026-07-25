#!/usr/bin/env tsx
/**
 * Sweep: find and (optionally) clean up players double-counted on a
 * payment_request because they were both (a) manually marked cash-paid
 * by the coach BEFORE the Stripe Connect webhook fix and (b) later
 * reflected via the real Stripe payment.
 *
 * Backstory: before the goalkickr-connect webhook shipped, Connected-
 * account events didn't reach the app, so paidUids / guestPaid[] never
 * advanced when a Stripe checkout completed. The coach worked around
 * this by manually toggling "mark paid" on the affected players.
 * Once the webhook fix landed, the same real payments started
 * reflecting automatically — leaving both entries in place on any
 * request where the coach had already patched around the outage.
 *
 * Rule:
 *   Stripe (paidUids ∪ guestPaid) is authoritative. If a family also
 *   shows up in paidByCoach / paidByCoachPlayerIds, the manual entry
 *   is stale and gets removed. We never touch paidUids or guestPaid.
 *
 * A player is counted as "hit" from a source when any ONE of:
 *   - stripePaidViaParent    : one of player.parentIds appears in paidUids
 *   - coachMarkedViaParent   : one of player.parentIds appears in paidByCoach
 *   - guestPaidViaParent     : a parent's user.email appears in guestPaid[].email
 *   - coachMarkedByPlayerId  : player.id appears in paidByCoachPlayerIds
 *
 * Two or more hits = double-mark. If any Stripe-side source is one of
 * them, the coach-side entries are safe to drop.
 *
 * Usage:
 *   npx tsx scripts/sweep-double-marked-payments.ts               # dry-run
 *   npx tsx scripts/sweep-double-marked-payments.ts --apply       # write
 *   npx tsx scripts/sweep-double-marked-payments.ts --pr=<id>     # scope
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const APPLY = process.argv.includes('--apply');
const PR_ONLY = (() => {
  const arg = process.argv.find(a => a.startsWith('--pr='));
  return arg ? arg.slice('--pr='.length) : null;
})();
const tag = APPLY ? 'APPLY' : 'DRY  ';

const SA_PATH = path.resolve(__dirname, 'firebase-service-account.json');
if (!fs.existsSync(SA_PATH)) {
  console.error('Service account JSON not found at', SA_PATH);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(SA_PATH) });
const db = admin.firestore();

interface PlayerLite {
  id: string;
  name: string;
  parentIds: string[];
  teamIds: string[];
}
interface UserLite {
  uid: string;
  email: string; // lower-cased, '' if missing
}

interface DoubleHit {
  paymentRequestId: string;
  paymentRequestTitle: string;
  teamId: string;
  playerId: string;
  playerName: string;
  sources: string[]; // labels of the sources that matched
  parentUidsToRemove: string[]; // uids to arrayRemove from paidByCoach
  playerIdToRemove: string | null; // pid to arrayRemove from paidByCoachPlayerIds (or null)
  recommendation: string;
}

const norm = (s: any) => String(s || '').trim().toLowerCase();

(async () => {
  console.log(`Sweep double-marked payments. tag=${tag}${PR_ONLY ? ` pr=${PR_ONLY}` : ''}`);

  // ── Preload users so parent uid -> email lookups are O(1). Small
  //    collection at current scale; a full scan is cheaper than one
  //    getDoc per parent per player per payment_request.
  const usersSnap = await db.collection('users').get();
  const usersByUid = new Map<string, UserLite>();
  for (const u of usersSnap.docs) {
    const d: any = u.data();
    usersByUid.set(u.id, { uid: u.id, email: norm(d?.email) });
  }
  console.log(`Loaded ${usersByUid.size} users.`);

  // ── Preload players once, indexed both by id and by teamId, so
  //    'all'-targeted requests can resolve their roster locally.
  const playersSnap = await db.collection('players').get();
  const playersById = new Map<string, PlayerLite>();
  const playersByTeamId = new Map<string, PlayerLite[]>();
  for (const p of playersSnap.docs) {
    const d: any = p.data();
    if (d?.isActive === false) continue; // soft-deleted rows do not owe money
    const teamIds: string[] = Array.isArray(d.teamIds) && d.teamIds.length
      ? d.teamIds
      : (d.teamId ? [d.teamId] : []);
    const lite: PlayerLite = {
      id: p.id,
      name: String(d.name || 'unnamed'),
      parentIds: Array.isArray(d.parentIds) ? d.parentIds.filter((x: any) => typeof x === 'string') : [],
      teamIds,
    };
    playersById.set(p.id, lite);
    for (const t of teamIds) {
      const arr = playersByTeamId.get(t) || [];
      arr.push(lite);
      playersByTeamId.set(t, arr);
    }
  }
  console.log(`Loaded ${playersById.size} players.`);

  // ── Walk payment_requests. Admin ignores firestore.rules; the
  //    scoping filter is defensive so archived requests (already
  //    closed out) don't spawn noise.
  const prCol = db.collection('payment_requests');
  const allDocs = PR_ONLY
    ? [await prCol.doc(PR_ONLY).get()]
    : (await prCol.get()).docs;

  const findings: DoubleHit[] = [];
  let scanned = 0;
  let skippedArchived = 0;

  for (const prDoc of allDocs) {
    if (!prDoc || !prDoc.exists) continue;
    const pr: any = prDoc.data();
    if (pr?.isActive === false) { skippedArchived++; continue; }
    if (pr?.status === 'archived') { skippedArchived++; continue; }
    scanned++;

    const stripePaidUids: Set<string> = new Set(Array.isArray(pr.paidUids) ? pr.paidUids : []);
    const coachMarkedUids: Set<string> = new Set(Array.isArray(pr.paidByCoach) ? pr.paidByCoach : []);
    const coachMarkedPlayerIds: Set<string> = new Set(Array.isArray(pr.paidByCoachPlayerIds) ? pr.paidByCoachPlayerIds : []);
    const guestPaidEmails: Set<string> = new Set(
      (Array.isArray(pr.guestPaid) ? pr.guestPaid : [])
        .map((g: any) => norm(g?.email))
        .filter((e: string) => e.length > 0),
    );

    // Nothing coach-marked = nothing to sweep, even if Stripe rows
    // exist. Skip fast.
    if (coachMarkedUids.size === 0 && coachMarkedPlayerIds.size === 0) continue;

    // Resolve the target roster. 'all' means "every active player on
    // pr.teamId at scan time" — matches the display code's join.
    const teamId: string = String(pr.teamId || '');
    let targets: PlayerLite[] = [];
    if (pr.targetPlayerIds === 'all') {
      targets = playersByTeamId.get(teamId) || [];
    } else if (Array.isArray(pr.targetPlayerIds)) {
      for (const pid of pr.targetPlayerIds) {
        const lite = playersById.get(pid);
        if (lite) targets.push(lite);
      }
    }

    for (const player of targets) {
      const parentEmails: string[] = player.parentIds
        .map(uid => usersByUid.get(uid)?.email || '')
        .filter(e => e.length > 0);

      const stripeParentHits: string[] = player.parentIds.filter(uid => stripePaidUids.has(uid));
      const coachParentHits: string[] = player.parentIds.filter(uid => coachMarkedUids.has(uid));
      const guestEmailHits: string[] = parentEmails.filter(e => guestPaidEmails.has(e));
      const playerIdHit: boolean = coachMarkedPlayerIds.has(player.id);

      const sources: string[] = [];
      if (stripeParentHits.length) sources.push(`stripe:paidUids[${stripeParentHits.join(',')}]`);
      if (coachParentHits.length)  sources.push(`coach:paidByCoach[${coachParentHits.join(',')}]`);
      if (guestEmailHits.length)   sources.push(`stripe:guestPaid[${guestEmailHits.join(',')}]`);
      if (playerIdHit)             sources.push(`coach:paidByCoachPlayerIds[${player.id}]`);

      if (sources.length < 2) continue; // single source = fine

      const stripeReflected = stripeParentHits.length > 0 || guestEmailHits.length > 0;
      const parentUidsToRemove = coachParentHits.slice();
      const playerIdToRemove = playerIdHit ? player.id : null;

      const recommendation = stripeReflected
        ? 'Remove from paidByCoach / paidByCoachPlayerIds. Stripe is authoritative.'
        : 'MANUAL REVIEW: two coach-side hits with no Stripe row. Verify one is a mis-mark.';

      findings.push({
        paymentRequestId: prDoc.id,
        paymentRequestTitle: String(pr.title || '(untitled)'),
        teamId,
        playerId: player.id,
        playerName: player.name,
        sources,
        parentUidsToRemove,
        playerIdToRemove,
        recommendation,
      });
    }
  }

  console.log(`\nScanned ${scanned} active payment_requests. Skipped ${skippedArchived} archived.`);
  console.log(`Found ${findings.length} double-marked player row(s).\n`);

  if (findings.length === 0) {
    console.log('Clean. Nothing to do.');
    process.exit(0);
  }

  // ── Group findings by paymentRequestId for a readable report.
  const byPr = new Map<string, DoubleHit[]>();
  for (const f of findings) {
    const arr = byPr.get(f.paymentRequestId) || [];
    arr.push(f);
    byPr.set(f.paymentRequestId, arr);
  }

  for (const [prId, hits] of byPr) {
    const title = hits[0].paymentRequestTitle;
    console.log(`\n[${tag}] payment_request ${prId} — "${title}"`);
    for (const h of hits) {
      console.log(`  - ${h.playerName} (${h.playerId})`);
      for (const s of h.sources) console.log(`      hit: ${s}`);
      console.log(`      -> ${h.recommendation}`);
    }
  }

  if (!APPLY) {
    console.log(`\nDRY RUN. Re-run with --apply to remove the coach-side entries.`);
    process.exit(0);
  }

  // ── APPLY. Only sweep rows where Stripe reflected the payment —
  //    the safe subset. Rows flagged MANUAL REVIEW are left in place
  //    so a human eyeballs them before either side is trusted.
  const sweepable = findings.filter(f =>
    f.recommendation.startsWith('Remove from paidByCoach'),
  );
  console.log(`\nApplying ${sweepable.length} of ${findings.length} finding(s). Skipping ${findings.length - sweepable.length} manual-review row(s).`);

  const FieldValue = admin.firestore.FieldValue;
  // Group patches per paymentRequestId so we make ONE update() per
  // doc, not one per player. arrayRemove is idempotent — re-running
  // the sweep is a no-op.
  const patchesByPr = new Map<string, { parentUids: Set<string>; playerIds: Set<string> }>();
  for (const f of sweepable) {
    const bucket = patchesByPr.get(f.paymentRequestId) || { parentUids: new Set(), playerIds: new Set() };
    for (const uid of f.parentUidsToRemove) bucket.parentUids.add(uid);
    if (f.playerIdToRemove) bucket.playerIds.add(f.playerIdToRemove);
    patchesByPr.set(f.paymentRequestId, bucket);
  }

  let updated = 0;
  for (const [prId, bucket] of patchesByPr) {
    const patch: Record<string, any> = { updatedAt: new Date() };
    if (bucket.parentUids.size > 0) {
      patch.paidByCoach = FieldValue.arrayRemove(...Array.from(bucket.parentUids));
    }
    if (bucket.playerIds.size > 0) {
      patch.paidByCoachPlayerIds = FieldValue.arrayRemove(...Array.from(bucket.playerIds));
    }
    await db.collection('payment_requests').doc(prId).update(patch);
    updated++;
    console.log(`  swept ${prId}: -${bucket.parentUids.size} parentUid(s), -${bucket.playerIds.size} playerId(s)`);
  }

  console.log(`\nDone. Updated ${updated} payment_request doc(s).`);
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
