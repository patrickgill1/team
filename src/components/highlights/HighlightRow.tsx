// Horizontal-scroll strip for one Netflix-style row inside the
// Highlights tab. Chrome-light: title + optional subtitle, then a
// snap-scroll flex row of HighlightCardLite. Returns null when there
// are no clips (silent-hide) so an empty row never adds visual noise.

import React from 'react';
import type { PlayerMedia as PlayerMediaType, Player } from '../../types';
import HighlightCardLite from './HighlightCardLite';

interface Props {
  title: string;
  subtitle?: string;
  clips: PlayerMediaType[];
  players?: Player[];
  onCardTap: (clipId: string) => void;
  // Optional right-side accent shown next to the title (e.g. a small
  // count pill or coach-only affordance). Kept simple to avoid the
  // "see all" trap — deep exploration goes through the filter sheet.
  accent?: React.ReactNode;
}

const HighlightRow: React.FC<Props> = ({ title, subtitle, clips, players, onCardTap, accent }) => {
  if (!clips || clips.length === 0) return null;
  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between gap-2 mb-3 px-1">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-ink-primary truncate">{title}</h2>
          {subtitle && (
            <p className="text-xs text-ink-secondary/80 truncate mt-0.5">{subtitle}</p>
          )}
        </div>
        {accent && <div className="shrink-0">{accent}</div>}
      </div>
      <div
        className="flex gap-3 overflow-x-auto overflow-y-hidden snap-x snap-mandatory pb-3 -mx-1 px-1 highlight-row-scroll"
        style={{ WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}
      >
        {clips.map(clip => (
          <HighlightCardLite
            key={clip.id}
            clip={clip}
            players={players}
            onOpen={() => onCardTap(clip.id)}
          />
        ))}
      </div>
    </section>
  );
};

export default HighlightRow;
