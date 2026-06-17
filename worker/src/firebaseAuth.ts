/**
 * Firebase Auth helpers — Cloudflare Worker / Web Crypto.
 *
 * Two purposes:
 *  1) `verifyIdToken(idToken, projectId)` — verify a Firebase ID token issued
 *     by Firebase Auth (typically from the native @capacitor-firebase
 *     /authentication plugin's getIdToken call) by validating its RS256
 *     signature against Google's published JWKS and checking the standard
 *     claims (iss/aud/exp/sub). Returns the decoded payload if valid.
 *
 *  2) `mintCustomToken(uid, sa)` — produce a Firebase Custom Token signed
 *     by the project's service account. Web SDK can sign in with it via
 *     `signInWithCustomToken(auth, token)`. Used to bridge native Firebase
 *     Auth (Keychain-backed on iOS, Keystore on Android) into the Web
 *     SDK after a WebView reload — so the cool auto-update splash can
 *     reload mid-session without nuking the user's session.
 *
 * Same RS256 + crypto.subtle pattern as `fcm.ts` so we're not bringing in
 * any new dependencies; fcm's helpers (`getAccessToken`, `pemToArrayBuffer`,
 * `base64UrlEncode`) are factored out and reused.
 */

import { ServiceAccount } from './fcm';

// Re-implemented here (matching fcm.ts) so this module is independently
// usable and easy to test. The two implementations should stay in sync;
// if you change one, change the other.
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

function base64UrlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

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

// ── Custom token minting (for signing the Web SDK in) ───────────────────

const CUSTOM_TOKEN_AUDIENCE =
  'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

export interface MintCustomTokenOptions {
  /** Optional custom claims to embed (visible to Firestore rules). */
  claims?: Record<string, unknown>;
  /** Token lifetime in seconds (max 3600). Defaults to 3600. */
  ttlSeconds?: number;
}

export async function mintCustomToken(
  uid: string,
  sa: ServiceAccount,
  opts: MintCustomTokenOptions = {},
): Promise<string> {
  if (!uid) throw new Error('uid-required');
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(Math.max(opts.ttlSeconds || 3600, 60), 3600);

  const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id };
  const payload: Record<string, unknown> = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: CUSTOM_TOKEN_AUDIENCE,
    uid,
    iat: now,
    exp: now + ttl,
  };
  if (opts.claims && Object.keys(opts.claims).length > 0) {
    payload.claims = opts.claims;
  }

  const headerEnc = base64UrlEncode(JSON.stringify(header));
  const payloadEnc = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerEnc}.${payloadEnc}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(sigBuf)}`;
}

// ── ID token verification ───────────────────────────────────────────────

// Google's JWKS for Firebase ID tokens. Returns JWKs in standard JSON Web
// Key format which crypto.subtle.importKey understands directly — no X.509
// parsing required.
const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

interface JwksCache {
  byKid: Record<string, JsonWebKey>;
  expiresAt: number;
}
let jwksCache: JwksCache | null = null;

async function getJwks(): Promise<Record<string, JsonWebKey>> {
  const now = Math.floor(Date.now() / 1000);
  if (jwksCache && jwksCache.expiresAt > now + 30) {
    return jwksCache.byKid;
  }
  const res = await fetch(FIREBASE_JWKS_URL);
  if (!res.ok) throw new Error(`jwks-fetch-${res.status}`);
  const json: any = await res.json();
  if (!json || !Array.isArray(json.keys)) throw new Error('jwks-shape-bad');
  const byKid: Record<string, JsonWebKey> = {};
  for (const k of json.keys) {
    if (k && typeof k.kid === 'string') byKid[k.kid] = k;
  }
  const cacheControl = res.headers.get('cache-control') || '';
  const m = cacheControl.match(/max-age=(\d+)/);
  const maxAge = m ? parseInt(m[1], 10) : 3600;
  jwksCache = { byKid, expiresAt: now + maxAge };
  return byKid;
}

export interface VerifiedIdToken {
  uid: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  signInProvider?: string;
  // Raw payload too, in case the caller wants more.
  payload: Record<string, unknown>;
}

export async function verifyIdToken(
  idToken: string,
  projectId: string,
): Promise<VerifiedIdToken> {
  if (!idToken || typeof idToken !== 'string') throw new Error('id-token-required');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed-jwt');
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
  if (header.alg !== 'RS256') throw new Error('unsupported-algorithm');
  if (header.typ && header.typ !== 'JWT') throw new Error('unsupported-type');
  if (!header.kid || typeof header.kid !== 'string') throw new Error('missing-kid');

  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now) throw new Error('token-expired');
  if (payload.iat && payload.iat > now + 60) throw new Error('token-not-yet-valid');
  if (payload.aud !== projectId) throw new Error('invalid-audience');
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;
  if (payload.iss !== expectedIssuer) throw new Error('invalid-issuer');
  if (!payload.sub || typeof payload.sub !== 'string') throw new Error('missing-subject');
  if (payload.auth_time && payload.auth_time > now) throw new Error('invalid-auth-time');

  const jwks = await getJwks();
  const jwk = jwks[header.kid];
  if (!jwk) {
    // Maybe the key just rotated — clear cache and try one more time.
    jwksCache = null;
    const retry = await getJwks();
    const j2 = retry[header.kid];
    if (!j2) throw new Error('unknown-kid');
    return finishVerification(j2, parts, payload);
  }
  return finishVerification(jwk, parts, payload);
}

async function finishVerification(
  jwk: JsonWebKey,
  parts: [string, string, string] | string[],
  payload: any,
): Promise<VerifiedIdToken> {
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64UrlDecode(parts[2]);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature,
    signingInput,
  );
  if (!ok) throw new Error('invalid-signature');

  return {
    uid: payload.sub,
    email: payload.email,
    email_verified: payload.email_verified,
    name: payload.name,
    picture: payload.picture,
    signInProvider: payload.firebase?.sign_in_provider,
    payload,
  };
}
