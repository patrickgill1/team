// Campaigns engine — fires scheduled email campaigns to filtered
// audience segments. Replaces Mailchimp for Patrick's own GoalKickr
// marketing emails. Authoring happens in goalkickr-admin; this
// worker owns the send pipeline, the unsubscribe endpoint, and the
// open-tracking pixel.
//
// Send model:
//   1. Cron tick reads campaigns/{id} where status='scheduled' and
//      scheduledFor <= now (or status='draft' AND scheduledFor==null
//      AND just-flipped to 'scheduled' via the admin portal).
//   2. Resolve the audience to a user list (Firestore query per
//      segment).
//   3. Filter out tier3 unsubscribers + missing emails.
//   4. Personalize subject + body with simple {{name}} substitution.
//   5. Send via /send-batch (Resend) in chunks.
//   6. Increment campaign counters; mark sent.
//
// Why audience resolution at send time (not at authoring):
//   The user list shifts between draft and send — new signups, new
//   unsubscribes, status changes. Storing the snapshot at authoring
//   means stale recipients. Resolving at send time costs one query
//   but guarantees freshness.

import { decodeFields } from './firestore';
import { ServiceAccount, parseServiceAccount, getAccessToken } from './fcm';

const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

export interface CampaignsEnv {
  FIREBASE_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT?: string;
  NOTIFY_SECRET?: string;
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
  FROM_NAME?: string;
  APP_ORIGIN?: string;
}

function getSa(env: CampaignsEnv): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try { return parseServiceAccount(env.FCM_SERVICE_ACCOUNT); } catch { return null; }
}

function projectId(env: CampaignsEnv): string | null {
  if (env.FIREBASE_PROJECT_ID) return env.FIREBASE_PROJECT_ID;
  return getSa(env)?.project_id || null;
}

// Tiny HMAC for unsubscribe + open-tracking tokens. Uses the
// NOTIFY_SECRET so we don't need a separate signing key. Format:
// base64url(uid:tier:expSeconds:sig) where sig = first 16 bytes of
// HMAC-SHA256(secret, uid:tier:expSeconds).
async function signToken(uid: string, tier: 'tier2' | 'tier3' | 'open', expSeconds: number, secret: string): Promise<string> {
  const payload = `${uid}:${tier}:${expSeconds}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf).slice(0, 16)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return btoa(`${payload}:${sig}`)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function verifyToken(token: string, secret: string): Promise<{ uid: string; tier: 'tier2' | 'tier3' | 'open' } | null> {
  try {
    const raw = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
    const parts = raw.split(':');
    if (parts.length !== 4) return null;
    const [uid, tier, expStr, sig] = parts;
    const exp = parseInt(expStr, 10);
    if (!Number.isFinite(exp)) return null;
    if (exp > 0 && Date.now() / 1000 > exp) return null;
    if (tier !== 'tier2' && tier !== 'tier3' && tier !== 'open') return null;
    const expected = await signToken(uid, tier as any, exp, secret);
    // Re-parse the expected token's sig — comparing the full token
    // is the simplest way; signToken is deterministic.
    if (token !== expected) return null;
    return { uid, tier: tier as 'tier2' | 'tier3' | 'open' };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// PUBLIC: build an unsubscribe link for a recipient + tier
// ─────────────────────────────────────────────────────────────
export async function buildUnsubscribeUrl(uid: string, tier: 'tier2' | 'tier3', env: CampaignsEnv): Promise<string> {
  const secret = env.NOTIFY_SECRET || '';
  // No expiry on unsub links — a user should always be able to
  // unsubscribe even from an old email. exp=0 means 'never'.
  const token = await signToken(uid, tier, 0, secret);
  const base = env.APP_ORIGIN?.replace(/\/$/, '') || 'https://api.goalkickr.com';
  return `${base}/u/${encodeURIComponent(token)}`;
}

export async function buildOpenPixelUrl(uid: string, campaignId: string, env: CampaignsEnv): Promise<string> {
  const secret = env.NOTIFY_SECRET || '';
  const token = await signToken(uid, 'open', 0, secret);
  const base = env.APP_ORIGIN?.replace(/\/$/, '') || 'https://api.goalkickr.com';
  return `${base}/o/${encodeURIComponent(campaignId)}/${encodeURIComponent(token)}.gif`;
}

// ─────────────────────────────────────────────────────────────
// HANDLER: GET /u/:token — flips the user's tier opt-out
// ─────────────────────────────────────────────────────────────
export async function handleUnsubscribe(request: Request, env: CampaignsEnv): Promise<Response> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/u\/(.+)$/);
  if (!m) return new Response('not found', { status: 404 });
  const token = decodeURIComponent(m[1]);
  const secret = env.NOTIFY_SECRET || '';
  const verified = await verifyToken(token, secret);
  if (!verified || verified.tier === 'open') {
    return new Response(unsubPage('Sorry — that unsubscribe link looks invalid or expired. Email support@goalkickr.com if you want help.'), {
      status: 400,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  const pid = projectId(env);
  const sa = getSa(env);
  if (!pid || !sa) {
    return new Response(unsubPage("We're hitting a hiccup processing your unsubscribe. Email support@goalkickr.com and we'll opt you out manually."), {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  try {
    const token = await getAccessToken(sa, FIRESTORE_SCOPE);
    const path = `users/${verified.uid}`;
    const mask = `updateMask.fieldPaths=emailPreferences.${verified.tier}&updateMask.fieldPaths=emailPreferences.lastUnsubscribedAt`;
    const body = {
      fields: {
        emailPreferences: {
          mapValue: {
            fields: {
              [verified.tier]: { booleanValue: false },
              lastUnsubscribedAt: { timestampValue: new Date().toISOString() },
            },
          },
        },
      },
    };
    const r = await fetch(
      `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents/${path}?${mask}`,
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!r.ok) {
      console.error('[unsubscribe] firestore patch failed', r.status, await r.text());
    }
  } catch (e) {
    console.error('[unsubscribe] write failed', (e as Error).message);
  }
  const tierLabel = verified.tier === 'tier2' ? 'club + team' : 'GoalKickr marketing';
  return new Response(unsubPage(
    `<h2>You're unsubscribed from ${tierLabel} emails.</h2>` +
    `<p>You'll still get transactional emails like password resets and billing receipts — those are required.</p>` +
    `<p>Changed your mind? <a href="${env.APP_ORIGIN || 'https://firefc.app'}/settings">Re-subscribe in Settings</a>.</p>`,
  ), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

