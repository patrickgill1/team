// Client helper to upload a video directly to Cloudflare Stream using a
// one-time direct-upload URL obtained from /api/stream-upload-url.
//
// Stream transcodes asynchronously, so by the time we resolve we have a UID
// the player can use, but the video may take 30s–several minutes to become
// ready depending on length. The UI should treat `streamReady` as eventually
// true and fall back to a "Processing…" state until then.

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
}

export async function uploadToStream(
  file: File,
  ctx: StreamUploadContext = {},
  onProgress?: (percent: number) => void
): Promise<StreamUploadResult> {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const idToken = await user.getIdToken();

  // 1. Ask our server for a one-time direct-upload URL.
  //    Use the absolute origin so the call works on the Capacitor
  //    iOS / Android shell, where window.location.origin is
  //    capacitor://localhost and a relative path 404s on the WebView.
  //    On web, getShareOrigin returns the current origin so dev /
  //    Vercel both keep working.
  const { getShareOrigin } = await import('./origin');
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
    }),
  });

  if (!presignRes.ok) {
    const text = await presignRes.text();
    throw new Error(`Stream upload URL request failed (${presignRes.status}): ${text}`);
  }
  const { uploadURL, uid } = await presignRes.json();
  if (!uploadURL || !uid) throw new Error('Stream upload URL response missing fields');

  // 2. Upload the file directly to Cloudflare Stream as multipart/form-data
  //    with progress events via XHR (fetch can't report upload progress).
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadURL);
    if (onProgress) {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Stream upload failed (${xhr.status}): ${xhr.responseText}`));
    };
    xhr.onerror = () => reject(new Error('Stream upload network error'));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });

  return {
    uid,
    hlsUrl: streamHlsUrl(uid),
    iframeUrl: streamIframeUrl(uid),
    thumbnailUrl: streamThumbnailUrl(uid),
  };
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
