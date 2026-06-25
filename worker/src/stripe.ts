/**
 * Stripe Connect glue for the Fire FC worker.
 *
 * Flow (Standard Connect):
 *   1. Club admin clicks "Connect Stripe" → UI hits GET /stripe/connect/start?clubId=X
 *      → worker returns Stripe's hosted OAuth URL.
 *   2. After approval, Stripe redirects to APP_ORIGIN/club?stripe_code=...&state=clubId
 *      → UI posts the code to /stripe/connect/finish.
 *      → worker exchanges code for an access token, writes club doc.
 *   3. Parent submits /register → UI hits POST /stripe/registration-checkout
 *      → worker creates Checkout Session on the connected account.
 *      → returns hosted URL, UI redirects parent.
 *   4. Stripe fires checkout.session.completed → POST /stripe/webhook
 *      → worker verifies signature, marks Registration paid, logs activity.
 *
 * Auth: connect/start, connect/finish, registration-checkout use the
 * standard NOTIFY_SECRET bearer. /stripe/webhook is anonymous —
 * authenticated by Stripe's signature header instead.
 */

import { ServiceAccount, parseServiceAccount } from './fcm';
import { getDocument, patchDocument, createDocument, runQuery } from './firestore';

export interface StripeEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_CONNECT_CLIENT_ID?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  APP_ORIGIN: string;
  FCM_SERVICE_ACCOUNT?: string;
  FIREBASE_PROJECT_ID?: string;
  // ── Coach subscription pricing ────────────────────────────────
  // Stripe price IDs for the GoalKickr Coach plans. Set per
  // environment in Cloudflare. Worker validates an inbound priceId
  // against this allowlist so a tampered client can't checkout a
  // random price. Tier is derived from the matched env var so the
  // Firestore subscription doc carries the canonical tier string.
  STRIPE_PRICE_COACH_ANNUAL?: string;
  STRIPE_PRICE_COACH_MONTHLY?: string;
  STRIPE_PRICE_FOUNDER?: string;
  // Club $299/yr — waived for clubs processing >= $15K/yr through
  // GoalKickr. The waiver is reconciled at renewal (manual today),
  // so the upfront charge stays in place as the guardrail.
  STRIPE_PRICE_CLUB_ANNUAL?: string;
  // Club Pro $499/yr — integrations + advanced reporting.
  STRIPE_PRICE_CLUB_PRO_ANNUAL?: string;
  // Number of Founder seats available before the tier closes.
  // String because Cloudflare env vars are always strings.
  // Defaults to 50.
  FOUNDER_CAPACITY?: string;
  // Resend (transactional email) — used to send the welcome /
  // trial-started email when a subscription.created webhook fires.
  // If unset, the email step is skipped silently (worker still
  // upserts the Firestore subscription doc; only the email is lost).
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
  FROM_NAME?: string;
}

function projectIdFromEnv(env: StripeEnv): string | null {
  if (env.FIREBASE_PROJECT_ID) return env.FIREBASE_PROJECT_ID;
  const sa = getServiceAccount(env);
  return sa?.project_id || null;
}

// Use the same parser as fcm.ts — handles BOTH raw JSON and base64
// encoded JSON (the recommended secret format). Original naive
// JSON.parse silently failed on base64-encoded secrets and surfaced
// as a 503 'firestore-not-configured' even though the secret was set.
function getServiceAccount(env: StripeEnv): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try { return parseServiceAccount(env.FCM_SERVICE_ACCOUNT); } catch { return null; }
}

// Form-encoded POST body builder — Stripe's API speaks application/x-www-form-urlencoded.
function form(obj: Record<string, any>): string {
  const out: string[] = [];
  const push = (k: string, v: any) => out.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  const walk = (prefix: string, v: any) => {
    if (v == null) return;
    if (Array.isArray(v)) v.forEach((vv, i) => walk(`${prefix}[${i}]`, vv));
    else if (typeof v === 'object') for (const k in v) walk(`${prefix}[${k}]`, v[k]);
    else push(prefix, v);
  };
  for (const k in obj) {
    const v = obj[k];
    if (v == null) continue;
    if (Array.isArray(v) || typeof v === 'object') walk(k, v);
    else push(k, v);
  }
  return out.join('&');
}

async function stripeRequest(env: StripeEnv, path: string, body: Record<string, any>, opts: { stripeAccount?: string } = {}): Promise<any> {
  if (!env.STRIPE_SECRET_KEY) throw new Error('stripe-not-configured');
  const isOAuth = path.startsWith('/oauth/');
  // OAuth endpoints live at connect.stripe.com (no /v1 prefix) and
  // use HTTP Basic auth with the secret key as username (empty
  // password). Bearer works on /oauth/token for legacy compat but
  // /oauth/deauthorize 401s on bearer — basic is the documented
  // pattern for both, so use it for everything OAuth.
  // Other API endpoints take Bearer auth as usual.
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    'authorization': isOAuth
      ? `Basic ${btoa(`${env.STRIPE_SECRET_KEY}:`)}`
      : `Bearer ${env.STRIPE_SECRET_KEY}`,
  };
  if (opts.stripeAccount) headers['Stripe-Account'] = opts.stripeAccount;
  const url = isOAuth
    ? `https://connect.stripe.com${path}`
    : `https://api.stripe.com/v1${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: form(body),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || data?.error_description || `stripe ${r.status}`;
    throw new Error(msg);
  }
  return data;
}

// ── Endpoint: GET /stripe/connect/start?clubId=... ────────────────

export function handleConnectStart(url: URL, env: StripeEnv): Response {
  if (!env.STRIPE_CONNECT_CLIENT_ID) {
    return json({ ok: false, error: 'stripe-connect-not-configured' }, 503);
  }
  const clubId = url.searchParams.get('clubId');
  if (!clubId) return json({ ok: false, error: 'missing-clubId' }, 400);
  // Stripe requires the redirect_uri to EXACTLY match one of the URIs
  // registered in the Connect platform settings. We register the
  // static base URL (no state in the URI itself) and rely on Stripe
  // to append `&state=<clubId>&code=<auth>` automatically via the
  // OAuth state parameter on the return trip. That way ONE registered
  // URI works for every club instead of needing one per club.
  const redirect = `${env.APP_ORIGIN}/club?stripe_connected=1`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.STRIPE_CONNECT_CLIENT_ID,
    scope: 'read_write',
    redirect_uri: redirect,
    state: clubId,
    'stripe_user[business_type]': 'company',
  });
  const oauthUrl = `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
  return json({ ok: true, url: oauthUrl });
}

// ── Endpoint: POST /stripe/connect/finish ─────────────────────────

