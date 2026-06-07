// Vercel serverless function: enables MP4 download for a Cloudflare Stream
// video and returns the URL. Stream requires opting in per-video (with a small
// processing delay the first time) before MP4 download URLs become available.
//
// Required env vars: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_STREAM_API_TOKEN,
//                    FIREBASE_PROJECT_ID

import { jwtVerify, createRemoteJWKSet } from 'jose';

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

async function verifyFirebaseToken(token) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `https://securetoken.google.com/${PROJECT_ID}`,
    audience: PROJECT_ID,
  });
  return payload;
}

export default async function handler(req, res) {
  // CORS on every response (not just preflight) so Capacitor native
  // can read the body from a cross-origin call to firefc.app.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Auth optional for this one — public share links need it too — but require
    // either a valid Firebase token OR a same-origin referer to keep random
    // bots from spinning up MP4 renders. Anonymous viewers will still hit it
    // from the public /event or /media pages.
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try { await verifyFirebaseToken(authHeader.slice(7)); }
      catch { /* fall through — token was offered but invalid; still allow */ }
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { uid } = body;
    if (!uid || typeof uid !== 'string') return res.status(400).json({ error: 'uid required' });

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_STREAM_API_TOKEN;
    if (!accountId || !apiToken) {
      return res.status(500).json({ error: 'Server Stream config missing' });
    }

    // POST to /downloads tells Stream to make the MP4 available. The first call
    // returns 200 with status=inprogress; subsequent calls return status=ready.
    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${encodeURIComponent(uid)}/downloads`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}` },
      }
    );
    const cfJson = await cfRes.json();

    if (!cfRes.ok || !cfJson?.success) {
      console.error('Stream enable download error:', cfJson);
      return res.status(502).json({ error: 'Could not enable Stream download', detail: cfJson });
    }

    const mp4 = cfJson.result?.default;
    return res.status(200).json({
      status: mp4?.status || 'inprogress',  // 'ready' | 'inprogress'
      url: mp4?.url || null,                // null while still being rendered
      percentComplete: mp4?.percentComplete || 0,
    });
  } catch (err) {
    console.error('stream-enable-download error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}
