// GametapeVideoPlayer — one place every Gametape clip renders.
// Uploads route through CloudflareStreamIframe (which handles the
// pre-ready transcode poll). YouTube and Vimeo links get plain
// iframe embeds — no readiness gating, they're always live.
//
// The `paused` prop remounts the iframe with a fresh key so the
// underlying player stops. Handy for "player just tapped Got it" —
// the card fades away, we don't want audio bleeding through.

import React, { useMemo } from 'react';
import CloudflareStreamIframe from '../common/CloudflareStreamIframe';
import type { PlayerClip } from '../../types';

interface Props {
  clip: PlayerClip;
  /** When true, re-key the iframe so it unmounts + stops playback. */
  paused?: boolean;
  /** Applied to the outer aspect-ratio wrapper. Callers usually want
   *  the default (rounded, black bg, 16:9). */
  className?: string;
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);

function safeParseUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Best-effort embed URL for a YouTube link. Handles youtu.be short
 *  links, watch?v= URLs, and already-embed URLs. Returns null when
 *  the source is unrecognizable so the caller can render a fallback. */
function toYoutubeEmbed(clip: PlayerClip): string | null {
  const explicit = clip.embedUrl || '';
  if (/youtube\.com\/embed\//i.test(explicit)) return explicit;
  const id = clip.externalVideoId;
  if (id) return `https://www.youtube.com/embed/${encodeURIComponent(id)}?rel=0&modestbranding=1&playsinline=1`;
  const u = safeParseUrl(explicit);
  if (!u) return null;
  if (u.hostname === 'youtu.be') {
    const shortId = u.pathname.replace(/^\//, '').split('/')[0];
    if (shortId) return `https://www.youtube.com/embed/${encodeURIComponent(shortId)}?rel=0&modestbranding=1&playsinline=1`;
  }
  if (YOUTUBE_HOSTS.has(u.hostname)) {
    const v = u.searchParams.get('v');
    if (v) return `https://www.youtube.com/embed/${encodeURIComponent(v)}?rel=0&modestbranding=1&playsinline=1`;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'shorts' && parts[1]) return `https://www.youtube.com/embed/${encodeURIComponent(parts[1])}?rel=0&modestbranding=1&playsinline=1`;
    if (parts[0] === 'embed' && parts[1]) return `https://www.youtube.com/embed/${encodeURIComponent(parts[1])}?rel=0&modestbranding=1&playsinline=1`;
  }
  return null;
}

function toVimeoEmbed(clip: PlayerClip): string | null {
  const explicit = clip.embedUrl || '';
  if (/player\.vimeo\.com\/video\//i.test(explicit)) return explicit;
  const id = clip.externalVideoId;
  if (id) return `https://player.vimeo.com/video/${encodeURIComponent(id)}`;
  const u = safeParseUrl(explicit);
  if (!u) return null;
  if (VIMEO_HOSTS.has(u.hostname)) {
    const parts = u.pathname.split('/').filter(Boolean);
    const numeric = parts.find(p => /^\d+$/.test(p));
    if (numeric) return `https://player.vimeo.com/video/${encodeURIComponent(numeric)}`;
  }
  return null;
}

const OPEN_LINK_ALLOW = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';

const GametapeVideoPlayer: React.FC<Props> = ({ clip, paused = false, className }) => {
  // Hooks BEFORE any conditional return (React #310 guard).
  const wrapperClass = className ?? 'relative w-full aspect-video rounded-xl overflow-hidden bg-black';
  const embedUrl = useMemo(() => {
    if (clip.source === 'youtube') return toYoutubeEmbed(clip);
    if (clip.source === 'vimeo') return toVimeoEmbed(clip);
    return null;
  }, [clip.source, clip.embedUrl, clip.externalVideoId]);

  // Bump the mount key when paused flips true so the iframe fully
  // unloads. Some browsers keep audio alive on a visibility:hidden
  // iframe; remount is the only reliable pause primitive across
  // Stream + YouTube + Vimeo.
  const mountKey = paused ? `${clip.id}-paused` : `${clip.id}-live`;

  if (clip.source === 'upload') {
    if (!clip.streamUid) {
      return (
        <div className={wrapperClass}>
          <div className="absolute inset-0 flex items-center justify-center text-ink-secondary text-xs">
            Clip is still processing. Check back in a moment.
          </div>
        </div>
      );
    }
    if (paused) {
      // Skip the iframe entirely while paused so nothing plays.
      return (
        <div className={wrapperClass}>
          <div className="absolute inset-0 flex items-center justify-center text-ink-primary/50 text-xs">
            Paused
          </div>
        </div>
      );
    }
    return (
      <div className={wrapperClass}>
        <CloudflareStreamIframe
          key={mountKey}
          uid={clip.streamUid}
          streamReady={!!clip.streamReady}
          title={clip.title || 'Gametape clip'}
          iframeClassName="absolute inset-0 w-full h-full block border-0"
        />
      </div>
    );
  }

  if (embedUrl) {
    if (paused) {
      return (
        <div className={wrapperClass}>
          <div className="absolute inset-0 flex items-center justify-center text-ink-primary/50 text-xs">
            Paused
          </div>
        </div>
      );
    }
    return (
      <div className={wrapperClass}>
        <iframe
          key={mountKey}
          src={embedUrl}
          title={clip.title || 'Gametape clip'}
          loading="lazy"
          allow={OPEN_LINK_ALLOW}
          allowFullScreen
          className="absolute inset-0 w-full h-full block border-0"
        />
      </div>
    );
  }

  // Fallback — malformed link. Give the user a way out instead of a
  // broken iframe with no context.
  const originalHref = clip.embedUrl || '';
  return (
    <div className={wrapperClass}>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6">
        <p className="text-sm text-ink-primary/80">Can't embed this clip.</p>
        {originalHref ? (
          <a
            href={originalHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-bold uppercase tracking-widest text-brand-primary-soft underline"
          >
            Open in a new tab
          </a>
        ) : null}
      </div>
    </div>
  );
};

export default GametapeVideoPlayer;
