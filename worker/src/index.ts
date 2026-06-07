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

import { sendPush } from './fcm';
import { runWeeklyDigest } from './digest';

export interface Env {
  NOTIFY_SECRET: string;
  RESEND_API_KEY: string;
  FROM_EMAIL: string;
  FROM_NAME: string;
  APP_ORIGIN: string;
  ALLOWED_ORIGINS: string;
  FCM_SERVICE_ACCOUNT?: string;
  GOOGLE_PLACES_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(req, env);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return json({ ok: true, from: env.FROM_EMAIL }, 200, cors);
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

    if (url.pathname === '/send') {
      const result = await sendOne(payload as MailMessage, env);
      return json(result, result.ok ? 200 : 502, cors);
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
    // plus an optional topic + age band; Claude returns a structured
    // drill the coach reviews before saving to their library. We force
    // tool-style structured output by asking for strict JSON in the
    // system prompt + parsing the first JSON object out of the response.
    if (url.pathname === '/generate-drill') {
      if (!env.ANTHROPIC_API_KEY) {
        return json({ ok: false, error: 'anthropic-not-configured' }, 503, cors);
      }
      const prompt = String(payload?.prompt || '').slice(0, 500).trim();
      const topic = String(payload?.topic || '').slice(0, 30);
      const ageBand = String(payload?.ageBand || 'all').slice(0, 16);
      if (!prompt) return json({ ok: false, error: 'no-prompt' }, 400, cors);

      const systemMsg = [
        'You write youth soccer drills for U6–U17 coaches.',
        'Output STRICT JSON only — no prose, no markdown fences, no preamble.',
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
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 800,
            system: systemMsg,
            messages: [{ role: 'user', content: userMsg }],
          }),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          return json({ ok: false, error: `anthropic ${res.status}`, detail: txt.slice(0, 300) }, 502, cors);
        }
        const data: any = await res.json();
        const text: string = data?.content?.[0]?.text || '';
        // Extract first JSON object out of the response in case the
        // model accidentally adds whitespace / a leading newline.
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end < 0 || end <= start) {
          return json({ ok: false, error: 'no-json-in-response', raw: text.slice(0, 300) }, 502, cors);
        }
        let parsed: any;
        try {
          parsed = JSON.parse(text.slice(start, end + 1));
        } catch (err: any) {
          return json({ ok: false, error: 'json-parse-failed', detail: String(err?.message || err).slice(0, 200), raw: text.slice(0, 300) }, 502, cors);
        }
        return json(parsed, 200, cors);
      } catch (err: any) {
        return json({ ok: false, error: 'anthropic-fetch-failed', detail: String(err?.message || err).slice(0, 200) }, 502, cors);
      }
    }

    return json({ ok: false, error: 'not-found' }, 404, cors);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Weekly digest — enabled via wrangler.toml [triggers] crons.
    ctx.waitUntil(
      runWeeklyDigest(env).then(r => console.log('[cron] weekly digest', JSON.stringify(r)))
    );
  },
};
