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

import React, { useEffect, useRef } from 'react';
import { streamIframeUrl } from '../../utils/streamUpload';

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
  onEnded,
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);

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
  }, [uid, onEnded]);

  return (
    <div className={`relative w-full bg-black overflow-hidden ${className}`} style={{ aspectRatio: '16 / 9' }}>
      <iframe
        ref={iframeRef}
        src={streamIframeUrl(uid, { autoplay, muted, loop, poster })}
        title={title || 'Video'}
        loading="lazy"
        allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
        allowFullScreen
        className="absolute inset-0 w-full h-full border-0"
      />
    </div>
  );
};

export default StreamPlayer;
