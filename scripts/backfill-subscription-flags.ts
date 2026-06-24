#!/usr/bin/env tsx
/**
 * Backfill users/{uid}.subscriptionActive + .subscriptionTier from
 * existing subscriptions/{uid} docs.
 *
 * Why: the Phase 2 firestore.rules trial wall checks
 * userDoc.subscriptionActive on coach creates. The Cloudflare worker
 * stamps that flag on every future Stripe webhook, but EXISTING
 * subscribers (including Patrick) won't have the flag until their
 * next webhook fires — which may be a year from now (annual renewal).
 *
 * This script reads every subscriptions/{uid} doc that's keyed by
 * uid (not cus_xxx), computes active = status in {trialing, active},
 * and patches the matching user doc. Idempotent.
 *
 * Usage:
 *   npx tsx scripts/backfill-subscription-flags.ts            # dry-run
 *   npx tsx scripts/backfill-subscription-flags.ts --apply    # write
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
  const snap = await db.collection('subscriptions').get();
  console.log(`Found ${snap.size} subscription docs.`);

  let stamped = 0, skipped = 0;
  for (const docSnap of snap.docs) {
    const docId = docSnap.id;
    if (docId.startsWith('cus_')) {
      skipped++;
      continue;
    }
    const data: any = docSnap.data();
    const status = String(data?.status || 'incomplete');
    const isActive = status === 'trialing' || status === 'active';
    const tier = data?.tier || 'unknown';
    const userRef = db.collection('users').doc(docId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      console.log(`[${tag}] users/${docId} does not exist, skipping`);
      skipped++;
      continue;
    }
    const u: any = userSnap.data();
    if (u.subscriptionActive === isActive
        && u.subscriptionTier === tier
        && u.subscriptionStatus === status) {
      skipped++;
      continue;
    }
    console.log(`[${tag}] users/${docId} -> active=${isActive} tier=${tier} status=${status}`);
    if (APPLY) {
      await userRef.update({
        subscriptionActive: isActive,
        subscriptionTier: tier,
        subscriptionStatus: status,
        subscriptionUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    stamped++;
  }
  console.log(`\nDone. stamped=${stamped} skipped=${skipped}`);
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
