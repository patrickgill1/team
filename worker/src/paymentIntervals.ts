/**
 * Enum <-> Stripe recurring interval mapping for team payment_requests.
 *
 * We ship a soccer-native "season" interval alongside the built-in
 * week/month/year. Stripe doesn't have a native "season" — we map it
 * to interval: 'month', interval_count: 4. Documented here so a future
 * reader knows why the Stripe Price on a season sub reads as "every
 * 4 months".
 *
 * Coach copy for each interval lives in src/pages/CoachPaymentCreate.tsx
 * (label + hint). Keep both sides in sync when new intervals ship.
 */

export type PaymentRecurringInterval = 'week' | 'month' | 'season' | 'year';

export interface StripeInterval {
  interval: 'day' | 'week' | 'month' | 'year';
  interval_count: number;
}

export function stripeInterval(kind: PaymentRecurringInterval): StripeInterval {
  switch (kind) {
    case 'week':   return { interval: 'week',  interval_count: 1 };
    case 'month':  return { interval: 'month', interval_count: 1 };
    case 'season': return { interval: 'month', interval_count: 4 };
    case 'year':   return { interval: 'year',  interval_count: 1 };
    default:       return { interval: 'month', interval_count: 1 };
  }
}

/** Human copy for a coach confirmation sheet. Warm, not techy. */
export function intervalLabel(kind: PaymentRecurringInterval): string {
  switch (kind) {
    case 'week':   return 'every week';
    case 'month':  return 'every month';
    case 'season': return 'every season (4 months)';
    case 'year':   return 'every year';
    default:       return 'every month';
  }
}
