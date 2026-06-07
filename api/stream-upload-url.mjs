// Vercel serverless function: returns a one-time Direct Creator Upload URL for
// Cloudflare Stream. The browser POSTs the video file directly to that URL,
// CF Stream transcodes asynchronously, and we store the returned `uid` on the
// Firestore doc so the player can find it later.
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

const MAX_DURATION_SECONDS = 60 * 60 * 4; // 4 h cap per clip

export default async function handler(req, res) {
  // CORS must be set on EVERY response, not just preflight. The
  // Capacitor iOS shell makes cross-origin calls from
  // capacitor://localhost → firefc.app/api/... and the browser blocks
  // the response body without Access-Control-Allow-Origin. We use
  // Bearer auth (not cookies) so the wildcard origin is safe.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Auth
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Authorization Bearer token' });
    }
    let userClaims;
    try {
      userClaims = await verifyFirebaseToken(authHeader.slice(7));
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token', detail: e.message });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { fileName, size, name, playerId, teamId } = body;

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_STREAM_API_TOKEN;
    if (!accountId || !apiToken) {
      return res.status(500).json({ error: 'Server Stream config missing' });
    }

    // Stream expects "Upload-Length" + "Upload-Metadata" for TUS, but for the
    // simpler Direct Creator Upload (single POST from browser) we just create
    // the upload and Stream gives us back a URL the browser can multipart-POST
    // the file to.
    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/direct_upload`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          maxDurationSeconds: MAX_DURATION_SECONDS,
          // 1 hour expiry on the signed upload URL.
          expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          creator: userClaims.user_id || userClaims.sub,
          meta: {
            name: name || fileName || 'untitled',
            uploadedBy: userClaims.user_id || userClaims.sub,
            ...(playerId ? { playerId } : {}),
            ...(teamId ? { teamId } : {}),
          },
          // Pre-enable MP4 download so users can grab the original later.
          // (Re-enable on the video once it finishes processing — Stream
          // ignores this flag if set at create-time, but kept for clarity.)
          requireSignedURLs: false,
        }),
      }
    );

    const cfJson = await cfRes.json();
    if (!cfRes.ok || !cfJson?.success) {
      console.error('Stream direct_upload error:', cfJson);
      return res.status(502).json({ error: 'Cloudflare Stream rejected the upload', detail: cfJson });
    }

    return res.status(200).json({
      uploadURL: cfJson.result.uploadURL,
      uid: cfJson.result.uid,
    });
  } catch (err) {
    console.error('stream-upload-url error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}