// ─────────────────────────────────────────────────────────────
// HANDLER: GET /o/:campaignId/:token.gif — 1x1 transparent pixel
// Bumps the campaign's openCount + records the recipient.
// ─────────────────────────────────────────────────────────────
const PIXEL_BYTES = Uint8Array.from(atob(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
), c => c.charCodeAt(0));

export async function handleOpenPixel(request: Request, env: CampaignsEnv): Promise<Response> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/o\/([^/]+)\/(.+)\.gif$/);
  if (!m) return new Response('not found', { status: 404 });
  const campaignId = decodeURIComponent(m[1]);
  const token = decodeURIComponent(m[2]);
  const secret = env.NOTIFY_SECRET || '';
  const verified = await verifyToken(token, secret);
  // Always return the pixel even if the token is invalid — never
  // give a bot a 4xx that hints at our scheme. Just don't count.
  if (verified && verified.tier === 'open') {
    const pid = projectId(env);
    const sa = getSa(env);
    if (pid && sa) {
      // Fire-and-forget; openCount accuracy isn't worth blocking
      // the pixel response on.
      bumpCampaignOpenCount(pid, sa, campaignId).catch(() => {});
    }
  }
  return new Response(PIXEL_BYTES, {
    status: 200,
    headers: {
      'content-type': 'image/gif',
      'cache-control': 'no-store, no-cache, must-revalidate',
      'content-length': String(PIXEL_BYTES.byteLength),
    },
  });
}

