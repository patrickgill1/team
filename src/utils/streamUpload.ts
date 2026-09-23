// Client helper to upload a video directly to Cloudflare Stream using a
// one-time direct-upload URL obtained from /api/stream-upload-url.
//
// Stream transcodes asynchronously, so by the time we resolve we have a UID
// the player can use, but the video may take 30s–several minutes to become
// ready depending on length. The UI should treat `streamReady` as eventually
// true and fall back to a "Processing…" state until then.

import * as Sentry from '@sentry/react';
import { auth } from './firebase';

// -----------------------------------------------------------------------------
// Pre-upload size guard
// -----------------------------------------------------------------------------
// Cloudflare Stream's direct-upload endpoint accepts single POSTs up to 30 GB,
// but a 45-minute upload of an accidental 22 GB clip is a bandwidth + coach
// time hole. We enforce a friendly cap on the client BEFORE any XHR fires so
// no serverless invocation happens and no CF bandwidth is burned.
//
// Every video upload call site imports checkVideoLimit and pops the warm
// message from the returned decision. Do NOT duplicate the threshold constants
// at call sites — always read from here.

/** Hard cap on client-side video uploads. Enforced before uploadToStream. */
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500 MB

/** Above this size we confirm with the coach before starting the upload. */
export const WARN_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB

/** Format a byte count the way iOS Photos does: "5.2 MB", "340 MB", "22 GB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (n >= GB) {
    const v = n / GB;
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} GB`;
  }
  if (n >= MB) {
    const v = n / MB;
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} MB`;
  }
  const v = n / KB;
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} KB`;
}

export interface VideoLimitDecision {
  /** false = block the upload. true = allow (possibly after a warn confirm). */
  ok: boolean;
  /** When ok is true, whether the caller should confirm with the coach first. */
  warn?: boolean;
  /** Machine-readable reason when ok is false. */
  reason?: 'too_big';
  /** Warm, coach-native copy for the reject or confirm surface. */
  message?: string;
}

/**
 * Decide whether a picked video file is safe to upload.
 *
 * - > MAX_VIDEO_BYTES: ok=false, block with a warm "try trimming it in Photos"
 *   message that names the actual clip size so the coach realizes they picked
 *   the wrong file.
 * - > WARN_VIDEO_BYTES and <= MAX_VIDEO_BYTES: ok=true, warn=true — caller
 *   should confirm with the coach that a slow upload is fine.
 * - <= WARN_VIDEO_BYTES: ok=true, no message — silent pass-through.
 */
export function checkVideoLimit(file: File): VideoLimitDecision {
  const size = file?.size ?? 0;
  if (size > MAX_VIDEO_BYTES) {
    return {
      ok: false,
      reason: 'too_big',
      message:
        `That's a ${formatBytes(size)} clip. We cap uploads at 500 MB to keep highlight ` +
        `uploads snappy. Try trimming it in your phone's Photos or Gallery app, or export ` +
        `a shorter version first.`,
    };
  }
  if (size > WARN_VIDEO_BYTES) {
    return {
      ok: true,
      warn: true,
      message: `This clip is ${formatBytes(size)}. Upload may take a few minutes. Continue?`,
    };
  }
  return { ok: true };
}

export interface StreamUploadResult {
  uid: string;
  // Convenience hosted URLs Stream serves once the video is ready.
  hlsUrl: string;        // adaptive bitrate manifest
  iframeUrl: string;     // drop-in Stream player iframe
  thumbnailUrl: string;  // poster image
}

export interface StreamUploadContext {
  fileName?: string;
  name?: string;
  playerId?: string;
  teamId?: string;
  /** When set to 'gametape', the presign endpoint enforces the 90s
   *  clip cap AND rejects non-paid-Coach callers with 402
   *  { error: 'paid_coach_required' }. Undefined = legacy 4-hour cap
   *  used by drills / highlights (no tier gate). */
  feature?: 'gametape';
}

