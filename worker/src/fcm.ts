/**
 * Firebase Cloud Messaging (HTTP v1) helper for Cloudflare Workers.
 *
 * Setup (do this once):
 *   1. Firebase console → Project settings → Service accounts → Generate new private key.
 *   2. wrangler secret put FCM_SERVICE_ACCOUNT  (paste the entire JSON)
 *   3. Add `FCM_PROJECT_ID` to wrangler.toml [vars] OR rely on the JSON's project_id.
 */

interface ServiceAccount {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
}

let cachedToken: { token: string; exp: number } | null = null;

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

function base64UrlEncode(input: ArrayBuffer | string): string {
  let bin: string;
  if (typeof input === 'string') {
    bin = btoa(unescape(encodeURIComponent(input)));
  } else {
    const bytes = new Uint8Array(input);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    bin = btoa(s);
  }
  return bin.replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };

  const headerEnc = base64UrlEncode(JSON.stringify(header));
  const claimEnc = base64UrlEncode(JSON.stringify(claim));
  const signingInput = `${headerEnc}.${claimEnc}`;

  const keyData = pemToArrayBuffer(sa.private_key);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${base64UrlEncode(sigBuf)}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`token exchange failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const data: any = await res.json();
  cachedToken = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return data.access_token;
}

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  icon?: string;
}

export interface PushResult { ok: boolean; sent: number; failed: number; invalidTokens: string[]; errors?: any[] }

export async function sendPush(tokens: string[], msg: PushMessage, serviceAccountJson: string): Promise<PushResult> {
  if (!serviceAccountJson) return { ok: false, sent: 0, failed: tokens.length, invalidTokens: [], errors: ['no-service-account'] };
  let sa: ServiceAccount;
  try { sa = JSON.parse(serviceAccountJson); }
  catch { return { ok: false, sent: 0, failed: tokens.length, invalidTokens: [], errors: ['bad-json'] }; }

  const accessToken = await getAccessToken(sa);
  const projectId = sa.project_id;
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  const invalidTokens: string[] = [];
  const errors: any[] = [];
  let sent = 0;

  // FCM v1 only sends to one token per call; loop sequentially (volumes are tiny).
  for (const token of tokens) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: msg.title, body: msg.body },
            webpush: {
              fcm_options: msg.url ? { link: msg.url } : undefined,
              notification: { icon: msg.icon || '/images/logo.png' },
            },
            data: msg.url ? { url: msg.url } : undefined,
          },
        }),
      });
      if (res.ok) { sent++; continue; }
      const data: any = await res.json().catch(() => ({}));
      const errStatus = data?.error?.status;
      // UNREGISTERED / NOT_FOUND / INVALID_ARGUMENT (for token) → mark token as dead
      if (errStatus === 'UNREGISTERED' || errStatus === 'NOT_FOUND' || res.status === 404) {
        invalidTokens.push(token);
      } else {
        errors.push({ token: token.slice(0, 12) + '…', status: errStatus, http: res.status });
      }
    } catch (e: any) {
      errors.push({ error: String(e?.message || e) });
    }
  }

  return { ok: true, sent, failed: tokens.length - sent, invalidTokens, errors: errors.length ? errors : undefined };
}