export async function handleConnectFinish(payload: any, env: StripeEnv): Promise<Response> {
  const code = String(payload?.code || '').trim();
  const clubId = String(payload?.clubId || '').trim();
  if (!code || !clubId) return json({ ok: false, error: 'missing-code-or-clubId' }, 400);
  const projectId = projectIdFromEnv(env);
  const sa = getServiceAccount(env);
  if (!projectId || !sa) return json({ ok: false, error: 'firestore-not-configured' }, 503);

  try {
    const tokenRes = await stripeRequest(env, '/oauth/token', {
      grant_type: 'authorization_code',
      code,
    });
    const stripeUserId = tokenRes.stripe_user_id;
    if (!stripeUserId) return json({ ok: false, error: 'no-stripe-user-id' }, 502);

    const acct = await stripeRequest(env, `/accounts/${stripeUserId}`, {} as any).catch(() => null as any);
    // Retrieving an account uses GET, not POST — re-do it properly.
    const r = await fetch(`https://api.stripe.com/v1/accounts/${stripeUserId}`, {
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const acctData: any = await r.json().catch(() => ({}));
    void acct;

    await patchDocument(projectId, `clubs/${clubId}`, {
      stripeAccountId: stripeUserId,
      stripeChargesEnabled: !!acctData?.charges_enabled,
      stripePayoutsEnabled: !!acctData?.payouts_enabled,
      stripeOnboardedAt: new Date(),
    }, sa);

    return json({ ok: true, stripeAccountId: stripeUserId, chargesEnabled: !!acctData?.charges_enabled });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err) }, 502);
  }
}

// ── Endpoint: POST /stripe/connect/disconnect ─────────────────────

export async function handleConnectDisconnect(payload: any, env: StripeEnv): Promise<Response> {
  const clubId = String(payload?.clubId || '').trim();
  if (!clubId) return json({ ok: false, error: 'missing-clubId' }, 400);
  if (!env.STRIPE_CONNECT_CLIENT_ID) return json({ ok: false, error: 'stripe-connect-not-configured' }, 503);
  const projectId = projectIdFromEnv(env);
  const sa = getServiceAccount(env);
  if (!projectId || !sa) return json({ ok: false, error: 'firestore-not-configured' }, 503);

  try {
    const club = await getDocument(projectId, `clubs/${clubId}`, sa);
    if (!club) return json({ ok: false, error: 'club-not-found' }, 404);
    const stripeUserId = club.data.stripeAccountId;
    if (!stripeUserId) {
      // Already disconnected on Stripe side — still clear local fields
      // to keep the doc consistent.
      await patchDocument(projectId, `clubs/${clubId}`, {
        stripeAccountId: null,
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
        stripeOnboardedAt: null,
        updatedAt: new Date(),
      }, sa);
      return json({ ok: true, alreadyDisconnected: true });
    }

    // Revoke OAuth access. Stripe accepts this even when the account
    // has already been revoked elsewhere (idempotent).
    try {
      await stripeRequest(env, '/oauth/deauthorize', {
        client_id: env.STRIPE_CONNECT_CLIENT_ID,
        stripe_user_id: stripeUserId,
      });
    } catch (err: any) {
      // If Stripe says it's already revoked, swallow and proceed to
      // clearing the local fields. Any other error bubbles up.
      const msg = String(err?.message || '');
      if (!/already|deauthorized|not.*connected/i.test(msg)) {
        return json({ ok: false, error: msg || 'stripe-deauthorize-failed' }, 502);
      }
    }

    await patchDocument(projectId, `clubs/${clubId}`, {
      stripeAccountId: null,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
      stripeOnboardedAt: null,
      updatedAt: new Date(),
    }, sa);

    return json({ ok: true, disconnectedAcctId: stripeUserId });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
}

// ── Endpoint: POST /stripe/registration-checkout ──────────────────

export async function handleRegistrationCheckout(payload: any, env: StripeEnv): Promise<Response> {
  const registrationId = String(payload?.registrationId || '').trim();
  if (!registrationId) return json({ ok: false, error: 'missing-registrationId' }, 400);
  // Optional — when set, charge only that installment's amount instead
  // of the full registration. Drives the payment-plan flow.
  const installmentId = payload?.installmentId ? String(payload.installmentId) : null;
  const projectId = projectIdFromEnv(env);
  const sa = getServiceAccount(env);
  if (!projectId || !sa) return json({ ok: false, error: 'firestore-not-configured' }, 503);

  try {
    const reg = await getDocument(projectId, `registrations/${registrationId}`, sa);
    if (!reg) return json({ ok: false, error: 'registration-not-found' }, 404);
    // For installment checkouts, status check is looser — registration
    // may have moved past pending_payment (e.g. tryout_invited) while
    // installments are still outstanding.
    if (!installmentId && reg.data.status !== 'pending_payment') {
      return json({ ok: false, error: 'registration-not-pending-payment' }, 409);
    }
    const clubId = reg.data.clubId;
    const club = await getDocument(projectId, `clubs/${clubId}`, sa);
    if (!club) return json({ ok: false, error: 'club-not-found' }, 404);
    const stripeAccountId = club.data.stripeAccountId;
    if (!stripeAccountId || !club.data.stripeChargesEnabled) {
      return json({ ok: false, error: 'club-not-stripe-ready' }, 409);
    }

    const baseCents = Number(reg.data.amountPaidCents || reg.data.registrationFeeCents || 0);
    const surchargeCents = Number(reg.data.stripeSurchargeCents || 0);
    const installments: any[] = Array.isArray(reg.data.installments) ? reg.data.installments : [];

    // Per-installment charge if installmentId is provided. Otherwise
    // charge the registration total (single-shot path).
    let chargedCents: number;
    let lineNameSuffix = '';
    let metadataInstallmentId: string | undefined;
    if (installmentId) {
      const inst = installments.find(i => i.id === installmentId);
      if (!inst) return json({ ok: false, error: 'installment-not-found' }, 404);
      if (inst.status === 'paid') return json({ ok: false, error: 'installment-already-paid' }, 409);
      if (inst.status === 'waived') return json({ ok: false, error: 'installment-waived' }, 409);
      chargedCents = Number(inst.amountCents || 0);
      lineNameSuffix = ` — ${inst.label || 'Installment'}`;
      metadataInstallmentId = installmentId;
    } else {
      const totalCents = baseCents + (surchargeCents || 0) > 0 ? baseCents + surchargeCents : baseCents;
      chargedCents = totalCents;
    }
    if (chargedCents <= 0) return json({ ok: false, error: 'zero-amount' }, 400);
    const totalCents = chargedCents;

    const productName = reg.data.productName || 'Registration';
    const tierLabel = reg.data.pricingTierLabel;
    const playerName = `${reg.data.player?.firstName || ''} ${reg.data.player?.lastName || ''}`.trim();
    const lineName = `${productName}${tierLabel ? ` — ${tierLabel}` : ''}${lineNameSuffix}${playerName ? ` (${playerName})` : ''}`;
    const parentEmail = reg.data.parents?.[0]?.email;

    const successUrl = `${env.APP_ORIGIN}/register/success?registrationId=${encodeURIComponent(registrationId)}`;
    const cancelUrl = `${env.APP_ORIGIN}/register/cancel?registrationId=${encodeURIComponent(registrationId)}`;

    // Platform fee — Fire FC's slice of every transaction. Settable
    // ONLY by the platform owner via /platform/clubs (see Club.platformFeeBps
    // doc comment + project_platform_fee memory). Defaults to 0 = no
    // platform fee, club keeps everything (minus Stripe's flat take).
    const platformFeeBps = Number(club.data.platformFeeBps || 0);
    const applicationFeeAmount = platformFeeBps > 0
      ? Math.round((totalCents * platformFeeBps) / 10000)
      : 0;

    const sessionParams: Record<string, any> = {
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': lineName,
      'line_items[0][price_data][unit_amount]': totalCents,
      'line_items[0][quantity]': 1,
      ...(parentEmail ? { customer_email: parentEmail } : {}),
      'metadata[registrationId]': registrationId,
      'metadata[clubId]': clubId,
    };
    if (applicationFeeAmount > 0) {
      sessionParams['payment_intent_data[application_fee_amount]'] = applicationFeeAmount;
      sessionParams['metadata[platformFeeCents]'] = applicationFeeAmount;
      sessionParams['metadata[platformFeeBps]'] = platformFeeBps;
    }
    if (metadataInstallmentId) {
      sessionParams['metadata[installmentId]'] = metadataInstallmentId;
    }
    const session = await stripeRequest(env, '/checkout/sessions', sessionParams, { stripeAccount: stripeAccountId });

    // Single-shot path writes the session id to the top-level field.
    // Installment path writes it inside the matching installment so
    // multiple in-flight checkouts don't clobber each other.
    if (metadataInstallmentId) {
      const next = installments.map(i => i.id === metadataInstallmentId
        ? { ...i, stripeCheckoutSessionId: session.id }
        : i);
      await patchDocument(projectId, `registrations/${registrationId}`, {
        installments: next,
        updatedAt: new Date(),
      }, sa);
    } else {
      await patchDocument(projectId, `registrations/${registrationId}`, {
        stripeCheckoutSessionId: session.id,
      }, sa);
    }

    return json({ ok: true, url: session.url });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err) }, 502);
  }
}

