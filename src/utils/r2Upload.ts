// Client-side helper to upload a file directly to Cloudflare R2 using a presigned URL from /api/r2-presign.
import { auth } from './firebase';

export interface R2UploadResult {
  url: string; // public URL to store in Firestore
  key: string; // R2 object key
}

export async function uploadToR2(
  file: File,
  folder: string = 'player_media',
  onProgress?: (percent: number) => void
): Promise<R2UploadResult> {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const idToken = await user.getIdToken();

  // 1. Ask our server for a presigned PUT URL
  const presignRes = await fetch('/api/r2-presign', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
      folder,
    }),
  });

  if (!presignRes.ok) {
    const text = await presignRes.text();
    throw new Error(`Presign failed (${presignRes.status}): ${text}`);
  }
  const { uploadUrl, publicUrl, key } = await presignRes.json();

  // 2. PUT the file directly to R2 with progress
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
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
