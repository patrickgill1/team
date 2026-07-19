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
import { getDocument, patchDocument, createDocument, runQuery, incrementFields, commitDocumentTransforms, patchMapEntry } from './firestore';

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
  // Per-team video tiers. Free is the implicit baseline (20 clips,
  // 60s each). Add-on ($10/mo) lifts the count cap. Pro ($29.99/mo)
  // also lifts the per-clip duration cap (unlimited length, 100hr
  // total storage). Tier is matched by exact price ID equality on
  // the inbound checkout request so a tampered client can't pay
  // for the wrong plan.
  STRIPE_PRICE_VIDEO_ADDON_MONTHLY?: string;
  STRIPE_PRICE_VIDEO_PRO_MONTHLY?: string;
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

// ── Endpoint: GET /stripe/connect/start?clubId=...&returnTo=... ──

export function handleConnectStart(url: URL, env: StripeEnv): Response {
  if (!env.STRIPE_CONNECT_CLIENT_ID) {
    return json({ ok: false, error: 'stripe-connect-not-configured' }, 503);
  }
  const clubId = url.searchParams.get('clubId');
  if (!clubId) return json({ ok: false, error: 'missing-clubId' }, 400);

  // Optional returnTo. Whitelist to same-origin RELATIVE paths only —
  // must start with a single '/' and must not open with '//' or '/\'
  // (protocol-relative). Anything else is dropped silently so an
  // attacker can't smuggle an external redirect through OAuth state.
  const returnToRaw = url.searchParams.get('returnTo') || '';
  const returnToSafe = (
    returnToRaw.startsWith('/')
    && !returnToRaw.startsWith('//')
    && !returnToRaw.startsWith('/\\')
  ) ? returnToRaw.slice(0, 512) : '';

  // Stripe requires the redirect_uri to EXACTLY match one of the URIs
  // registered in the Connect platform settings. We register the
  // static base URL (no state in the URI itself) and carry per-flow
  // context (clubId + returnTo) inside the OAuth `state` param, which
  // Stripe echoes back untouched. That way ONE registered URI works
  // for every club instead of needing one per club.
  const redirect = `${env.APP_ORIGIN}/club?stripe_connected=1`;

  // Encode {clubId, returnTo} as base64url-JSON. Client decodes on
  // return to run its clubId security check and pick the destination
  // route. base64url (not standard base64) keeps the payload safe
  // through any intermediate form-decoding that would otherwise turn
  // `+` into space and break atob() on the client. JSON gives us room
  // to add fields later without another format break.
  // Backwards-compat: any in-flight OAuth session whose `state` was
  // the raw clubId string still passes the client-side check because
  // that decoder falls back to a plain string compare.
  const statePayload = returnToSafe ? { clubId, returnTo: returnToSafe } : { clubId };
  const state = btoa(JSON.stringify(statePayload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // Default business_type=individual (was 'company'). Company mode
  // forces coaches through EIN + representative + owners screens they
  // can't fill on a solo-coach setup. Individual pre-fills legal name
  // + DOB + address only — no website required. Coaches who actually
  // operate as an LLC/corp can flip this in the Stripe Dashboard after
  // onboarding. Personal shell clubs (personal_{uid}) and any club
  // flagged isDefaultSoloClub are ALWAYS individual; other clubs also
  // default to individual for now as the safer, lower-friction choice.
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.STRIPE_CONNECT_CLIENT_ID,
    scope: 'read_write',
    redirect_uri: redirect,
    state,
    'stripe_user[business_type]': 'individual',
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
    // doc comment + project_platform_fee memory).
    //
    // Fallback order: explicit value on the club doc → platform default
    // (read from platform_settings/defaults). The default is applied
    // lazily AND persisted back to the club doc so PlatformClubs reads
    // the same number going forward. "Explicit 0" beats default —
    // we only fall back when the field is genuinely absent.
    let platformFeeBps = (typeof club.data.platformFeeBps === 'number')
      ? club.data.platformFeeBps
      : null;
    if (platformFeeBps === null) {
      try {
        const defaults = await getDocument(projectId, 'platform_settings/defaults', sa).catch(() => null);
        const defaultBps = Number(defaults?.data?.platformFeeBps || 0);
        if (defaultBps > 0) {
          platformFeeBps = defaultBps;
          // Persist so the PlatformClubs page sees the same value and
          // so the next payment doesn't re-read defaults.
          await patchDocument(projectId, `clubs/${clubId}`, {
            platformFeeBps: defaultBps,
            platformFeeBpsAppliedFromDefault: true,
            updatedAt: new Date(),
          }, sa);
        } else {
          platformFeeBps = 0;
        }
      } catch (err) {
        console.warn('platform default fallback failed', err);
        platformFeeBps = 0;
      }
    }
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
    // Proportional platform-fee reversal — Stripe gives the slice back
    // to the customer via refund_application_fee, so the club's
    // platformFeeCentsCollected counter has to decrement to match.
    const originalPlatformFeeCents = Number(reg.data.platformFeeCents || 0);
    const refundedFeeCents = (originalCents > 0 && originalPlatformFeeCents > 0)
      ? Math.round((refundCents * originalPlatformFeeCents) / originalCents)
      : 0;

    await patchDocument(projectId, `registrations/${registrationId}`, {
      refunds: [...priorRefunds, entry],
      updatedAt: new Date(),
    }, sa);

    if (refundedFeeCents > 0) {
      try {
        await incrementFields(projectId, `clubs/${clubId}`, {
          platformFeeCentsCollected: -refundedFeeCents,
        }, sa);
      } catch (err) {
        console.warn('platform fee counter decrement failed', err);
      }
    }

    await createDocument(projectId, 'activities', {
      clubId,
      kind: 'registration_refunded',
      registrationId,
      actorUid: actorUid || 'system',
      actorName: actorName || 'Refund',
      payload: {
        amountCents: refundCents,
        platformFeeCentsReversed: refundedFeeCents,
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

  // Optional pre-applied coupon. Marketing site accepts ?coupon=X
  // in the URL, forwards it here, and we resolve the human-readable
  // code to a Stripe promotion_code id + attach it via discounts[]
  // so the customer never has to click "Add promotion code" on the
  // hosted checkout. Any resolution failure (bad code, deactivated,
  // expired) is non-fatal — we log and drop the pre-apply, but let
  // the checkout continue with allow_promotion_codes on so the user
  // can still enter it manually.
  const couponCode = payload?.couponCode ? String(payload.couponCode).trim().toUpperCase() : '';
  let resolvedPromotionCodeId: string | null = null;
  if (couponCode && env.STRIPE_SECRET_KEY) {
    // Stripe's /v1/promotion_codes list is a GET endpoint; the shared
    // stripeRequest helper only does POST. Inline fetch here.
    try {
      const listUrl = `https://api.stripe.com/v1/promotion_codes?code=${encodeURIComponent(couponCode)}&active=true&limit=1`;
      const listRes = await fetch(listUrl, {
        headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      const listData: any = await listRes.json().catch(() => ({}));
      const first = Array.isArray(listData?.data) ? listData.data[0] : null;
      if (first?.id) resolvedPromotionCodeId = first.id;
      else console.warn('[subscription-checkout] coupon code not found or inactive:', couponCode);
    } catch (err) {
      console.warn('[subscription-checkout] promotion_code lookup failed', err);
    }
  }

  try {
    const sessionParams: Record<string, any> = {
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': 1,
      'metadata[tier]': tier,
      'metadata[priceId]': priceId,
    };
    // allow_promotion_codes and discounts are mutually exclusive on
    // the Stripe API — if we pre-apply, drop the "Add promotion
    // code" link so the customer isn't confused seeing two ways to
    // enter one. If we didn't resolve one, keep the manual entry.
    if (resolvedPromotionCodeId) {
      sessionParams['discounts[0][promotion_code]'] = resolvedPromotionCodeId;
      sessionParams['metadata[couponCode]'] = couponCode;
      sessionParams['metadata[couponPreApplied]'] = 'true';
    } else {
      sessionParams['allow_promotion_codes'] = true;
    }
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
    return json({ ok: true, url: session.url, sessionId: session.id, couponPreApplied: !!resolvedPromotionCodeId });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err) }, 502);
  }
}

// ── Per-team video subscription checkout ────────────────────────
//
// Separate flow from the Coach / Club subscription above because the
// owning entity is a TEAM, not a user. The Checkout metadata carries
// teamId + videoTier, the webhook flips teams/{teamId}.videoTier
// when the session completes, and a video_subscriptions/{subId}
// pointer doc lets the cancel/update webhooks find the right team.
//
// Body: { priceId, teamId, uid, successUrl?, cancelUrl?, customerEmail? }
export async function handleVideoCheckout(payload: any, env: StripeEnv): Promise<Response> {
  const priceId = String(payload?.priceId || '').trim();
  if (!priceId) return json({ ok: false, error: 'missing-priceId' }, 400);
  const videoTier = videoTierForPriceId(priceId, env);
  if (!videoTier) return json({ ok: false, error: 'invalid-priceId' }, 400);

  const teamId = String(payload?.teamId || '').trim();
  if (!teamId) return json({ ok: false, error: 'missing-teamId' }, 400);
  const uid = payload?.uid ? String(payload.uid) : undefined;
  const customerEmail = payload?.customerEmail ? String(payload.customerEmail) : undefined;

  // Default success/cancel routes land back on the team's settings
  // page where the new tier badge will read live from team.videoTier.
  const successUrl = String(payload?.successUrl || `${env.APP_ORIGIN}/teams?video_upgrade=ok&team=${encodeURIComponent(teamId)}`);
  const cancelUrl = String(payload?.cancelUrl || `${env.APP_ORIGIN}/teams?video_upgrade=cancel&team=${encodeURIComponent(teamId)}`);

  try {
    const sessionParams: Record<string, any> = {
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': 1,
      allow_promotion_codes: true,
      // Top-level metadata for the Checkout session — used by
      // checkout.session.completed handler. Mirrored into
      // subscription_data so it survives on the Subscription
      // object itself for the recurring lifecycle events.
      'metadata[kind]': 'video',
      'metadata[videoTier]': videoTier,
      'metadata[teamId]': teamId,
      'metadata[priceId]': priceId,
      'subscription_data[metadata][kind]': 'video',
      'subscription_data[metadata][videoTier]': videoTier,
      'subscription_data[metadata][teamId]': teamId,
    };
    if (customerEmail) sessionParams['customer_email'] = customerEmail;
    if (uid) {
      sessionParams['metadata[uid]'] = uid;
      sessionParams['subscription_data[metadata][uid]'] = uid;
    }
    const session = await stripeRequest(env, '/checkout/sessions', sessionParams);
    return json({ ok: true, url: session.url, sessionId: session.id });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err) }, 502);
  }
}

// ────────────────────────────────────────────────────────────────
// Event drop-in fee checkout. Adult-pickup use case: coach sets
// event.feeCents on a weekly Saturday event; players tap "Pay drop-in"
// on EventDetail; worker creates a one-shot Stripe Checkout session
// against the club's connected Stripe account. Success URL bounces
// back to the event page.
//
// Body: { eventId, uid, successUrl?, cancelUrl?, customerEmail? }
// ────────────────────────────────────────────────────────────────
export async function handleEventDropInCheckout(payload: any, env: StripeEnv): Promise<Response> {
  const eventId = String(payload?.eventId || '').trim();
  const uid = String(payload?.uid || '').trim();
  if (!eventId) return json({ ok: false, error: 'missing-eventId' }, 400);
  if (!uid) return json({ ok: false, error: 'missing-uid' }, 400);

  const projectId = projectIdFromEnv(env);
  const sa = getServiceAccount(env);
  if (!projectId || !sa) return json({ ok: false, error: 'firestore-not-configured' }, 503);

  const ev = await getDocument(projectId, `events/${eventId}`, sa);
  if (!ev?.data) return json({ ok: false, error: 'event-not-found' }, 404);
  const feeCents = Number(ev.data.feeCents || 0);
  if (feeCents <= 0) return json({ ok: false, error: 'no-fee-set' }, 400);
  const teamId = String(ev.data.teamId || '');
  if (!teamId) return json({ ok: false, error: 'event-missing-team' }, 400);

  const team = await getDocument(projectId, `teams/${teamId}`, sa);
  if (!team?.data) return json({ ok: false, error: 'team-not-found' }, 404);
  const clubId = String(team.data.clubId || '');
  if (!clubId) return json({ ok: false, error: 'team-missing-club', hint: 'Team must belong to a club with Stripe Connect set up.' }, 400);

  const club = await getDocument(projectId, `clubs/${clubId}`, sa);
  if (!club?.data) return json({ ok: false, error: 'club-not-found' }, 404);
  const stripeAccountId = club.data.stripeAccountId;
  if (!stripeAccountId || !club.data.stripeChargesEnabled) {
    return json({ ok: false, error: 'club-not-stripe-ready', hint: 'Club admin must connect Stripe before drop-in fees can be collected.' }, 409);
  }

  const eventTitle = String(ev.data.title || 'Drop-in');
  const successUrl = String(payload?.successUrl || `${env.APP_ORIGIN}/event/${encodeURIComponent(eventId)}?paid=1`);
  const cancelUrl = String(payload?.cancelUrl || `${env.APP_ORIGIN}/event/${encodeURIComponent(eventId)}?paid=0`);
  const customerEmail = payload?.customerEmail ? String(payload.customerEmail) : undefined;

  // Platform fee (same fallback pattern as registration checkout).
  let platformFeeBps = (typeof club.data.platformFeeBps === 'number')
    ? club.data.platformFeeBps
    : null;
  if (platformFeeBps === null) {
    try {
      const defaults = await getDocument(projectId, 'platform_settings/defaults', sa).catch(() => null);
      const defaultBps = Number(defaults?.data?.platformFeeBps || 0);
      platformFeeBps = defaultBps > 0 ? defaultBps : 0;
    } catch {
      platformFeeBps = 0;
    }
  }

  // Who eats Stripe + platform fees. Missing = 'player' (default),
  // matching how the drop-in Checkout has historically behaved. When
  // 'player', gross the line item so the coach nets the raw
  // feeCents; when 'coach', charge feeCents as-is and the coach's
  // deposit absorbs both fee slices.
  const feeCoveredBy: 'player' | 'coach' = ev.data.feeCoveredBy === 'coach' ? 'coach' : 'player';
  const { grossUpCents } = await import('./pricing');
  const chargedCents = feeCoveredBy === 'player'
    ? grossUpCents(feeCents, platformFeeBps)
    : feeCents;

  // application_fee_amount is always computed off the actual charged
  // total (not the raw feeCents) so Stripe's own rounding lands on
  // the same integer both sides expect.
  const applicationFeeAmount = platformFeeBps > 0
    ? Math.round((chargedCents * platformFeeBps) / 10000)
    : 0;

  const sessionParams: Record<string, any> = {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': `Drop-in · ${eventTitle}`,
    'line_items[0][price_data][unit_amount]': chargedCents,
    'line_items[0][quantity]': 1,
    'metadata[kind]': 'event_dropin',
    'metadata[eventId]': eventId,
    'metadata[uid]': uid,
    'metadata[clubId]': clubId,
    'metadata[teamId]': teamId,
    'metadata[feeCoveredBy]': feeCoveredBy,
    'metadata[feeCentsRaw]': String(feeCents),
    'metadata[chargedCents]': String(chargedCents),
  };
  if (customerEmail) sessionParams['customer_email'] = customerEmail;
  if (applicationFeeAmount > 0) {
    sessionParams['payment_intent_data[application_fee_amount]'] = applicationFeeAmount;
    sessionParams['metadata[platformFeeCents]'] = applicationFeeAmount;
  }

  try {
    const session = await stripeRequest(env, '/checkout/sessions', sessionParams, { stripeAccount: stripeAccountId });
    return json({ ok: true, url: session.url, sessionId: session.id });
  } catch (err: any) {
    console.error('event-dropin-checkout error', err);
    return json({ ok: false, error: 'stripe_error', detail: String(err?.message || err).slice(0, 300) }, 502);
  }
}

// Map a Stripe priceId to one of the video-tier strings, or null
// if it's not an allowlisted video price.
function videoTierForPriceId(priceId: string, env: StripeEnv): 'addon' | 'pro' | null {
  if (env.STRIPE_PRICE_VIDEO_ADDON_MONTHLY && priceId === env.STRIPE_PRICE_VIDEO_ADDON_MONTHLY) return 'addon';
  if (env.STRIPE_PRICE_VIDEO_PRO_MONTHLY && priceId === env.STRIPE_PRICE_VIDEO_PRO_MONTHLY) return 'pro';
  return null;
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

// ── Endpoint: POST /stripe/subscription-cancel ──────────────────
//
// User-initiated cancellation for the caller's own subscription.
// Body: { uid, subscriptionId, atPeriodEnd?: boolean }
//
// Defaults to cancel_at_period_end=true so the customer keeps what
// they've already paid for through the current cycle. Passing
// atPeriodEnd=false cancels immediately (destroys the sub).
//
// Apple compliance note: user-initiated cancellation of an
// externally-purchased subscription is account-servicing under the
// App Store rules — no IAP required. This is intentionally
// paired with keeping tier changes on the Stripe hosted portal
// (proration-based upgrades read as "in-app payment" to a strict
// reviewer, so we punt those to Safari).
export async function handleSubscriptionCancel(payload: any, env: StripeEnv): Promise<Response> {
  const subscriptionId = String(payload?.subscriptionId || '').trim();
  if (!subscriptionId) return json({ ok: false, error: 'missing-subscriptionId' }, 400);
  const atPeriodEnd = payload?.atPeriodEnd !== false; // default true
  try {
    let sub: any;
    if (atPeriodEnd) {
      sub = await stripeRequest(env, `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        cancel_at_period_end: true,
      });
    } else {
      // DELETE is done via POST with _method override on some
      // clients, but Stripe supports POST /subscriptions/{id}/cancel
      // for the immediate cancel. Falling through the standard REST
      // helper (which posts) hits it correctly.
      sub = await stripeRequest(env, `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {});
    }
    return json({
      ok: true,
      id: sub.id,
      status: sub.status,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      cancelAt: sub.cancel_at || null,
      canceledAt: sub.canceled_at || null,
    });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err) }, 502);
  }
}

