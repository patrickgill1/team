// Vercel serverless function: returns a one-time Direct Creator Upload URL for
// Cloudflare Stream. The browser POSTs the video file directly to that URL,
// CF Stream transcodes asynchronously, and we store the returned `uid` on the
// Firestore doc so the player can find it later.
//
// Required env vars: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_STREAM_API_TOKEN,
//                    FIREBASE_PROJECT_ID

import { jwtVerify, createRemoteJWKSet } from 'jose';
import { checkPaidCoach } from './_lib/subscription.mjs';

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
// Gametape clips are intentionally short so parents actually watch.
// Server-enforced belt to the client probeVideoDuration suspenders in
// GametapeComposeModal. Kept in sync with worker/src/gametape.ts
// createStreamDirectUpload maxDurationSeconds.
const GAMETAPE_MAX_DURATION_SECONDS = 90;

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
    const { fileName, size, name, playerId, teamId, feature, useTus } = body;

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_STREAM_API_TOKEN;
    if (!accountId || !apiToken) {
      return res.status(500).json({ error: 'Server Stream config missing' });
    }

    // Feature gate — Gametape uploads must be short and paid-Coach-only.
    // Any other value (including undefined) falls through to the legacy
    // 4-hour cap the drill/highlight flows depend on.
    const isGametape = feature === 'gametape';
    if (isGametape) {
      try {
        const paid = await checkPaidCoach(userClaims.user_id || userClaims.sub);
        if (!paid.ok) {
          return res.status(402).json({ error: 'paid_coach_required', reason: paid.reason });
        }
      } catch (e) {
        console.error('paid-coach check failed:', e);
        return res.status(500).json({ error: 'subscription_check_failed', detail: e.message });
      }
    }

    // TUS branch — for files > 200 MB the single-POST direct_upload
    // endpoint rejects with "Upload too large." TUS uses a different
    // CF endpoint (POST /stream?direct_user=true) with Tus-Resumable
    // + Upload-Length + Upload-Metadata headers. CF responds with a
    // Location: header pointing at the resumable URL the browser
    // then PATCHes chunks to (via tus-js-client). Same uid comes back
    // in the stream-media-id response header.
    if (useTus) {
      const maxDuration = isGametape ? GAMETAPE_MAX_DURATION_SECONDS : MAX_DURATION_SECONDS;
      const meta = {
        name: name || fileName || 'untitled',
        uploadedBy: userClaims.user_id || userClaims.sub,
        ...(playerId ? { playerId } : {}),
        ...(teamId ? { teamId } : {}),
        ...(isGametape ? { feature: 'gametape' } : {}),
        maxDurationSeconds: String(maxDuration),
        expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        allowedOrigins: '*',
        requiresignedurls: 'false',
      };
      // Upload-Metadata is comma-separated key value pairs where the
      // value is base64-encoded. TUS spec §5.4.
      const encodedMeta = Object.entries(meta)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${k} ${Buffer.from(String(v), 'utf8').toString('base64')}`)
        .join(',');

      const cfTusRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream?direct_user=true`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Tus-Resumable': '1.0.0',
            'Upload-Length': String(size || 0),
            'Upload-Metadata': encodedMeta,
            'Upload-Creator': userClaims.user_id || userClaims.sub,
          },
        },
      );

      if (!cfTusRes.ok && cfTusRes.status !== 201) {
        const text = await cfTusRes.text().catch(() => '');
        console.error('Stream TUS create error:', cfTusRes.status, text);
        return res.status(502).json({ error: 'Cloudflare Stream rejected the TUS upload', detail: text });
      }

      const uploadURL = cfTusRes.headers.get('location') || '';
      const uid = cfTusRes.headers.get('stream-media-id') || '';
      if (!uploadURL || !uid) {
        console.error('Stream TUS response missing headers:', {
          location: uploadURL,
          streamMediaId: uid,
          allHeaders: [...cfTusRes.headers.entries()],
        });
        return res.status(502).json({ error: 'Cloudflare Stream TUS response missing Location/stream-media-id' });
      }

      return res.status(200).json({ uploadURL, uid, mode: 'tus' });
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
          maxDurationSeconds: isGametape ? GAMETAPE_MAX_DURATION_SECONDS : MAX_DURATION_SECONDS,
          // 1 hour expiry on the signed upload URL.
          expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          creator: userClaims.user_id || userClaims.sub,
          meta: {
            name: name || fileName || 'untitled',
            uploadedBy: userClaims.user_id || userClaims.sub,
            ...(playerId ? { playerId } : {}),
            ...(teamId ? { teamId } : {}),
            ...(isGametape ? { feature: 'gametape' } : {}),
          },
          // Pre-enable MP4 download so users can grab the original later.
          // (Re-enable on the video once it finishes processing — Stream
          // ignores this flag if set at create-time, but kept for clarity.)
          requireSignedURLs: false,
          // Whitelist the origins the iframe.cloudflarestream.com player
          // can embed the manifest from. Without any allowedOrigins, the
          // customer-{acct}.cloudflarestream.com manifest endpoint emits
          // no Access-Control-Allow-Origin header and the browser blocks
          // the fetch as a CORS violation — coach sees "Failed to fetch."
          //
          // Wildcard "*" because our clients live on multiple origins we
          // can't fully enumerate: app.goalkickr.com (web), capacitor://
          // localhost (iOS native WebView), https://localhost (Android),
          // *.vercel.app previews. CF Stream matches scheme-strictly, so a
          // plain "localhost" entry does NOT cover capacitor://localhost.
          // Our security boundary is the unguessable video UID (same
          // model as YouTube's unlisted video IDs), not origin ACLs.
          allowedOrigins: ['*'],
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
      mode: 'single',
    });
  } catch (err) {
    console.error('stream-upload-url error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}
