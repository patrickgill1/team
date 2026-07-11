// Vercel serverless function: deletes an object from Cloudflare R2 by key.
//
// Called when the user deletes a media clip / photo. Without this call
// the R2 blob (mp4, jpeg, etc.) sits at paid storage indefinitely —
// every hard-delete on Firestore left the underlying blob as an
// orphan. Complements /api/stream-delete.mjs which cleans up the
// Cloudflare Stream side.
//
// Required env vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
//                    R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL,
//                    FIREBASE_PROJECT_ID

import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
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

/** Derive the R2 object key from the doc's stored public URL.
 *  publicUrl = `${R2_PUBLIC_BASE_URL}/${key}` — trim the base and
 *  return the remainder. Returns null if the URL isn't on the
 *  configured base (defense against a client passing an arbitrary
 *  URL — we only delete from our own bucket). */
function keyFromUrl(publicBase, url) {
  if (!publicBase || !url) return null;
  const normalizedBase = publicBase.replace(/\/+$/, '');
  const normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith(normalizedBase + '/')) return null;
  return normalizedUrl.slice(normalizedBase.length + 1);
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
    const bucket = process.env.R2_BUCKET;
    const accountId = process.env.R2_ACCOUNT_ID;
    const publicBase = process.env.R2_PUBLIC_BASE_URL;
    if (!bucket || !accountId || !publicBase) {
      return res.status(500).json({ error: 'Server R2 config missing' });
    }

    let key = typeof body?.key === 'string' ? body.key.trim() : '';
    if (!key && body?.url) {
      const derived = keyFromUrl(publicBase, String(body.url));
      if (!derived) {
        return res.status(400).json({ error: 'url-not-in-bucket', hint: 'url must start with R2_PUBLIC_BASE_URL' });
      }
      key = derived;
    }
    if (!key) return res.status(400).json({ error: 'key-or-url-required' });
    // Belt-and-suspenders: refuse absurdly long keys (accidental garbage).
    if (key.length > 500) return res.status(400).json({ error: 'key-too-long' });

    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });

    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      // R2 returns 204 on both "deleted" and "was never there"; a
      // failure here means genuine issue (auth, network, bad key).
      console.error('R2 delete error:', err);
      return res.status(502).json({ error: 'R2 refused delete', detail: err.message });
    }

    return res.status(200).json({ ok: true, key });
  } catch (err) {
    console.error('r2-delete error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}