// ── Endpoint: POST /stripe/subscription-reactivate ──────────────
//
// Undo a cancel_at_period_end that hasn't yet cycled through. If
// the subscription is already past the cancel date (status=canceled),
// this is a no-op that returns 409 — reactivation requires a new
// checkout, not a resurrection of the Stripe object.
//
// Body: { uid, subscriptionId }
export async function handleSubscriptionReactivate(payload: any, env: StripeEnv): Promise<Response> {
  const subscriptionId = String(payload?.subscriptionId || '').trim();
  if (!subscriptionId) return json({ ok: false, error: 'missing-subscriptionId' }, 400);
  if (!env.STRIPE_SECRET_KEY) return json({ ok: false, error: 'stripe-not-configured' }, 500);
  try {
    // Fetch the sub via GET so we can check state before mutating.
    // stripeRequest is POST-only, so hit Stripe directly.
    const getRes = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const current: any = await getRes.json();
    if (!getRes.ok) {
      return json({ ok: false, error: current?.error?.message || `stripe ${getRes.status}` }, 502);
    }
    if (current.status === 'canceled') {
      return json({ ok: false, error: 'already-terminated', hint: 'Subscription already canceled. Start a new checkout to resubscribe.' }, 409);
    }
    if (!current.cancel_at_period_end) {
      return json({ ok: true, id: current.id, status: current.status, noop: true });
    }
    const sub = await stripeRequest(env, `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      cancel_at_period_end: false,
    });
    return json({
      ok: true,
      id: sub.id,
      status: sub.status,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err) }, 502);
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

// ────────────────────────────────────────────────────────────────
// Team payment_requests — Stripe flows for one-off, catalog, and
// recurring coach-created payment requests. Mirrors the event
// drop-in checkout pattern (grossed-up destination charge) with two
// additions: catalog carries a variable-length line-item list, and
// recurring creates an on-the-fly Stripe Product+Price on the
// connected account before opening a subscription-mode Checkout.
//
// All three land back on /payments (parent) or /coach/payments/:id
// (coach) so the success page never has to know which shape fired.
// ────────────────────────────────────────────────────────────────

async function resolvePaymentClub(projectId: string, sa: ServiceAccount, clubId: string): Promise<{ stripeAccountId: string; platformFeeBps: number } | null> {
  const club = await getDocument(projectId, `clubs/${clubId}`, sa).catch(() => null);
  if (!club?.data) return null;
  const stripeAccountId = String(club.data.stripeAccountId || '');
  if (!stripeAccountId || !club.data.stripeChargesEnabled) return null;
  let platformFeeBps = (typeof club.data.platformFeeBps === 'number')
    ? club.data.platformFeeBps
    : null;
  if (platformFeeBps === null) {
    try {
      const defaults = await getDocument(projectId, 'platform_settings/defaults', sa).catch(() => null);
      const defaultBps = Number(defaults?.data?.platformFeeBps || 0);
      platformFeeBps = defaultBps > 0 ? defaultBps : 0;
    } catch { platformFeeBps = 0; }
  }
  return { stripeAccountId, platformFeeBps };
}

// Shared team-name lookup so the Stripe hosted page can say "Team
// dues from Coach Patrick, Fire FC U12" instead of just the bare
// title. Fails silently to '' so a missing team doc doesn't break
// checkout. Kept small; called from every session builder.
async function resolveTeamName(projectId: string, sa: ServiceAccount, teamId: string): Promise<string> {
  if (!teamId) return '';
  try {
    const team = await getDocument(projectId, `teams/${teamId}`, sa);
    return String(team?.data?.name || '').trim();
  } catch {
    return '';
  }
}

// Build the `product_data.description` line parents see on the
// Stripe hosted checkout page. Empty string if we have nothing warm
// to say (Stripe accepts an empty description as absence). Length
// stays well under Stripe's 250-char cap.
function buildProductDescription(args: { title: string; coachName?: string; teamName?: string }): string {
  const parts: string[] = [];
  if (args.title) parts.push(args.title);
  const from: string[] = [];
  if (args.coachName) from.push(`Coach ${args.coachName}`);
  if (args.teamName) from.push(args.teamName);
  // Comma join, not em dash — Patrick's copy rule forbids em dashes in
  // user-facing text, and the Stripe hosted page is user-facing.
  if (from.length > 0) parts.push(`From ${from.join(', ')}`);
  return parts.join(' • ').slice(0, 240);
}

// POST /payments/checkout — one_off + catalog. Body:
//   { paymentRequestId, uid, items?: [{ itemId, quantity }],
//     playerIds?: string[], successUrl?, cancelUrl?, customerEmail? }
// For one_off, playerIds names the kids this parent is paying for
// (multi-child families multiply the fee). For catalog, items is the
// cart.
export async function handlePaymentCheckout(payload: any, env: StripeEnv): Promise<Response> {
  const paymentRequestId = String(payload?.paymentRequestId || '').trim();
  const uid = String(payload?.uid || '').trim();
  if (!paymentRequestId) return json({ ok: false, error: 'missing-paymentRequestId' }, 400);
  if (!uid) return json({ ok: false, error: 'missing-uid' }, 400);
  const projectId = projectIdFromEnv(env);
  const sa = getServiceAccount(env);
  if (!projectId || !sa) return json({ ok: false, error: 'firestore-not-configured' }, 503);

  const pr = await getDocument(projectId, `payment_requests/${paymentRequestId}`, sa);
  if (!pr?.data) return json({ ok: false, error: 'payment-request-not-found' }, 404);
  if (pr.data.status !== 'active' || pr.data.isActive === false) {
    return json({ ok: false, error: 'payment-request-closed' }, 409);
  }
  const kind = String(pr.data.kind || '');
  if (kind !== 'one_off' && kind !== 'catalog') {
    return json({ ok: false, error: 'wrong-kind', hint: 'Use /payments/subscription-checkout for recurring.' }, 400);
  }

  const clubInfo = await resolvePaymentClub(projectId, sa, String(pr.data.clubId || ''));
  if (!clubInfo) return json({ ok: false, error: 'club-not-stripe-ready', hint: 'Coach must connect Stripe before payments can be collected.' }, 409);
  const { stripeAccountId, platformFeeBps } = clubInfo;

  const { grossUpCents } = await import('./pricing');
  const feeCoveredBy: 'player' | 'coach' = pr.data.feeCoveredBy === 'coach' ? 'coach' : 'player';

  // Build line items.
  interface LineSpec { name: string; unitCents: number; quantity: number; }
  const lines: LineSpec[] = [];
  let metaExtras: Record<string, string> = {};

  if (kind === 'one_off') {
    const feeCents = Number(pr.data.feeCents || 0);
    if (feeCents <= 0) return json({ ok: false, error: 'no-fee-set' }, 400);
    const playerIdsRaw = Array.isArray(payload?.playerIds) ? payload.playerIds : [];
    const playerIds: string[] = playerIdsRaw.filter((s: unknown) => typeof s === 'string');
    const quantity = Math.max(1, playerIds.length);
    const perUnitCharged = feeCoveredBy === 'player' ? grossUpCents(feeCents, platformFeeBps) : feeCents;
    lines.push({
      name: `${pr.data.title || 'Team payment'}${quantity > 1 ? ` (${quantity} players)` : ''}`,
      unitCents: perUnitCharged,
      quantity,
    });
    if (playerIds.length > 0) metaExtras['playerIds'] = playerIds.slice(0, 20).join(',');
  } else {
    // catalog
    const cart = Array.isArray(payload?.items) ? payload.items : [];
    if (cart.length === 0) return json({ ok: false, error: 'empty-cart' }, 400);
    const catalog: any[] = Array.isArray(pr.data.items) ? pr.data.items : [];
    const purchases: any[] = Array.isArray(pr.data.purchases) ? pr.data.purchases : [];
    const cartMeta: Array<{ itemId: string; quantity: number }> = [];
    for (const row of cart) {
      const itemId = String(row?.itemId || '');
      const qty = Math.max(1, Math.round(Number(row?.quantity || 1)));
      const item = catalog.find(i => i.id === itemId);
      if (!item || item.isActive === false) return json({ ok: false, error: 'item-unavailable', itemId }, 409);
      // maxPerPlayer enforcement (per-uid across prior purchases)
      if (item.maxPerPlayer != null) {
        const priorForUid = purchases
          .filter(p => p?.itemId === itemId && p?.uid === uid && p?.paidVia !== 'refunded')
          .reduce((sum, p) => sum + Number(p.quantity || 0), 0);
        if (priorForUid + qty > item.maxPerPlayer) {
          return json({ ok: false, error: 'max-per-player', itemId, maxPerPlayer: item.maxPerPlayer, priorPurchased: priorForUid }, 409);
        }
      }
      const perUnitCharged = feeCoveredBy === 'player' ? grossUpCents(Number(item.priceCents), platformFeeBps) : Number(item.priceCents);
      lines.push({
        name: `${item.name}${qty > 1 ? ` x${qty}` : ''}`,
        unitCents: perUnitCharged,
        quantity: qty,
      });
      cartMeta.push({ itemId, quantity: qty });
    }
    metaExtras['cart'] = JSON.stringify(cartMeta).slice(0, 480);
  }

  const chargedTotal = lines.reduce((sum, l) => sum + l.unitCents * l.quantity, 0);
  const applicationFeeAmount = platformFeeBps > 0
    ? Math.round((chargedTotal * platformFeeBps) / 10000)
    : 0;

  const successUrl = String(payload?.successUrl || `${env.APP_ORIGIN}/payments?paid=${encodeURIComponent(paymentRequestId)}`);
  const cancelUrl = String(payload?.cancelUrl || `${env.APP_ORIGIN}/payments`);
  const customerEmail = payload?.customerEmail ? String(payload.customerEmail) : undefined;

  const teamName = await resolveTeamName(projectId, sa, String(pr.data.teamId || ''));
  const coachName = String(pr.data.createdByName || '').trim();
  const productDescription = buildProductDescription({
    title: String(pr.data.title || ''),
    coachName,
    teamName,
  });
  const sessionParams: Record<string, any> = {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    'metadata[kind]': 'payment_request',
    'metadata[paymentKind]': kind,
    'metadata[paymentRequestId]': paymentRequestId,
    'metadata[uid]': uid,
    'metadata[teamId]': String(pr.data.teamId || ''),
    'metadata[clubId]': String(pr.data.clubId || ''),
    'metadata[feeCoveredBy]': feeCoveredBy,
    'metadata[chargedCents]': String(chargedTotal),
    // Ship 1 decision #4 — warm Stripe copy so the hosted page
    // stays on-brand and parents can be reached if there's an issue.
    'custom_text[submit][message]': 'Thanks for supporting the team.',
    'phone_number_collection[enabled]': 'true',
  };
  lines.forEach((l, i) => {
    sessionParams[`line_items[${i}][price_data][currency]`] = 'usd';
    sessionParams[`line_items[${i}][price_data][product_data][name]`] = l.name;
    if (productDescription) {
      sessionParams[`line_items[${i}][price_data][product_data][description]`] = productDescription;
    }
    sessionParams[`line_items[${i}][price_data][unit_amount]`] = l.unitCents;
    sessionParams[`line_items[${i}][quantity]`] = l.quantity;
  });
  for (const [k, v] of Object.entries(metaExtras)) {
    sessionParams[`metadata[${k}]`] = v;
  }
  if (customerEmail) sessionParams['customer_email'] = customerEmail;
  if (applicationFeeAmount > 0) {
    sessionParams['payment_intent_data[application_fee_amount]'] = applicationFeeAmount;
    sessionParams['metadata[platformFeeCents]'] = String(applicationFeeAmount);
  }

  try {
    const session = await stripeRequest(env, '/checkout/sessions', sessionParams, { stripeAccount: stripeAccountId });
    return json({ ok: true, url: session.url, sessionId: session.id });
  } catch (err: any) {
    console.error('payments-checkout error', err);
    return json({ ok: false, error: 'stripe_error', detail: String(err?.message || err).slice(0, 300) }, 502);
  }
}

// POST /payments/checkout-anon — anonymous one_off checkout for the
// /pay/{requestId} shareable link (Ship 1 decision #3). Guests type
// their email + optional name, and Stripe fires a payment_intent
// carrying metadata { paymentKind: 'one_off_anon', requestId,
// guestEmail, guestName }. Webhook appends the row to guestPaid[].
// Only accepts kind: 'one_off' — recurring + catalog need accounts.
//
// Anonymous by design; no auth check upstream. Rate limiting is a
// best-effort in-memory Map keyed by ip+requestId with a 1h TTL to
// keep the surface honest without pulling in KV. If we get real
// abuse the mitigation is to require a KV binding here.
const anonAttemptWindow = 60 * 60 * 1000;
const anonAttemptCap = 5;
const anonAttempts = new Map<string, number[]>();

function anonRateLimit(ip: string, requestId: string): boolean {
  const key = `${ip}::${requestId}`;
  const now = Date.now();
  const hits = (anonAttempts.get(key) || []).filter(t => now - t < anonAttemptWindow);
  if (hits.length >= anonAttemptCap) {
    anonAttempts.set(key, hits);
    return false;
  }
  hits.push(now);
  anonAttempts.set(key, hits);
  return true;
}

// POST /payments/pay-link-info — anonymous fetch for the /pay/{id}
// share page. Returns ONLY the safe, share-friendly subset of the
// payment_request doc — the raw doc is off-limits to unauthenticated
// callers because it also holds guestPaid[] (guest emails + names),
// paidUids, stripeSubscriptionIds, and purchases[].uid, which are
// prior-payer PII no guest with a link should see. Firestore rules
// don't do field projection, so we project here in the worker and
// keep the doc auth-gated at the rules level.
export async function handlePayLinkInfo(payload: any, env: StripeEnv): Promise<Response> {
  const paymentRequestId = String(payload?.paymentRequestId || '').trim();
  if (!paymentRequestId) return json({ ok: false, error: 'missing-paymentRequestId' }, 400);
  const projectId = projectIdFromEnv(env);
  const sa = getServiceAccount(env);
  if (!projectId || !sa) return json({ ok: false, error: 'firestore-not-configured' }, 503);

  const pr = await getDocument(projectId, `payment_requests/${paymentRequestId}`, sa).catch(() => null);
  if (!pr?.data) return json({ ok: false, error: 'not-found' }, 404);
  if (pr.data.status !== 'active' || pr.data.isActive === false || pr.data.kind !== 'one_off') {
    return json({ ok: false, error: 'not-shareable' }, 409);
  }

  // Warm header line — the club name is public-ish (it's on the app
  // header and public league pages), so we fetch and project it here
  // so PayLink never has to touch Firestore itself.
  let clubName: string | undefined;
  try {
    const club = await getDocument(projectId, `clubs/${String(pr.data.clubId || '')}`, sa);
    const nm = String(club?.data?.name || '').trim();
    if (nm) clubName = nm;
  } catch { /* ignore */ }

  return json({
    ok: true,
    request: {
      id: paymentRequestId,
      title: String(pr.data.title || 'Team payment'),
      description: pr.data.description ? String(pr.data.description) : undefined,
      kind: 'one_off',
      feeCents: Number(pr.data.feeCents || 0) || undefined,
      createdByName: pr.data.createdByName ? String(pr.data.createdByName) : undefined,
      clubName,
    },
  });
}

export async function handlePaymentCheckoutAnon(payload: any, env: StripeEnv, req?: Request): Promise<Response> {
  const paymentRequestId = String(payload?.paymentRequestId || '').trim();
  if (!paymentRequestId) return json({ ok: false, error: 'missing-paymentRequestId' }, 400);
  const emailRaw = String(payload?.email || '').trim().toLowerCase();
  if (!emailRaw || !/^\S+@\S+\.\S+$/.test(emailRaw) || emailRaw.length > 200) {
    return json({ ok: false, error: 'bad-email' }, 400);
  }
  const guestName = String(payload?.name || '').trim().slice(0, 80) || undefined;

  // Best-effort rate limit — 5 attempts per hour per (ip, requestId).
  const ip = (req?.headers.get('cf-connecting-ip') || req?.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  if (!anonRateLimit(ip, paymentRequestId)) {
    return json({ ok: false, error: 'too-many-attempts', hint: 'Give it a few minutes and try again.' }, 429);
  }

  const projectId = projectIdFromEnv(env);
  const sa = getServiceAccount(env);
  if (!projectId || !sa) return json({ ok: false, error: 'firestore-not-configured' }, 503);

  const pr = await getDocument(projectId, `payment_requests/${paymentRequestId}`, sa);
  if (!pr?.data) return json({ ok: false, error: 'payment-request-not-found' }, 404);
  if (pr.data.status !== 'active' || pr.data.isActive === false) {
    return json({ ok: false, error: 'payment-request-closed' }, 409);
  }
  const kind = String(pr.data.kind || '');
  if (kind !== 'one_off') {
    return json({ ok: false, error: 'wrong-kind', hint: 'Guest links only work for one-time collections.' }, 400);
  }

  const clubInfo = await resolvePaymentClub(projectId, sa, String(pr.data.clubId || ''));
  if (!clubInfo) return json({ ok: false, error: 'club-not-stripe-ready' }, 409);
  const { stripeAccountId, platformFeeBps } = clubInfo;

  const { grossUpCents } = await import('./pricing');
  const feeCoveredBy: 'player' | 'coach' = pr.data.feeCoveredBy === 'coach' ? 'coach' : 'player';
  const feeCents = Number(pr.data.feeCents || 0);
  if (feeCents <= 0) return json({ ok: false, error: 'no-fee-set' }, 400);
  const chargedTotal = feeCoveredBy === 'player' ? grossUpCents(feeCents, platformFeeBps) : feeCents;
  const applicationFeeAmount = platformFeeBps > 0 ? Math.round((chargedTotal * platformFeeBps) / 10000) : 0;

  const successUrl = String(payload?.successUrl || `${env.APP_ORIGIN}/pay/${encodeURIComponent(paymentRequestId)}?paid=1`);
  const cancelUrl = String(payload?.cancelUrl || `${env.APP_ORIGIN}/pay/${encodeURIComponent(paymentRequestId)}`);

  const teamName = await resolveTeamName(projectId, sa, String(pr.data.teamId || ''));
  const coachName = String(pr.data.createdByName || '').trim();
  const productDescription = buildProductDescription({
    title: String(pr.data.title || ''),
    coachName,
    teamName,
  });

  const sessionParams: Record<string, any> = {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: emailRaw,
    'custom_text[submit][message]': 'Thanks for supporting the team.',
    'phone_number_collection[enabled]': 'true',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': String(pr.data.title || 'Team payment'),
    ...(productDescription ? { 'line_items[0][price_data][product_data][description]': productDescription } : {}),
    'line_items[0][price_data][unit_amount]': chargedTotal,
    'line_items[0][quantity]': 1,
    'metadata[kind]': 'payment_request',
    'metadata[paymentKind]': 'one_off_anon',
    'metadata[paymentRequestId]': paymentRequestId,
    'metadata[teamId]': String(pr.data.teamId || ''),
    'metadata[clubId]': String(pr.data.clubId || ''),
    'metadata[feeCoveredBy]': feeCoveredBy,
    'metadata[chargedCents]': String(chargedTotal),
    'metadata[guestEmail]': emailRaw,
    ...(guestName ? { 'metadata[guestName]': guestName } : {}),
    'payment_intent_data[metadata][kind]': 'payment_request',
    'payment_intent_data[metadata][paymentKind]': 'one_off_anon',
    'payment_intent_data[metadata][paymentRequestId]': paymentRequestId,
    'payment_intent_data[metadata][guestEmail]': emailRaw,
    ...(guestName ? { 'payment_intent_data[metadata][guestName]': guestName } : {}),
  };
  if (applicationFeeAmount > 0) {
    sessionParams['payment_intent_data[application_fee_amount]'] = applicationFeeAmount;
    sessionParams['metadata[platformFeeCents]'] = String(applicationFeeAmount);
  }

  try {
    const session = await stripeRequest(env, '/checkout/sessions', sessionParams, { stripeAccount: stripeAccountId });
    return json({ ok: true, url: session.url, sessionId: session.id });
  } catch (err: any) {
    console.error('payments-checkout-anon error', err);
    return json({ ok: false, error: 'stripe_error', detail: String(err?.message || err).slice(0, 300) }, 502);
  }
}

// POST /payments/subscription-checkout — recurring only. Body:
//   { paymentRequestId, uid, successUrl?, cancelUrl?, customerEmail? }
// Creates a Stripe Product+Price on the connected account (idempotent
// by paymentRequestId lookup) and opens a subscription-mode Checkout
// with transfer_data.destination and application_fee_percent.
export async function handlePaymentSubscriptionCheckout(payload: any, env: StripeEnv): Promise<Response> {
  const paymentRequestId = String(payload?.paymentRequestId || '').trim();
  const uid = String(payload?.uid || '').trim();
  if (!paymentRequestId) return json({ ok: false, error: 'missing-paymentRequestId' }, 400);
  if (!uid) return json({ ok: false, error: 'missing-uid' }, 400);
  const projectId = projectIdFromEnv(env);
  const sa = getServiceAccount(env);
  if (!projectId || !sa) return json({ ok: false, error: 'firestore-not-configured' }, 503);

  const pr = await getDocument(projectId, `payment_requests/${paymentRequestId}`, sa);
  if (!pr?.data) return json({ ok: false, error: 'payment-request-not-found' }, 404);
  if (pr.data.kind !== 'recurring') return json({ ok: false, error: 'wrong-kind' }, 400);
  if (pr.data.status !== 'active' || pr.data.isActive === false) {
    return json({ ok: false, error: 'payment-request-closed' }, 409);
  }
  // One active sub per parent uid.
  const subs: Record<string, string> = (pr.data.stripeSubscriptionIds || {}) as Record<string, string>;
  if (subs && subs[uid]) return json({ ok: false, error: 'already-subscribed', subscriptionId: subs[uid] }, 409);

  const clubInfo = await resolvePaymentClub(projectId, sa, String(pr.data.clubId || ''));
  if (!clubInfo) return json({ ok: false, error: 'club-not-stripe-ready' }, 409);
  const { stripeAccountId, platformFeeBps } = clubInfo;

  const { grossUpCents } = await import('./pricing');
  const { stripeInterval } = await import('./paymentIntervals');
  const feeCoveredBy: 'player' | 'coach' = pr.data.feeCoveredBy === 'coach' ? 'coach' : 'player';
  const intervalCents = Number(pr.data.intervalCents || 0);
  if (intervalCents <= 0) return json({ ok: false, error: 'no-interval-cents' }, 400);
  const chargedPer = feeCoveredBy === 'player' ? grossUpCents(intervalCents, platformFeeBps) : intervalCents;
  const stripeIvl = stripeInterval(pr.data.interval);

  const successUrl = String(payload?.successUrl || `${env.APP_ORIGIN}/payments?subscribed=${encodeURIComponent(paymentRequestId)}`);
  const cancelUrl = String(payload?.cancelUrl || `${env.APP_ORIGIN}/payments`);
  const customerEmail = payload?.customerEmail ? String(payload.customerEmail) : undefined;

  try {
    // Create (or reuse) a Stripe Product on the connected account. We
    // key by paymentRequestId in metadata so a re-run finds the same
    // product without needing to store the id on the request doc.
    // Stripe's `product_data` on price_data can create the product
    // inline, so we skip the explicit product create step — subscription
    // mode requires a recurring price, and price_data.recurring is
    // enough.
    const teamName = await resolveTeamName(projectId, sa, String(pr.data.teamId || ''));
    const coachName = String(pr.data.createdByName || '').trim();
    const productDescription = buildProductDescription({
      title: String(pr.data.title || ''),
      coachName,
      teamName,
    });
    const sessionParams: Record<string, any> = {
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      'custom_text[submit][message]': 'Thanks for supporting the team.',
      'phone_number_collection[enabled]': 'true',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': `${pr.data.title || 'Team dues'}`,
      ...(productDescription ? { 'line_items[0][price_data][product_data][description]': productDescription } : {}),
      'line_items[0][price_data][unit_amount]': chargedPer,
      'line_items[0][price_data][recurring][interval]': stripeIvl.interval,
      'line_items[0][price_data][recurring][interval_count]': stripeIvl.interval_count,
      'line_items[0][quantity]': 1,
      'metadata[kind]': 'payment_request',
      'metadata[paymentKind]': 'recurring',
      'metadata[paymentRequestId]': paymentRequestId,
      'metadata[uid]': uid,
      'metadata[teamId]': String(pr.data.teamId || ''),
      'metadata[clubId]': String(pr.data.clubId || ''),
      'metadata[feeCoveredBy]': feeCoveredBy,
      'metadata[chargedCents]': String(chargedPer),
      'subscription_data[metadata][kind]': 'payment_request',
      'subscription_data[metadata][paymentKind]': 'recurring',
      'subscription_data[metadata][paymentRequestId]': paymentRequestId,
      'subscription_data[metadata][uid]': uid,
      'subscription_data[metadata][teamId]': String(pr.data.teamId || ''),
      'subscription_data[metadata][clubId]': String(pr.data.clubId || ''),
      'subscription_data[metadata][feeCoveredBy]': feeCoveredBy,
    };
    if (customerEmail) sessionParams['customer_email'] = customerEmail;
    // application_fee_percent on subscriptions is a percent (not bps),
    // and accepts up to 2 decimal places. Convert bps -> percent.
    if (platformFeeBps > 0) {
      const pct = (platformFeeBps / 100).toFixed(2);
      sessionParams['subscription_data[application_fee_percent]'] = pct;
      sessionParams['metadata[platformFeeBps]'] = String(platformFeeBps);
    }

    // Direct charge on the connected account (Stripe-Account header),
    // same shape as the one_off path. The coach's connected account is
    // the merchant of record, so Stripe processing fees are debited
    // there and the platform's cut (application_fee_percent) transfers
    // back to us. The prior destination-charge shape had the platform
    // absorbing Stripe fees on every renewal, silently overpaying the
    // coach by ~3% and breaking the gross-up math parents saw.
    const session = await stripeRequest(env, '/checkout/sessions', sessionParams, { stripeAccount: stripeAccountId });
    return json({ ok: true, url: session.url, sessionId: session.id });
  } catch (err: any) {
    console.error('payment-subscription-checkout error', err);
    return json({ ok: false, error: 'stripe_error', detail: String(err?.message || err).slice(0, 300) }, 502);
  }
}

// POST /payments/subscription-cancel — parent or coach.
// Body: { paymentRequestId, uid, atPeriodEnd?: boolean }
// Defaults to cancel_at_period_end=true. Coach forcing an immediate
// cancel passes atPeriodEnd=false.
export async function handlePaymentSubscriptionCancel(payload: any, env: StripeEnv): Promise<Response> {
  const paymentRequestId = String(payload?.paymentRequestId || '').trim();
  const targetUid = String(payload?.uid || '').trim();
  if (!paymentRequestId) return json({ ok: false, error: 'missing-paymentRequestId' }, 400);
  if (!targetUid) return json({ ok: false, error: 'missing-uid' }, 400);
  const projectId = projectIdFromEnv(env);
  const sa = getServiceAccount(env);
  if (!projectId || !sa) return json({ ok: false, error: 'firestore-not-configured' }, 503);
  const pr = await getDocument(projectId, `payment_requests/${paymentRequestId}`, sa);
  if (!pr?.data) return json({ ok: false, error: 'payment-request-not-found' }, 404);
  const subs: Record<string, string> = (pr.data.stripeSubscriptionIds || {}) as Record<string, string>;
  const subId = subs?.[targetUid];
  if (!subId) return json({ ok: false, error: 'no-subscription' }, 404);
  const atPeriodEnd = payload?.atPeriodEnd !== false;
  const clubInfo = await resolvePaymentClub(projectId, sa, String(pr.data.clubId || ''));
  if (!clubInfo) return json({ ok: false, error: 'club-not-stripe-ready' }, 409);
  try {
    if (atPeriodEnd) {
      await stripeRequest(env, `/subscriptions/${encodeURIComponent(subId)}`, {
        cancel_at_period_end: true,
      });
    } else {
      // Immediate cancel via DELETE — stripeRequest is POST-only, so
      // we inline this call.
      const url = `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subId)}`;
      const r = await fetch(url, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      if (!r.ok) throw new Error(`stripe cancel ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    return json({ ok: true, subscriptionId: subId, atPeriodEnd });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err) }, 502);
  }
}

