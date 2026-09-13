// Replaces the YouTube <iframe> everywhere in the app. Reason: the
// standard youtube.com embed player throws "Error 153" in the iOS
// Capacitor WebView (origin is capacitor://localhost, which YouTube's
// origin check rejects). Nocookie + origin= workarounds still show the
// error page on some videos. The error UI reads as broken.
//
// Instead we render our own poster + play-button card. Tap opens the
// video externally (Safari or the YouTube app — anchor with
// target="_blank" is the reliable way on Capacitor iOS without a
// native Browser-plugin dependency). Zero YouTube error UI ever
// appears in-app.
//
// Reversible: when we do the native iosScheme='https' rebuild, we can
// swap back to inline iframes. Until then this is the clean surface.
//
// 2026-09-13: Patrick "I don't want that message to appear at all,
// it is hideous and unprofessional."

import React, { useState } from 'react';

interface Props {
  youtubeId: string;
  /** Optional title rendered under the poster (video subject). */
  title?: string;
  /** Optional caption below the title (opponent + date, etc). */
  caption?: string;
  /** Wrapper className — layout/sizing owned by the caller. Defaults
   *  to a 16:9 rounded card. */
  className?: string;
}

// YouTube thumbnail tiers. `maxresdefault` is the highest quality but
// isn't available for every video (uploader-dependent). Fall back to
// `hqdefault` (always available, 480x360).
const thumbUrl = (id: string, tier: 'max' | 'hq') =>
  `https://i.ytimg.com/vi/${id}/${tier === 'max' ? 'maxresdefault' : 'hqdefault'}.jpg`;

const YouTubePosterCard: React.FC<Props> = ({ youtubeId, title, caption, className }) => {
  const [tier, setTier] = useState<'max' | 'hq'>('max');
  const watchUrl = `https://www.youtube.com/watch?v=${youtubeId}`;

  return (
    <a
      href={watchUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? 'block relative w-full aspect-video rounded-2xl overflow-hidden bg-black ring-1 ring-white/10 shadow-xl shadow-black/40 group theme-ok'}
      aria-label={title ? `Play ${title} on YouTube` : 'Play video on YouTube'}
    >
      <img
        src={thumbUrl(youtubeId, tier)}
        alt=""
        aria-hidden
        loading="lazy"
        onError={() => { if (tier === 'max') setTier('hq'); }}
        className="absolute inset-0 w-full h-full object-cover"
      />
      {/* Vignette + gradient scrim so the play button always reads
          against any thumbnail color. */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/25 theme-ok" />
      {/* Center play glyph. Sizing scales with viewport so the tap
          target reads big on phones and proportional on tablets. */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-red-600 flex items-center justify-center shadow-2xl ring-4 ring-white/25 group-hover:scale-110 group-active:scale-95 transition theme-ok">
          <svg className="w-7 h-7 sm:w-9 sm:h-9 text-white ml-1" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
            <polygon points="7 4 21 12 7 20 7 4" />
          </svg>
        </div>
      </div>
      {/* YouTube corner mark — signals to the user the tap will hand
          off to YouTube (Safari or the YT app). Understated so it
          doesn't fight the thumbnail. */}
      <div className="absolute top-2 right-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/65 backdrop-blur-sm ring-1 ring-white/15 theme-ok">
        <svg className="w-3.5 h-3.5 text-red-500" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2C0 8.1 0 12 0 12s0 3.9.5 5.8a3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1c.5-1.9.5-5.8.5-5.8s0-3.9-.5-5.8ZM9.6 15.6V8.4L15.8 12l-6.2 3.6Z"/>
        </svg>
        <span className="text-[9px] font-black uppercase tracking-wider text-white theme-ok">YouTube</span>
      </div>
      {(title || caption) && (
        <div className="absolute inset-x-0 bottom-0 p-3 sm:p-4">
          {title && <div className="text-sm sm:text-base font-black text-white leading-tight drop-shadow theme-ok">{title}</div>}
          {caption && <div className="text-[11px] sm:text-xs font-semibold text-white/85 mt-0.5 drop-shadow theme-ok">{caption}</div>}
        </div>
      )}
    </a>
  );
};

export default YouTubePosterCard;
