/**
 * Fire FC16 mailer — Cloudflare Worker
 *
 * Endpoints:
 *   POST /send         { to, subject, html, text? }            single
 *   POST /send-batch   { messages: [{ to, subject, html, text? }] }
 *   GET  /health
 *
 * Auth: every request needs `Authorization: Bearer <NOTIFY_SECRET>`.
 * The same secret must be set in the React app's env as REACT_APP_NOTIFY_SECRET.
 *
 * Email transport: Resend (https://resend.com). Free tier 3k/month, 100/day.
 *   Requires a verified domain in Resend with the DNS records they generate
 *   (SPF/DKIM as TXT in Cloudflare DNS for firefc16.com).
 *
 * Cron: weekly digest will be added once Firestore wiring is in place.
 */

export interface Env {
  NOTIFY_SECRET: string;
  RESEND_API_KEY: string;
  FROM_EMAIL: string;
  FROM_NAME: string;
  APP_ORIGIN: string;
  ALLOWED_ORIGINS: string;
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

    return json({ ok: false, error: 'not-found' }, 404, cors);
  },

  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Weekly digest stub. Will be wired up to Firestore in a follow-up commit.
    // Need: Firebase Admin REST or a callable on the app side that the worker pings,
    // since workers can't run the firebase-admin SDK directly.
    console.log('[cron] weekly digest tick — not yet wired');
  },
};