async function bumpCampaignOpenCount(pid: string, sa: ServiceAccount, campaignId: string): Promise<void> {
  const token = await getAccessToken(sa, FIRESTORE_SCOPE);
  // Firestore REST doesn't expose FieldValue.increment cleanly via
  // PATCH; use commit with a transform op instead.
  const url = `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents:commit`;
  const body = {
    writes: [
      {
        transform: {
          document: `projects/${pid}/databases/(default)/documents/campaigns/${campaignId}`,
          fieldTransforms: [
            { fieldPath: 'openCount', increment: { integerValue: '1' } },
          ],
        },
      },
    ],
  };
  await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function unsubPage(html: string): string {
  return `<!doctype html>
<html><head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #0f172a; line-height: 1.6; }
    a { color: #dc2626; font-weight: 600; }
    h2 { font-size: 1.4rem; margin: 0 0 1rem; }
  </style>
</head><body>${html}</body></html>`;
}

// ─────────────────────────────────────────────────────────────
// CRON: process scheduled campaigns (called from worker scheduled handler)
// ─────────────────────────────────────────────────────────────

interface ResolvedRecipient {
  uid: string;
  email: string;
  name: string;
}

async function loadDueCampaigns(pid: string, sa: ServiceAccount): Promise<any[]> {
  const token = await getAccessToken(sa, FIRESTORE_SCOPE);
  const nowIso = new Date().toISOString();
  // status == 'scheduled' AND scheduledFor <= now. Composite filter
  // needs no index if both filters are on different fields (status
  // equality + scheduledFor inequality). Single-collection query.
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'campaigns' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'scheduled' } } },
            { fieldFilter: { field: { fieldPath: 'scheduledFor' }, op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: nowIso } } },
          ],
        },
      },
      limit: 10,
    },
  };
  const r = await fetch(
    `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) {
    console.error('[campaigns] load due failed', r.status, await r.text());
    return [];
  }
  const arr: any[] = await r.json();
  return arr.filter((row: any) => row.document).map((row: any) => ({
    id: String(row.document.name).split('/').pop(),
    name: row.document.name,
    data: decodeFields(row.document.fields || {}),
  }));
}

async function resolveAudience(pid: string, sa: ServiceAccount, audience: string): Promise<ResolvedRecipient[]> {
  const token = await getAccessToken(sa, FIRESTORE_SCOPE);
  const url = `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents:runQuery`;

  // Each audience segment is a separate structured query. Limit
  // generous; campaigns are infrequent and admin can split a bigger
  // send across multiple if needed.
  let filters: any[] = [];
  switch (audience) {
    case 'all-coaches':
      filters = [{ fieldFilter: { field: { fieldPath: 'role' }, op: 'IN', value: { arrayValue: { values: [{ stringValue: 'coach' }, { stringValue: 'team_manager' }] } } } }];
      break;
    case 'all-parents':
      filters = [{ fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: 'parent' } } }];
      break;
    case 'all-adult-players':
      // selfPlayerId is a string field; filter on it being set is tricky
      // without an index — instead query everyone and filter in memory.
      filters = [];
      break;
    case 'trial-expired':
      filters = [{ fieldFilter: { field: { fieldPath: 'subscriptionStatus' }, op: 'IN', value: { arrayValue: { values: [{ stringValue: 'trial_expired' }, { stringValue: 'canceled' }] } } } }];
      break;
    case 'past-due':
      filters = [{ fieldFilter: { field: { fieldPath: 'subscriptionStatus' }, op: 'EQUAL', value: { stringValue: 'past_due' } } }];
      break;
    case 'no-player-linked': {
      // Signed up >30d ago. Combine with parentIds emptiness in memory
      // post-fetch because Firestore can't filter on array length.
      const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
      filters = [
        { fieldFilter: { field: { fieldPath: 'createdAt' }, op: 'LESS_THAN', value: { timestampValue: cutoff } } },
        { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: 'parent' } } },
      ];
      break;
    }
    case 'all-users':
    case 'club-owners':
    default:
      filters = [];
      break;
  }

  const where = filters.length === 0 ? undefined
    : filters.length === 1 ? filters[0]
    : { compositeFilter: { op: 'AND', filters } };
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'users' }],
      ...(where ? { where } : {}),
      limit: 5000,
    },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    console.error('[campaigns] resolveAudience failed', audience, r.status);
    return [];
  }
  const arr: any[] = await r.json();
  let rows = arr.filter((row: any) => row.document).map((row: any) => {
    const data = decodeFields(row.document.fields || {});
    return {
      uid: String(row.document.name).split('/').pop() || '',
      email: typeof data.email === 'string' ? data.email : '',
      name: typeof data.name === 'string' ? data.name : '',
      _raw: data as any,
    };
  });

  // In-memory post-filters where Firestore couldn't express the
  // condition cleanly.
  if (audience === 'all-adult-players') {
    rows = rows.filter((r) => typeof r._raw.selfPlayerId === 'string' && r._raw.selfPlayerId.length > 0);
  }
  if (audience === 'no-player-linked') {
    rows = rows.filter((r) => {
      const kids = Array.isArray(r._raw.children) ? r._raw.children : [];
      return kids.length === 0;
    });
  }
  // Tier3 opt-out: drop anyone who unsubscribed from marketing.
  // Treat undefined as opted in (tier3 == undefined or true → keep).
  rows = rows.filter((r) => {
    const prefs = r._raw.emailPreferences || {};
    return prefs.tier3 !== false;
  });
  // Require a valid email.
  rows = rows.filter((r) => r.email && r.email.includes('@'));
  // Drop inactive users.
  rows = rows.filter((r) => r._raw.isActive !== false);

  return rows.map(({ uid, email, name }) => ({ uid, email, name }));
}

async function markCampaignSending(pid: string, sa: ServiceAccount, campaignId: string, recipientCount: number): Promise<void> {
  const token = await getAccessToken(sa, FIRESTORE_SCOPE);
  const url = `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents/campaigns/${campaignId}?updateMask.fieldPaths=status&updateMask.fieldPaths=recipientCount`;
  await fetch(url, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      fields: {
        status: { stringValue: 'sending' },
        recipientCount: { integerValue: String(recipientCount) },
      },
    }),
  });
}

async function markCampaignSent(pid: string, sa: ServiceAccount, campaignId: string, sentCount: number, failedCount: number): Promise<void> {
  const token = await getAccessToken(sa, FIRESTORE_SCOPE);
  const url = `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents/campaigns/${campaignId}?updateMask.fieldPaths=status&updateMask.fieldPaths=sentCount&updateMask.fieldPaths=failedCount&updateMask.fieldPaths=sentAt`;
  await fetch(url, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      fields: {
        status: { stringValue: 'sent' },
        sentCount: { integerValue: String(sentCount) },
        failedCount: { integerValue: String(failedCount) },
        sentAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });
}

function wrapBody(bodyHtml: string, opts: {
  recipientName: string;
  openPixelUrl: string;
  unsubUrl: string;
  appOrigin: string;
}): string {
  const personalized = bodyHtml.replace(/\{\{\s*name\s*\}\}/g, opts.recipientName || 'Coach');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>GoalKickr</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,system-ui,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f6f8;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <tr><td style="padding:24px 28px 8px;">
          <div style="font-size:11px;font-weight:800;letter-spacing:2px;color:#dc2626;text-transform:uppercase;">GoalKickr</div>
        </td></tr>
        <tr><td style="padding:8px 28px 24px;font-size:15px;line-height:1.6;color:#0f172a;">
          ${personalized}
        </td></tr>
        <tr><td style="padding:18px 28px 24px;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0;">
          Don't want these emails? <a href="${opts.unsubUrl}" style="color:#64748b;text-decoration:underline;">Unsubscribe</a>.
        </td></tr>
      </table>
    </td></tr>
  </table>
  <img src="${opts.openPixelUrl}" alt="" width="1" height="1" style="display:block;border:0;width:1px;height:1px;" />
</body></html>`;
}

