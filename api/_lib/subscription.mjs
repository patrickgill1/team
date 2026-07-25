// Shared paid-coach gate for Vercel serverless endpoints.
//
// Mirrors worker/src/gametape.ts checkPaidCoach() line-for-line so the
// two enforcement points can't drift. Any change here MUST be made on
// the worker side too.
//
// Env vars required (Vercel):
//   FIREBASE_PROJECT_ID   — Firebase project id
//   FIREBASE_CLIENT_EMAIL — service account email
//   FIREBASE_PRIVATE_KEY  — service account PEM key
//                           (Vercel stores it with literal \n; we
//                            convert those back to real newlines.)

import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

/** Returns a memoized Firebase Admin app initialized from Vercel env. */
export function adminApp() {
  const existing = getApps();
  if (existing.length > 0) return existing[0];
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Missing Firebase Admin env vars (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).');
  }
  return initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    projectId,
  });
}

// Keep in sync with worker/src/gametape.ts PAID_COACH_TIERS.
const PAID_COACH_TIERS = new Set(['annual', 'monthly', 'founder', 'club-pro']);

/**
 * Check whether the given uid is on a paid Coach tier.
 *
 * Returns { ok: true, reason: 'ok' } for platform admins (isClubAdmin)
 * and coaches on an active Stripe subscription whose tier is one of the
 * paid-coach set. Auto-trial coaches (subscriptionSource !== 'stripe')
 * return { ok: false, reason: 'trial' } so trial users can't burn CF
 * Stream storage.
 *
 * Non-throwing — a missing user doc falls through as 'no-sub'.
 */
export async function checkPaidCoach(uid) {
  if (!uid) return { ok: false, reason: 'no-sub' };
  const db = getFirestore(adminApp());
  const snap = await db.doc(`users/${uid}`).get().catch(() => null);
  const data = (snap && snap.exists ? snap.data() : null) || {};
  if (data.isClubAdmin === true) return { ok: true, reason: 'ok' };
  const active = data.subscriptionActive === true;
  const source = String(data.subscriptionSource || '');
  const tier = String(data.subscriptionTier || '');
  const status = String(data.subscriptionStatus || '');
  if (!active) {
    if (status === 'past_due') return { ok: false, reason: 'past-due' };
    if (status === 'canceled') return { ok: false, reason: 'canceled' };
    return { ok: false, reason: 'no-sub' };
  }
  if (source !== 'stripe') return { ok: false, reason: 'trial' };
  if (!PAID_COACH_TIERS.has(tier)) return { ok: false, reason: 'trial' };
  return { ok: true, reason: 'ok' };
}
