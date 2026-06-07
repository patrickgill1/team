// Vercel serverless function: returns a presigned PUT URL for direct browser upload to Cloudflare R2.
// Requires env vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL, FIREBASE_PROJECT_ID

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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

const ALLOWED_PREFIXES = ['video/', 'image/'];
const MAX_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

export default async function handler(req, res) {
  // CORS on every response — Capacitor iOS calls cross-origin from
  // capacitor://localhost → firefc.app/api/r2-presign, and browsers
  // block the response body without Access-Control-Allow-Origin on
  // the actual response (not just the preflight).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Auth
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Authorization Bearer token' });
    }
    const token = authHeader.slice(7);
    let userClaims;
    try {
      userClaims = await verifyFirebaseToken(token);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token', detail: e.message });
    }

    // Body (Vercel parses JSON automatically when content-type: application/json)
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { fileName, contentType, size, folder } = body;

    if (!fileName || !contentType) {
      return res.status(400).json({ error: 'fileName and contentType are required' });
    }
    if (!ALLOWED_PREFIXES.some((p) => contentType.startsWith(p))) {
      return res.status(400).json({ error: 'Unsupported contentType' });
    }
    if (typeof size === 'number' && size > MAX_SIZE) {
      return res.status(400).json({ error: 'File too large (max 2GB)' });
    }

    const accountId = process.env.R2_ACCOUNT_ID;
    const bucket = process.env.R2_BUCKET;
    const publicBase = process.env.R2_PUBLIC_BASE_URL;
    if (!accountId || !bucket || !publicBase) {
      return res.status(500).json({ error: 'Server R2 config missing' });
    }

    // Sanitize filename, build a unique key
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    const folderPart = folder && /^[a-zA-Z0-9/_-]+$/.test(folder) ? folder.replace(/^\/+|\/+$/g, '') : 'player_media';
    const key = `${folderPart}/${userClaims.user_id || userClaims.sub}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;

    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });

    const cmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 600 }); // 10 min

    const publicUrl = `${publicBase.replace(/\/+$/, '')}/${key}`;

    return res.status(200).json({ uploadUrl, publicUrl, key });
  } catch (err) {
    console.error('r2-presign error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}