// ── Endpoint: POST /stripe/registration-refund ───────────────────

export async function handleRegistrationRefund(payload: any, env: StripeEnv): Promise<Response> {
  const registrationId = String(payload?.registrationId || '').trim();
  if (!registrationId) return json({ ok: false, error: 'missing-registrationId' }, 400);
  const projectId = projectIdFromEnv(env);
  const sa = getServiceAccount(env);
  if (!projectId || !sa) return json({ ok: false, error: 'firestore-not-configured' }, 503);

  // Optional partial-refund amount in cents. Omit for full refund.
  const requestedCents = payload?.amountCents != null ? Number(payload.amountCents) : null;
  const reason = String(payload?.reason || '').trim() || undefined;
  const actorUid = String(payload?.actorUid || '').trim() || undefined;
  const actorName = String(payload?.actorName || '').trim() || undefined;

  try {
    const reg = await getDocument(projectId, `registrations/${registrationId}`, sa);
    if (!reg) return json({ ok: false, error: 'registration-not-found' }, 404);
    const paymentIntentId = reg.data.stripePaymentIntentId;
    if (!paymentIntentId) return json({ ok: false, error: 'no-payment-intent' }, 409);
    const clubId = reg.data.clubId;
    const club = await getDocument(projectId, `clubs/${clubId}`, sa);
    const stripeAccountId = club?.data?.stripeAccountId;
    if (!stripeAccountId) return json({ ok: false, error: 'club-not-stripe-ready' }, 409);

    // Compute remaining refundable. Sum prior refunds and check against
    // the original charged total so we don't over-refund.
    const originalCents = Number(reg.data.amountPaidCents || reg.data.registrationFeeCents || 0)
      + Number(reg.data.stripeSurchargeCents || 0);
    const priorRefunds: any[] = Array.isArray(reg.data.refunds) ? reg.data.refunds : [];
    const alreadyRefundedCents = priorRefunds
      .filter(r => r.status !== 'failed' && r.status !== 'canceled')
      .reduce((sum, r) => sum + Number(r.amountCents || 0), 0);
    const remainingCents = Math.max(0, originalCents - alreadyRefundedCents);
    if (remainingCents <= 0) return json({ ok: false, error: 'fully-refunded' }, 409);
    const refundCents = requestedCents != null ? Math.min(requestedCents, remainingCents) : remainingCents;
    if (refundCents <= 0) return json({ ok: false, error: 'invalid-amount' }, 400);

    const stripeReason = reason && /^(duplicate|fraudulent|requested_by_customer)$/.test(reason)
      ? reason
      : 'requested_by_customer';

    const refundBody: Record<string, any> = {
      payment_intent: paymentIntentId,
      amount: refundCents,
      reason: stripeReason,
      'metadata[registrationId]': registrationId,
      'metadata[clubId]': clubId,
      ...(actorUid ? { 'metadata[actorUid]': actorUid } : {}),
      ...(actorName ? { 'metadata[actorName]': actorName } : {}),
      // Reverse the platform fee proportionally so Fire FC gives back
      // the slice it took on the refunded portion. Without this the
      // platform keeps its cut on refunded money — bad look.
      refund_application_fee: true,
    };
    const refund = await stripeRequest(env, '/refunds', refundBody, { stripeAccount: stripeAccountId });

    // Append the refund record to the Registration immediately. The
    // webhook handler will reconcile status from 'pending' → 'succeeded'
    // when Stripe confirms (most card refunds are instant).
    const entry = {
      id: refund.id,
      amountCents: refundCents,
      reason: reason || undefined,
      refundedAt: new Date(),
      refundedByUid: actorUid,
      refundedByName: actorName,
      stripeRefundId: refund.id,
      status: refund.status || 'pending',
    };
    await patchDocument(projectId, `registrations/${registrationId}`, {
      refunds: [...priorRefunds, entry],
      updatedAt: new Date(),
    }, sa);

    await createDocument(projectId, 'activities', {
      clubId,
      kind: 'registration_refunded',
      registrationId,
      actorUid: actorUid || 'system',
      actorName: actorName || 'Refund',
      payload: {
        amountCents: refundCents,
        stripeRefundId: refund.id,
        reason: reason || undefined,
        remainingCents: remainingCents - refundCents,
      },
      createdAt: new Date(),
    }, sa);

    return json({ ok: true, refundId: refund.id, amountCents: refundCents, remainingCents: remainingCents - refundCents });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err) }, 502);
  }
}

