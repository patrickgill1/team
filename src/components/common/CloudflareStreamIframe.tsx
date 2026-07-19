// CloudflareStreamIframe — one component every Stream iframe call site
// funnels through. It waits for Cloudflare to finish transcoding before
// mounting the iframe, so coaches uploading from a computer never see
// the CORS/500 wall the SDK fires when it races transcoding.
//
// Behavior:
//   - `streamReady:true` prop  → mount iframe immediately (no poll).
//   - Otherwise polls /api/stream-status every 3s, up to 40 tries.
//   - Until ready: renders a warm "Processing this clip" card.
//   - When ready: mounts <iframe> with cacheBust=<ts> so any residual
//     browser negative-cache on the manifest URL is bypassed.
//
// One canonical mount so future call sites don't have to remember the
// gating dance.

import React, { forwardRef, useMemo, useRef, useState } from 'react';
import { streamIframeUrl } from '../../utils/streamUpload';
import { useStreamReadiness } from '../../hooks/useStreamReadiness';

export interface CloudflareStreamIframeProps {
  uid: string;
  /** True when the persisted doc says the video finished transcoding
   *  previously. Skips the status poll — future viewers of an old clip
   *  see the iframe immediately. */
  streamReady?: boolean;
  autoplay?: boolean;
  muted?: boolean;
  loop?: boolean;
  poster?: string;
  title?: string;
  /** Applied to the OUTER wrapper. Defaults to nothing — the caller
   *  usually owns the aspect ratio (`aspect-video rounded-lg bg-black`
   *  and so on) via a parent div. */
  className?: string;
  /** Applied to the iframe element itself. Defaults to
   *  `w-full h-full block border-0`. */
  iframeClassName?: string;
  allow?: string;
  loading?: 'lazy' | 'eager';
  allowFullScreen?: boolean;
  /** Called the moment readiness flips true via polling. Not called
   *  when `streamReady:true` short-circuited the poll (there was no
   *  transition). Callers that want to persist the flag on their
   *  Firestore doc pass a handler here. */
  onReady?: () => void;
  /** Copy override for the Processing card body. Default is soccer-warm. */
  processingCopy?: string;
}

const DEFAULT_ALLOW = 'accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;';
const DEFAULT_IFRAME_CLASS = 'w-full h-full block border-0';

// Monoline SVG spinner — no emoji, no third-party icon. 2px stroke to
// match the rest of the app's icon language.
const ProcessingSpinner: React.FC = () => (
  <svg
    className="w-8 h-8 text-brand-primary-soft animate-spin"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M12 3 A 9 9 0 0 1 21 12" opacity="0.9" />
    <path d="M3 12 A 9 9 0 0 0 12 21" opacity="0.35" />
  </svg>
);

const CloudflareStreamIframe = forwardRef<HTMLIFrameElement, CloudflareStreamIframeProps>(
  function CloudflareStreamIframe(
    {
      uid,
      streamReady = false,
      autoplay,
      muted,
      loop,
      poster,
      title,
      className = '',
      iframeClassName = DEFAULT_IFRAME_CLASS,
      allow = DEFAULT_ALLOW,
      loading = 'lazy',
      allowFullScreen = true,
      onReady,
      processingCopy,
    },
    ref
  ) {
    // Freeze the cache-bust value the moment readiness first flips true
    // so the src doesn't churn on every render (which would remount the
    // iframe mid-playback). Only set once ready is true.
    const cacheBustRef = useRef<number | null>(null);
    const [, forceRender] = useState(0);

    const handleReadyFlip = () => {
      if (cacheBustRef.current == null) {
        cacheBustRef.current = Date.now();
        // Nudge React so the src re-computes with the fresh cacheBust.
        forceRender((n) => n + 1);
      }
      try { onReady?.(); } catch (err) { console.warn('CloudflareStreamIframe onReady threw', err); }
    };

    const { ready, pctComplete, timedOut } = useStreamReadiness(uid, {
      initialReady: streamReady,
      onReady: handleReadyFlip,
    });

    const src = useMemo(() => {
      if (!ready) return '';
      // If we polled to ready, cache-bust; if streamReady:true was
      // passed (persisted), no bust needed — the manifest is cache-safe.
      const cb = cacheBustRef.current;
      return streamIframeUrl(uid, {
        autoplay,
        muted,
        loop,
        poster,
        ...(cb ? { cacheBust: cb } : {}),
      });
    }, [ready, uid, autoplay, muted, loop, poster]);

    if (!ready) {
      // Warm processing card. rounded/aspect handled by parent wrapper.
      const showPct = pctComplete > 0 && pctComplete < 100 && !timedOut;
      const bodyCopy = timedOut
        ? "This one is taking longer than usual. Give it another minute, then reopen."
        : (processingCopy ||
            "This clip is still processing. It'll play as soon as Cloudflare finishes the encode, usually 15 to 30 seconds.");
      return (
        <div
          className={`w-full h-full flex items-center justify-center bg-surface-elevated text-ink-primary ${className}`}
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-col items-center text-center px-6 py-8 max-w-sm">
            {!timedOut && <ProcessingSpinner />}
            {timedOut && (
              <svg
                className="w-8 h-8 text-ink-primary/60"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
            )}
            <p className="mt-3 text-xs font-extrabold uppercase tracking-widest text-brand-primary-soft">
              {timedOut ? 'Still cooking' : 'Processing clip'}
            </p>
            <p className="mt-1.5 text-sm text-ink-primary/70 leading-snug">
              {bodyCopy}
            </p>
            {showPct && (
              <div className="mt-3 w-40 h-1.5 rounded-full bg-line-default/15 overflow-hidden">
                <div
                  className="h-full bg-brand-primary transition-[width] duration-500"
                  style={{ width: `${Math.max(4, Math.min(100, pctComplete))}%` }}
                />
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <iframe
        ref={ref}
        src={src}
        title={title || 'Video'}
        loading={loading}
        allow={allow}
        allowFullScreen={allowFullScreen}
        className={iframeClassName}
      />
    );
  }
);

export default CloudflareStreamIframe;
