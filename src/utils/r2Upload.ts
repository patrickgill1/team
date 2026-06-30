// Client-side helper to upload a file directly to Cloudflare R2 using a presigned URL from /api/r2-presign.
import { auth } from './firebase';

export interface R2UploadResult {
  url: string; // public URL to store in Firestore
  key: string; // R2 object key
}

/** iOS camera-roll photos (especially HEIC) often have an empty
 *  `file.type`. The presign server rejects anything that doesn't start
 *  with `image/` or `video/`, so `application/octet-stream` fails the
 *  check and the upload errors out with "Unsupported contentType".
 *  Sniff the extension as a fallback before giving up. */
function inferContentType(file: File): string {
  if (file.type) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const imageMap: Record<string, string> = {
    heic: 'image/heic',
    heif: 'image/heif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
  };
  const videoMap: Record<string, string> = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    m4v: 'video/x-m4v',
    webm: 'video/webm',
  };
  return imageMap[ext] || videoMap[ext] || 'application/octet-stream';
}

export async function uploadToR2(
  file: File,
  folder: string = 'player_media',
  onProgress?: (percent: number) => void
): Promise<R2UploadResult> {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const idToken = await user.getIdToken();
  const contentType = inferContentType(file);

  // 1. Ask our server for a presigned PUT URL. Absolute origin so
  //    Capacitor (capacitor://localhost) routes to app.goalkickr.com, same
  //    fix as streamUpload.ts.
  const { getShareOrigin } = await import('./origin');
  const presignRes = await fetch(`${getShareOrigin()}/api/r2-presign`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      fileName: file.name,
      contentType,
      size: file.size,
      folder,
    }),
  });

  if (!presignRes.ok) {
    const text = await presignRes.text();
    throw new Error(`Presign failed (${presignRes.status}): ${text}`);
  }
  const { uploadUrl, publicUrl, key } = await presignRes.json();

  // 2. PUT the file directly to R2 with progress. Content-Type must
  //    match what we signed — using the sniffed value, not file.type.
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', contentType);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`R2 upload failed (${xhr.status}): ${xhr.responseText}`));
    };
    xhr.onerror = () => reject(new Error('R2 upload network error'));
    xhr.send(file);
  });

  return { url: publicUrl, key };
}
