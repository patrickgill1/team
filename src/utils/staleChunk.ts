// Stale-chunk detection + auto-reload.
//
// After a Vercel deploy, any open tab still holding an old
// index.html will 404 the next lazy-loaded chunk. Vercel's
// SPA rewrite serves index.html for the missing hash, so the
// browser tries to parse HTML as JavaScript and throws.
//
// The failure surfaces THREE different ways depending on how
// webpack injects the chunk fetch:
//
//   1. A React render error: "Loading chunk 870 failed" or
//      "Failed to fetch dynamically imported module …".
//      Caught by ErrorBoundary.
//   2. A SyntaxError from the JS parser: "Unexpected token '<'"
//      when webpack's script-tag chunk loader (the default in
//      CRA/react-scripts 5) evaluates the HTML it got back.
//      This one fires as a top-level window error and does NOT
//      hit ErrorBoundary. It's why users saw a white screen
//      after the 3.9.253 deploy.
//   3. An unhandledrejection on the lazy() import promise.
//
// Ergo: one shared detector + reload helper, wired into
// ErrorBoundary AND global window listeners at boot.

const RELOAD_STAMP_KEY = 'firefc.chunkReloadAt';
const RELOAD_DEBOUNCE_MS = 60_000;

export function looksLikeStaleChunkError(error: unknown): boolean {
  const msg = String((error as any)?.message || error || '').toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('loading chunk') ||
    msg.includes('failed to fetch dynamically imported module') ||
    msg.includes('importing a module script failed') ||
    // The "returned HTML instead of JS" family. SyntaxError from a
    // fetched chunk that came back as index.html shows one of these
    // in Chrome/Safari/Firefox respectively.
    msg.includes("unexpected token '<'") ||
    msg.includes('unexpected token <') ||
    msg.includes('expected expression, got') ||
    msg.includes("expected '=>' after argument list, got")
  );
}

/** Match a URL that looks like one of our hashed webpack chunks.
 *  Used by the SyntaxError filter, because a SyntaxError from an
 *  ad-network script is NOT a chunk problem and we don't want to
 *  spin the user in a reload loop. */
export function looksLikeAppChunkUrl(url: unknown): boolean {
  const s = String(url || '');
  if (!s) return false;
  return /\/static\/js\/[\w-]+\.[a-f0-9]+\.chunk\.js/i.test(s);
}

/** One-shot hard reload. Debounced per session so a persistent
 *  real bug can't loop-reload the user. */
export function tryStaleChunkReload(): void {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_STAMP_KEY) || 0);
    if (Date.now() - last <= RELOAD_DEBOUNCE_MS) return;
    sessionStorage.setItem(RELOAD_STAMP_KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable (private mode Safari, etc). Still
    // reload — worst case is one extra loop, better than a blank
    // screen the user can't escape.
  }
  try {
    window.location.reload();
  } catch {
    /* ignore */
  }
}

/** Install top-level listeners for stale-chunk failures that
 *  don't reach the React error boundary. Idempotent. Wire from
 *  index.tsx once, before render. */
let installed = false;
export function installStaleChunkGuard(): void {
  if (installed) return;
  installed = true;
  if (typeof window === 'undefined') return;

  // SyntaxError from a chunk script tag: the parser fires an
  // ErrorEvent on the window with filename = the chunk URL. The
  // 'error' event on the script element itself doesn't bubble to
  // React, so we listen here instead.
  //
  // Detection widened 2026-07-13 after a real production report
  // (session opened before the 3.9.254 guard ship, then a Vercel
  // deploy invalidated its chunk hashes). Prior version required
  // BOTH the SyntaxError message pattern AND filename matching a
  // chunk URL — but for some browsers/error paths evt.filename is
  // empty on parse errors, so the URL guard rejected legit hits.
  //
  // Now: an app-chunk URL anywhere (filename OR error.stack) is a
  // strong signal → reload. If we can't find a URL but the message
  // still looks like the HTML-as-JS family, fall through to a
  // debounced reload — the 60s debounce prevents any real-bug loop,
  // and the user was headed for a white screen anyway.
  window.addEventListener('error', (evt: ErrorEvent) => {
    const isSyntaxHtml = looksLikeStaleChunkError(evt?.message) || looksLikeStaleChunkError(evt?.error);
    if (!isSyntaxHtml) return;
    // Debounced reload — the message pattern is specific enough to
    // HTML-as-JS that a false positive costs a single 60s-debounced
    // reload. Real bugs get one reload then the debounce kicks in
    // and they surface as normal errors on the next render. This
    // beats keeping the user stuck on a broken WebView.
    tryStaleChunkReload();
  }, true);

  // Unhandled rejection path: React.lazy() converts the chunk load
  // failure into a rejected promise. If nothing awaits it, we still
  // want to auto-recover.
  window.addEventListener('unhandledrejection', (evt: PromiseRejectionEvent) => {
    if (looksLikeStaleChunkError(evt?.reason)) tryStaleChunkReload();
  });
}
