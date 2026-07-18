/**
 * Client-side mirror of worker/src/paymentIntervals.ts. Enum-only —
 * the mapping to Stripe intervals stays worker-side because a client
 * never talks to Stripe directly. Kept in step with the worker copy.
 */

import type { PaymentRecurringInterval } from '../types';

export function intervalLabel(kind: PaymentRecurringInterval): string {
  switch (kind) {
    case 'week':   return 'every week';
    case 'month':  return 'every month';
    case 'season': return 'every season (4 months)';
    case 'year':   return 'every year';
    default:       return 'every month';
  }
}

export function intervalShort(kind: PaymentRecurringInterval): string {
  switch (kind) {
    case 'week':   return '/wk';
    case 'month':  return '/mo';
    case 'season': return '/season';
    case 'year':   return '/yr';
    default:       return '/mo';
  }
}
