/**
 * Fire FC16 mailer — Cloudflare Worker
 *
 * Endpoints:
 *   POST /send         { to, subject, html, text? }            single email
 *   POST /send-batch   { messages: [{ to, subject, html, text? }] }
 *   POST /send-push    { tokens: string[], title, body, url?, icon? }
 *   GET  /health
 *
 * Auth (2026-07-03 hardening): every non-public endpoint now requires
 * a Firebase ID token in `Authorization: Bearer <idToken>`. Each
 * endpoint enforces its own authorization scope via helpers in
 * `./auth`:
 *   - requireUser: any signed-in caller
 *   - requireCoachOfTeam(teamId): coach or team_manager on that team
 *   - requireClubAdmin(clubId): club owner or listed admin
 *   - requirePlatformAdmin: user.isClubAdmin === true (rare — Patrick)
 *   - requireSelf(uid): the token's uid must equal the target uid
 *
 * The prior NOTIFY_SECRET static bearer was shipped in the client
 * bundle via REACT_APP_NOTIFY_SECRET, giving anyone with the JS
 * admin access to every endpoint. That vector is closed.
 */

import { sendPush, parseServiceAccount } from './fcm';
import { verifyIdToken, mintCustomToken } from './firebaseAuth';
import {
  requireUser,
  requireCoachOfTeam,
  requireClubAdmin,
  requirePlatformAdmin,
  requireSelf,
  authErrorResponse,
  AuthError,
} from './auth';
import { runWeeklyDigest, runWeeklyTeamWallDigest } from './digest';
import { runRegistrationDrips } from './drips';
import { runTrialExpirySweep } from './trialExpiry';
import { runEventReminders } from './eventReminders';
import { runPotmAutoCreate } from './potmAutoCreate';
import { runAdminWeeklyRoundup } from './adminDigest';
import {
  handleConnectStart,
  handleConnectFinish,
  handleConnectDisconnect,
  handleRegistrationCheckout,
  handleRegistrationRefund,
  handleSubscriptionCheckout,
  handleSubscriptionCancel,
  handleSubscriptionReactivate,
  handleSubscriptionResync,
  handleVideoSubscriptionAttachTeam,
  handleVideoCheckout,
  handleFounderCount,
  handleCustomerPortal,
  handleWebhook,
} from './stripe';
import { handleWidgetRequest } from './widget';
import { handleParentEmailPrecheck } from './precheck';
import { logWorkerError } from './errorLog';
import { handleUnsubscribe, handleOpenPixel, runDueCampaigns } from './campaigns';
import { handleSendVerification } from './authMail';
import { routeWriteGuard, drainPendingBackground } from './writeGuards';
import {
  handleCreatePaymentRequest,
  handleUpdatePaymentRequest,
  handleClosePaymentRequest,
  handlePaymentMarkPaidCash,
} from './paymentRequests';
import {
  handlePaymentCheckout,
  handlePaymentCheckoutAnon,
  handlePayLinkInfo,
  handlePaymentSubscriptionCheckout,
  handlePaymentSubscriptionCancel,
  handlePaymentRefund,
  handlePaymentReconcileSession,
} from './stripe';
import {
  handleCreateTrip,
  handleUpdateTrip,
  handleArchiveTrip,
  handleTripAttend,
  handleTripPublicInfo,
} from './trips';
import { handleWallParentPostNotify } from './wallPosts';
import { handleWallCommentNotify } from './wallComments';
import { routeGametape } from './gametape';

export interface Env {
  // NOTIFY_SECRET is retained on the env for backwards compatibility
  // with any scheduled/cron entry points that used to require it —
  // it is NOT used to authenticate normal client-triggered
  // endpoints anymore. Rotate + delete after the client rollout.
  NOTIFY_SECRET?: string;
  RESEND_API_KEY: string;
  FROM_EMAIL: string;
  FROM_NAME: string;
  APP_ORIGIN: string;
  API_ORIGIN?: string;
  ALLOWED_ORIGINS: string;
  FCM_SERVICE_ACCOUNT?: string;
  FIREBASE_PROJECT_ID?: string;
  GOOGLE_PLACES_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Shared secret so the admin backfill route can call the drill
   *  diagram generator without a user session (batch job). Optional
   *  — if unset, only user-session calls are accepted. */
  ADMIN_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_CONNECT_CLIENT_ID?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Cloudflare Stream — used by /gametape/stream-upload-url and
   *  /gametape/delete for the direct-upload presign + video removal
   *  (mirrors api/stream-upload-url.mjs on the Vercel side). Configure
   *  via `wrangler secret put CLOUDFLARE_ACCOUNT_ID` etc. If missing,
   *  the gametape upload path 503s with 'stream_not_configured'; the
   *  YouTube/Vimeo link path works without it. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_STREAM_API_TOKEN?: string;
}

interface MailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  const allow = allowed.includes(origin) ? origin : allowed[0] || '*';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>(?!\n)/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendOne(msg: MailMessage, env: Env): Promise<{ ok: boolean; error?: string; id?: string }> {
  const recipients = Array.isArray(msg.to) ? msg.to : [msg.to];
  const valid = recipients.filter((r) => /.+@.+\..+/.test(r));
  if (valid.length === 0) return { ok: false, error: 'no-valid-recipients' };