// ── Endpoint: POST /stripe/subscription-checkout ─────────────────
//
// Creates a Stripe Checkout Session in subscription mode for the
// GoalKickr Coach plans (Annual / Monthly / Founder $5). UNLIKE
// /stripe/registration-checkout this is a PLATFORM-level charge —
// no Stripe-Account header, no application fee. The money lands in
// GoalKickr's own Stripe balance.
//
// Auth: anonymous-by-design. Two callers:
//   1. Marketing site /signup (goalkickr.com) — user may not yet
//      have a Firebase account at signup time.
//   2. In-app upgrade flow (Settings → Choose plan) — user is
//      signed in. App passes uid so the webhook can stamp the doc
//      keyed by uid instead of customer email.
//
// Anti-abuse:
//   - priceId MUST match one of the env-allowlisted plans
//     (STRIPE_PRICE_COACH_ANNUAL / _MONTHLY / FOUNDER). Random
//     priceIds (e.g. someone else's) are rejected.
//   - Founder is gated on FOUNDER_CAPACITY count from Firestore;
//     returns 409 'founder-sold-out' when full.
//
// Body: { priceId, uid?, customerEmail?, successUrl, cancelUrl,
//         referralSource?, trialDays? }
export async function handleSubscriptionCheckout(payload: any, env: StripeEnv): Promise<Response> {
  const priceId = String(payload?.priceId || '').trim();
  if (!priceId) return json({ ok: false, error: 'missing-priceId' }, 400);
  const tier = tierForPriceId(priceId, env);
  if (!tier) return json({ ok: false, error: 'invalid-priceId' }, 400);

  const successUrl = String(payload?.successUrl || `${env.APP_ORIGIN}/signup/success?session_id={CHECKOUT_SESSION_ID}`);
  const cancelUrl = String(payload?.cancelUrl || `${env.APP_ORIGIN}/signup`);
  const uid = payload?.uid ? String(payload.uid) : undefined;
  const customerEmail = payload?.customerEmail ? String(payload.customerEmail) : undefined;
  const referralSource = payload?.referralSource ? String(payload.referralSource).slice(0, 64) : undefined;
  const trialDays = Number.isFinite(payload?.trialDays) ? Number(payload.trialDays) : undefined;

  // Founder cap check — done BEFORE creating the session so we don't
  // hand out an unredeemable URL when the 50th seat just got taken.
  if (tier === 'founder') {
    const projectId = projectIdFromEnv(env);
    const sa = getServiceAccount(env);
    if (projectId && sa) {
      try {
        const { taken, capacity } = await countFounderActive(projectId, sa, env);
        if (taken >= capacity) return json({ ok: false, error: 'founder-sold-out', taken, capacity }, 409);
      } catch (err) {
        // Don't hard-fail on the count — log and let the checkout
        // through. Worst case we go a seat or two over capacity.
        console.warn('founder count check failed', err);
      }
    }
  }

  try {
    const sessionParams: Record<string, any> = {
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': 1,
      // Allow promotion codes on the hosted page — handy for the
      // launch period when Patrick is dropping codes in DMs.
      allow_promotion_codes: true,
      'metadata[tier]': tier,
      'metadata[priceId]': priceId,
    };
    if (customerEmail) sessionParams['customer_email'] = customerEmail;
    if (uid) {
      sessionParams['metadata[uid]'] = uid;
      // Mirror into subscription_data so the metadata persists on
      // the Subscription object itself (not just the Checkout
      // session). Webhook handlers for customer.subscription.*
      // events read from subscription.metadata.
      sessionParams['subscription_data[metadata][uid]'] = uid;
      sessionParams['subscription_data[metadata][tier]'] = tier;
    }
    if (referralSource) {
      sessionParams['metadata[referralSource]'] = referralSource;
      sessionParams['subscription_data[metadata][referralSource]'] = referralSource;
    }
    if (trialDays && trialDays > 0 && trialDays <= 90) {
      sessionParams['subscription_data[trial_period_days]'] = trialDays;
    }
    const session = await stripeRequest(env, '/checkout/sessions', sessionParams);
    return json({ ok: true, url: session.url, sessionId: session.id });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err) }, 502);
  }
}

// Map a Stripe priceId to a canonical tier string, or null if the
// price isn't one of our allowlisted plans.
function tierForPriceId(priceId: string, env: StripeEnv): 'annual' | 'monthly' | 'founder' | 'club' | 'club-pro' | null {
  if (env.STRIPE_PRICE_COACH_ANNUAL && priceId === env.STRIPE_PRICE_COACH_ANNUAL) return 'annual';
  if (env.STRIPE_PRICE_COACH_MONTHLY && priceId === env.STRIPE_PRICE_COACH_MONTHLY) return 'monthly';
  if (env.STRIPE_PRICE_FOUNDER && priceId === env.STRIPE_PRICE_FOUNDER) return 'founder';
  if (env.STRIPE_PRICE_CLUB_ANNUAL && priceId === env.STRIPE_PRICE_CLUB_ANNUAL) return 'club';
  if (env.STRIPE_PRICE_CLUB_PRO_ANNUAL && priceId === env.STRIPE_PRICE_CLUB_PRO_ANNUAL) return 'club-pro';
  return null;
}

function founderCapacity(env: StripeEnv): number {
  const raw = Number(env.FOUNDER_CAPACITY);
  return Number.isFinite(raw) && raw > 0 ? raw : 50;
}

// Count active Founder subscriptions in Firestore. Used both by the
// pre-checkout gate (so we don't sell a 51st seat) and by the public
// /stripe/founder/count endpoint (drives the live "X of 50 left"
// counter on the marketing site).
//
// Statuses considered to "occupy a seat": active, trialing, past_due.
// runQuery() doesn't expose Firestore's IN operator, so we issue three
// EQUAL queries in parallel and count the union by document id.
async function countFounderActive(projectId: string, sa: ServiceAccount, env: StripeEnv): Promise<{ taken: number; capacity: number }> {
  const capacity = founderCapacity(env);
  const statuses = ['active', 'trialing', 'past_due'];
  const results = await Promise.all(statuses.map(s => runQuery(
    projectId,
    'subscriptions',
    [
      { field: 'tier', op: 'EQUAL', value: 'founder' },
      { field: 'status', op: 'EQUAL', value: s },
    ],
    sa,
    200,
  ).catch(() => [])));
  const ids = new Set<string>();
  for (const list of results) for (const doc of list) ids.add(doc.id);
  return { taken: ids.size, capacity };
}

