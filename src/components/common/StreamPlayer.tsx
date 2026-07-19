// Cloudflare Stream iframe player.
//
// Stream's hosted iframe handles HLS, adaptive bitrate, mobile playback (incl.
// iOS native HLS), captions, and the player chrome — saves us from owning a
// custom hls.js setup.
//
// For features that need to react to playback events (e.g. auto-advance on the
// Highlights reel) we lazy-load Cloudflare's Stream Player SDK and wrap the
// iframe with it. The SDK exposes a normal addEventListener API on top of the
// iframe's postMessage channel.
//
// While a freshly uploaded video is still being transcoded, the iframe shows
// CF's own "video is being processed" UI.

import React, { useEffect, useRef, useState } from 'react';
import CloudflareStreamIframe from './CloudflareStreamIframe';

interface StreamPlayerProps {
  uid: string;
  className?: string;
  autoplay?: boolean;
  // Start muted. Required for autoplay to actually fire on mobile browsers,
  // which block any video with audio from auto-starting. Pair with an
  // unmute toggle in the host component for the TikTok-style experience.
  muted?: boolean;
  loop?: boolean;
  poster?: string;
  title?: string;
  // When true, the host doc already has streamReady:true persisted (or
  // the caller otherwise knows the video is finished transcoding). Skips
  // the status poll — instant iframe mount. Default false: any video
  // freshly uploaded shows a warm "Processing" card until CF is ready,
  // so we never race the SDK against the CORS window.
  streamReady?: boolean;
  // Fires when playback reaches the end. Powered by the Cloudflare Stream
  // Player SDK (lazy-loaded the first time it's needed).
  onEnded?: () => void;
}

export interface StreamSdkPlayer {
  addEventListener: (event: string, handler: () => void) => void;
  removeEventListener: (event: string, handler: () => void) => void;
  // The Stream SDK exposes currentTime as a property getter; documented at
  // https://developers.cloudflare.com/stream/uploading-videos/player-api/
  currentTime: number;
  duration?: number;
  pause?: () => void;
}

declare global {
  interface Window {
    Stream?: (iframe: HTMLIFrameElement) => StreamSdkPlayer;
  }
}

const SDK_SRC = 'https://embed.videodelivery.net/embed/sdk.latest.js';
let sdkPromise: Promise<void> | null = null;
export function loadStreamSdk(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.Stream) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SDK_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { sdkPromise = null; reject(new Error('Failed to load Stream SDK')); };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

const StreamPlayer: React.FC<StreamPlayerProps> = ({
  uid,
  className = '',
  autoplay = false,
  muted = false,
  loop = false,
  poster,
  title,
  streamReady = false,
  onEnded,
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // The SDK can only attach once the iframe is actually in the DOM. We
  // gate the iframe on readiness, so the SDK attach must ALSO wait for
  // the mount — we look up the ref lazily inside the effect and re-run
  // whenever the ref becomes non-null (via the readiness prop) so
  // auto-advance keeps working after the Processing card flips.
  const [sdkAttachTick, setSdkAttachTick] = useState(0);

  useEffect(() => {
    if (!onEnded || !iframeRef.current) return;
    let cancelled = false;
    let player: ReturnType<NonNullable<Window['Stream']>> | null = null;
    loadStreamSdk()
      .then(() => {
        if (cancelled || !window.Stream || !iframeRef.current) return;
        player = window.Stream(iframeRef.current);
        player.addEventListener('ended', onEnded);
      })
      .catch(err => console.warn('Stream SDK failed to load — auto-advance disabled for this clip', err));
    return () => {
      cancelled = true;
      if (player) {
        try { player.removeEventListener('ended', onEnded); } catch { /* ignore */ }
      }
    };
    // sdkAttachTick bumps when the iframe mounts (after readiness flip)
    // so the SDK attaches to the real iframe, not the Processing card.
  }, [uid, onEnded, sdkAttachTick]);

  return (
    <div className={`relative w-full bg-black overflow-hidden ${className}`} style={{ aspectRatio: '16 / 9' }}>
      <CloudflareStreamIframe
        ref={iframeRef}
        uid={uid}
        streamReady={streamReady}
        autoplay={autoplay}
        muted={muted}
        loop={loop}
        poster={poster}
        title={title}
        iframeClassName="absolute inset-0 w-full h-full border-0"
        onReady={() => setSdkAttachTick((n) => n + 1)}
      />
    </div>
  );
};

export default StreamPlayer;
