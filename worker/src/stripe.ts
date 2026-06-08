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

import { ServiceAccount } from './fcm';
import { getDocument, patchDocument, createDocument } from './firestore';

export interface StripeEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_CONNECT_CLIENT_ID?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  APP_ORIGIN: string;
  FCM_SERVICE_ACCOUNT?: string;
  FIREBASE_PROJECT_ID?: string;
}

function projectIdFromEnv(env: StripeEnv): string | null {
  if (env.FIREBASE_PROJECT_ID) return env.FIREBASE_PROJECT_ID;
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try {
    const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
    return sa.project_id || null;
  } catch {
    return null;
  }
}

function getServiceAccount(env: StripeEnv): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try { return JSON.parse(env.FCM_SERVICE_ACCOUNT); } catch { return null; }
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
  const headers: Record<string, string> = {
    'authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (opts.stripeAccount) headers['Stripe-Account'] = opts.stripeAccount;
  const r = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers,
    body: form(body),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `stripe ${r.status}`;
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
  const redirect = `${env.APP_ORIGIN}/club?stripe_connected=1&state=${encodeURIComponent(clubId)}`;
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

// ── Endpoint: POST /stripe/registration-checkout ──────────────────

export async function handleRegistrationCheckout(payload: any, env: StripeEnv): Promise<Response> {
  const registrationId = String(payload?.registrationId || '').trim();
  if (!registrationId) return json({ ok: false, error: 'missing-registrationId' }, 400);
  const projectId = projectIdFromEnv(env);
  const sa = getServiceAccount(env);
  if (!projectId || !sa) return json({ ok: false, error: 'firestore-not-configured' }, 503);

  try {
    const reg = await getDocument(projectId, `registrations/${registrationId}`, sa);
    if (!reg) return json({ ok: false, error: 'registration-not-found' }, 404);
    if (reg.data.status !== 'pending_payment') {
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
    const totalCents = baseCents + (surchargeCents || 0) > 0 ? baseCents + surchargeCents : baseCents;
    if (totalCents <= 0) return json({ ok: false, error: 'zero-amount' }, 400);

    const productName = reg.data.productName || 'Registration';
    const tierLabel = reg.data.pricingTierLabel;
    const playerName = `${reg.data.player?.firstName || ''} ${reg.data.player?.lastName || ''}`.trim();
    const lineName = `${productName}${tierLabel ? ` — ${tierLabel}` : ''}${playerName ? ` (${playerName})` : ''}`;
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
    const session = await stripeRequest(env, '/checkout/sessions', sessionParams, { stripeAccount: stripeAccountId });

    await patchDocument(projectId, `registrations/${registrationId}`, {
      stripeCheckoutSessionId: session.id,
    }, sa);

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

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const registrationId = session?.metadata?.registrationId;
    const clubId = session?.metadata?.clubId;
    if (registrationId && clubId) {
      try {
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