// POST /payments/refund — coach-only, one_off + catalog.
// Body: { paymentRequestId, uid?, purchaseId?, chargeId?, actorUid, actorName? }
// Either uid (one_off) or purchaseId (catalog). Refunds the full
// slice via refund_application_fee: true so the platform gives its
// 100 bps back too.
export async function handlePaymentRefund(payload: any, env: StripeEnv): Promise<Response> {
  const paymentRequestId = String(payload?.paymentRequestId || '').trim();
  if (!paymentRequestId) return json({ ok: false, error: 'missing-paymentRequestId' }, 400);
  const projectId = projectIdFromEnv(env);
  const sa = getServiceAccount(env);
  if (!projectId || !sa) return json({ ok: false, error: 'firestore-not-configured' }, 503);
  const pr = await getDocument(projectId, `payment_requests/${paymentRequestId}`, sa);
  if (!pr?.data) return json({ ok: false, error: 'payment-request-not-found' }, 404);

  const clubInfo = await resolvePaymentClub(projectId, sa, String(pr.data.clubId || ''));
  if (!clubInfo) return json({ ok: false, error: 'club-not-stripe-ready' }, 409);

  const paymentIntentId = String(payload?.paymentIntentId || '').trim();
  if (!paymentIntentId) return json({ ok: false, error: 'missing-paymentIntentId' }, 400);
  try {
    const refund = await stripeRequest(env, '/refunds', {
      payment_intent: paymentIntentId,
      refund_application_fee: true,
      reverse_transfer: true,
      'metadata[paymentRequestId]': paymentRequestId,
      'metadata[actorUid]': String(payload?.actorUid || ''),
    }, { stripeAccount: clubInfo.stripeAccountId });

    // Reflect on the payment_request. one_off: drop from paidUids.
    // catalog: mark the matching purchase as refunded (audit trail).
    if (pr.data.kind === 'one_off' && payload?.uid) {
      const targetUid = String(payload.uid);
      await commitDocumentTransforms(projectId, `payment_requests/${paymentRequestId}`, [
        { fieldPath: 'paidUids', kind: 'arrayRemove', value: targetUid },
      ], { updatedAt: new Date() }, sa);
    } else if (pr.data.kind === 'catalog' && payload?.purchaseId) {
      const purchases: any[] = Array.isArray(pr.data.purchases) ? pr.data.purchases : [];
      const next = purchases.map((p: any) => p.id === payload.purchaseId
        ? { ...p, refundedAt: new Date() }
        : p);
      await patchDocument(projectId, `payment_requests/${paymentRequestId}`, {
        purchases: next,
        updatedAt: new Date(),
      }, sa);
    }
    return json({ ok: true, refundId: refund.id });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err) }, 502);
  }
}

