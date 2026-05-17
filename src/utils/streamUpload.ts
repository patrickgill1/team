// Client helper to upload a video directly to Cloudflare Stream using a
// one-time direct-upload URL obtained from /api/stream-upload-url.
//
// Stream transcodes asynchronously, so by the time we resolve we have a UID
// the player can use, but the video may take 30s–several minutes to become
// ready depending on length. The UI should treat `streamReady` as eventually
// true and fall back to a "Processing…" state until then.

import { auth } from './firebase';

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

  // 1. Ask our server for a one-time direct-upload URL
  const presignRes = await fetch('/api/stream-upload-url', {
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

export function streamIframeUrl(uid: string, opts: { autoplay?: boolean; poster?: string } = {}): string {
  const qs = new URLSearchParams();
  if (opts.autoplay) qs.set('autoplay', 'true');
  if (opts.poster) qs.set('poster', opts.poster);
  const q = qs.toString();
  // Universal embed — works without the customer subdomain.
  return `https://iframe.cloudflarestream.com/${uid}${q ? `?${q}` : ''}`;
}

export function streamThumbnailUrl(uid: string, opts: { time?: string; height?: number } = {}): string {
  const qs = new URLSearchParams();
  if (opts.time) qs.set('time', opts.time);
  if (opts.height) qs.set('height', String(opts.height));
  const q = qs.toString();
  return `https://${customerBase()}/${uid}/thumbnails/thumbnail.jpg${q ? `?${q}` : ''}`;
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
  const res = await fetch('/api/stream-enable-download', {
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
