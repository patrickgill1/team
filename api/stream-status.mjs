// Vercel serverless function: reports readiness of a Cloudflare Stream
// video so the client can gate iframe mount on transcode-complete.
//
// The failure this endpoint prevents: CF Stream's customer-subdomain
// endpoints (`/manifest/video.mpd`, `/metadata/playerEnhancementInfo.json`)
// return HTTP 500 *without* an Access-Control-Allow-Origin header during
// the brief window between upload-bytes-accepted and transcode-registered.
// If we mount the iframe eagerly, the SDK inside racing that window fires
// CORS errors to the console and shows a broken player.
//
// The bulletproof flow:
//   1. Client uploads bytes to CF via /api/stream-upload-url + XHR.
//   2. Client polls this endpoint every ~3s until `ready:true`.
//   3. THEN the iframe mounts. No pre-ready fetches, no CORS noise.
//
// Belt-and-suspenders: if the video's `allowedOrigins` is empty (a
// symptom of the Vercel deploy racing an upload before the fix landed),
// we PATCH it to ["*"] before returning. Costs one extra API call in a
// failure mode we know we hit at least once in prod.
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
  // CORS on every response so Capacitor native reads the body.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Auth: readiness itself isn't a secret, but we require a valid
    // Firebase token so bots can't burn CF API quota probing us.
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Authorization Bearer token' });
    }
    try {
      await verifyFirebaseToken(authHeader.slice(7));
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token', detail: e.message });
    }

    // uid can arrive on the query string (GET) or in a JSON body (POST).
    let uid = '';
    if (req.method === 'GET') {
      uid = String(req.query?.uid || '').trim();
    } else {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      uid = String(body?.uid || '').trim();
    }
    if (!uid) return res.status(400).json({ error: 'uid required' });

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_STREAM_API_TOKEN;
    if (!accountId || !apiToken) {
      return res.status(500).json({ error: 'Server Stream config missing' });
    }

    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${encodeURIComponent(uid)}`,
      { headers: { Authorization: `Bearer ${apiToken}` } }
    );
    const cfJson = await cfRes.json().catch(() => ({}));

    if (cfRes.status === 404 || cfJson?.errors?.some((e) => e?.code === 10005)) {
      // Video not found — treat as "not ready yet" so the client keeps
      // polling briefly (bytes may still be being registered) instead of
      // hard-failing. The client's poll ceiling stops the loop.
      return res.status(200).json({ ok: true, ready: false, pctComplete: 0, allowedOrigins: [], notFound: true });
    }
    if (!cfRes.ok || !cfJson?.success) {
      console.error('Stream status error:', cfRes.status, cfJson);
      return res.status(502).json({ error: 'Cloudflare Stream status query failed', detail: cfJson });
    }

    const result = cfJson.result || {};
    const readyToStream = Boolean(result.readyToStream);
    const state = result.status?.state || 'unknown';
    const pctComplete = Number(result.status?.pctComplete);
    const allowedOrigins = Array.isArray(result.allowedOrigins) ? result.allowedOrigins : [];

    // Belt-and-suspenders re-patch. If the video was created by a stale
    // Vercel deploy that shipped without allowedOrigins:["*"], the
    // customer-subdomain endpoints will emit no ACAO header and the
    // browser will block the iframe. Silently correct it here on the
    // next readiness poll so the coach never sees the CORS wall.
    if (!allowedOrigins || allowedOrigins.length === 0) {
      try {
        await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${encodeURIComponent(uid)}`,
          {
            method: 'POST', // CF Stream uses POST for "update video" here
            headers: {
              Authorization: `Bearer ${apiToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ allowedOrigins: ['*'] }),
          }
        );
      } catch (patchErr) {
        // Non-fatal — we still return the current readiness. The next
        // poll will retry the patch if it didn't stick.
        console.warn('Stream allowedOrigins re-patch failed', patchErr);
      }
    }

    return res.status(200).json({
      ok: true,
      ready: readyToStream,
      pctComplete: Number.isFinite(pctComplete) ? pctComplete : (readyToStream ? 100 : 0),
      state,
      allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : ['*'],
    });
  } catch (err) {
    console.error('stream-status error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}
