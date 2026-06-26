/**
 * Fire FC16 mailer — Cloudflare Worker
 *
 * Endpoints:
 *   POST /send         { to, subject, html, text? }            single email
 *   POST /send-batch   { messages: [{ to, subject, html, text? }] }
 *   POST /send-push    { tokens: string[], title, body, url?, icon? }
 *   GET  /health
 *
 * Auth: every request needs `Authorization: Bearer <NOTIFY_SECRET>`.
 */

import { sendPush, parseServiceAccount } from './fcm';
import { verifyIdToken, mintCustomToken } from './firebaseAuth';
import { runWeeklyDigest } from './digest';
import { runRegistrationDrips } from './drips';
import { runAdminWeeklyRoundup } from './adminDigest';
import {
  handleConnectStart,
  handleConnectFinish,
  handleConnectDisconnect,
  handleRegistrationCheckout,
  handleRegistrationRefund,
  handleSubscriptionCheckout,
  handleFounderCount,
  handleCustomerPortal,
  handleWebhook,
} from './stripe';
import { handleWidgetRequest } from './widget';
import { handleParentEmailPrecheck } from './precheck';
import { logWorkerError } from './errorLog';

export interface Env {
  NOTIFY_SECRET: string;
  RESEND_API_KEY: string;
  FROM_EMAIL: string;
  FROM_NAME: string;
  APP_ORIGIN: string;
  ALLOWED_ORIGINS: string;
  FCM_SERVICE_ACCOUNT?: string;
  FIREBASE_PROJECT_ID?: string;
  GOOGLE_PLACES_API_KEY?: string;
  OPENAI_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_CONNECT_CLIENT_ID?: string;
  STRIPE_WEBHOOK_SECRET?: string;
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

function authed(req: Request, env: Env): boolean {
  const h = req.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return !!m && m[1] === env.NOTIFY_SECRET;
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
    const url = new URL(req.url);
    await logWorkerError(env, {
      err,
      workerRoute: url.pathname,
      url: req.url,
      status: 500,
    }).catch(() => { /* never throw */ });
    const cors = corsHeaders(req, env);
    return new Response(JSON.stringify({ ok: false, error: 'internal' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
    });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return safeFetch(req, env);
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

    if (!authed(req, env)) {
      return json({ ok: false, error: 'unauthorized' }, 401, cors);
    }

    if (req.method !== 'POST') {
      return json({ ok: false, error: 'method-not-allowed' }, 405, cors);
    }

    // /run-digest takes no body — handle it before requiring JSON parse.
    if (url.pathname === '/run-digest') {
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
    // says — same identity, just a different token format.
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
      const result = await sendOne(payload as MailMessage, env);
      return json(result, result.ok ? 200 : 502, cors);
    }

    if (url.pathname === '/stripe/connect/finish') {
      const res = await handleConnectFinish(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    if (url.pathname === '/stripe/connect/disconnect') {
      const res = await handleConnectDisconnect(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    if (url.pathname === '/stripe/registration-checkout') {
      const res = await handleRegistrationCheckout(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    if (url.pathname === '/stripe/registration-refund') {
      const res = await handleRegistrationRefund(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // Stripe Billing Customer Portal session — gated behind the
    // bearer because callers send their stripeCustomerId in the
    // clear and we don't want a random someone minting portal links
    // for someone else's customer id.
    if (url.pathname === '/stripe/customer-portal') {
      const res = await handleCustomerPortal(payload, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    if (url.pathname === '/send-batch') {
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
      if (!env.FCM_SERVICE_ACCOUNT) return json({ ok: false, error: 'fcm-not-configured' }, 503, cors);
      const tokens: string[] = Array.isArray(payload?.tokens) ? payload.tokens.filter((t: any) => typeof t === 'string' && t.length > 10) : [];
      const title: string = String(payload?.title || '').slice(0, 200);
      const body: string  = String(payload?.body  || '').slice(0, 500);
      if (tokens.length === 0) return json({ ok: false, error: 'no-tokens' }, 400, cors);
      if (!title) return json({ ok: false, error: 'no-title' }, 400, cors);
      if (tokens.length > 500) return json({ ok: false, error: 'too-many' }, 400, cors);
      const result = await sendPush(tokens, {
        title, body,
        url: payload?.url ? String(payload.url) : undefined,
        icon: payload?.icon ? String(payload.icon) : undefined,
      }, env.FCM_SERVICE_ACCOUNT);
      return json(result, 200, cors);
    }

    // ---- AI drill generator -------------------------------------------
    // Coach types a one-liner ("first touch under pressure, 10 min, U10")
    // plus an optional topic + age band; GPT returns a structured drill
    // the coach reviews before saving to their library. We use OpenAI's
    // JSON mode (response_format) so the model is forced to emit valid
    // JSON — no regex parsing of free-form prose needed.
    if (url.pathname === '/generate-drill') {
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

    return json({ ok: false, error: 'not-found' }, 404, cors);
}

async function scheduledHandler(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Two cron schedules per wrangler.toml — route by the cron string:
    //   "0 22 * * SUN" — weekly digest (Sun 4pm MDT)
    //   "0 16 * * *"   — daily registration drips (10am MDT)
    const cron = event.cron || '';
    if (cron === '0 22 * * SUN') {
      ctx.waitUntil(
        runWeeklyDigest(env).then(r => console.log('[cron] weekly digest', JSON.stringify(r)))
      );
      ctx.waitUntil(
        runAdminWeeklyRoundup(env).then(r => console.log('[cron] admin roundup', JSON.stringify(r)))
      );
    } else if (cron === '0 16 * * *') {
      ctx.waitUntil(
        runRegistrationDrips(env).then(r => console.log('[cron] registration drips', JSON.stringify(r)))
      );
    } else {
      // Unknown cron — run digest as a safe default so we don't lose
      // the weekly send if Cloudflare hands us a slightly different
      // string format.
      ctx.waitUntil(
        runWeeklyDigest(env).then(r => console.log('[cron] (unknown) digest', JSON.stringify(r)))
      );
    }
}