// ── Endpoint: GET /stripe/founder/count ──────────────────────────
//
// Public, anonymous endpoint that powers the live "X of 50 spots
// left" counter on the marketing site /signup page. Cheap — single
// Firestore structured query, no Stripe roundtrip.
export async function handleFounderCount(env: StripeEnv): Promise<Response> {
  const projectId = projectIdFromEnv(env);
  const sa = getServiceAccount(env);
  const capacity = founderCapacity(env);
  if (!projectId || !sa) {
    // Degrade gracefully — surface capacity so the UI can render
    // "50 spots" without crashing if Firestore isn't configured.
    return json({ ok: true, taken: 0, capacity, configured: false });
  }
  try {
    const { taken } = await countFounderActive(projectId, sa, env);
    return json({ ok: true, taken, capacity, configured: true, remaining: Math.max(0, capacity - taken) });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err), capacity }, 502);
  }
}

// ── Endpoint: POST /stripe/customer-portal ──────────────────────
//
// Creates a Stripe Billing Customer Portal session so a subscribed
// user can self-serve update card / cancel / view invoices. Caller
// passes their stripeCustomerId (read from subscriptions/{uid}).
export async function handleCustomerPortal(payload: any, env: StripeEnv): Promise<Response> {
  const customerId = String(payload?.customerId || '').trim();
  if (!customerId) return json({ ok: false, error: 'missing-customerId' }, 400);
  const returnUrl = String(payload?.returnUrl || `${env.APP_ORIGIN}/settings`);
  try {
    const session = await stripeRequest(env, '/billing_portal/sessions', {
      customer: customerId,
      return_url: returnUrl,
    });
    return json({ ok: true, url: session.url });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err) }, 502);
  }
}

// ── Endpoint: POST /stripe/webhook ───────────────────────────────