// Cloudflare Stream's single-POST direct upload caps at 200 MB. Above
// that CF rejects with "Upload too large" and the client sees a
// generic "Stream upload failed" — which is exactly what Patrick hit
// on a 330 MB clip. TUS resumable uploads use the SAME direct-upload
// URL but PATCH in chunks with Upload-Offset headers, so we can go up
// to CF's 30 GB TUS cap AND survive cellular blips mid-upload.
//
// Threshold set well below the 200 MB single-POST cap so we don't
// have to reason about "was this exactly at the limit" edge cases;
// 100 MB gives us headroom for CF's multipart overhead.
const TUS_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MB
// Chunk size used by tus-js-client. 50 MB is a good balance between
// upload-progress granularity and per-request overhead on flaky
// cellular; small enough to fit in WebView memory even on iPhone SE.
const TUS_CHUNK_SIZE = 50 * 1024 * 1024;

// Single-POST attempts before giving up on a network-level failure. Each
// retry asks for a FRESH direct-upload URL (they're one-time use), so a
// half-consumed URL from the failed attempt can't poison the retry. The
// abandoned URL expires server-side after 1h with zero bytes stored.
const SINGLE_POST_ATTEMPTS = 3;
const SINGLE_POST_RETRY_DELAYS_MS = [2000, 5000];

// Android WebView (Chromium) records a picked file's size + modified time
// when <input type="file"> hands it to JS, then re-checks both when the
// request body is read. Content-URI-backed files (Google Photos, Gallery,
// cloud-synced clips) routinely fail that check, so Chromium aborts with
// net::ERR_UPLOAD_FILE_CHANGED before a single byte leaves the phone. JS
// only sees a bare XHR "network error" at 0%, and every retry fails the
// same way. Nick Barker hit this 5/5 times on 2026-09-22 (five
// pendingupload videos in CF, all 0 bytes). Uploading an in-memory copy
// has no disk file behind it, so there is nothing to re-check.
//
// Single-POST files are < TUS_THRESHOLD_BYTES (100 MB), and TUS reads one
// TUS_CHUNK_SIZE (50 MB) slice at a time, so peak memory stays bounded.
class FileReadError extends Error {}

async function readIntoMemory(blob: Blob): Promise<Blob> {
  try {
    const buf = await blob.arrayBuffer();
    return new Blob([buf], { type: blob.type });
  } catch (err: any) {
    throw new FileReadError(
      "We couldn't open that video on this phone. Try picking it again. " +
      'If it lives in Google Photos or iCloud, save it to the phone first. ' +
      `(read-failed: ${err?.name || err?.message || 'unknown'})`
    );
  }
}

class StreamNetworkError extends Error {
  constructor(public bytesSent: number) {
    super('Stream upload network error');
  }
}

function networkFailureMessage(attempts: number): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return "Looks like you're offline. Check your connection and try again. (offline)";
  }
  return (
    `We couldn't reach the video server after ${attempts} tries. ` +
    'Check your Wi-Fi or cell signal and try again. (network)'
  );
}

export async function uploadToStream(
  file: File,
  ctx: StreamUploadContext = {},
  onProgress?: (percent: number) => void
): Promise<StreamUploadResult> {
  const wantsTus = file.size >= TUS_THRESHOLD_BYTES;
  try {
    return await uploadToStreamInner(file, ctx, wantsTus, onProgress);
  } catch (err: any) {
    // Every video upload surface funnels through here, so this is the one
    // place that reports failures with enough context to diagnose from
    // Sentry instead of from a coach's screenshot.
    Sentry.captureException(err, {
      tags: {
        area: 'stream-upload',
        mode: wantsTus ? 'tus' : 'single',
        kind: err instanceof FileReadError ? 'read' : err instanceof StreamNetworkError ? 'network' : 'other',
      },
      extra: {
        size: file.size,
        type: file.type,
        name: file.name,
        feature: ctx.feature,
        teamId: ctx.teamId,
        online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
        bytesSent: err instanceof StreamNetworkError ? err.bytesSent : undefined,
      },
    });
    throw err;
  }
}

