// Vercel serverless function: deletes a Cloudflare Stream video by uid.
//
// Called when the user deletes a highlight clip. Without this call the
// Stream video sits on Cloudflare's paid storage indefinitely — every
// deleted clip was a permanent orphan. Called AFTER the Firestore doc
// gets soft-deleted so a Stream-side failure doesn't leave a live
// video with no metadata pointing at it.
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Authorization Bearer token' });
    }
    try {
      await verifyFirebaseToken(authHeader.slice(7));
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token', detail: e.message });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const uid = String(body?.uid || '').trim();
    if (!uid) return res.status(400).json({ error: 'uid required' });

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_STREAM_API_TOKEN;
    if (!accountId || !apiToken) {
      return res.status(500).json({ error: 'Server Stream config missing' });
    }

    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${encodeURIComponent(uid)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiToken}` },
      }
    );

    // Idempotency: a 404 means the video was already deleted (or never
    // existed). Treat as success so the client never gets stuck on a
    // half-deleted state.
    if (cfRes.status === 404) {
      return res.status(200).json({ ok: true, alreadyGone: true });
    }
    if (!cfRes.ok) {
      const detail = await cfRes.text().catch(() => '');
      console.error('Stream delete error:', cfRes.status, detail);
      return res.status(502).json({ error: 'Cloudflare Stream refused delete', status: cfRes.status, detail: detail.slice(0, 300) });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('stream-delete error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}
