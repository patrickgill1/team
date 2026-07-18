import type { Product, PricingTier, Coupon } from '../types';

function toMs(d: any): number | null {
  if (!d) return null;
  if (d instanceof Date) return d.getTime();
  if (typeof d?.toDate === 'function') return d.toDate().getTime();
  if (typeof d === 'number') return d;
  if (typeof d === 'string') {
    const n = Date.parse(d);
    return isNaN(n) ? null : n;
  }
  if (typeof d?.seconds === 'number') return d.seconds * 1000;
  return null;
}

export function selectActivePricingTier(
  product: Pick<Product, 'pricingTiers'>,
  now: Date = new Date()
): PricingTier | null {
  const tiers = product.pricingTiers || [];
  if (tiers.length === 0) return null;
  const t = now.getTime();
  for (const tier of tiers) {
    const start = toMs(tier.startsAt);
    const end = toMs(tier.endsAt);
    const startsOk = start == null || t >= start;
    const endsOk = end == null || t <= end;
    if (startsOk && endsOk) {
      const isDated = start != null || end != null;
      if (isDated) return tier;
    }
  }
  const def = tiers.find((tier) => tier.isDefault);
  if (def) return def;
  return tiers[0];
}

export type ApplyCouponResult =
  | { ok: true; coupon: Coupon; discountCents: number }
  | { ok: false; reason: 'not_found' | 'inactive' | 'expired' | 'maxed_out' | 'no_discount' };

export function applyCoupon(
  product: Pick<Product, 'coupons'>,
  code: string,
  baseCents: number,
  now: Date = new Date()
): ApplyCouponResult {
  const normalized = (code || '').trim().toUpperCase();
  if (!normalized) return { ok: false, reason: 'not_found' };
  const coupons = product.coupons || [];
  const coupon = coupons.find((c) => (c.code || '').trim().toUpperCase() === normalized);
  if (!coupon) return { ok: false, reason: 'not_found' };
  if (coupon.isActive === false) return { ok: false, reason: 'inactive' };
  const exp = toMs(coupon.expiresAt);
  if (exp != null && now.getTime() > exp) return { ok: false, reason: 'expired' };
  if (
    coupon.maxUses != null &&
    coupon.maxUses > 0 &&
    (coupon.usesCount ?? 0) >= coupon.maxUses
  ) {
    return { ok: false, reason: 'maxed_out' };
  }
  let discountCents = 0;
  if (coupon.discountCents && coupon.discountCents > 0) {
    discountCents = Math.min(coupon.discountCents, baseCents);
  } else if (coupon.discountPercent && coupon.discountPercent > 0) {
    const pct = Math.min(100, Math.max(0, coupon.discountPercent));
    discountCents = Math.round((baseCents * pct) / 100);
  }
  if (discountCents <= 0) return { ok: false, reason: 'no_discount' };
  return { ok: true, coupon, discountCents };
}

export interface PriceQuote {
  tier: PricingTier | null;
  baseCents: number;
  discountCents: number;
  surchargeCents: number;
  totalCents: number;
  couponCode?: string;
}

export function quotePrice(
  product: Pick<Product, 'pricingTiers' | 'coupons' | 'stripeSurchargeBps'>,
  opts: { couponCode?: string; now?: Date } = {}
): PriceQuote {
  const now = opts.now || new Date();
  const tier = selectActivePricingTier(product, now);
  const baseCents = tier?.priceCents ?? 0;
  let discountCents = 0;
  let couponCode: string | undefined;
  if (opts.couponCode) {
    const res = applyCoupon(product, opts.couponCode, baseCents, now);
    if (res.ok) {
      discountCents = res.discountCents;
      couponCode = res.coupon.code;
    }
  }
  const afterDiscount = Math.max(0, baseCents - discountCents);
  const bps = product.stripeSurchargeBps ?? 0;
  const surchargeCents = bps > 0 ? Math.round((afterDiscount * bps) / 10000) : 0;
  return {
    tier,
    baseCents,
    discountCents,
    surchargeCents,
    totalCents: afterDiscount + surchargeCents,
    couponCode,
  };
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ─── Drop-in fee gross-up ────────────────────────────────────────
//
// Single source of truth for the "player covers fees" math on
// per-event drop-in Checkout. Duplicated in worker/src/pricing.ts
// because the worker can't import from src/ (separate tsconfig).
// Keep the two copies in lockstep.
//
// Fee stack (integer cents throughout):
//   Stripe    = charged * STRIPE_PCT + STRIPE_FIXED_CENTS
//   Platform  = charged * platformBps / 10000
//   Coach net = charged - Stripe - Platform
//
// When event.feeCoveredBy === 'player': worker charges the customer
//   grossUpCents(feeCents) so the coach nets exactly feeCents.
// When event.feeCoveredBy === 'coach': worker charges feeCents as-is
//   and the coach's deposit nets coachNetCents(feeCents).

export const DROPIN_STRIPE_PCT = 0.029;
export const DROPIN_STRIPE_FIXED_CENTS = 30;
/** Fallback platform fee when platform_settings/defaults is missing.
 *  Patrick 2026-07-18: set to 100 bps (1% above Stripe passthrough).
 *  Raise via platform_settings/defaults (admin-only doc), never in
 *  coach UI. Baseline was 500. Pricing philosophy: "we're not
 *  squeezing coaches." Take is intentionally thin. */
export const DROPIN_DEFAULT_PLATFORM_BPS = 100;

/**
 * Total to charge the customer so the coach nets `feeCents` after
 * Stripe + platform fees. Rounded UP so cent-level rounding never
 * leaves the coach a cent short.
 *
 * platformBps is the platform take in basis points. Read from
 * platform_settings/defaults.platformFeeBps in the worker; the
 * default here is only used for client-side "what will the player
 * see?" previews. Never expose this parameter in coach UI.
 *
 * Enforce a UI minimum of feeCents >= 100 when the player is
 * covering: below that the ratio gets ugly (a $0.50 fee grosses to
 * roughly $0.87) and players notice.
 */
export function grossUpCents(feeCents: number, platformBps: number = DROPIN_DEFAULT_PLATFORM_BPS): number {
  if (!Number.isFinite(feeCents) || feeCents <= 0) return 0;
  const platformPct = platformBps / 10000;
  const denom = 1 - DROPIN_STRIPE_PCT - platformPct;
  if (denom <= 0) return feeCents; // pathological — fees ate 100%
  return Math.ceil((feeCents + DROPIN_STRIPE_FIXED_CENTS) / denom);
}

/**
 * What the coach nets on a Checkout for `chargedCents` after Stripe
 * + platform fees. Used for coach-facing display only ("You net
 * $Y.YY per player"). Do not use for sizing Stripe's
 * application_fee_amount — the worker computes that off chargedCents
 * directly so both sides land on the same rounded value.
 */
export function coachNetCents(chargedCents: number, platformBps: number = DROPIN_DEFAULT_PLATFORM_BPS): number {
  if (!Number.isFinite(chargedCents) || chargedCents <= 0) return 0;
  const stripeFee = Math.ceil(chargedCents * DROPIN_STRIPE_PCT) + DROPIN_STRIPE_FIXED_CENTS;
  const platformFee = Math.ceil((chargedCents * platformBps) / 10000);
  return Math.max(0, chargedCents - stripeFee - platformFee);
}