async function uploadToStreamInner(
  file: File,
  ctx: StreamUploadContext,
  wantsTus: boolean,
  onProgress?: (percent: number) => void
): Promise<StreamUploadResult> {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');

  // Pull small files into memory BEFORE asking for an upload URL so a
  // read failure never burns a CF direct-upload slot. See readIntoMemory.
  const body = wantsTus ? null : await readIntoMemory(file);

  // 1. Ask our server for a one-time direct-upload URL. Files ≥ 100 MB
  //    request useTus:true so the server creates a TUS-compatible
  //    upload via CF's /stream?direct_user=true endpoint (returns a
  //    Location header pointing at a resumable URL). Smaller files
  //    keep the simpler direct_upload (single-POST) path.
  //    Use the absolute origin so the call works on the Capacitor
  //    iOS / Android shell, where window.location.origin is
  //    capacitor://localhost and a relative path 404s on the WebView.
  const { getShareOrigin } = await import('./origin');
  const requestUploadUrl = async (): Promise<{ uploadURL: string; uid: string }> => {
    const idToken = await user.getIdToken();
    const presignRes = await fetch(`${getShareOrigin()}/api/stream-upload-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        fileName: file.name,
        name: ctx.name || file.name,
        size: file.size,
        playerId: ctx.playerId,
        teamId: ctx.teamId,
        ...(ctx.feature ? { feature: ctx.feature } : {}),
        ...(wantsTus ? { useTus: true } : {}),
      }),
    });

    if (!presignRes.ok) {
      const text = await presignRes.text();
      // Preserve the HTTP status so upstream callers (e.g. the Gametape
      // compose flow) can distinguish 402 paid-coach-required from a
      // generic upload failure and swap the surfaced copy.
      const err: any = new Error(`Stream upload URL request failed (${presignRes.status}): ${text}`);
      err.status = presignRes.status;
      throw err;
    }
    const { uploadURL, uid } = await presignRes.json();
    if (!uploadURL || !uid) throw new Error('Stream upload URL response missing fields');
    return { uploadURL, uid };
  };

  // 2. Upload. When the server returned a TUS URL (useTus branch),
  //    tus-js-client PATCHes chunks to it in `uploadUrl` mode (upload
  //    already exists server-side, no creation POST needed) and handles
  //    its own retries. Small files ride the fast single-POST XHR path,
  //    retried here with a fresh URL on network-level failures.
  let uid: string;
  if (wantsTus) {
    const presign = await requestUploadUrl();
    uid = presign.uid;
    await uploadViaTusResume(file, presign.uploadURL, onProgress);
  } else {
    for (let attempt = 1; ; attempt++) {
      const presign = await requestUploadUrl();
      try {
        await uploadViaSinglePost(body!, file.name, presign.uploadURL, onProgress);
        uid = presign.uid;
        break;
      } catch (err) {
        if (!(err instanceof StreamNetworkError)) throw err;
        if (attempt >= SINGLE_POST_ATTEMPTS) {
          const final: any = new StreamNetworkError(err.bytesSent);
          final.message = networkFailureMessage(attempt);
          throw final;
        }
        onProgress?.(0);
        await new Promise(r => setTimeout(r, SINGLE_POST_RETRY_DELAYS_MS[attempt - 1] ?? 5000));
      }
    }
  }

  return {
    uid,
    hlsUrl: streamHlsUrl(uid),
    iframeUrl: streamIframeUrl(uid),
    thumbnailUrl: streamThumbnailUrl(uid),
  };
}

// Legacy single-POST path — retained for small clips because it's one
// round trip and doesn't require the tus-js-client bundle to load.
// `body` must be an in-memory Blob (see readIntoMemory), never the
// picked File itself.
async function uploadViaSinglePost(
  body: Blob,
  fileName: string,
  uploadURL: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let bytesSent = 0;
    xhr.open('POST', uploadURL);
    xhr.upload.onprogress = e => {
      bytesSent = e.loaded;
      if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Stream upload failed (${xhr.status}): ${xhr.responseText}`));
    };
    xhr.onerror = () => reject(new StreamNetworkError(bytesSent));
    xhr.ontimeout = () => reject(new StreamNetworkError(bytesSent));
    const form = new FormData();
    form.append('file', body, fileName);
    xhr.send(form);
  });
}

// tus-js-client reads chunks with file.slice(), which on Android is still
// backed by the picked file and trips the same ERR_UPLOAD_FILE_CHANGED
// check as the single POST. This reader copies each chunk into memory
// first. Shape matches tus-js-client's FileReader / FileSource interfaces.
const inMemoryChunkReader = {
  async openFile(input: Blob) {
    return {
      size: input.size,
      async slice(start: number, end: number) {
        const value = await readIntoMemory(input.slice(start, end));
        return { value, done: end >= input.size };
      },
      close() {},
    };
  },
};