// ── Webhook helpers for payment_requests ────────────────────────
// Called from handleWebhook below when metadata.kind === 'payment_request'.

async function reflectPaymentSuccess(
  projectId: string,
  sa: ServiceAccount,
  env: StripeEnv,
  session: any,
): Promise<void> {
  const meta = session?.metadata || {};
  const paymentRequestId = meta.paymentRequestId;
  const uid = meta.uid;
  const paymentKind = meta.paymentKind;
  if (!paymentRequestId) return;
  // Anon guest checkout has no uid (guest never signs in). Every other
  // paymentKind must carry uid or we can't credit the payer, so we
  // gate uid AFTER dispatching the anon branch.
  if (paymentKind !== 'one_off_anon' && !uid) return;

  const pr = await getDocument(projectId, `payment_requests/${paymentRequestId}`, sa).catch(() => null);
  if (!pr?.data) return;

  if (paymentKind === 'one_off') {
    // Add uid to paidUids (atomic arrayUnion).
    await commitDocumentTransforms(projectId, `payment_requests/${paymentRequestId}`, [
      { fieldPath: 'paidUids', kind: 'arrayUnion', value: uid },
    ], { updatedAt: new Date() }, sa);
  } else if (paymentKind === 'one_off_anon') {
    // Anon /pay/{id} guest checkout. Append to guestPaid[] on the
    // request doc. Idempotent via stripeSessionId — a webhook retry
    // never doubles the row. No uid on the row (guest has no account).
    const guestEmail = String(meta.guestEmail || '').trim().toLowerCase();
    if (!guestEmail) return;
    const guestName = meta.guestName ? String(meta.guestName) : undefined;
    const chargedCents = Number(session.amount_total || meta.chargedCents || 0);
    const rows: any[] = Array.isArray(pr.data.guestPaid) ? pr.data.guestPaid : [];
    if (rows.some((r: any) => r?.stripeSessionId === session.id)) return;
    const nextRow: any = {
      email: guestEmail,
      amount: chargedCents,
      paidAt: new Date(),
      stripeSessionId: session.id,
    };
    if (guestName) nextRow.name = guestName;
    if (session.payment_intent) nextRow.stripePaymentIntentId = String(session.payment_intent);
    await patchDocument(projectId, `payment_requests/${paymentRequestId}`, {
      guestPaid: [...rows, nextRow],
      updatedAt: new Date(),
    }, sa);
    // Coach push for guest pays. No parent-side push (they don't have
    // an account). Skip early — fall-through would look up
    // users/{uid} and 404.
    try {
      const { pushPaymentConfirmed } = await import('./paymentRequests');
      await pushPaymentConfirmed(projectId, sa, env, {
        paymentRequestId,
        payerUid: '',
        payerName: guestName || guestEmail,
        amountCents: chargedCents,
        kind: 'one_off',
      });
    } catch (err) {
      console.warn('[payments] anon push after session.completed failed', err);
    }
    return;
  } else if (paymentKind === 'catalog') {
    let cart: Array<{ itemId: string; quantity: number }> = [];
    try { cart = meta.cart ? JSON.parse(meta.cart) : []; } catch { cart = []; }
    const purchases: any[] = Array.isArray(pr.data.purchases) ? pr.data.purchases : [];
    const items: any[] = Array.isArray(pr.data.items) ? pr.data.items : [];
    // Dedup: purchase ids are deterministic on (session, itemId), so a
    // Stripe webhook retry (very common on network blips) would
    // otherwise append duplicate rows and double the "collected" total.
    const existing = new Set(purchases.map((p: any) => String(p?.id || '')));
    const additions: any[] = [];
    for (const row of cart) {
      const item = items.find(i => i.id === row.itemId);
      if (!item) continue;
      const purchaseId = `purch_${session.id}_${row.itemId}`;
      if (existing.has(purchaseId)) continue;
      const feeCoveredBy = meta.feeCoveredBy === 'coach' ? 'coach' : 'player';
      const perUnit = Number(item.priceCents || 0);
      let chargedPer = perUnit;
      if (feeCoveredBy === 'player') {
        const { grossUpCents } = await import('./pricing');
        const platformFeeBps = Number(meta.platformFeeBps || 0);
        chargedPer = grossUpCents(perUnit, platformFeeBps || undefined);
      }
      additions.push({
        id: purchaseId,
        uid,
        itemId: row.itemId,
        quantity: row.quantity,
        chargedCents: chargedPer * row.quantity,
        paidVia: 'stripe',
        purchasedAt: new Date(),
        stripeSessionId: session.id,
        stripePaymentIntentId: session.payment_intent || undefined,
      });
    }
    if (additions.length === 0) return;
    await patchDocument(projectId, `payment_requests/${paymentRequestId}`, {
      purchases: [...purchases, ...additions],
      updatedAt: new Date(),
    }, sa);
  } else if (paymentKind === 'recurring') {
    const subscriptionId = String(session.subscription || '');
    if (!subscriptionId) return;
    // Atomic map-subfield write so two parents subscribing back-to-back
    // don't clobber each other's ids under stripeSubscriptionIds. The
    // prior read-merge-write pattern lost one parent's row on races.
    await patchMapEntry(
      projectId,
      `payment_requests/${paymentRequestId}`,
      'stripeSubscriptionIds',
      uid,
      subscriptionId,
      sa,
    );
    await patchDocument(projectId, `payment_requests/${paymentRequestId}`, {
      updatedAt: new Date(),
    }, sa);
    // First invoice = renewal; skip the "renewed" push and let the
    // upcoming invoice.paid webhook handle repeat renewals.
  }

  // Fire the coach notification.
  try {
    const { pushPaymentConfirmed } = await import('./paymentRequests');
    const parent = await getDocument(projectId, `users/${uid}`, sa).catch(() => null);
    const payerName = String(parent?.data?.name || 'A parent');
    await pushPaymentConfirmed(projectId, sa, env, {
      paymentRequestId,
      payerUid: uid,
      payerName,
      amountCents: Number(session.amount_total || meta.chargedCents || 0),
      kind: paymentKind as 'one_off' | 'recurring' | 'catalog',
    });
  } catch (err) {
    console.warn('[payments] push after session.completed failed', err);
  }
}

