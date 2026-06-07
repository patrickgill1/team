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