// TUS resumable path — chunks the file into 50 MB slices with retry.
// The server has already created the upload on Cloudflare Stream via
// POST /stream?direct_user=true with Upload-Length + Upload-Metadata,
// and returned the Location header as `uploadURL`. We pass that as
// tus-js-client's `uploadUrl` (not `endpoint`) so it PATCHes chunks
// directly without a redundant creation POST.
async function uploadViaTusResume(
  file: File,
  uploadURL: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const tus = await import('tus-js-client');
  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(file, {
      uploadUrl: uploadURL,
      chunkSize: TUS_CHUNK_SIZE,
      fileReader: inMemoryChunkReader,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      onError: (err) => {
        // Surface the friendly read-failed copy as-is; wrap everything else.
        if (err instanceof FileReadError) reject(err);
        else reject(new Error(`Stream upload failed (tus): ${err.message || String(err)}`));
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        if (onProgress && bytesTotal > 0) {
          onProgress(Math.round((bytesUploaded / bytesTotal) * 100));
        }
      },
      onSuccess: () => resolve(),
    });
    upload.start();
  });
}

// Cloudflare Stream exposes a universal iframe embed at
// `iframe.cloudflarestream.com/{uid}` that works without knowing the customer
// subdomain — which means the client doesn't need a REACT_APP_ env var. For
// HLS manifests / thumbnails the customer subdomain IS required; we read it
// from REACT_APP_CLOUDFLARE_STREAM_SUBDOMAIN, falling back to the universal
// `customer-www.cloudflarestream.com` only as a last resort.
const customerBase = (): string => {
  const fromEnv = (process.env.REACT_APP_CLOUDFLARE_STREAM_SUBDOMAIN || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  return fromEnv || 'customer-www.cloudflarestream.com';
};

export function streamHlsUrl(uid: string): string {
  return `https://${customerBase()}/${uid}/manifest/video.m3u8`;
}

export function streamIframeUrl(
  uid: string,
  opts: {
    autoplay?: boolean;
    muted?: boolean;
    loop?: boolean;
    poster?: string;
    /** Optional cache-buster appended as `_=<number>` on the iframe URL.
     *  Forces a fresh iframe DOM + fresh SDK-issued manifest fetches,
     *  sidestepping any browser negative-cache entry the manifest
     *  endpoint might have picked up during the pre-ready CORS window.
     *  Only set this once we've confirmed readiness via /api/stream-status
     *  — a cache-bust on an unready video just re-runs the failure. */
    cacheBust?: number;
  } = {}
): string {
  const qs = new URLSearchParams();
  if (opts.autoplay) qs.set('autoplay', 'true');
  // Mobile browsers (iOS Safari, Chrome) silently block autoplay on videos
  // with audio. Passing muted=true lets the player auto-start; the host page
  // can offer an unmute toggle. Without this, autoplay is essentially a no-op.
  if (opts.muted) qs.set('muted', 'true');
  if (opts.loop) qs.set('loop', 'true');
  if (opts.poster) qs.set('poster', opts.poster);
  if (typeof opts.cacheBust === 'number' && opts.cacheBust > 0) {
    qs.set('_', String(opts.cacheBust));
  }
  const q = qs.toString();
  // Universal embed — works without the customer subdomain.
  return `https://iframe.cloudflarestream.com/${uid}${q ? `?${q}` : ''}`;
}

export function streamThumbnailUrl(uid: string, opts: { time?: string; height?: number } = {}): string {
  const qs = new URLSearchParams();
  // Default to 3s into the video. A *lot* of highlight clips start with an
  // intro fade / transition banner that's solid black for the first second or
  // two, which makes Stream's default time=0 poster look broken. 3s is past
  // virtually all intro effects; Stream clamps past-end-of-video to the last
  // frame so this is safe for short clips too.
  qs.set('time', opts.time || '3s');
  if (opts.height) qs.set('height', String(opts.height));
  return `https://${customerBase()}/${uid}/thumbnails/thumbnail.jpg?${qs.toString()}`;
}

// Ask the server to (a) enable MP4 download on the Stream video if not
// already enabled and (b) report when the render is ready. Returns the MP4
// URL when status='ready', otherwise null + a hint string.
export interface StreamDownloadStatus {
  ready: boolean;
  url: string;     // empty string when not ready
  percent: number; // 0..100; 100 when ready
}

export async function getStreamDownloadUrl(uid: string): Promise<StreamDownloadStatus> {
  const user = auth.currentUser;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (user) {
    try { headers.Authorization = `Bearer ${await user.getIdToken()}`; } catch { /* anonymous */ }
  }
  const { getShareOrigin } = await import('./origin');
  const res = await fetch(`${getShareOrigin()}/api/stream-enable-download`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ uid }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Enable download failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  if (json.status === 'ready' && json.url) {
    return { ready: true, url: json.url, percent: 100 };
  }
  return { ready: false, url: '', percent: Number(json.percentComplete) || 0 };
}

/**
 * Share-time convenience wrapper around getStreamDownloadUrl.
 *
 * Race the enable-download call against a caller-supplied timeout so the
 * UI can decide: "wait a second or two for a proper MP4 URL, else fall
 * back to the iframe embed and let the next tap benefit from the render
 * we just kicked off in the background."
 *
 * Behavior:
 *  - Returns the MP4 URL when Cloudflare reports status='ready' inside
 *    the timeout window. Caller should cache it (e.g., write back to
 *    the source drill doc as `streamMp4Url`) so future shares skip the
 *    network round trip.
 *  - Returns null on timeout, on not-yet-ready, or on any fetch error.
 *    The first call to /api/stream-enable-download is what kicks off
 *    Cloudflare's MP4 render, so a null return still moves progress
 *    forward — the next call is very likely to resolve ready.
 *  - Never throws. Share flows must not blow up on a flaky network.
 *
 * The default 4000 ms budget is a compromise: long enough that an
 * already-rendered video (very likely on drills uploaded seconds or
 * more ago) resolves in a single tap, short enough that the parent
 * doesn't see the app hang before the native share sheet appears.
 */
export async function getOrEnableStreamDownloadUrl(
  uid: string,
  opts: { timeoutMs?: number } = {}
): Promise<string | null> {
  if (!uid) return null;
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 4000;
  try {
    const timeout = new Promise<null>(resolve => {
      setTimeout(() => resolve(null), timeoutMs);
    });
    const fetchStatus = getStreamDownloadUrl(uid)
      .then(s => (s.ready && s.url ? s.url : null))
      .catch(() => null);
    return await Promise.race([fetchStatus, timeout]);
  } catch {
    return null;
  }
}

/** Poll Cloudflare for a video's readiness. Powers useStreamReadiness.
 *  The server ALSO re-patches allowedOrigins to ["*"] if the video was
 *  created before that fix landed — belt-and-suspenders for any coach
 *  who caught the racing deploy. */
export interface StreamStatus {
  ready: boolean;
  pctComplete: number;
  state?: string;
  notFound?: boolean;
}

export async function getStreamStatus(uid: string): Promise<StreamStatus> {
  if (!uid) return { ready: true, pctComplete: 100 };
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const token = await user.getIdToken();
  const { getShareOrigin } = await import('./origin');
  const res = await fetch(
    `${getShareOrigin()}/api/stream-status?uid=${encodeURIComponent(uid)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Stream status failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return {
    ready: Boolean(json.ready),
    pctComplete: Number(json.pctComplete) || 0,
    state: typeof json.state === 'string' ? json.state : undefined,
    notFound: Boolean(json.notFound),
  };
}

/** Delete a Cloudflare Stream video by uid. Fires against
 *  /api/stream-delete (Vercel serverless), which holds the
 *  CLOUDFLARE_STREAM_API_TOKEN. Non-throwing helper — caller decides
 *  whether to await + surface. Silent no-op on missing uid. */
export async function deleteStreamVideo(uid: string): Promise<{ ok: boolean; error?: string }> {
  if (!uid) return { ok: true };
  try {
    const user = auth.currentUser;
    if (!user) return { ok: false, error: 'not-signed-in' };
    const token = await user.getIdToken();
    const { getShareOrigin } = await import('./origin');
    const res = await fetch(`${getShareOrigin()}/api/stream-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ uid }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `stream-${res.status}: ${detail.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