async function verifyStripeSignature(rawBody: string, sigHeader: string, secret: string): Promise<boolean> {
  if (!sigHeader || !secret) return false;
  const parts = sigHeader.split(',').reduce<Record<string, string>>((acc, p) => {
    const [k, v] = p.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  const ts = parts.t;
  const v1 = parts.v1;
  if (!ts || !v1) return false;
  const signed = `${ts}.${rawBody}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  // Constant-time compare.
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

export async function handleWebhook(rawBody: string, sigHeader: string, env: StripeEnv): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ ok: false, error: 'webhook-not-configured' }, 503);
  const ok = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return json({ ok: false, error: 'invalid-signature' }, 401);

  const projectId = projectIdFromEnv(env);
  const sa = getServiceAccount(env);
  if (!projectId || !sa) return json({ ok: false, error: 'firestore-not-configured' }, 503);

  let event: any;
  try { event = JSON.parse(rawBody); } catch { return json({ ok: false, error: 'invalid-json' }, 400); }

  // Refund reconciliation. We optimistically write a refund entry as
  // 'pending' when the worker fires off the refund; Stripe sends back
  // 'refund.updated' / 'charge.refunded' once it confirms. We match by
  // stripeRefundId and update the status in place.
  if (event.type === 'refund.updated' || event.type === 'charge.refunded') {
    try {
      // Either the event payload IS a refund (refund.updated) or it's
      // a charge with refunds[] (charge.refunded).
      const refunds: any[] = event.type === 'refund.updated'
        ? [event.data.object]
        : (event.data.object?.refunds?.data || []);
      for (const r of refunds) {
        const registrationId = r?.metadata?.registrationId;
        if (!registrationId) continue;
        const reg = await getDocument(projectId, `registrations/${registrationId}`, sa);
        if (!reg) continue;
        const list: any[] = Array.isArray(reg.data.refunds) ? reg.data.refunds : [];
        const next = list.map(x => x.stripeRefundId === r.id
          ? { ...x, status: r.status || x.status, amountCents: r.amount ?? x.amountCents }
          : x);
        // If the refund wasn't in the list yet (rare race), add it.
        if (!list.find(x => x.stripeRefundId === r.id)) {
          next.push({
            id: r.id,
            stripeRefundId: r.id,
            amountCents: r.amount,
            status: r.status,
            refundedAt: r.created ? new Date(r.created * 1000) : new Date(),
            reason: r.reason,
          });
        }
        await patchDocument(projectId, `registrations/${registrationId}`, {
          refunds: next,
          updatedAt: new Date(),
        }, sa);
      }
    } catch (err) {
      console.warn('refund webhook reconciliation failed', err);
    }
  }

  // ── Subscription lifecycle ─────────────────────────────────────
  // Stamps subscriptions/{uid} (or subscriptions/cus_{customerId} if
  // no uid was passed) with the current tier + status + period end
  // every time Stripe sends us a state change. The webhook is the
  // single source of truth — the app reads from Firestore, never
  // from Stripe directly.
  if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    try {
      const sub = event.data.object;
      await upsertSubscriptionDoc(projectId, sa, sub, env);
      // Welcome email on the very first subscription.created event.
      // Dedupes via subscriptions/{docId}.welcomeEmailSentAt — set
      // after we successfully send. Stripe retries that hit the same
      // event after success will see the timestamp and skip.
      if (event.type === 'customer.subscription.created' && projectId && sa) {
        try { await maybeSendWelcomeEmail(env, projectId, sa, sub); }
        catch (err) { console.warn('welcome email failed', err); }
      }
    } catch (err) {
      console.warn('subscription webhook failed', err);
      // Stripe retries on non-2xx for 72h. We log and return 200 so
      // a Firestore blip doesn't trigger an indefinite retry loop —
      // the next subscription event will heal the doc anyway.
    }
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const registrationId = session?.metadata?.registrationId;
    const clubId = session?.metadata?.clubId;
    const installmentId = session?.metadata?.installmentId;

    // Subscription Checkout completed — fast-path the doc creation
    // so the marketing-site /signup/success page can read the
    // subscriptions doc immediately. Without this we'd wait on the
    // separate customer.subscription.created event, which sometimes
    // arrives out-of-order behind checkout.session.completed.
    if (session?.mode === 'subscription' && session?.subscription) {
      try {
        const subId = String(session.subscription);
        // Expand the subscription so we can capture period dates +
        // price details in one webhook handler.
        const sub = await stripeRequest(env, `/subscriptions/${subId}?expand[]=items.data.price`, {} as any).catch(() => null);
        if (sub) {
          // Carry checkout session metadata onto the subscription so
          // upsertSubscriptionDoc has the uid/tier even when the
          // Subscription itself wasn't tagged (rare, but happens when
          // the upstream Checkout was created from Stripe Dashboard
          // not our worker).
          sub.metadata = {
            ...(sub.metadata || {}),
            uid: sub.metadata?.uid || session?.metadata?.uid,
            tier: sub.metadata?.tier || session?.metadata?.tier,
            referralSource: sub.metadata?.referralSource || session?.metadata?.referralSource,
            checkoutSessionId: session.id,
            customerEmail: session?.customer_details?.email || session?.customer_email || null,
          };
          await upsertSubscriptionDoc(projectId, sa, sub, env);
        }
      } catch (err) {
        console.warn('subscription checkout.session.completed handler failed', err);
      }
    }

    if (registrationId && clubId) {
      try {
        if (installmentId) {
          // Installment path — mark THIS installment paid; only flip
          // the Registration to 'paid' once every installment is
          // paid or waived.
          const reg = await getDocument(projectId, `registrations/${registrationId}`, sa);
          const installments: any[] = Array.isArray(reg?.data?.installments) ? reg!.data.installments : [];
          const nextInstallments = installments.map(i => i.id === installmentId
            ? { ...i, status: 'paid', paidAt: new Date(), stripePaymentIntentId: session.payment_intent || null }
            : i);
          const allDone = nextInstallments.every(i => i.status === 'paid' || i.status === 'waived');
          const patch: Record<string, any> = {
            installments: nextInstallments,
            updatedAt: new Date(),
          };
          if (allDone) {
            patch.status = 'paid';
            patch.paidAt = new Date();
          }
          await patchDocument(projectId, `registrations/${registrationId}`, patch, sa);
          await createDocument(projectId, 'activities', {
            clubId,
            kind: 'installment_paid',
            registrationId,
            actorUid: 'system',
            actorName: 'Stripe webhook',
            payload: {
              installmentId,
              amountTotalCents: session.amount_total,
              sessionId: session.id,
              remainingInstallments: nextInstallments.filter(i => i.status === 'pending').length,
            },
            createdAt: new Date(),
          }, sa);
          if (allDone) {
            await createDocument(projectId, 'activities', {
              clubId,
              kind: 'registration_paid',
              registrationId,
              actorUid: 'system',
              actorName: 'Stripe webhook',
              payload: {
                via: 'installments',
                installmentCount: nextInstallments.length,
              },
              createdAt: new Date(),
            }, sa);
          }
        } else {
          // Single-shot path — original behavior, mark the whole
          // registration paid.
          await patchDocument(projectId, `registrations/${registrationId}`, {
            status: 'paid',
            stripePaymentIntentId: session.payment_intent || null,
            paidAt: new Date(),
          }, sa);
          await createDocument(projectId, 'activities', {
            clubId,
            kind: 'registration_paid',
            registrationId,
            actorUid: 'system',
            actorName: 'Stripe webhook',
            payload: {
              amountTotalCents: session.amount_total,
              sessionId: session.id,
            },
            createdAt: new Date(),
          }, sa);
        }

        // Funnel stage 6 — auto-stamp club_dues on the linked player
        // doc the moment the registration is fully paid (either path).
        // Only fires when status flipped to 'paid' on this webhook —
        // partial installment payments leave the circle empty until
        // the last one clears.
        //
        // patchDocument doesn't natively support dotted-path updates
        // (the REST API needs nested map structure in the body, and
        // our encoder doesn't split keys on '.'), so we read-merge-
        // write the whole funnelProgress map. Race window with other
        // stages is microscopic — club_dues only fires from this one
        // webhook and never sooner than offer_accept, which writes
        // from the parent's browser.
        try {
          const reg = await getDocument(projectId, `registrations/${registrationId}`, sa);
          const linkedPlayerId = reg?.data?.promotedToPlayerId || reg?.data?.playerId;
          const fullyPaid = reg?.data?.status === 'paid';
          if (linkedPlayerId && fullyPaid) {
            const playerDoc = await getDocument(projectId, `players/${linkedPlayerId}`, sa);
            const currentFunnel = (playerDoc?.data?.funnelProgress || {}) as Record<string, any>;
            const nextFunnel = {
              ...currentFunnel,
              club_dues: {
                completedAt: new Date(),
                by: 'system',
                meta: {
                  registrationId,
                  stripeSessionId: session.id,
                  amountTotalCents: session.amount_total,
                },
              },
            };
            await patchDocument(projectId, `players/${linkedPlayerId}`, {
              funnelProgress: nextFunnel,
            }, sa);
          }
        } catch (err) {
          // Non-fatal — payment is already recorded. Coach can mark the
          // dues stage manually from PersonAdmin if this misfires.
          console.warn('funnel.club_dues write failed', err);
        }

        // Coupon counter bump. The intent + max-uses ceiling were
        // validated at submit time; this is just bookkeeping so the
        // next redemption sees the right usesCount. Reading + writing
        // the whole coupons array because Firestore doesn't support
        // partial array element updates.
        try {
          const reg = await getDocument(projectId, `registrations/${registrationId}`, sa);
          const productId = reg?.data?.productId;
          const couponCode = (reg?.data?.couponCode || '').toUpperCase();
          if (productId && couponCode) {
            const product = await getDocument(projectId, `products/${productId}`, sa);
            const coupons: any[] = Array.isArray(product?.data?.coupons) ? product!.data.coupons : [];
            let touched = false;
            const next = coupons.map(c => {
              if ((c?.code || '').toUpperCase() === couponCode) {
                touched = true;
                return { ...c, usesCount: (Number(c.usesCount) || 0) + 1 };
              }
              return c;
            });
            if (touched) {
              await patchDocument(projectId, `products/${productId}`, { coupons: next }, sa);
            }
          }
        } catch (err) {
          // Bookkeeping miss — don't fail the webhook, the registration
          // is already marked paid. Log and move on.
          console.warn('coupon counter bump failed', err);
        }
      } catch (err: any) {
        return json({ ok: false, error: `update-failed: ${err?.message || err}` }, 500);
      }
    }
  }

  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// ── Subscription doc upsert ────────────────────────────────────
//
// Single source-of-truth writer for subscriptions/{uid}. Called from
// the webhook on customer.subscription.* AND from the post-Checkout
// fast path. Keyed by metadata.uid when present, otherwise by
// `cus_<customerId>` so users who signed up via marketing site before
// account creation still get a doc we can later relink.
async function upsertSubscriptionDoc(
  projectId: string | null,
  sa: ServiceAccount | null,
  sub: any,
  env: StripeEnv,
): Promise<void> {
  if (!projectId || !sa) return;
  if (!sub) return;
  const subscriptionId = String(sub.id || '');
  if (!subscriptionId) return;

  // Stripe sometimes returns the price on the subscription items
  // already and sometimes not, depending on which event fired. Walk
  // both shapes defensively.
  const item = sub.items?.data?.[0] || sub.items?.[0];
  const priceObj = item?.price || sub.plan; // legacy `plan` for old events
  const priceId = String(priceObj?.id || sub.metadata?.priceId || '');
  const customerId = String(sub.customer || '');
  const uid = (sub.metadata?.uid || '').toString().trim();
  const docId = uid || (customerId ? `cus_${customerId}` : '');
  if (!docId) return;

  const tier = (sub.metadata?.tier && tierLooksValid(sub.metadata.tier))
    ? sub.metadata.tier
    : (tierForPriceId(priceId, env) || 'unknown');

  const periodEndSec = Number(sub.current_period_end || item?.current_period_end || 0);
  const startedAtSec = Number(sub.start_date || 0);
  const canceledAtSec = Number(sub.canceled_at || 0);
  const trialEndSec = Number(sub.trial_end || 0);

  const data: Record<string, any> = {
    userId: uid || null,
    customerId: customerId || null,
    customerEmail: sub.metadata?.customerEmail || null,
    subscriptionId,
    checkoutSessionId: sub.metadata?.checkoutSessionId || null,
    priceId: priceId || null,
    productId: priceObj?.product ? String(priceObj.product) : null,
    tier,
    status: String(sub.status || 'incomplete'),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    currentPeriodEnd: periodEndSec ? new Date(periodEndSec * 1000) : null,
    startedAt: startedAtSec ? new Date(startedAtSec * 1000) : null,
    canceledAt: canceledAtSec ? new Date(canceledAtSec * 1000) : null,
    trialEnd: trialEndSec ? new Date(trialEndSec * 1000) : null,
    referralSource: sub.metadata?.referralSource || null,
    updatedAt: new Date(),
  };

  // Existence check — patch if it exists, create if not. Worker has
  // no native upsert; this two-step is the cheap workaround.
  const existing = await getDocument(projectId, `subscriptions/${docId}`, sa).catch(() => null);
  if (existing) {
    await patchDocument(projectId, `subscriptions/${docId}`, data, sa);
  } else {
    await createDocument(projectId, 'subscriptions', { ...data, createdAt: new Date() }, sa, docId);
  }

  // Mirror to users/{uid} so firestore.rules can gate writes on
  // subscriptionActive in O(0) extra reads. The trial wall depends
  // on this flag — without the mirror, a coach who pays would still
  // be blocked from creating events. Only patch when we know the
  // uid (cus_xxx-keyed docs from pre-signup will mirror on relink).
  //
  // The user-doc write rule in firestore.rules explicitly forbids
  // clients from touching these fields, so this worker (service-
  // account, bypasses rules) is the only writer.
  if (uid) {
    const status = String(sub.status || 'incomplete');
    const isActive = status === 'trialing' || status === 'active';
    try {
      await patchDocument(projectId, `users/${uid}`, {
        subscriptionActive: isActive,
        subscriptionTier: tier,
        subscriptionStatus: status,
        subscriptionUpdatedAt: new Date(),
      }, sa);
    } catch (err) {
      // Non-fatal: subscriptions/{uid} is still the source of truth
      // for the in-app UI, so a failed user-doc mirror just means
      // the rule layer won't gate writes for this user until the
      // next webhook fires successfully. Surface in logs.
      console.warn('[stripe] failed to mirror sub flags to users/', uid, err);
    }
  }
}

function tierLooksValid(t: any): boolean {
  return t === 'annual' || t === 'monthly' || t === 'founder' || t === 'club' || t === 'club-pro';
}

// ── Subscription welcome / lifecycle emails ───────────────────────
//
// One transactional email per inbound Stripe webhook event we care
// about. Resend-only (matches the rest of the worker). All steps are
// best-effort: if RESEND_API_KEY is missing or the API call fails,
// the webhook still 200s — the Firestore subscription doc is the
// source of truth and the app reads from there.
//
// To prevent duplicate emails on Stripe retries, we stamp the
// outbound type on subscriptions/{docId}.emailsSent[] before sending.
// Existence check is cheap; the upsert already touched the doc.

const TIER_LABEL: Record<string, string> = {
  founder: 'Founder Rate',
  annual: 'Coach Annual',
  monthly: 'Coach Monthly',
  club: 'Club',
  'club-pro': 'Club Pro',
  unknown: 'GoalKickr',
};

async function sendSubscriptionEmail(
  env: StripeEnv,
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL || !env.FROM_NAME) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: `${env.FROM_NAME} <${env.FROM_EMAIL}>`,
        to: [to],
        subject,
        html,
      }),
    });
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}

// Brand constants mirrored from src/utils/inviteEmails.ts. Two
// separate codebases (app vs worker) means we either duplicate this
// or set up shared package; keeping it inline for now since the
// template is short.
const CRIMSON = '#DC2626';
const CHARCOAL_950 = '#0d0d10';
const CHARCOAL_900 = '#16161c';
const BONE = '#f1e9d8';
const PAGE_BG = '#f3f4f6'; // light grey behind the dark email card
// Full-wordmark logo (shield + GOALKICKR text baked into the image).
// Add this asset to goalkickr.com — same dir as logo-light.svg.
// Falls back gracefully if missing (alt text reads 'GoalKickr').
const LOGO_FULL_URL = 'https://goalkickr.com/logo-full-light.svg';
const TAGLINE = 'Every Team Deserves a Shot';
// COUNTRY-NEUTRAL App Store URL — no /us/ segment so iTunes uses
// the user's home store automatically. The /us/ form was failing
// for non-US Apple IDs with "not available in your country."
const APP_STORE_URL = 'https://apps.apple.com/app/id6770324158';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.firefc.team';
const APP_OPEN_URL = APP_STORE_URL; // sub email CTA -> straight to App Store

function escapeHtmlWorker(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function welcomeEmailHtml(opts: { tierLabel: string; trialEndDate: Date | null }): string {
  const tierLabel = escapeHtmlWorker(opts.tierLabel);
  const trialLine = opts.trialEndDate
    ? `<p style="margin:0 0 14px 0;font-size:15px;line-height:1.55;color:#c2bdb1;">Your free trial runs through <strong style="color:#ffffff;">${escapeHtmlWorker(opts.trialEndDate.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }))}</strong>. No charge until then. Cancel anytime in the app or at goalkickr.com.</p>`
    : `<p style="margin:0 0 14px 0;font-size:15px;line-height:1.55;color:#c2bdb1;">Your subscription is now active. Manage it anytime in the app under Settings.</p>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Welcome to GoalKickr</title>
  </head>
  <body style="margin:0;padding:0;background:${PAGE_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;color:${BONE};">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAGE_BG};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:${CHARCOAL_900};border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.25);">

            <!-- Brand bar — gradient runs black -> red (left -> right)
                 so the warm color climbs into the wordmark space. Full
                 logo (shield + GOALKICKR text baked in) sits left; the
                 tagline sits right on a single line aligned to the
                 logo's baseline. -->
            <tr>
              <td style="background:linear-gradient(90deg,${CHARCOAL_950} 0%,${CRIMSON} 100%);padding:22px 28px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="table-layout:fixed;">
                  <tr>
                    <td width="160" style="vertical-align:middle;width:160px;">
                      <img src="${LOGO_FULL_URL}" alt="GoalKickr" height="36" style="display:block;border:0;outline:none;text-decoration:none;height:36px;width:auto;" />
                    </td>
                    <td align="right" style="vertical-align:middle;color:#ffffff;font-size:12px;font-weight:600;letter-spacing:0.02em;line-height:1;white-space:nowrap;">
                      ${escapeHtmlWorker(TAGLINE)}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Kicker -->
            <tr>
              <td style="padding:32px 32px 4px 32px;">
                <p style="margin:0;font-size:11px;font-weight:800;letter-spacing:0.2em;text-transform:uppercase;color:${CRIMSON};">Welcome to GoalKickr</p>
              </td>
            </tr>

            <!-- Main headline -->
            <tr>
              <td style="padding:4px 32px 8px 32px;">
                <h1 style="margin:0;font-size:24px;line-height:1.2;font-weight:900;color:${BONE};">
                  You&rsquo;re in on the <span style="color:#ffffff;">${tierLabel}</span> plan.
                </h1>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:16px 32px 8px 32px;">
                ${trialLine}
                <p style="margin:0;font-size:15px;line-height:1.55;color:#c2bdb1;">
                  Open the GoalKickr app to start adding players, scheduling events, and sending messages. Everything you set up before signing up is still here.
                </p>
              </td>
            </tr>

            <!-- CTA -->
            <tr>
              <td align="center" style="padding:24px 32px 12px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" style="background:${CRIMSON};border-radius:8px;">
                      <a href="${APP_OPEN_URL}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;letter-spacing:0.01em;">
                        Open GoalKickr &rarr;
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Plain-text fallback link -->
            <tr>
              <td align="center" style="padding:0 32px 24px 32px;">
                <p style="margin:0;font-size:12px;color:#8a8275;line-height:1.55;">
                  Or paste this link into your browser:<br />
                  <a href="${APP_OPEN_URL}" target="_blank" style="color:${CRIMSON};word-break:break-all;text-decoration:underline;">${APP_OPEN_URL}</a>
                </p>
              </td>
            </tr>

            <!-- App store badges -->
            <tr>
              <td align="center" style="padding:8px 32px 20px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:0 6px;">
                      <a href="${APP_STORE_URL}" target="_blank" style="display:inline-block;font-size:11px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:${BONE};background:#1a1a22;border:1px solid #2a2a36;border-radius:6px;padding:8px 14px;text-decoration:none;">
                        App Store
                      </a>
                    </td>
                    <td style="padding:0 6px;">
                      <a href="${PLAY_STORE_URL}" target="_blank" style="display:inline-block;font-size:11px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:${BONE};background:#1a1a22;border:1px solid #2a2a36;border-radius:6px;padding:8px 14px;text-decoration:none;">
                        Google Play
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:18px 32px 24px 32px;border-top:1px solid #2a2a36;">
                <p style="margin:0;font-size:12px;color:#8a8275;line-height:1.5;">
                  Questions, billing, or to cancel: reply to this email or visit <a href="https://goalkickr.com" style="color:${CRIMSON};text-decoration:underline;">goalkickr.com</a>.
                </p>
                <p style="margin:8px 0 0 0;font-size:11px;color:#6e6757;line-height:1.45;">
                  GoalKickr &middot; Youth soccer team management built by a coach who codes.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// Idempotent welcome-email send. Reads the just-upserted subscription
