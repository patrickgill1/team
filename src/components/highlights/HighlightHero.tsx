// Hero clip at the top of the Netflix Highlights tab. Big 16:9 tile
// bound to a single clip — never ambient wallpaper. For Cloudflare
// Stream clips we attempt a muted, looping autoplay preview so the
// tile feels alive on desktop; the poster stays as a fallback until
// the iframe is ready and on browsers that block autoplay.

import React from 'react';
import type { PlayerMedia as PlayerMediaType, Player } from '../../types';
import { posterFor } from '../../utils/mediaPoster';
import StreamPlayer from '../common/StreamPlayer';

interface Props {
  clip: PlayerMediaType | null;
  players?: Player[];
  onOpen: () => void;
  // Optional pill top-left (e.g. "Newest", "Needs your caption").
  label?: string;
  // When true, render the pill in the coach-attention color (amber).
  labelTone?: 'default' | 'attention';
}

/** Same warm label logic HighlightCardLite uses. Kept here so the
 *  hero can stand alone without importing internals from the card. */
function momentLabel(kind?: string): string | null {
  if (kind === 'goal') return 'Goal';
  if (kind === 'assist') return 'Assist';
  if (kind === 'big_play') return 'Big play';
  return null;
}

function shortDate(v: any): string {
  const d: Date = v?.toDate ? v.toDate() : v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function displayName(clip: PlayerMediaType, players?: Player[]): string {
  if (clip.goalScorerId && players && players.length > 0) {
    const scorer = players.find(p => p.id === clip.goalScorerId);
    if (scorer?.name) return scorer.name;
  }
  return clip.playerName || 'Highlight';
}

const HighlightHero: React.FC<Props> = ({ clip, players, onOpen, label, labelTone = 'default' }) => {
  if (!clip) return null;
  const poster = posterFor(clip);
  const name = displayName(clip, players);
  const secondary = clip.caption || momentLabel(clip.momentType) || shortDate(clip.createdAt);
  const canPreview = clip.type === 'video' && !!clip.streamUid;

  const pillTone = labelTone === 'attention'
    ? 'bg-amber-500/90 text-black ring-amber-300/50'
    : 'bg-black/60 text-white ring-white/25';

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative w-full aspect-video max-h-[420px] rounded-2xl overflow-hidden bg-surface-elevated ring-1 ring-line-default/10 text-left transition-transform focus:outline-none focus:ring-2 focus:ring-brand-primary/60 mb-8"
      aria-label={`Play ${name}`}
    >
      {/* Poster layer — always mounted so the tile has something to
          show while the Stream iframe is still transcoding / loading. */}
      {poster ? (
        <img
          src={poster}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          loading="eager"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-surface-raised to-surface-elevated" />
      )}

      {/* Muted autoplay preview for Stream clips. Wrapped in a div
          with pointer-events-none so the underlying <button> still
          receives the tap; the iframe just paints. */}
      {canPreview && (
        <div className="absolute inset-0 pointer-events-none">
          <StreamPlayer
            uid={clip.streamUid as string}
            autoplay
            muted
            loop
            streamReady={clip.streamReady === true}
            className="!aspect-auto w-full h-full"
            poster={poster}
            title={clip.caption || name}
          />
        </div>
      )}

      {/* Optional attention pill top-left. */}
      {label && (
        <span className={`absolute top-3 left-3 z-10 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ring-1 backdrop-blur-sm ${pillTone}`}>
          {label}
        </span>
      )}

      {/* Play triangle overlay — subtle so it doesn't fight the preview. */}
      <span
        className="absolute inset-0 flex items-center justify-center opacity-70 group-hover:opacity-100 transition-opacity pointer-events-none"
        aria-hidden
      >
        <span className="w-16 h-16 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center ring-1 ring-white/25">
          <svg
            className="w-7 h-7 text-white translate-x-[1.5px]"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      </span>

      {/* Bottom-left label overlay. */}
      <div className="absolute inset-x-0 bottom-0 p-4 pt-16 bg-gradient-to-t from-black/85 via-black/50 to-transparent pointer-events-none">
        <div className="text-white text-xl sm:text-2xl font-black truncate leading-tight">{name}</div>
        {secondary && (
          <div className="text-white/80 text-sm font-medium truncate leading-snug mt-1">
            {secondary}
          </div>
        )}
      </div>
    </button>
  );
};

export default HighlightHero;
