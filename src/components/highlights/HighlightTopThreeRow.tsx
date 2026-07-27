// Leaderboard-style "Top 3 Clips This Season" row for the Highlights
// tab. Replaces the plain HighlightRow rendering for the top-3 case:
// each card gets a big gold/silver/bronze rank numeral overlay so the
// row reads instantly as a competitive ranking, not just three more
// thumbnails.
//
// Chrome-light like the rest of the highlights UI: no like/view/share
// chips on the card - the numeral + the tagged player avatar + name +
// meta line is enough. Deep engagement happens in the reel.

import React from 'react';
import type { PlayerMedia as PlayerMediaType, Player } from '../../types';
import { posterFor } from '../../utils/mediaPoster';
import RosterAvatar from '../common/RosterAvatar';
import { primaryTaggedPlayer } from './HighlightCardLite';

interface Props {
  clips: PlayerMediaType[];         // caller passes exactly the top 3, in order
  players?: Player[];
  onCardTap: (clipId: string) => void;
  title?: string;
}

function shortDate(v: any): string {
  const d: Date = v?.toDate ? v.toDate() : v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function momentLabel(kind?: string): string | null {
  if (kind === 'goal') return 'Goal';
  if (kind === 'assist') return 'Assist';
  if (kind === 'big_play') return 'Big play';
  return null;
}

function displayName(clip: PlayerMediaType, players?: Player[]): string {
  const tagged = primaryTaggedPlayer(clip, players);
  if (tagged?.name) return tagged.name;
  return clip.playerName || 'Highlight';
}

// Numeral tone per rank. Kept as class strings (not tokens) so the
// gold/silver/bronze medal metaphor stays intact in both themes -
// this is one of the rare spots where the metaphor is intentional
// even in light mode. Glow is subtler now that the numeral is a
// small top-left corner overlay instead of a giant left slab.
function rankStyle(rank: 1 | 2 | 3): { color: string; glow: string; label: string } {
  if (rank === 1) {
    return {
      color: 'text-amber-300',
      glow: 'drop-shadow-[0_1px_6px_rgba(251,191,36,0.6)]',
      label: 'Gold',
    };
  }
  if (rank === 2) {
    return {
      color: 'text-slate-200',
      glow: 'drop-shadow-[0_1px_6px_rgba(226,232,240,0.5)]',
      label: 'Silver',
    };
  }
  return {
    color: 'text-orange-400',
    glow: 'drop-shadow-[0_1px_6px_rgba(251,146,60,0.55)]',
    label: 'Bronze',
  };
}

const HighlightTopThreeRow: React.FC<Props> = ({ clips, players, onCardTap, title }) => {
  if (!clips || clips.length === 0) return null;
  const heading = title || 'Top 3 Clips This Season';
  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between gap-2 mb-3 px-1">
        <div className="min-w-0 flex items-center gap-2">
          <svg
            aria-hidden
            className="w-4 h-4 text-amber-400 shrink-0"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M12 2l2.39 4.84 5.34.78-3.87 3.77.92 5.32L12 14.9l-4.78 2.51.92-5.32L4.27 7.62l5.34-.78L12 2z" />
          </svg>
          <h2 className="text-lg font-bold text-ink-primary truncate">{heading}</h2>
        </div>
      </div>
      <div
        className="flex gap-4 overflow-x-auto overflow-y-hidden snap-x snap-mandatory pb-3 -mx-1 px-1 highlight-row-scroll"
        style={{ WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}
      >
        {clips.slice(0, 3).map((clip, i) => (
          <TopCard
            key={clip.id}
            rank={(i + 1) as 1 | 2 | 3}
            clip={clip}
            players={players}
            onTap={() => onCardTap(clip.id)}
          />
        ))}
      </div>
    </section>
  );
};

// ── Sub: single ranked card ─────────────────────────────────────────

interface TopCardProps {
  rank: 1 | 2 | 3;
  clip: PlayerMediaType;
  players?: Player[];
  onTap: () => void;
}

const TopCard: React.FC<TopCardProps> = ({ rank, clip, players, onTap }) => {
  const poster = posterFor(clip);
  const tagged = primaryTaggedPlayer(clip, players);
  const name = displayName(clip, players);
  const secondary = momentLabel(clip.momentType) || shortDate(clip.createdAt);
  const { color, glow, label } = rankStyle(rank);

  return (
    <button
      type="button"
      onClick={onTap}
      className="group relative w-[260px] md:w-[320px] snap-start shrink-0 aspect-video rounded-xl overflow-hidden bg-surface-elevated ring-1 ring-line-default/10 text-left transition-transform hover:scale-[1.02] focus:outline-none focus:ring-2 focus:ring-brand-primary/60"
      aria-label={`Rank ${rank} (${label}): Play ${name}`}
    >
      {poster ? (
        <img
          src={poster}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          loading="lazy"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-surface-raised to-surface-elevated" />
      )}

      {/* Bottom-weighted gradient so the info row stays readable on
          bright posters, plus a soft top-left gradient so the corner
          numeral has enough contrast. */}
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent pointer-events-none"
      />
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/55 to-transparent pointer-events-none"
      />

      {/* Play triangle on hover / touch (same idiom as HighlightCardLite). */}
      <span
        className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity [@media(pointer:coarse)]:opacity-100"
        aria-hidden
      >
        <span className="w-11 h-11 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center ring-1 ring-white/20">
          <svg className="w-5 h-5 text-white translate-x-[1px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      </span>

      {/* Small rank numeral, top-left corner. Gold/silver/bronze color
          treatment preserved; drop-shadow subtler now that the numeral
          is a corner mark rather than the loudest thing on the card. */}
      <span
        aria-hidden
        className={`absolute left-2 top-1 text-4xl md:text-[44px] leading-none font-black select-none pointer-events-none ${color} ${glow}`}
        style={{
          letterSpacing: '-0.05em',
          fontFamily: 'ui-serif, Georgia, "Times New Roman", serif',
        }}
      >
        {rank}
      </span>

      {/* Info row - full-width across the bottom now that the numeral
          lives up in the corner. */}
      <div className="absolute inset-x-0 bottom-0 p-3 pointer-events-none">
        <div className="flex items-center gap-2 min-w-0">
          <RosterAvatar
            name={tagged?.name || name}
            photoUrl={tagged?.profilePhotoUrl || undefined}
            size={28}
            className="ring-1 ring-white/50"
          />
          <div className="min-w-0 flex-1">
            <div className="text-white text-[14px] font-bold truncate leading-tight">{name}</div>
            {secondary && (
              <div className="text-white/75 text-[11px] font-medium truncate leading-tight mt-0.5">
                {secondary}
              </div>
            )}
          </div>
        </div>
      </div>
    </button>
  );
};

export default HighlightTopThreeRow;
