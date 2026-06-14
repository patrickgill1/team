// Client-side image resize for chat / wall uploads. Uses a canvas to
// downscale the picked image to a thumbnail (max ~800px on the longer
// edge) and re-encode as JPEG at q=0.82 before uploading. The full
// image is still uploaded separately so the lightbox can show full
// resolution; the thumbnail is what renders in the message list.
//
// This makes chat-list scroll fast even when a thread has dozens of
// photos — each list image is now 50-150 KB instead of 3-6 MB
// straight off the phone camera.

export type ResizedImage = {
  blob: Blob;
  width: number;
  height: number;
};

const DEFAULT_THUMB_MAX = 800; // px on the longer edge
const DEFAULT_QUALITY = 0.82;

/**
 * Load a File / Blob into an HTMLImageElement so we can read its
 * intrinsic dimensions and draw it to a canvas. Resolves with the
 * loaded image element and the object URL (caller revokes when done).
 */
function loadImage(file: Blob): Promise<{ img: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

/**
 * Downscale a picked image so the longer edge is at most `maxDim`. If
 * the image is already smaller, returns the source untouched (no
 * upscale, no re-encode). Returns a JPEG blob — strips EXIF as a side
 * effect, which is fine for chat content (no rotation issue because
 * we're drawing decoded pixels).
 */
export async function resizeImage(
  file: File,
  maxDim: number = DEFAULT_THUMB_MAX,
  quality: number = DEFAULT_QUALITY,
): Promise<ResizedImage> {
  const { img, url } = await loadImage(file);
  try {
    const longer = Math.max(img.naturalWidth, img.naturalHeight);

    // Already small enough — return original bytes. Saves a re-encode
    // pass for the common case of already-compressed phone screenshots.
    if (longer <= maxDim) {
      return { blob: file, width: img.naturalWidth, height: img.naturalHeight };
    }

    const scale = maxDim / longer;
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(img, 0, 0, w, h);

    const blob: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Canvas toBlob returned null'))),
        'image/jpeg',
        quality,
      );
    });

    return { blob, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}
