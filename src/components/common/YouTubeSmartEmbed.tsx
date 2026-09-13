// Smart YouTube embed. Tries to play inline via the standard iframe
// (with nocookie host + safe params) and listens for playback errors
// via the iframe API's postMessage stream. If the video refuses to
// play in-context (Error 100 = removed, 101/150 = embed disabled,
// 153 = origin/config rejection — which the iOS Capacitor WebView
// triggers on some videos even with nocookie + origin=), swap to
// YouTubePosterCard so the user never sees YouTube's own error UI.
//
// Rationale: previous shape rendered iframe unconditionally and let
// Error 153 leak (ugly / unprofessional per Patrick 2026-09-13). Then
// 3.9.502 swapped to poster-card unconditionally, which killed inline
// playback for the majority of videos that DO work. This wrapper
// gets both: inline when it works, clean fallback when it doesn't.
//
// The iframe API sends events like `{event:"onError",info:153}` from
// its own origin. We enable it with enablejsapi=1 and listen on the
// window message channel.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ensureYoutubeSafeParams } from '../../utils/helpers';
import YouTubePosterCard from './YouTubePosterCard';

interface Props {
  youtubeId: string;
  /** Optional title (used as iframe title + poster caption fallback). */
  title?: string;
  /** Optional caption below the title in the poster fallback. */
  caption?: string;
  /** Wrapper className — layout/sizing owned by the caller. Applied
   *  to both the iframe wrapper AND the fallback poster card so the
   *  swap has zero layout shift. Defaults to a 16:9 rounded card. */
  className?: string;
  /** Iframe `allow` attribute. Defaults to the full soccer app set
   *  (autoplay, fullscreen, etc). */
  allow?: string;
  /** Add ?autoplay=1 to the embed URL. Defaults to true for lightbox
   *  contexts — user tapped a thumbnail, they expect it to play. */
  autoplay?: boolean;
}

// YouTube error codes that mean "give up on the iframe." Silent for
// this codebase's needs — we don't distinguish 100 vs 150 in the UI,
// they all get the same clean fallback.
const FATAL_ERRORS = new Set([2, 5, 100, 101, 150, 153]);

// If the iframe never sends its "onReady" message within this window,
// treat it as broken and fall back. Handles the Capacitor case where
// the iframe loads a page that hangs on YouTube's origin check.
const READY_TIMEOUT_MS = 5000;

const DEFAULT_ALLOW = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen';

const YouTubeSmartEmbed: React.FC<Props> = ({
  youtubeId,
  title,
  caption,
  className,
  allow,
  autoplay = true,
}) => {
  const [fallback, setFallback] = useState(false);
  const readyRef = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const embedSrc = useMemo(() => {
    const base = `https://www.youtube.com/embed/${youtubeId}?${autoplay ? 'autoplay=1&' : ''}enablejsapi=1`;
    return ensureYoutubeSafeParams(base);
  }, [youtubeId, autoplay]);

  useEffect(() => {
    if (fallback) return;
    // Listen for postMessage events from the YouTube iframe. The
    // iframe API always posts as JSON strings with an `event` field.
    // Origins to accept: nocookie (our chosen host), plus standard
    // youtube.com in case ensureYoutubeSafeParams was bypassed by
    // some legacy path.
    const onMessage = (e: MessageEvent) => {
      try {
        const origin = e.origin || '';
        if (!origin.includes('youtube.com') && !origin.includes('youtube-nocookie.com')) return;
        let data: any = e.data;
        if (typeof data === 'string') {
          try { data = JSON.parse(data); } catch { return; }
        }
        if (!data || typeof data !== 'object') return;
        if (data.event === 'onReady' || data.event === 'infoDelivery') {
          readyRef.current = true;
        }
        // Explicit error event OR error code embedded in an
        // infoDelivery frame. Both mean "player can't proceed."
        const errCode: number | undefined =
          data.event === 'onError' ? Number(data.info) :
          (data.info && typeof data.info.errorCode === 'number') ? data.info.errorCode :
          undefined;
        if (errCode != null && FATAL_ERRORS.has(errCode)) {
          setFallback(true);
        }
      } catch {
        // Never let a bad postMessage crash the app.
      }
    };
    window.addEventListener('message', onMessage);

    // Ready-timeout fallback for the case where YouTube's iframe
    // loads a page but never posts anything (silent 153-style
    // origin rejection).
    const readyTimer = window.setTimeout(() => {
      if (!readyRef.current) setFallback(true);
    }, READY_TIMEOUT_MS);

    return () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(readyTimer);
    };
  }, [fallback, embedSrc]);

  const wrapperClass = className ?? 'relative w-full aspect-video rounded-xl overflow-hidden bg-black theme-ok';

  if (fallback) {
    return (
      <YouTubePosterCard
        youtubeId={youtubeId}
        title={title}
        caption={caption}
        className={className}
      />
    );
  }

  return (
    <div className={wrapperClass}>
      <iframe
        ref={iframeRef}
        src={embedSrc}
        title={title || 'YouTube video'}
        allow={allow || DEFAULT_ALLOW}
        allowFullScreen
        className="absolute inset-0 w-full h-full border-0"
      />
    </div>
  );
};

export default YouTubeSmartEmbed;