  const body = {
    from: `${env.FROM_NAME} <${env.FROM_EMAIL}>`,
    to: valid,
    subject: msg.subject,
    html: msg.html,
    text: msg.text || htmlToText(msg.html),
    ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (res.status >= 200 && res.status < 300) {
    const data: any = await res.json().catch(() => ({}));
    return { ok: true, id: data?.id };
  }
  const txt = await res.text().catch(() => '');
  return { ok: false, error: `resend ${res.status}: ${txt.slice(0, 300)}` };
}

// Top-level catch so any unhandled error inside fetch() ends up
// in crash_logs (with source: 'worker') instead of disappearing
// into wrangler-tail history. The handler still returns a clean
// 500 to the client so a logging failure doesn't cascade.
async function safeFetch(req: Request, env: Env): Promise<Response> {
  try {
    return await routeFetch(req, env);
  } catch (err: any) {
    const cors = corsHeaders(req, env);
    // AuthError → clean 401/403 with the error code; nothing to log.
    // Prevents auth failures from clogging crash_logs.
    const authResp = authErrorResponse(err, cors);
    if (authResp) return authResp;
    const url = new URL(req.url);
    await logWorkerError(env, {
      err,
      workerRoute: url.pathname,
      url: req.url,
      status: 500,
    }).catch(() => { /* never throw */ });
    return new Response(JSON.stringify({ ok: false, error: 'internal' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
    });
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const resp = await safeFetch(req, env);
    // Drain background work (custom-claims mint, cleanup) into
    // ctx.waitUntil so the promises live past the Response return.
    // Without this Cloudflare kills any in-flight fetch the moment
    // we hand back a Response and the claim mint gets dropped.
    const pending = drainPendingBackground();
    if (pending.length > 0) ctx.waitUntil(Promise.all(pending));
    return resp;
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    return scheduledHandler(event, env, ctx);
  },
};

async function routeFetch(req: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(req, env);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return json({ ok: true, from: env.FROM_EMAIL }, 200, cors);
    }

    // GET /widget/snapshot is anonymous — the iOS widget extension
    // can't run Firebase Auth. Gated by a long-lived widgetToken on
    // the user doc that the user pastes into the widget config.
    if (url.pathname === '/widget/snapshot' && req.method === 'GET') {
      const res = await handleWidgetRequest(req, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // GET /u/:token — campaign unsubscribe. Anonymous, signed link.
    //   Flips users/{uid}.emailPreferences.tier3 (or tier2) to false
    //   and returns a tiny success page. Never errors visibly to a
    //   bot; only invalid links surface a soft error page.
    if (url.pathname.startsWith('/u/') && req.method === 'GET') {
      return handleUnsubscribe(req, env);
    }

    // GET /public/team-fixtures/:teamId — anonymous JSON of a team's
    //   upcoming games, recent results, and public-share-opted roster.
    //   Gated by team.publicFixturesEnabled; renders on /f/{teamId}.
    if (url.pathname.startsWith('/public/team-fixtures/') && req.method === 'GET') {
      const { handlePublicFixtures } = await import('./publicFixtures');
      const res = await handlePublicFixtures(req, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // GET /public/voting/:votingId/roster — anonymous, sanitized
    //   player list for the /vote page. Existed as a raw players
    //   query with `isActive == true` from the client before, which
    //   dumped every player's DOB / medical / parent emails to any
    //   voter. This returns ONLY name + jersey + photo — enough to
    //   render the ballot, nothing more. Firestore.rules on
    //   players.get gets tightened in the same ship so the old
    //   direct path is blocked. Response shape:
    //     { ok: true, teamId, players: [{id, name, jerseyNumber,
    //        profilePhotoUrl}] }
    if (url.pathname.startsWith('/public/voting/') && url.pathname.endsWith('/roster') && req.method === 'GET') {
      const { handlePublicVotingRoster } = await import('./publicFixtures');
      const res = await handlePublicVotingRoster(req, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // GET /public/invite-preview/:inviteId — team-specific title +
    //   image for the /join Open Graph meta tags. Called by the
    //   Vercel edge route so WhatsApp / iMessage / Slack render
    //   "Join {team}" previews instead of generic app copy.
    if (url.pathname.startsWith('/public/invite-preview/') && req.method === 'GET') {
      const { handleInvitePreview } = await import('./publicFixtures');
      const res = await handleInvitePreview(req, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // GET /o/:campaignId/:token.gif — campaign open-tracking pixel.
    //   Always returns a 1x1 transparent gif; bumps openCount when
    //   the token is valid. No CORS or auth.
    if (url.pathname.startsWith('/o/') && req.method === 'GET') {
      return handleOpenPixel(req, env);
    }

    // POST /auth/send-verification — branded email verification
    //   send via Resend. Replaces Firebase Auth's default sender
    //   (noreply@<project>.firebaseapp.com) with GoalKickr branding
    //   AND rewrites the link host to point at our /auth/action
    //   page. Anonymous (signup flow hasn't fully auth'd yet).
    if (url.pathname === '/auth/send-verification' && req.method === 'POST') {
      const res = await handleSendVerification(req, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // POST /precheck/parent-email — anonymous lookup for the signup
    // lockdown gate. Returns { hasPlayer: boolean }. Client uses it
    // instead of querying players directly (Firestore list requires
    // auth and the user isn't authenticated at signup time).
    if (url.pathname === '/precheck/parent-email' && req.method === 'POST') {
      const res = await handleParentEmailPrecheck(req, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // POST /payments/checkout-anon — anonymous by design (Ship 1
    // decision #3). Guest pays a one_off payment_request through
    // the /pay/{id} share link with just email + optional name.
    // Rate-limited inside the handler. Routed BEFORE the bearer
    // check so it accepts unauthenticated callers.
    if (url.pathname === '/payments/checkout-anon' && req.method === 'POST') {
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handlePaymentCheckoutAnon(payload, env, req);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // POST /payments/pay-link-info — anonymous read for the /pay/{id}
    // share page. Returns only the safe subset (title, description,
    // amount, club/coach name). Prevents leaking prior-payer PII that
    // sits on the raw payment_request doc. Anonymous by design.
    if (url.pathname === '/payments/pay-link-info' && req.method === 'POST') {
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handlePayLinkInfo(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // Stripe webhook is anonymous — Stripe doesn't send our bearer.
    // Verified by the Stripe-Signature header inside the handler.
    // Raw body is required for signature verification, so this must
    // run before req.json() consumes the stream.
    if (url.pathname === '/stripe/webhook' && req.method === 'POST') {
      const raw = await req.text();
      const sig = req.headers.get('stripe-signature') || '';
      const res = await handleWebhook(raw, sig, env);
      // Re-wrap with CORS for completeness (Stripe doesn't care).
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // GET /stripe/connect/start is anonymous from the worker's POV — it
    // just returns the OAuth URL. The UI calls it from the browser and
    // immediately redirects, so requiring a bearer would be awkward.
    if (url.pathname === '/stripe/connect/start' && req.method === 'GET') {
      const res = handleConnectStart(url, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // GET /stripe/founder/count is anonymous — drives the live
    // "X of 50 spots left" counter on goalkickr.com/signup. No PII
    // exposed (just two integers), so safe to leave open.
    if (url.pathname === '/stripe/founder/count' && req.method === 'GET') {
      const res = await handleFounderCount(env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // POST /stripe/subscription-checkout is anonymous — called from
    // BOTH the marketing site signup (user has no app account yet)
    // AND the in-app upgrade flow. priceId is validated against an
    // env allowlist inside the handler so a tampered client can't
    // checkout a random price.
    if (url.pathname === '/stripe/subscription-checkout' && req.method === 'POST') {
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handleSubscriptionCheckout(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // POST /stripe/video-checkout — per-team video tier upgrade
    // ($10/mo Add-on or $29.99/mo Pro). Anonymous from the auth
    // perspective; the inbound priceId is validated against the
    // env allowlist and the teamId is stamped into the Checkout
    // session metadata so the webhook can flip the right team's
    // videoTier without leaking cross-team writes.
    if (url.pathname === '/stripe/video-checkout' && req.method === 'POST') {
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handleVideoCheckout(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // POST /stripe/event-dropin-checkout — one-shot drop-in fee for
    // a single event (adult-pickup use case). Charges event.feeCents
    // against the club's connected Stripe account.
    if (url.pathname === '/stripe/event-dropin-checkout' && req.method === 'POST') {
      await requireUser(req, env);
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const { handleEventDropInCheckout } = await import('./stripe');
      const res = await handleEventDropInCheckout(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // POST /payments/checkout + /payments/subscription-checkout —
    // parent-facing pay flows for team payment_requests. Any signed-in
    // user, worker validates the paymentRequest is active + club is
    // Stripe-ready.
    if (url.pathname === '/payments/checkout' && req.method === 'POST') {
      await requireUser(req, env);
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handlePaymentCheckout(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }
    if (url.pathname === '/payments/subscription-checkout' && req.method === 'POST') {
      await requireUser(req, env);
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handlePaymentSubscriptionCheckout(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }
    // POST /payments/reconcile-session — belt-and-suspenders self heal
    // for the connected-account webhook drop. Any signed-in user; the
    // handler enforces that the caller's uid matches session metadata.
    if (url.pathname === '/payments/reconcile-session' && req.method === 'POST') {
      await requireUser(req, env);
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handlePaymentReconcileSession(payload, env, req);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }
    if (url.pathname === '/payments/subscription-cancel' && req.method === 'POST') {
      // Parent cancels their own sub OR coach force-cancels. The
      // caller's uid MUST match payload.uid unless the caller is a
      // coach on the payment request's team.
      const claims = await requireUser(req, env);
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const targetUid = String(payload?.uid || '');
      if (targetUid && targetUid !== claims.uid) {
        // Attempt coach check via the payment_request doc.
        const { getDocument } = await import('./firestore');
        const { parseServiceAccount } = await import('./fcm');
        const sa = env.FCM_SERVICE_ACCOUNT ? parseServiceAccount(env.FCM_SERVICE_ACCOUNT) : null;
        const pid = env.FIREBASE_PROJECT_ID;
        if (!sa || !pid) return json({ ok: false, error: 'server_not_configured' }, 500, cors);
        const pr = await getDocument(pid, `payment_requests/${String(payload?.paymentRequestId || '')}`, sa).catch(() => null);
        const teamId = String(pr?.data?.teamId || '');
        try { await requireCoachOfTeam(req, env, teamId); }
        catch (err: any) {
          const resp = authErrorResponse(err, cors);
          if (resp) return resp;
          throw err;
        }
      }
      const res = await handlePaymentSubscriptionCancel(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }
    if (url.pathname === '/payments/refund' && req.method === 'POST') {
      // Coach-only. Resolve teamId from the paymentRequest doc first,
      // then gate on requireCoachOfTeam.
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const { getDocument } = await import('./firestore');
      const { parseServiceAccount } = await import('./fcm');
      const sa = env.FCM_SERVICE_ACCOUNT ? parseServiceAccount(env.FCM_SERVICE_ACCOUNT) : null;
      const pid = env.FIREBASE_PROJECT_ID;
      if (!sa || !pid) return json({ ok: false, error: 'server_not_configured' }, 500, cors);
      const pr = await getDocument(pid, `payment_requests/${String(payload?.paymentRequestId || '')}`, sa).catch(() => null);
      const teamId = String(pr?.data?.teamId || '');
      await requireCoachOfTeam(req, env, teamId);
      const res = await handlePaymentRefund(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }
    if (url.pathname === '/payments/create' && req.method === 'POST') {
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handleCreatePaymentRequest(req, env, payload);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }
    if (url.pathname === '/payments/update' && req.method === 'POST') {
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handleUpdatePaymentRequest(req, env, payload);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }
    if (url.pathname === '/payments/close' && req.method === 'POST') {
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handleClosePaymentRequest(req, env, payload);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }
    if (url.pathname === '/payments/mark-paid-cash' && req.method === 'POST') {
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handlePaymentMarkPaidCash(req, env, payload);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // ── Trips (2026-07-19) — coach-owned tournament / weekend-trip
    // stat-scoping container. Auto-attribution runs client-side at stat
    // write time; these endpoints own the CRUD for the trip doc itself.
    if (url.pathname === '/trips/create' && req.method === 'POST') {
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handleCreateTrip(req, env, payload);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }
    if (url.pathname === '/trips/update' && req.method === 'POST') {
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handleUpdateTrip(req, env, payload);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }
    if (url.pathname === '/trips/archive' && req.method === 'POST') {
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handleArchiveTrip(req, env, payload);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }
    if (url.pathname === '/trips/attend' && req.method === 'POST') {
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handleTripAttend(req, env, payload);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }
    // Anonymous by design — shareToken in the body IS the auth. Routed
    // before the bearer check so /trip/:id?token=... recap URLs work
    // without a signed-in user.
    if (url.pathname === '/trips/public-info' && req.method === 'POST') {
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handleTripPublicInfo(req, env, payload);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // ── Team Wall parent-post notify (2026-07-23) ────────────────
    // Parents can't enumerate other users on their team via Firestore
    // rules, so the coach-push + parent-email fanout for parent-authored
    // posts has to run server-side. The wallPosts handler enforces its
    // own author-uid / coach-uid gate before firing anything.
    if (url.pathname === '/wall/notify-parent-post' && req.method === 'POST') {
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handleWallParentPostNotify(req, env, payload);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // ── Wall comment notify (2026-08-03 coach ask) ───────────────
    // Pushes to post author + prior distinct commenters when a new
    // comment lands on a wall post. Client can't enumerate other
    // team members via Firestore rules — same reason wall/notify-
    // parent-post lives here. Own author-uid gate inside the
    // handler prevents drive-by push spam.
    if (url.pathname === '/wall/notify-comment' && req.method === 'POST') {
      let payload: any = {};
      try { payload = await req.json(); } catch {}
      const res = await handleWallCommentNotify(req, env, payload);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    if (req.method !== 'POST') {
      return json({ ok: false, error: 'method-not-allowed' }, 405, cors);
    }

    // /run-digest takes no body — handle it before requiring JSON parse.
    // Platform-admin only (Patrick).
    if (url.pathname === '/run-digest') {
      await requirePlatformAdmin(req, env);
      const result = await runWeeklyDigest(env);
      return json(result, result.ok ? 200 : 500, cors);
    }

    let payload: any;
    try {
      payload = await req.json();
    } catch {
      return json({ ok: false, error: 'invalid-json' }, 400, cors);
    }

    // Exchange a Firebase ID token (from the native
    // @capacitor-firebase/authentication plugin's getIdToken call)
    // for a Firebase Custom Token the Web SDK can sign in with.
    //
    // Path A of the Keychain-backed Auth migration: native Firebase
    // Auth is the source of truth (Keychain on iOS, Keystore on
    // Android) because it survives WebView reloads cleanly. After a
    // Capgo OTA reload, the WebView's Web SDK is a fresh slate; we
    // ask the native plugin for an ID token, hand it to this
    // endpoint, get back a custom token, and call
    // signInWithCustomToken on the Web SDK to bridge the session.
    //
    // Security: ID token is verified against Google's JWKS (real
    // RS256 signature check + claim validation), so a bad actor
    // can't pass an arbitrary uid and get a token for it. Custom
    // token's uid is whatever the verified ID token's `sub` claim
    // says — same identity, just a different token format. Because
    // this endpoint self-authenticates via the ID token in the
    // body, it does NOT require an Authorization: Bearer header —
    // that would be circular during the sign-in-refresh flow.
    if (url.pathname === '/auth/exchange-id-token') {
      const idToken = String(payload?.idToken || '');
      if (!idToken) return json({ ok: false, error: 'id-token-required' }, 400, cors);
      const projectId = env.FIREBASE_PROJECT_ID || '';
      if (!projectId) return json({ ok: false, error: 'project-id-not-configured' }, 500, cors);
      if (!env.FCM_SERVICE_ACCOUNT) {
        return json({ ok: false, error: 'service-account-not-configured' }, 500, cors);
      }
      try {
        const verified = await verifyIdToken(idToken, projectId);
        const sa = parseServiceAccount(env.FCM_SERVICE_ACCOUNT);
        const customToken = await mintCustomToken(verified.uid, sa, { ttlSeconds: 3600 });
        return json({ ok: true, customToken, uid: verified.uid }, 200, cors);
      } catch (err: any) {
        const message = String(err?.message || err);
        // Distinguish "you sent us a bad token" (400) from "we couldn't
        // verify because of an internal/network issue" (500).
        const clientErrors = new Set([
          'id-token-required',
          'malformed-jwt',
          'unsupported-algorithm',
          'unsupported-type',
          'missing-kid',
          'token-expired',
          'token-not-yet-valid',
          'invalid-audience',
          'invalid-issuer',
          'missing-subject',
          'invalid-auth-time',
          'unknown-kid',
          'invalid-signature',
        ]);
        const status = clientErrors.has(message) ? 401 : 500;
        return json({ ok: false, error: message }, status, cors);
      }
    }

    // Proxy an iCal feed URL so the browser can import its events
    // without hitting CORS. Used by ImportScheduleModal's URL-paste
    // flow — most calendar systems (Ollie, GotSoccer, etc.) serve
    // .ics feeds without CORS headers because they're built for
    // calendar clients (Apple, Google) that don't enforce CORS.
    // Worker fetches server-side, returns the text body to the
    // browser with proper CORS for our origins.
    if (url.pathname === '/ical-fetch') {
      await requireUser(req, env);
      const target = String(payload?.url || '');
      if (!/^https?:\/\//i.test(target)) {
        return json({ ok: false, error: 'invalid-url' }, 400, cors);
      }
      try {
        const upstream = await fetch(target, {
          headers: { accept: 'text/calendar, text/plain, */*' },
          redirect: 'follow',
        });
        if (!upstream.ok) {
          return json({ ok: false, error: `upstream-${upstream.status}` }, 502, cors);
        }
        const text = await upstream.text();
        if (!text.includes('BEGIN:VCALENDAR')) {
          return json({ ok: false, error: 'not-ical', preview: text.slice(0, 120) }, 422, cors);
        }
        return json({ ok: true, text }, 200, cors);
      } catch (err: any) {
        return json({ ok: false, error: 'fetch-failed', message: String(err?.message || err) }, 502, cors);
      }
    }

    if (url.pathname === '/send') {
      // Any signed-in user may send from the app's from-address; the
      // From is server-set, so misuse is bounded by rate-limits (TODO).
      await requireUser(req, env);
      const result = await sendOne(payload as MailMessage, env);
      return json(result, result.ok ? 200 : 502, cors);
    }

    if (url.pathname === '/stripe/connect/finish') {
      // Only the club owner/admin can wire a Stripe Connect account
      // onto a club they belong to.
      await requireClubAdmin(req, env, String(payload?.clubId || ''));
      const res = await handleConnectFinish(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    if (url.pathname === '/stripe/connect/disconnect') {
      await requireClubAdmin(req, env, String(payload?.clubId || ''));
      const res = await handleConnectDisconnect(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    if (url.pathname === '/stripe/registration-checkout') {
      // A parent registering a kid — any signed-in user is fine.
      await requireUser(req, env);
      const res = await handleRegistrationCheckout(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    if (url.pathname === '/stripe/registration-refund') {
      // Refunds move money out — must be a club admin. clubId is
      // typically embedded in the registration doc; we require it in
      // the payload for the authz gate.
      await requireClubAdmin(req, env, String(payload?.clubId || ''));
      const res = await handleRegistrationRefund(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // Stripe Billing Customer Portal session — user must be the same
    // uid that owns the subscription. Body ships `uid`; requireSelf
    // pins it to the token's claim.
    if (url.pathname === '/stripe/customer-portal') {
      await requireSelf(req, env, String(payload?.uid || ''));
      const res = await handleCustomerPortal(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    if (url.pathname === '/stripe/subscription-cancel') {
      await requireSelf(req, env, String(payload?.uid || ''));
      const res = await handleSubscriptionCancel(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    if (url.pathname === '/stripe/subscription-reactivate') {
      await requireSelf(req, env, String(payload?.uid || ''));
      const res = await handleSubscriptionReactivate(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // Force-sync a caller's Stripe subscriptions into Firestore.
    // Fixes the "subscribed via Customer Portal, in-app state stale"
    // case where the webhook fired without app-controlled metadata.
    if (url.pathname === '/subscriptions/resync') {
      const claims = await requireUser(req, env);
      const res = await handleSubscriptionResync(req, env, { ...payload, _claims: claims });
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // Attach an existing Stripe video subscription to a team.
    // Coach-only. Stamps metadata + patches team.videoTier so the
    // upload gate opens.
    if (url.pathname === '/video-subscriptions/attach-team') {
      const claims = await requireUser(req, env);
      const res = await handleVideoSubscriptionAttachTeam(req, env, { ...payload, _claims: claims });
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    if (url.pathname === '/send-batch') {
      // Same posture as /send — any signed-in user; rate-limit later.
      await requireUser(req, env);
      const messages: MailMessage[] = Array.isArray(payload?.messages) ? payload.messages : [];
      if (messages.length === 0) return json({ ok: false, error: 'no-messages' }, 400, cors);
      if (messages.length > 50) return json({ ok: false, error: 'too-many' }, 400, cors);

      const results = await Promise.all(messages.map((m) => sendOne(m, env)));
      const sent = results.filter((r) => r.ok).length;
      return json({ ok: true, sent, failed: results.length - sent, results }, 200, cors);
    }

    // ---- Google Places proxy ------------------------------------------
    // Why proxy: keeps the API key server-side so it can't be scraped
    // from the client bundle. Also lets us cache common queries (TODO)
    // and centralize rate-limit handling. Auth is the same NOTIFY_SECRET
    // bearer pattern as the other endpoints.
    if (url.pathname === '/places/autocomplete') {
      await requireUser(req, env);
      if (!env.GOOGLE_PLACES_API_KEY) return json({ ok: false, error: 'google-places-not-configured' }, 503, cors);
      const q = String(payload?.q || '').slice(0, 200);
      if (!q || q.length < 2) return json({ ok: false, error: 'no-query' }, 400, cors);
      // Optional bias to a point — pulls local results to the top.
      const lat = typeof payload?.lat === 'number' ? payload.lat : undefined;
      const lon = typeof payload?.lon === 'number' ? payload.lon : undefined;
      // Session token is a UUID generated client-side; bundling
      // autocomplete+details under one token reduces billing to a
      // single $0.017 per "session" instead of per request.
      const sessionToken = typeof payload?.sessionToken === 'string' ? payload.sessionToken : undefined;
      const body: any = { input: q };
      if (sessionToken) body.sessionToken = sessionToken;
      if (typeof lat === 'number' && typeof lon === 'number') {
        body.locationBias = { circle: { center: { latitude: lat, longitude: lon }, radius: 50000 } };
      }
      try {
        const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          return json({ ok: false, error: `google ${res.status}`, detail: txt.slice(0, 300) }, 502, cors);
        }
        const data: any = await res.json();
        // Slim payload — only what the client needs to render rows.
        const predictions = (data.suggestions || []).map((s: any) => {
          const p = s.placePrediction;
          if (!p) return null;
          return {
            placeId: p.placeId,
            label: p.structuredFormat?.mainText?.text || p.text?.text,
            address: p.structuredFormat?.secondaryText?.text || p.text?.text,
          };
        }).filter(Boolean);
        return json({ ok: true, predictions }, 200, cors);
      } catch (err: any) {
        return json({ ok: false, error: 'google-fetch-failed', detail: String(err?.message || err).slice(0, 200) }, 502, cors);
      }
    }

    if (url.pathname === '/places/details') {
      await requireUser(req, env);
      if (!env.GOOGLE_PLACES_API_KEY) return json({ ok: false, error: 'google-places-not-configured' }, 503, cors);
      const placeId = String(payload?.placeId || '');
      if (!placeId) return json({ ok: false, error: 'no-place-id' }, 400, cors);
      const sessionToken = typeof payload?.sessionToken === 'string' ? payload.sessionToken : undefined;
      try {
        const headers: Record<string, string> = {
          'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
          // Field mask — only return what we need (smaller bill).
          'X-Goog-FieldMask': 'id,displayName,formattedAddress,location',
        };
        let detailsUrl = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
        if (sessionToken) detailsUrl += `?sessionToken=${encodeURIComponent(sessionToken)}`;
        const res = await fetch(detailsUrl, { headers });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          return json({ ok: false, error: `google ${res.status}`, detail: txt.slice(0, 300) }, 502, cors);
        }
        const data: any = await res.json();
        return json({
          ok: true,
          place: {
            placeId: data.id,
            name: data.displayName?.text,
            address: data.formattedAddress,
            lat: data.location?.latitude,
            lon: data.location?.longitude,
          },
        }, 200, cors);
      } catch (err: any) {
        return json({ ok: false, error: 'google-fetch-failed', detail: String(err?.message || err).slice(0, 200) }, 502, cors);
      }
    }

    if (url.pathname === '/send-push') {
      // Any signed-in user. A followup phase should tighten this to
      // requireCoachOfTeam(payload.teamId) once every push call site
      // in the client plumbs teamId through — right now they don't.
      // The main exposure (unauthenticated bundle-scraped bearer)
      // closes just by requiring an ID token.
      await requireUser(req, env);
      if (!env.FCM_SERVICE_ACCOUNT) return json({ ok: false, error: 'fcm-not-configured' }, 503, cors);
      const tokens: string[] = Array.isArray(payload?.tokens) ? payload.tokens.filter((t: any) => typeof t === 'string' && t.length > 10) : [];
      const title: string = String(payload?.title || '').slice(0, 200);
      const body: string  = String(payload?.body  || '').slice(0, 500);
      if (tokens.length === 0) return json({ ok: false, error: 'no-tokens' }, 400, cors);
      if (!title) return json({ ok: false, error: 'no-title' }, 400, cors);
      if (tokens.length > 500) return json({ ok: false, error: 'too-many' }, 400, cors);
      // Badge count for iOS app icon + Android launcher. Absolute
      // integer, 0 to clear, undefined to leave the current badge
      // alone (right for non-message notifications).
      const badgeRaw = payload?.badge;
      const badge = typeof badgeRaw === 'number' && badgeRaw >= 0 && badgeRaw < 10000
        ? Math.round(badgeRaw)
        : undefined;
      const result = await sendPush(tokens, {
        title, body,
        url: payload?.url ? String(payload.url) : undefined,
        icon: payload?.icon ? String(payload.icon) : undefined,
        badge,
      }, env.FCM_SERVICE_ACCOUNT);
      return json(result, 200, cors);
    }

    // ---- AI drill generator -------------------------------------------
    // Coach types a one-liner ("first touch under pressure, 10 min, U10")
    // plus an optional topic + age band; GPT returns a structured drill
    // the coach reviews before saving to their library. We use OpenAI's
    // JSON mode (response_format) so the model is forced to emit valid
    // JSON — no regex parsing of free-form prose needed.
    // Guarded-write endpoints — sensitive Firestore mutations
    // (invite claim, team create, role change, etc.) that need
    // server-verified authorization. Each handler in
    // writeGuards.ts requires its own auth scope; returns null
    // when the pathname isn't one of ours so we fall through.
    {
      const guardResp = await routeWriteGuard(url.pathname, req, env, payload);
      if (guardResp) {
        const headers = new Headers(guardResp.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        return new Response(guardResp.body, { status: guardResp.status, headers });
      }
    }

    // Gametape (coach-assigned tactical clips) — separate dispatcher
    // rather than folding into routeWriteGuard so the module can own
    // its own Env keys (CLOUDFLARE_*) without dragging them through
    // every writeGuards handler signature.
    {
      const gametapeResp = await routeGametape(url.pathname, req, env, payload);
      if (gametapeResp) {
        const headers = new Headers(gametapeResp.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        return new Response(gametapeResp.body, { status: gametapeResp.status, headers });
      }
    }

    if (url.pathname === '/generate-drill') {
      await requireUser(req, env);
      if (!env.OPENAI_API_KEY) {
        return json({ ok: false, error: 'openai-not-configured' }, 503, cors);
      }
      const prompt = String(payload?.prompt || '').slice(0, 500).trim();
      const topic = String(payload?.topic || '').slice(0, 30);
      const ageBand = String(payload?.ageBand || 'all').slice(0, 16);
      if (!prompt) return json({ ok: false, error: 'no-prompt' }, 400, cors);

      // The literal word "json" must appear in the system prompt when
      // response_format: json_object is set — OpenAI enforces this.
      const systemMsg = [
        'You write youth soccer drills for U6–U17 coaches.',
        'Output STRICT json only — no prose, no markdown fences, no preamble.',
        'Schema:',
        '{',
        '  "title": string (5–10 words),',
        '  "topic": "dribbling" | "passing" | "shooting" | "first-touch" | "defending" | "goalkeeping" | "fitness" | "agility" | "tactical" | "other",',
        '  "category": "technical" | "tactical" | "physical" | "mental",',
        '  "setup": string (1–3 sentences, what cones/balls/players needed),',
        '  "instructions": string (3–6 numbered steps, "1) ... 2) ..." inline),',
        '  "focus": string (one sentence — the ONE coaching point to hammer),',
        '  "durationMinutes": integer (5–25)',
        '}',
        'Match the requested age band — simpler language and smaller spaces for younger.',
        'No music citations, no copyrighted brand names, no equipment the family probably does not have.',
      ].join('\n');

      const userMsg = `Coach wants: ${prompt}\nTopic hint: ${topic || 'unspecified'}\nAge band: ${ageBand}`;

      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            // gpt-4o-mini is the cheap-and-fast workhorse — comparable
            // quality to Haiku for structured tasks, ~$0.005 per drill.
            model: 'gpt-4o-mini',
            max_tokens: 800,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: systemMsg },
              { role: 'user', content: userMsg },
            ],
          }),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          return json({ ok: false, error: `openai ${res.status}`, detail: txt.slice(0, 300) }, 502, cors);
        }
        const data: any = await res.json();
        const text: string = data?.choices?.[0]?.message?.content || '';
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch (err: any) {
          return json({ ok: false, error: 'json-parse-failed', detail: String(err?.message || err).slice(0, 200), raw: text.slice(0, 300) }, 502, cors);
        }
        return json(parsed, 200, cors);
      } catch (err: any) {
        return json({ ok: false, error: 'openai-fetch-failed', detail: String(err?.message || err).slice(0, 200) }, 502, cors);
      }
    }

    if (url.pathname === '/generate-drill-diagram') {
      // Auth is deliberately looser here — admin backfill runs may
      // hit this via a service key rather than a user session. We
      // still require an X-Api-Key that matches ADMIN_API_KEY when
      // present, else require a user.
      const providedKey = req.headers.get('x-api-key') || '';
      if (env.ADMIN_API_KEY && providedKey && providedKey === env.ADMIN_API_KEY) {
        // service-to-service, no user gate
      } else {
        await requireUser(req, env);
      }
      const title = String(payload?.title || '').slice(0, 120).trim();
      const setup = String(payload?.setup || '').slice(0, 500).trim();
      const instructions = String(payload?.instructions || '').slice(0, 800).trim();
      const focus = String(payload?.focus || '').slice(0, 200).trim();
      const topic = String(payload?.topic || '').slice(0, 30);
      const ageBand = String(payload?.ageBand || 'all').slice(0, 16);
      // Modes:
      //   'library-then-ai' (default): try the hand-authored library
      //     first, fall back to AI generation for anything not in it.
      //   'library-only': manual library only. Drills not in the
      //     library get { diagram: null } so the caller can wipe the
      //     old AI-generated field. This is the mode Patrick uses
      //     when replacing the earlier AI batch with quality
      //     hand-authored diagrams for the seed drills.
      //   'ai-only': skip the library entirely and force AI. Escape
      //     hatch for debugging.
      const mode = payload?.mode === 'library-only'
        ? 'library-only'
        : payload?.mode === 'ai-only' ? 'ai-only' : 'library-then-ai';
      if (!title) return json({ ok: false, error: 'title-required' }, 400, cors);

      if (mode !== 'ai-only') {
        const { findManualDiagram } = await import('./drillDiagramLibrary');
        const manual = findManualDiagram(title);
        if (manual) {
          return json({ ok: true, diagram: manual, source: 'library' }, 200, cors);
        }
        if (mode === 'library-only') {
          // No manual entry + no AI fallback allowed. Caller should
          // set drill.diagram = null / delete the field.
          return json({ ok: true, diagram: null, source: 'not-in-library' }, 200, cors);
        }
      }

      if (!setup) return json({ ok: false, error: 'setup-required-for-ai-generation' }, 400, cors);
      if (!env.OPENAI_API_KEY) {
        return json({ ok: false, error: 'openai-not-configured' }, 503, cors);
      }

      const systemMsg = [
        'You are a youth-soccer chalkboard artist.',
        'Given a drill, output a compact json scene graph the app renders into a diagram.',
        'Only output strict json. No prose, no markdown, no fences.',
        '',
        'Coordinate system: origin top-left. x and y are floats 0..100 (percent of canvas).',
        'Canvas is landscape 400x240. Leave 8pt of margin — keep values in 5..95 unless the piece belongs on an edge (goal, sideline).',
        'For "half" pitch, the goal is at the top (small y); attack moves top-to-bottom-ish.',
        'For "grid" or "none", no goals — just cones marking the box.',
        '',
        'Schema:',
        '{',
        '  "field": "none" | "half" | "full" | "grid" | "circle",',
        '  "cones":     [ { "x": number, "y": number, "color": "orange" | "yellow" | "red" | "blue" } ],',
        '  "players":   [ { "x": number, "y": number, "team": "attack" | "defense" | "neutral" | "keeper", "label": string } ],',
        '  "balls":     [ { "x": number, "y": number } ],',
        '  "goals":     [ { "x": number, "y": number, "orientation": "n" | "s" | "e" | "w" } ],',
        '  "movements": [ { "from": {"x":number,"y":number}, "to": {"x":number,"y":number}, "type": "run" | "pass" | "dribble" | "shot", "label": string } ],',
        '  "caption": string',
        '}',
        '',
        'Rules:',
        '- Every list is optional; omit any that would be empty.',
        '- Player labels: 1-2 chars max (jersey number or role letter like "A" / "D" / "GK").',
        '- Movement labels: order number ("1","2","3") when steps happen in sequence, else leave blank.',
        '- Ball placement: put a ball at the feet of whichever attacker is starting with it.',
        '- Prefer 4-8 players total. Prefer 2-6 cones. Prefer 1-3 movements. Simple > cluttered.',
        '- Never invent equipment beyond cones, balls, players, goals.',
        '- caption: one short line (<= 60 chars) tying the diagram to the drill outcome.',
      ].join('\n');

      const userMsg = [
        `Title: ${title}`,
        `Topic: ${topic || 'unspecified'}`,
        `Age band: ${ageBand}`,
        `Setup: ${setup}`,
        instructions ? `Instructions: ${instructions}` : '',
        focus ? `Focus: ${focus}` : '',
      ].filter(Boolean).join('\n');

      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            max_tokens: 900,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: systemMsg },
              { role: 'user', content: userMsg },
            ],
          }),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          return json({ ok: false, error: `openai ${res.status}`, detail: txt.slice(0, 300) }, 502, cors);
        }
        const data: any = await res.json();
        const text: string = data?.choices?.[0]?.message?.content || '';
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch (err: any) {
          return json({ ok: false, error: 'json-parse-failed', detail: String(err?.message || err).slice(0, 200), raw: text.slice(0, 300) }, 502, cors);
        }
        // Light validation — the client-side renderer already
        // clamps out-of-range values, so we mostly just guard the
        // top-level shape so we don't store garbage on the drill.
        const spec = sanitizeDiagram(parsed);
        return json({ ok: true, diagram: spec, source: 'ai' }, 200, cors);
      } catch (err: any) {
        return json({ ok: false, error: 'openai-fetch-failed', detail: String(err?.message || err).slice(0, 200) }, 502, cors);
      }
    }

    return json({ ok: false, error: 'not-found' }, 404, cors);
}

// Trim any keys we don't recognize and coerce values to what the
// renderer expects. Anything the model misses gets an empty array,
// never undefined, so Firestore writes don't reject.
function sanitizeDiagram(raw: any): any {
  const field = ['none', 'half', 'full', 'grid', 'circle'].includes(raw?.field) ? raw.field : 'none';
  const num = (v: any) => (typeof v === 'number' && isFinite(v) ? v : 50);
  const str = (v: any, max = 80) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const point = (p: any) => ({ x: num(p?.x), y: num(p?.y) });

  const cones = Array.isArray(raw?.cones) ? raw.cones.slice(0, 20).map((c: any) => ({
    x: num(c?.x), y: num(c?.y),
    ...(str(c?.color, 10) ? { color: c.color } : {}),
  })) : [];
  const players = Array.isArray(raw?.players) ? raw.players.slice(0, 22).map((p: any) => {
    const label = str(p?.label, 3);
    return {
      x: num(p?.x), y: num(p?.y),
      team: ['attack', 'defense', 'neutral', 'keeper'].includes(p?.team) ? p.team : 'attack',
      ...(label ? { label } : {}),
    };
  }) : [];
  const balls = Array.isArray(raw?.balls) ? raw.balls.slice(0, 10).map((b: any) => ({ x: num(b?.x), y: num(b?.y) })) : [];
  const goals = Array.isArray(raw?.goals) ? raw.goals.slice(0, 2).map((g: any) => ({
    x: num(g?.x), y: num(g?.y),
    orientation: ['n', 's', 'e', 'w'].includes(g?.orientation) ? g.orientation : 'n',
  })) : [];
  const movements = Array.isArray(raw?.movements) ? raw.movements.slice(0, 12).map((m: any) => {
    const label = str(m?.label, 4);
    return {
      from: point(m?.from),
      to: point(m?.to),
      type: ['run', 'pass', 'dribble', 'shot'].includes(m?.type) ? m.type : 'run',
      ...(label ? { label } : {}),
    };
  }) : [];
  const caption = str(raw?.caption, 80);

  const out: any = { field };
  if (cones.length) out.cones = cones;
  if (players.length) out.players = players;
  if (balls.length) out.balls = balls;
  if (goals.length) out.goals = goals;
  if (movements.length) out.movements = movements;
  if (caption) out.caption = caption;
  return out;
}

async function scheduledHandler(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Three cron schedules per wrangler.toml:
    //   "0 22 * * SUN" — weekly digest (Sun 4pm MDT)
    //   "0 16 * * *"   — daily registration drips (10am MDT)
    //   "*/5 * * * *"  — campaign tick (in-app Mailchimp replacement)
    const cron = event.cron || '';

    // Gate happy-path cron logs on actual work-done, matching the
    // pattern used by runPotmAutoCreate/runDueCampaigns/runEventReminders
    // below. Prior version logged on every daily tick regardless of
    // whether any user's configured day matched today, which produced
    // dozens of empty-{} lines/day in Tail. Defensive: any recognized
    // counter or errors array triggers the log; unknown shape → log
    // (fail-loud beats silent regression on a new counter name).
    const cronHadWork = (r: any): boolean => {
      if (!r || typeof r !== 'object') return false;
      const counters = ['sent', 'sentEvents', 'processed', 'created', 'flipped', 'total'];
      for (const k of counters) {
        if (typeof r[k] === 'number' && r[k] > 0) return true;
      }
      if (Array.isArray(r.errors) && r.errors.length > 0) return true;
      // Unknown shape — err toward logging so a new counter name
      // doesn't silently hide real work.
      const knownKeys = new Set([...counters, 'errors', 'ok', 'skipped']);
      for (const k of Object.keys(r)) if (!knownKeys.has(k)) return true;
      return false;
    };
    const logIfWork = (tag: string) => (r: any) => {
      if (cronHadWork(r)) console.log(tag, JSON.stringify(r));
    };

    if (cron === '0 22 * * SUN') {
      // Retained: admin roundup runs once a week on Sunday. The
      // parent-facing digest moved to the daily tick below so coaches
      // can pick the day themselves.
      ctx.waitUntil(
        runAdminWeeklyRoundup(env).then(logIfWork('[cron] admin roundup'))
      );
    } else if (cron === '0 16 * * *') {
      ctx.waitUntil(
        runRegistrationDrips(env).then(logIfWork('[cron] registration drips'))
      );
      // Daily 10am MDT tick reads each team's config and fires the
      // parent digests only when the configured day matches today.
      // Team Wall summary + parent email digest both live here so
      // coaches control both from Team settings.
      ctx.waitUntil(
        runWeeklyTeamWallDigest(env).then(logIfWork('[cron] team-wall daily tick'))
      );
      ctx.waitUntil(
        runWeeklyDigest(env).then(logIfWork('[cron] email digest daily tick'))
      );
      // Defense-in-depth: flip subscriptionActive=false on auto-trial
      // users whose subscriptionExpiresAt is in the past. Rules already
      // block their writes, but useSubscription() on the client trusts
      // the flag and won't surface the paywall until the flag flips.
      ctx.waitUntil(
        runTrialExpirySweep(env).then(logIfWork('[cron] trial expiry sweep'))
      );
      // Post-game POTM auto-create. Scans events past their date but
      // within 48h, type=game, opt-outs honored, no existing voting,
      // creates match_voting + posts "Vote for Player of the Match"
      // wall CTA on behalf of the head coach. Coach can still
      // manually create; belt-and-suspenders guard picks that up.
      ctx.waitUntil(
        runPotmAutoCreate(env).then(r => {
          if (r.created > 0 || r.errors.length > 0) console.log('[cron] potm auto-create', JSON.stringify(r));
        })
      );
    } else if (cron === '*/5 * * * *') {
      // Campaign tick — only does work when scheduled campaigns are
      // due. Cheap to no-op on idle ticks (single Firestore query).
      ctx.waitUntil(
        runDueCampaigns(env).then(r => {
          if (r.processed > 0) console.log('[cron] campaigns', JSON.stringify(r));
        })
      );
      // 2-hour-before event reminders. Queries events in the
      // (now+110min, now+130min] window, skips any already stamped
      // reminderSentAt, sends one push per unique recipient with
      // pushPreferences.events not explicitly off. Idempotent via
      // the stamp so cron slop can't double-fire.
      ctx.waitUntil(
        runEventReminders(env).then(r => {
          if (r.sentEvents > 0 || r.errors.length > 0) console.log('[cron] event reminders', JSON.stringify(r));
        })
      );
    } else {
      // Unknown cron schedule — surface loudly so a stray wrangler.toml
      // entry can't silently re-fire the weekly digest off-cycle. Prior
      // version ran runWeeklyDigest here as a fallback, which was
      // exactly wrong (off-cycle sends + no error signal).
      console.error('[cron] unknown schedule; no handler ran', event.cron);
    }
}
