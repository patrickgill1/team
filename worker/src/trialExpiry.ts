/**
 * Trial expiry sweep — defense-in-depth for the auto-trial system.
 *
 * The 7-day auto-trial stamped on team-create / club-create sets
 * users/{uid}.subscriptionActive=true + subscriptionExpiresAt=now+7d.
 * firestore.rules already blocks writes when now > subscriptionExpiresAt
 * (see hasActiveSub), so an expired coach can't mutate — but the
 * subscriptionActive flag stays `true` in the doc forever until they
 * pay, and useSubscription() on the client reads that flag optimistically
 * and considers them "active". Result: an expired trialer sees a
 * paywall-free UI but every write silently fails against rules.
 *
 * This cron flips subscriptionActive → false for docs where:
 *   - subscriptionExpiresAt is in the past, AND
 *   - subscriptionSource starts with 'auto-trial-' (never touch paid
 *     Stripe subs; the webhook is source of truth for those)
 *
 * Once flipped, useSubscription() returns null and the trial-gate UI
 * surfaces the paywall correctly.
 *
 * Runs on the existing daily 10am MDT cron ("0 16 * * *") so we don't
 * spend a new Cron Triggers slot on Cloudflare's free tier.
 */

import { ServiceAccount } from './fcm';
import { patchDocument, runQuery } from './firestore';

interface ExpiryEnv {
  FCM_SERVICE_ACCOUNT?: string;
  FIREBASE_PROJECT_ID?: string;
}

export async function runTrialExpirySweep(env: ExpiryEnv): Promise<{
  ok: boolean;
  scanned: number;
  flipped: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let scanned = 0;
  let flipped = 0;

  if (!env.FCM_SERVICE_ACCOUNT) return { ok: false, scanned, flipped, errors: ['no-service-account'] };
  const { parseServiceAccount } = await import('./fcm');
  let sa: ServiceAccount;
  try {
    sa = parseServiceAccount(env.FCM_SERVICE_ACCOUNT);
  } catch {
    return { ok: false, scanned, flipped, errors: ['invalid-service-account'] };
  }
  const projectId = env.FIREBASE_PROJECT_ID || sa.project_id;
  if (!projectId) return { ok: false, scanned, flipped, errors: ['no-project-id'] };

  const now = new Date();

  // Query users where the trial has expired. Firestore's structured
  // query supports composite AND filters, so we filter both
  // subscriptionActive=true AND subscriptionExpiresAt<now server-side.
  // Cap at 500 per run — well above the realistic churn of a single
  // day for a solo-club product; if we ever hit the cap, the next
  // day's tick sweeps the rest.
  let expired: Awaited<ReturnType<typeof runQuery>> = [];
  try {
    expired = await runQuery(projectId, 'users', [
      { field: 'subscriptionActive', op: 'EQUAL', value: true },
      { field: 'subscriptionExpiresAt', op: 'LESS_THAN', value: now },
    ], sa, 500);
  } catch (err: any) {
    // Missing composite index (subscriptionActive ASC, subscriptionExpiresAt ASC)
    // is the likely first-run failure. Surface the message so the
    // Firestore console link in the error can be followed.
    errors.push(`query-failed: ${String(err?.message || err).slice(0, 200)}`);
    return { ok: false, scanned, flipped, errors };
  }

  scanned = expired.length;

  for (const u of expired) {
    const source = String(u.data?.subscriptionSource || '');
    // Never touch paid subs. Stripe webhook is the only writer for
    // those; a flip here would race with the next webhook and confuse
    // useSubscription().
    if (!source.startsWith('auto-trial-')) continue;

    try {
      await patchDocument(projectId, `users/${u.id}`, {
        subscriptionActive: false,
        subscriptionStatus: 'trial_expired',
        subscriptionUpdatedAt: now,
      }, sa);
      flipped++;
    } catch (err: any) {
      errors.push(`patch ${u.id}: ${String(err?.message || err).slice(0, 200)}`);
    }
  }

  return { ok: errors.length === 0, scanned, flipped, errors };
}
