/**
 * Drop-in fee pricing math. Worker-side copy of the same helpers in
 * src/utils/pricing.ts. Kept in lockstep; both files pure integer-cent
 * math so unit tests on either side transfer without change.
 *
 * See src/utils/pricing.ts for the design rationale.
 */

export const DROPIN_STRIPE_PCT = 0.029;
export const DROPIN_STRIPE_FIXED_CENTS = 30;
export const DROPIN_DEFAULT_PLATFORM_BPS = 500;

/** Total to charge so the coach nets `feeCents` after Stripe +
 *  platform fees. See src/utils/pricing.ts for the notes on rounding
 *  and the UI minimum-fee guardrail. */
export function grossUpCents(feeCents: number, platformBps: number = DROPIN_DEFAULT_PLATFORM_BPS): number {
  if (!Number.isFinite(feeCents) || feeCents <= 0) return 0;
  const platformPct = platformBps / 10000;
  const denom = 1 - DROPIN_STRIPE_PCT - platformPct;
  if (denom <= 0) return feeCents;
  return Math.ceil((feeCents + DROPIN_STRIPE_FIXED_CENTS) / denom);
}

/** Coach net after Stripe + platform on `chargedCents`. Display-only. */
export function coachNetCents(chargedCents: number, platformBps: number = DROPIN_DEFAULT_PLATFORM_BPS): number {
  if (!Number.isFinite(chargedCents) || chargedCents <= 0) return 0;
  const stripeFee = Math.ceil(chargedCents * DROPIN_STRIPE_PCT) + DROPIN_STRIPE_FIXED_CENTS;
  const platformFee = Math.ceil((chargedCents * platformBps) / 10000);
  return Math.max(0, chargedCents - stripeFee - platformFee);
}
