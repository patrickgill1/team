// GET /yt/:videoId — returns an HTML page containing a YouTube
// nocookie embed iframe. Purpose: give the iframe a REAL https origin
// (api.goalkickr.com) instead of the app's capacitor://localhost origin
// that YouTube's embed player rejects with "Video player configuration
// error / Error 153" on some videos.
//
// Flow:
//   App renders <iframe src="https://api.goalkickr.com/yt/<id>">
//   Worker returns HTML with <iframe src="https://youtube-nocookie.com/embed/<id>">
//   YouTube's origin check sees api.goalkickr.com → accepts → plays
//
// Anonymous — video IDs are already public (they'd be embed-shareable
// on any site). No auth, no rate limit beyond the CF default.
//
// Path safety: we only accept the standard 11-char YouTube video ID
// alphabet ([A-Za-z0-9_-]{11}). Anything else 404s.

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

interface Env { [k: string]: any }

export async function handleYouTubeProxy(req: Request, _env: Env): Promise<Response> {
  const url = new URL(req.url);
  // Path is /yt/<id>. Split on / and grab the last segment.
  const parts = url.pathname.split('/').filter(Boolean);
  const videoId = parts[parts.length - 1] || '';
  if (!VIDEO_ID_RE.test(videoId)) {
    return new Response('Not found', { status: 404 });
  }

  // Pass-through of caller-controlled query params. We ONLY forward a
  // small allowlist (autoplay, playsinline, mute, start) so a caller
  // can't smuggle arbitrary YouTube params in — keeps the surface
  // small. Everything else is a hard default set below.
  const passthrough = new URLSearchParams();
  for (const key of ['autoplay', 'playsinline', 'mute', 'start']) {
    const v = url.searchParams.get(key);
    if (v != null) passthrough.set(key, v);
  }
  // Hardcoded defaults (playsinline for iOS, modestbranding, rel=0,
  // origin so YouTube's postMessage check has a valid target).
  if (!passthrough.has('playsinline')) passthrough.set('playsinline', '1');
  passthrough.set('modestbranding', '1');
  passthrough.set('rel', '0');
  passthrough.set('origin', 'https://api.goalkickr.com');

  const embedSrc = `https://www.youtube-nocookie.com/embed/${videoId}?${passthrough.toString()}`;

  // Relay script: forward YouTube's iframe API postMessages up to our
  // parent (the app). The app's YouTubeSmartEmbed listens for these to
  // detect fatal errors (100/101/150/153) and swap to poster-card.
  // Without this relay the app can't hear YouTube because postMessage
  // only reaches the immediate parent, which is this proxy page.
  const relayScript = `
    window.addEventListener('message', function(e) {
      try {
        var origin = e.origin || '';
        if (origin.indexOf('youtube.com') === -1 && origin.indexOf('youtube-nocookie.com') === -1) return;
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(e.data, '*');
        }
      } catch (_) {}
    });
  `.replace(/\s+/g, ' ').trim();

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Video</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #000; }
  iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
</style>
</head>
<body>
<iframe
  src="${embedSrc}"
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
  allowfullscreen
  title="Video"
></iframe>
<script>${relayScript}</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      // Allow the app WebView (capacitor://localhost) to embed this
      // page as an iframe. Without this, some WebViews block cross-
      // origin iframe embedding by default.
      'x-frame-options': 'ALLOWALL',
      // Explicit CSP that permits the nested YouTube iframe. Without
      // frame-src the browser can block the inner iframe.
      'content-security-policy': "frame-src https://www.youtube-nocookie.com https://www.youtube.com;",
    },
  });
}