async function reflectRecurringInvoice(
  projectId: string,
  sa: ServiceAccount,
  env: StripeEnv,
  invoice: any,
  outcome: 'paid' | 'failed',
): Promise<void> {
  // The invoice metadata inherits from subscription metadata (Stripe
  // copies it). Look up paymentRequestId + uid from there.
  const meta = invoice?.subscription_details?.metadata || invoice?.metadata || {};
  const paymentRequestId = meta.paymentRequestId;
  const uid = meta.uid;
  if (!paymentRequestId || !uid) return;

  // Log to subcollection payment_requests/{id}/invoices/{invoiceId} —
  // creates a queryable audit trail without bloating the main doc.
  try {
    await createDocument(projectId, `payment_requests/${paymentRequestId}/invoices`, {
      uid,
      amountCents: Number(invoice.amount_paid || invoice.amount_due || 0),
      status: outcome,
      periodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : null,
      periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : null,
      stripeInvoiceId: String(invoice.id || ''),
      createdAt: new Date(),
    }, sa, String(invoice.id));
  } catch (err) {
    // AlreadyExists is fine — Stripe retries land here.
    console.warn('[payments] invoice log failed', err);
  }

  if (outcome === 'paid') {
    // Skip the very-first invoice push (checkout.session.completed
    // already handled it). Stripe billing_reason === 'subscription_create'
    // is the first invoice.
    if (invoice.billing_reason === 'subscription_create') return;
    try {
      const { pushPaymentConfirmed } = await import('./paymentRequests');
      const parent = await getDocument(projectId, `users/${uid}`, sa).catch(() => null);
      await pushPaymentConfirmed(projectId, sa, env, {
        paymentRequestId,
        payerUid: uid,
        payerName: String(parent?.data?.name || 'A parent'),
        amountCents: Number(invoice.amount_paid || 0),
        kind: 'recurring',
        isRenewal: true,
      });
    } catch (err) { console.warn('[payments] renewal push failed', err); }
  } else {
    try {
      const { pushPaymentFailed } = await import('./paymentRequests');
      await pushPaymentFailed(projectId, sa, env, {
        paymentRequestId,
        payerUid: uid,
        amountCents: Number(invoice.amount_due || 0),
      });
    } catch (err) { console.warn('[payments] failure push failed', err); }
  }
}

