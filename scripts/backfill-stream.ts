#!/usr/bin/env tsx
/**
 * Backfill existing R2-hosted videos into Cloudflare Stream.
 *
 * For every player_media doc with type='video' AND no streamUid, and every
 * full_games doc with videoUrl AND no streamUid:
 *   1. Tell Cloudflare Stream to pull the video from its public R2 URL via the
 *      "copy from URL" endpoint (no local egress/ingress — Stream fetches it
 *      directly).
 *   2. Wait for the UID, write it back to the Firestore doc as `streamUid`.
 *
 * After this runs, the app's playback paths automatically switch the affected
 * videos to the Stream iframe (adaptive bitrate). Original R2 file is left in
 * place so legacy direct links keep working and so we can roll back by simply
 * clearing the streamUid field.
 *
 * SAFETY: dry-run by default. Pass --apply to actually write.
 *
 * Setup (one-time):
 *   1. Firebase Admin service account JSON at ./scripts/firebase-service-account.json
 *      (same file used by migrate-seasons.ts; gitignored).
 *   2. `export CLOUDFLARE_ACCOUNT_ID=...`
 *      `export CLOUDFLARE_STREAM_API_TOKEN=...`
 *      (Same values as your Vercel env vars. Token needs Stream:Edit.)
 *
 * Usage:
 *   npx tsx scripts/backfill-stream.ts                        # dry-run
 *   npx tsx scripts/backfill-stream.ts --apply                # write
 *   npx tsx scripts/backfill-stream.ts --apply --only highlights  # player_media only
 *   npx tsx scripts/backfill-stream.ts --apply --only fullgames   # full_games only
 *   npx tsx scripts/backfill-stream.ts --apply --limit 5      # stop after 5 docs
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

// ─── .env loader ─────────────────────────────────────────────────────────────
// Minimal dotenv: read KEY=VALUE lines from .env in the project root and
// populate process.env for any keys not already set. Saves having to `export`
// or prefix the command every time.
(function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf-8');
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present (KEY="value" or KEY='value')
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
})();

// ─── Args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i > -1 ? argv[i + 1] : null; // 'highlights' | 'fullgames' | null (both)
})();
const LIMIT = (() => {
  const i = argv.indexOf('--limit');
  return i > -1 ? parseInt(argv[i + 1], 10) : Infinity;
})();

// ─── Env ─────────────────────────────────────────────────────────────────────
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_STREAM_API_TOKEN;
if (!accountId || !apiToken) {
  console.error('Missing env: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_STREAM_API_TOKEN must be set.');
  process.exit(1);
}

// Up-front token sanity check so a bad token doesn't waste the long download
// before we discover it. Hits Cloudflare's /user/tokens/verify endpoint.
async function preflightCfToken(): Promise<void> {
  console.log(`Account ID: ${accountId!.slice(0, 8)}…${accountId!.slice(-4)} (len=${accountId!.length})`);
  console.log(`API token:  ${apiToken!.slice(0, 6)}…${apiToken!.slice(-4)} (len=${apiToken!.length})`);
  const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const json: any = await res.json().catch(() => ({}));
  if (res.ok && json?.success && json?.result?.status === 'active') {
    console.log(`✓ Token is active (id=${String(json.result.id).slice(0, 8)}…)\n`);
    return;
  }
  console.error('❌ Cloudflare token failed verification:');
  console.error(`   status: ${res.status}`);
  console.error(`   body:   ${JSON.stringify(json)}`);
  console.error('   Fix: regenerate the token in Cloudflare → My Profile → API Tokens');
  console.error('        (template: "Read and write Cloudflare Stream and Images")');
  console.error('        and copy it into .env as CLOUDFLARE_STREAM_API_TOKEN exactly.');
  process.exit(1);
}

// ─── Firebase Admin ──────────────────────────────────────────────────────────
const sa = path.join(__dirname, 'firebase-service-account.json');
if (!fs.existsSync(sa)) {
  console.error(`Missing service account: ${sa}`);
  console.error('Firebase Console → Project Settings → Service Accounts → Generate new private key.');
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(fs.readFileSync(sa, 'utf-8'))),
});
const db = admin.firestore();

// ─── Firebase Storage source ─────────────────────────────────────────────────
// storage.rules require auth, so Cloudflare's copy-from-URL endpoint can't
// fetch firebasestorage.googleapis.com URLs (and the bucket-name aliasing
// between `.firebasestorage.app` and `.appspot.com` makes signed URLs flaky
// too). We instead download the file bytes via the Admin SDK and POST them
// straight to Stream — no public URL needed.
function parseFirebaseStorageUrl(url: string): { bucket: string; path: string } | null {
  const m = url.match(/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/([^/]+)\/o\/([^?]+)/);
  if (!m) return null;
  return {
    bucket: decodeURIComponent(m[1]),
    path: decodeURIComponent(m[2]),
  };
}

const FIREBASE_BUCKET_CANDIDATES = (bucket: string): string[] => {
  // The .firebasestorage.app suffix is a Firebase-side alias; the underlying
  // GCS bucket may actually be <project>.appspot.com. Try both.
  const out = [bucket];
  if (bucket.endsWith('.firebasestorage.app')) {
    out.push(bucket.replace(/\.firebasestorage\.app$/, '.appspot.com'));
  } else if (bucket.endsWith('.appspot.com')) {
    out.push(bucket.replace(/\.appspot\.com$/, '.firebasestorage.app'));
  }
  return out;
};

async function downloadFromFirebase(bucketName: string, filePath: string): Promise<{ buffer: Buffer; contentType: string }> {
  let lastErr: any = null;
  for (const candidate of FIREBASE_BUCKET_CANDIDATES(bucketName)) {
    try {
      const bucket = admin.storage().bucket(candidate);
      const file = bucket.file(filePath);
      const [exists] = await file.exists();
      if (!exists) { lastErr = new Error(`Not found in bucket ${candidate}`); continue; }
      const [buffer] = await file.download();
      const [metadata] = await file.getMetadata();
      return { buffer, contentType: String(metadata.contentType || 'video/mp4') };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Could not download from Firebase Storage');
}

// ─── Stream API ──────────────────────────────────────────────────────────────
interface StreamCopyResponse {
  success: boolean;
  result?: { uid: string; status?: { state: string } };
  errors?: unknown[];
}

async function streamCopyFromUrl(url: string, name: string): Promise<string> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/copy`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        meta: { name: name.slice(0, 120) },
      }),
    }
  );
  const json = (await res.json()) as StreamCopyResponse;
  if (!res.ok || !json.success || !json.result?.uid) {
    throw new Error(`Stream copy ${res.status}: ${JSON.stringify(json.errors || json)}`);
  }
  return json.result.uid;
}

// Upload a file Buffer to Cloudflare Stream via the Direct Creator Upload flow:
// (1) ask CF for a one-time upload URL, (2) POST the file as multipart/form-data.
// Used for sources that aren't publicly fetchable (Firebase Storage with auth-required rules).
async function streamUploadBytes(buffer: Buffer, contentType: string, name: string): Promise<string> {
  // 1) Mint a direct-upload URL
  const minted = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/direct_upload`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maxDurationSeconds: 60 * 60 * 4,
        expiry: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        meta: { name: name.slice(0, 120) },
        requireSignedURLs: false,
      }),
    }
  );
  const mintedJson: any = await minted.json();
  if (!minted.ok || !mintedJson?.success || !mintedJson.result?.uploadURL || !mintedJson.result?.uid) {
    throw new Error(`direct_upload mint ${minted.status}: ${JSON.stringify(mintedJson?.errors || mintedJson)}`);
  }
  const { uploadURL, uid } = mintedJson.result as { uploadURL: string; uid: string };

  // 2) POST the file body as multipart/form-data
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: contentType }), name);
  const up = await fetch(uploadURL, { method: 'POST', body: form });
  if (!up.ok) {
    throw new Error(`Stream upload ${up.status}: ${await up.text()}`);
  }
  return uid;
}

// ─── Worker ──────────────────────────────────────────────────────────────────
interface Target {
  collection: string;
  doc: admin.firestore.QueryDocumentSnapshot;
  url: string;
  name: string;
}

async function collectTargets(): Promise<Target[]> {
  const targets: Target[] = [];

  if (ONLY === null || ONLY === 'highlights') {
    const snap = await db.collection('player_media').get();
    for (const d of snap.docs) {
      const data = d.data();
      if (data.streamUid) continue;
      if (data.type !== 'video') continue;
      if (!data.url || typeof data.url !== 'string') continue;
      targets.push({
        collection: 'player_media',
        doc: d,
        url: data.url,
        name: data.caption || data.playerName || data.fileName || d.id,
      });
    }
  }

  if (ONLY === null || ONLY === 'fullgames') {
    const snap = await db.collection('full_games').get();
    for (const d of snap.docs) {
      const data = d.data();
      if (data.streamUid) continue;
      if (!data.videoUrl || typeof data.videoUrl !== 'string') continue;
      targets.push({
        collection: 'full_games',
        doc: d,
        url: data.videoUrl,
        name: data.title || d.id,
      });
    }
  }

  return targets.slice(0, LIMIT);
}

async function main() {
  console.log(APPLY ? '🚀 APPLY mode — writing changes\n' : '🔍 DRY RUN — pass --apply to write\n');

  if (APPLY) await preflightCfToken();

  const targets = await collectTargets();
  console.log(`Found ${targets.length} videos to backfill${ONLY ? ` (scope: ${ONLY})` : ''}\n`);

  let migrated = 0;
  let failed = 0;
  let skipped = 0;

  for (const t of targets) {
    const label = `[${t.collection}/${t.doc.id}]`;
    process.stdout.write(`${label} ${t.url.slice(0, 80)}${t.url.length > 80 ? '…' : ''}\n`);

    if (!APPLY) {
      process.stdout.write(`  → would copy "${t.name.slice(0, 60)}" into Stream\n`);
      skipped++;
      continue;
    }

    try {
      let uid: string;
      const fb = parseFirebaseStorageUrl(t.url);
      if (fb) {
        // Auth-protected Firebase Storage → download bytes via Admin SDK,
        // upload directly to Stream.
        process.stdout.write(`  ↓ downloading from Firebase Storage…\n`);
        const { buffer, contentType } = await downloadFromFirebase(fb.bucket, fb.path);
        process.stdout.write(`  ↑ uploading ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB to Stream…\n`);
        uid = await streamUploadBytes(buffer, contentType, t.name);
      } else {
        // Public URL (R2 etc.) → tell Stream to copy directly.
        uid = await streamCopyFromUrl(t.url, t.name);
      }
      await t.doc.ref.update({ streamUid: uid, updatedAt: new Date() });
      process.stdout.write(`  ✓ streamUid=${uid}\n`);
      migrated++;
    } catch (err: any) {
      process.stdout.write(`  ✗ ${err.message}\n`);
      failed++;
    }

    // Be gentle on the Stream API
    await new Promise(r => setTimeout(r, 250));
  }

  console.log('\n──── summary ────');
  console.log(`  migrated: ${migrated}`);
  console.log(`  failed:   ${failed}`);
  console.log(`  skipped:  ${skipped}`);
  if (!APPLY) {
    console.log('\nNote: this was a dry-run. Re-run with --apply to actually copy.');
  } else if (migrated > 0) {
    console.log('\nStream processes uploads asynchronously — clips will become playable');
    console.log('within ~1–5 minutes (longer for full games). The streamUid is already');
    console.log('on the doc, so the app will auto-switch to the Stream player on next load.');
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
