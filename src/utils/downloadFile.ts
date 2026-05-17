// Cross-origin friendly file download.
//
// The default `<a download>` attribute is silently ignored by browsers for
// cross-origin URLs (which is the case for our R2-hosted media). Result: tap
// "Download" -> browser just navigates to the file. On mobile Safari it then
// opens inline with no Save button anywhere obvious.
//
// This helper fetches the file as a Blob and triggers the save via a Blob URL,
// which IS same-origin and honors the `download` attribute on every browser
// that matters. If the fetch fails (CORS misconfigured, offline, etc.) it
// falls back to opening the URL in a new tab — the old behavior — so the user
// still gets *something*.

export type DownloadProgress = {
  loaded: number;
  total: number; // 0 if unknown (no Content-Length header)
  percent: number; // 0 if total is unknown
};

export type DownloadOptions = {
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
};

export async function downloadFile(
  url: string,
  filename: string,
  opts: DownloadOptions = {}
): Promise<{ ok: true } | { ok: false; reason: 'fetch-failed' | 'aborted' }> {
  try {
    const res = await fetch(url, { signal: opts.signal, mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const total = Number(res.headers.get('Content-Length') || 0);
    let blob: Blob;

    if (opts.onProgress && res.body && typeof (res.body as any).getReader === 'function') {
      // Stream the body so we can report progress.
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          loaded += value.byteLength;
          opts.onProgress({
            loaded,
            total,
            percent: total ? Math.min(99, Math.round((loaded / total) * 100)) : 0,
          });
        }
      }
      blob = new Blob(chunks as BlobPart[], { type: res.headers.get('Content-Type') || 'application/octet-stream' });
    } else {
      blob = await res.blob();
    }

    triggerBlobSave(blob, filename);
    opts.onProgress?.({ loaded: blob.size, total: blob.size, percent: 100 });
    return { ok: true };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { ok: false, reason: 'aborted' };
    // CORS, network, or any other failure -> fall back so the user still gets
    // the file (just via the old "opens in new tab" route).
    console.warn('downloadFile: fetch failed, falling back to direct link', err);
    openInNewTab(url);
    return { ok: false, reason: 'fetch-failed' };
  }
}

function triggerBlobSave(blob: Blob, filename: string) {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke later so the click has time to register on slower browsers.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
}

function openInNewTab(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