async function sendViaResend(env: CampaignsEnv, messages: Array<{ to: string; subject: string; html: string }>): Promise<number> {
  if (!env.RESEND_API_KEY) return 0;
  // Resend's /emails/batch supports up to 100 per call.
  let sent = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100).map((m) => ({
      from: `${env.FROM_NAME || 'GoalKickr'} <${env.FROM_EMAIL || 'noreply@goalkickr.com'}>`,
      to: m.to,
      subject: m.subject,
      html: m.html,
    }));
    const r = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(chunk),
    });
    if (r.ok) {
      sent += chunk.length;
    } else {
      console.error('[campaigns] resend batch failed', r.status, (await r.text()).slice(0, 300));
    }
  }
  return sent;
}

export async function runDueCampaigns(env: CampaignsEnv): Promise<{ processed: number; sent: number; failed: number }> {
  const pid = projectId(env);
  const sa = getSa(env);
  if (!pid || !sa) return { processed: 0, sent: 0, failed: 0 };

  const due = await loadDueCampaigns(pid, sa);
  if (due.length === 0) return { processed: 0, sent: 0, failed: 0 };

  let totalSent = 0;
  let totalFailed = 0;
  for (const c of due) {
    const data = c.data;
    try {
      const audience = String(data.audience || 'all-users');
      const recipients = await resolveAudience(pid, sa, audience);
      await markCampaignSending(pid, sa, c.id, recipients.length);

      // Build personalized messages.
      const messages: Array<{ to: string; subject: string; html: string }> = [];
      for (const r of recipients) {
        const unsubUrl = await buildUnsubscribeUrl(r.uid, 'tier3', env);
        const openPixelUrl = await buildOpenPixelUrl(r.uid, c.id, env);
        const html = wrapBody(String(data.bodyHtml || ''), {
          recipientName: r.name,
          openPixelUrl,
          unsubUrl,
          appOrigin: env.APP_ORIGIN || 'https://firefc.app',
        });
        const subject = String(data.subject || 'A note from GoalKickr')
          .replace(/\{\{\s*name\s*\}\}/g, r.name || 'Coach');
        messages.push({ to: r.email, subject, html });
      }

      const sent = await sendViaResend(env, messages);
      const failed = messages.length - sent;
      await markCampaignSent(pid, sa, c.id, sent, failed);
      totalSent += sent;
      totalFailed += failed;
      console.log(`[campaigns] sent ${sent}/${messages.length} for ${c.id} (audience=${audience})`);
    } catch (e) {
      console.error('[campaigns] failed campaign', c.id, (e as Error).message);
      totalFailed += 1;
    }
  }
  return { processed: due.length, sent: totalSent, failed: totalFailed };
}