// doc; if welcomeEmailSentAt isn't stamped, sends + stamps. Resolves
// the recipient address from (priority order) sub.metadata.customerEmail,
// then the Stripe customer object via API. Skips entirely without a
// usable email.
async function maybeSendWelcomeEmail(
  env: StripeEnv,
  projectId: string,
  sa: ServiceAccount,
  sub: any,
): Promise<void> {
  const subscriptionId = String(sub?.id || '');
  if (!subscriptionId) return;
  const customerId = String(sub?.customer || '');
  const uid = (sub?.metadata?.uid || '').toString().trim();
  const docId = uid || (customerId ? `cus_${customerId}` : '');
  if (!docId) return;

  const existing: any = await getDocument(projectId, `subscriptions/${docId}`, sa).catch(() => null);
  if (existing?.welcomeEmailSentAt) return;

  // Recipient resolution.
  let toEmail: string | null = (sub?.metadata?.customerEmail || '').toString().trim() || null;
  if (!toEmail && customerId) {
    try {
      const cust: any = await stripeRequest(env, `/customers/${customerId}`, {} as any).catch(() => null);
      if (cust?.email) toEmail = String(cust.email);
    } catch { /* ignore */ }
  }
  if (!toEmail || !/^\S+@\S+\.\S+$/.test(toEmail)) return;

  const item = sub.items?.data?.[0] || sub.items?.[0];
  const priceObj = item?.price || sub.plan;
  const priceId = String(priceObj?.id || sub.metadata?.priceId || '');
  const tier = (sub.metadata?.tier && tierLooksValid(sub.metadata.tier))
    ? sub.metadata.tier
    : (tierForPriceId(priceId, env) || 'unknown');
  const tierLabel = TIER_LABEL[tier] || TIER_LABEL.unknown;

  const trialEndSec = Number(sub.trial_end || 0);
  const trialEndDate = trialEndSec ? new Date(trialEndSec * 1000) : null;

  const subject = trialEndDate
    ? `Your GoalKickr trial is live`
    : `Welcome to GoalKickr (${tierLabel})`;
  const html = welcomeEmailHtml({ tierLabel, trialEndDate });
  // Text body is built but not currently passed to Resend (Resend
  // auto-derives a text alternative from HTML when omitted).
  void welcomeEmailText({ tierLabel, trialEndDate });

  const sent = await sendSubscriptionEmail(env, toEmail, subject, html);
  if (sent) {
    try {
      await patchDocument(projectId, `subscriptions/${docId}`, {
        welcomeEmailSentAt: new Date(),
        welcomeEmailTo: toEmail,
      }, sa);
    } catch { /* ignore — duplicate sends from Stripe retries are mostly harmless */ }
  }
}

function welcomeEmailText(opts: { tierLabel: string; trialEndDate: Date | null }): string {
  const trial = opts.trialEndDate
    ? `Your free trial runs through ${opts.trialEndDate.toLocaleDateString()}. No charge until then. Cancel anytime in the app or at goalkickr.com.\n\n`
    : `Your subscription is now active. Manage it anytime under Settings.\n\n`;
  return `Welcome to GoalKickr — you're in on the ${opts.tierLabel} plan.\n\n${trial}Open the GoalKickr app to start adding players, scheduling events, and sending messages.\n\nQuestions, billing, or to cancel: reply to this email or visit goalkickr.com.\n`;
}