async function reflectSubscriptionDeleted(
  projectId: string,
  sa: ServiceAccount,
  sub: any,
): Promise<void> {
  const meta = sub?.metadata || {};
  const paymentRequestId = meta.paymentRequestId;
  const uid = meta.uid;
  if (!paymentRequestId || !uid) return;
  const pr = await getDocument(projectId, `payment_requests/${paymentRequestId}`, sa).catch(() => null);
  if (!pr?.data) return;
  // Atomic: clear only this parent's map entry (null preserves the map
  // for other subscribers). Combine cancelledUids arrayUnion + updatedAt
  // in one commit so a re-delivery is idempotent.
  await patchMapEntry(
    projectId,
    `payment_requests/${paymentRequestId}`,
    'stripeSubscriptionIds',
    uid,
    null,
    sa,
  );
  await commitDocumentTransforms(
    projectId,
    `payment_requests/${paymentRequestId}`,
    [{ fieldPath: 'cancelledUids', kind: 'arrayUnion', value: uid }],
    { updatedAt: new Date() },
    sa,
  );
}

// Public hooks used by handleWebhook — exposed so the switch stays
// readable. Guarded by metadata.kind === 'payment_request'.
export async function paymentWebhookHandleSessionCompleted(
  projectId: string,
  sa: ServiceAccount,
  env: StripeEnv,
  session: any,
): Promise<void> {
  if (session?.metadata?.kind !== 'payment_request') return;
  await reflectPaymentSuccess(projectId, sa, env, session);
}
export async function paymentWebhookHandleInvoicePaid(
  projectId: string,
  sa: ServiceAccount,
  env: StripeEnv,
  invoice: any,
): Promise<void> {
  const meta = invoice?.subscription_details?.metadata || invoice?.metadata || {};
  if (meta.kind !== 'payment_request') return;
  await reflectRecurringInvoice(projectId, sa, env, invoice, 'paid');
}
export async function paymentWebhookHandleInvoiceFailed(
  projectId: string,
  sa: ServiceAccount,
  env: StripeEnv,
  invoice: any,
): Promise<void> {
  const meta = invoice?.subscription_details?.metadata || invoice?.metadata || {};
  if (meta.kind !== 'payment_request') return;
  await reflectRecurringInvoice(projectId, sa, env, invoice, 'failed');
}
export async function paymentWebhookHandleSubscriptionDeleted(
  projectId: string,
  sa: ServiceAccount,
  sub: any,
): Promise<void> {
  if (sub?.metadata?.kind !== 'payment_request') return;
  await reflectSubscriptionDeleted(projectId, sa, sub);
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
  // Team payment_request invoice events. Recurring dues (see
  // payment_requests kind='recurring') get renewed via Stripe
  // Subscription; each renewal fires invoice.paid / .payment_failed.
  // We branch by metadata.kind and log to a subcollection so the coach
  // detail view can render history without bloating the main doc.
  if (event.type === 'invoice.paid') {
    try { await paymentWebhookHandleInvoicePaid(projectId, sa, env, event.data.object); }
    catch (err) { console.warn('payment_request invoice.paid handler failed', err); }
  }
  if (event.type === 'invoice.payment_failed') {
    try { await paymentWebhookHandleInvoiceFailed(projectId, sa, env, event.data.object); }
    catch (err) { console.warn('payment_request invoice.payment_failed handler failed', err); }
  }

  if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    try {
      const sub = event.data.object;
      // Team payment_request recurring subs are keyed by
      // metadata.kind === 'payment_request'. Deletion clears the
      // subscription id off the request doc + adds the uid to
      // cancelledUids. Created/updated events don't need extra work
      // because the checkout.session.completed handler below already
      // stamped stripeSubscriptionIds[uid].
      if (sub?.metadata?.kind === 'payment_request') {
        if (event.type === 'customer.subscription.deleted') {
          await paymentWebhookHandleSubscriptionDeleted(projectId, sa, sub);
        }
        return json({ ok: true });
      }
      // Branch on metadata.kind. Video subscriptions are per-team
      // and write to teams/{teamId}.videoTier instead of the
      // per-user subscriptions doc. Coach/Club subs fall through
      // to the existing upsertSubscriptionDoc path unchanged.
      if (sub?.metadata?.kind === 'video') {
        await syncVideoSubscription(projectId, sa, sub, event.type);
      } else {
        await upsertSubscriptionDoc(projectId, sa, sub, env);
        // Welcome email on the very first subscription.created event.
        // Dedupes via subscriptions/{docId}.welcomeEmailSentAt — set
        // after we successfully send. Stripe retries that hit the same
        // event after success will see the timestamp and skip.
        if (event.type === 'customer.subscription.created' && projectId && sa) {
          try { await maybeSendWelcomeEmail(env, projectId, sa, sub); }
          catch (err) { console.warn('welcome email failed', err); }
        }
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

    // Team payment_request — reflect one_off / catalog paid state, or
    // stamp the subscription id on the request doc for recurring. Runs
    // before the registration branches below since it short-circuits
    // for our namespace.
    if (session?.metadata?.kind === 'payment_request') {
      try { await paymentWebhookHandleSessionCompleted(projectId, sa, env, session); }
      catch (err) { console.warn('payment_request session.completed handler failed', err); }
      return json({ ok: true });
    }

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
            kind: sub.metadata?.kind || session?.metadata?.kind,
            videoTier: sub.metadata?.videoTier || session?.metadata?.videoTier,
            teamId: sub.metadata?.teamId || session?.metadata?.teamId,
            priceId: sub.metadata?.priceId || session?.metadata?.priceId,
            referralSource: sub.metadata?.referralSource || session?.metadata?.referralSource,
            checkoutSessionId: session.id,
            customerEmail: session?.customer_details?.email || session?.customer_email || null,
          };
          if (sub.metadata?.kind === 'video') {
            await syncVideoSubscription(projectId, sa, sub, 'customer.subscription.created');
          } else {
            await upsertSubscriptionDoc(projectId, sa, sub, env);
          }
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
          const installmentFeeCents = Number(session.metadata?.platformFeeCents || 0);
          if (installmentFeeCents > 0) {
            try {
              await incrementFields(projectId, `clubs/${clubId}`, {
                platformFeeCentsCollected: installmentFeeCents,
                platformFeePaymentsCount: 1,
              }, sa);
            } catch (err) {
              console.warn('platform fee counter increment failed (installment)', err);
            }
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
              platformFeeCents: installmentFeeCents,
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
          const oneShotFeeCents = Number(session.metadata?.platformFeeCents || 0);
          await patchDocument(projectId, `registrations/${registrationId}`, {
            status: 'paid',
            stripePaymentIntentId: session.payment_intent || null,
            paidAt: new Date(),
            platformFeeCents: oneShotFeeCents,
          }, sa);
          if (oneShotFeeCents > 0) {
            try {
              await incrementFields(projectId, `clubs/${clubId}`, {
                platformFeeCentsCollected: oneShotFeeCents,
                platformFeePaymentsCount: 1,
              }, sa);
            } catch (err) {
              console.warn('platform fee counter increment failed (one-shot)', err);
            }
          }
          await createDocument(projectId, 'activities', {
            clubId,
            kind: 'registration_paid',
            registrationId,
            actorUid: 'system',
            actorName: 'Stripe webhook',
            payload: {
              amountTotalCents: session.amount_total,
              platformFeeCents: oneShotFeeCents,
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
    const userPatch: Record<string, any> = {
      subscriptionActive: isActive,
      subscriptionTier: tier,
      subscriptionStatus: status,
      subscriptionUpdatedAt: new Date(),
    };
    // On paid conversion (real Stripe sub is now active/trialing),
    // clear the auto-trial stamps so TrialCountdownBanner stops
    // showing. writeGuards stamps subscriptionSource='auto-trial-*'
    // and a 7-day subscriptionExpiresAt on team/club create; without
    // this clear, a paid user keeps seeing the trial banner forever
    // because the banner predicate is `source.startsWith('auto-trial')
    // && subscriptionActive`.
    if (isActive) {
      userPatch.subscriptionSource = 'stripe';
      userPatch.subscriptionExpiresAt = null;
    }
    try {
      await patchDocument(projectId, `users/${uid}`, userPatch, sa);
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

// Video subscriptions are scoped to a single team (teams/{teamId}.videoTier)
// instead of a user, so they don't share the subscriptions/{uid} doc shape.
// We keep a small pointer doc at video_subscriptions/{subscriptionId} so the
// cancel/update events (which only carry the subscription, not the team)
// can find their way back to the team.
async function syncVideoSubscription(
  projectId: string | null,
  sa: ServiceAccount | null,
  sub: any,
  eventType: string,
): Promise<void> {
  if (!projectId || !sa || !sub) return;
  const subscriptionId = String(sub.id || '');
  if (!subscriptionId) return;

  // teamId comes from metadata on the subscription itself (mirrored at
  // checkout time via subscription_data[metadata]). On cancel events the
  // metadata is still there; on edge cases where it isn't, fall back to
  // the pointer doc written on the create event.
  let teamId = String(sub.metadata?.teamId || '').trim();
  if (!teamId) {
    const pointer = await getDocument(projectId, `video_subscriptions/${subscriptionId}`, sa).catch(() => null);
    teamId = String(pointer?.data?.teamId || '').trim();
  }
  if (!teamId) return;

  const status = String(sub.status || 'incomplete');
  const isActive = status === 'trialing' || status === 'active';
  const tierFromMeta = sub.metadata?.videoTier;
  const resolvedTier: 'free' | 'addon' | 'pro' =
    eventType === 'customer.subscription.deleted' || !isActive
      ? 'free'
      : (tierFromMeta === 'addon' || tierFromMeta === 'pro' ? tierFromMeta : 'free');

  const periodEndSec = Number(sub.current_period_end || 0);
  const canceledAtSec = Number(sub.canceled_at || 0);

  // Pointer doc — survives so a later cancel without metadata can still
  // resolve back to the team.
  const pointer: Record<string, any> = {
    subscriptionId,
    teamId,
    customerId: sub.customer ? String(sub.customer) : null,
    priceId: sub.metadata?.priceId || null,
    videoTier: resolvedTier,
    status,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    currentPeriodEnd: periodEndSec ? new Date(periodEndSec * 1000) : null,
    canceledAt: canceledAtSec ? new Date(canceledAtSec * 1000) : null,
    updatedAt: new Date(),
  };
  const existingPointer = await getDocument(projectId, `video_subscriptions/${subscriptionId}`, sa).catch(() => null);
  if (existingPointer) {
    await patchDocument(projectId, `video_subscriptions/${subscriptionId}`, pointer, sa);
  } else {
    await createDocument(projectId, 'video_subscriptions', { ...pointer, createdAt: new Date() }, sa, subscriptionId);
  }

  // Flip the team's tier. videoTier is the only field the upload-quota
  // helper reads; the rest power the "Manage subscription" button on
  // TeamManagement (Customer Portal needs the customerId).
  try {
    await patchDocument(projectId, `teams/${teamId}`, {
      videoTier: resolvedTier,
      videoSubscriptionId: resolvedTier === 'free' ? null : subscriptionId,
      videoCustomerId: sub.customer ? String(sub.customer) : null,
      videoTierUpdatedAt: new Date(),
    }, sa);
  } catch (err) {
    console.warn('[stripe] failed to patch teams/', teamId, 'videoTier', err);
  }
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
// Icon-only shield logo. Used inline with an HTML wordmark text
// alongside — more reliable across email clients than a single
// full-vector logo (Patrick's full-logo SVG was missing OAL
// glyphs and rendered as 'G/ KICKR' with a gap in the middle).
const LOGO_ICON_URL = 'https://goalkickr.com/logo-light.svg';
const TAGLINE = 'Every Team Deserves a Shot';
import { PLAY_STORE_LIVE } from './appAvailability';

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

            <!-- Brand bar — gradient runs black -> red (left -> right).
                 Layout: shield icon + GOALKICKR wordmark text on the
                 left, tagline on the right. Wordmark is HTML text so
                 it always renders cleanly regardless of SVG file
                 quirks. -->
            <tr>
              <td style="background:linear-gradient(90deg,${CHARCOAL_950} 0%,${CRIMSON} 100%);padding:22px 28px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="table-layout:fixed;">
                  <tr>
                    <td style="vertical-align:middle;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td style="vertical-align:middle;padding-right:10px;">
                            <img src="${LOGO_ICON_URL}" alt="" width="32" height="32" style="display:block;border:0;outline:none;text-decoration:none;width:32px;height:32px;" />
                          </td>
                          <td style="vertical-align:middle;color:#ffffff;font-size:20px;font-weight:900;letter-spacing:0.04em;line-height:1;">
                            <span style="color:${BONE};">GOAL</span><span style="color:#ffffff;">KICKR</span>
                          </td>
                        </tr>
                      </table>
                    </td>
                    <td align="right" style="vertical-align:middle;color:#ffffff;font-size:12px;font-weight:600;letter-spacing:0.02em;line-height:1;white-space:nowrap;padding-left:8px;">
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

            <!-- App store badges. Play Store badge gates on
                 PLAY_STORE_LIVE so the welcome email never promises
                 an install that requires the coach to allowlist the
                 recipient's email first. When PLAY_STORE_LIVE is
                 false we render only the App Store badge + a subdued
                 line explaining the web app is the Android path
                 today. -->
            <tr>
              <td align="center" style="padding:8px 32px 20px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:0 6px;">
                      <a href="${APP_STORE_URL}" target="_blank" style="display:inline-block;font-size:11px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:${BONE};background:#1a1a22;border:1px solid #2a2a36;border-radius:6px;padding:8px 14px;text-decoration:none;">
                        App Store
                      </a>
                    </td>
                    ${PLAY_STORE_LIVE ? `<td style="padding:0 6px;">
                      <a href="${PLAY_STORE_URL}" target="_blank" style="display:inline-block;font-size:11px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:${BONE};background:#1a1a22;border:1px solid #2a2a36;border-radius:6px;padding:8px 14px;text-decoration:none;">
                        Google Play
                      </a>
                    </td>` : ''}
                  </tr>
                </table>
                ${PLAY_STORE_LIVE ? '' : `<p style="margin:12px 32px 0;font-size:12px;color:#8a8275;line-height:1.55;text-align:center;">On Android? Open goalkickr.com in Chrome. The web version is the full app. Our Android app is still in closed beta.</p>`}
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
