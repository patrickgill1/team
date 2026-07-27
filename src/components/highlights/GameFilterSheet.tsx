// Chip + bottom-sheet game picker for the Highlights tab. Chip sits
// beside the Sort pill in the grid section header. Tap opens a
// bottom sheet listing every past game the team has played (games
// linked to at least one clip via clip.gameId), sorted newest-first.
// "All games" resets the filter.
//
// Kept next to HighlightsNetflixTab because it's the only consumer
// today. If a second surface wants a game picker, promote to /ui.

import React, { useState } from 'react';
import Sheet from '../ui/Sheet';

export interface GameFilterOption {
  gameId: string;
  opponent: string;
  title: string;
  date: Date;
}

interface Props {
  options: GameFilterOption[];
  value: string | 'all';
  onChange: (next: string | 'all') => void;
}

function fmtDate(d: Date): string {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  try {
    return d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'America/Denver',
    });
  } catch {
    return d.toDateString();
  }
}

function labelFor(opt: GameFilterOption): string {
  return opt.opponent ? `vs ${opt.opponent}` : (opt.title || 'Game');
}

const GameFilterSheet: React.FC<Props> = ({ options, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const selected = value === 'all' ? null : options.find(o => o.gameId === value) || null;
  const chipLabel = selected ? labelFor(selected) : 'All games';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-surface-elevated text-ink-primary ring-1 ring-line-default/20 hover:bg-line-default/10 focus:outline-none focus:ring-2 focus:ring-brand-primary/60 max-w-[180px]"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="text-ink-secondary font-medium shrink-0">Game:</span>
        <span className="truncate">{chipLabel}</span>
        <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        kicker="Filter clips"
        title="Pick a game"
        size="sm"
      >
        <div className="flex flex-col divide-y divide-line-default/10 pb-3">
          <button
            type="button"
            onClick={() => { onChange('all'); setOpen(false); }}
            className={`text-left py-3 px-1 flex items-center justify-between gap-3 ${value === 'all' ? 'text-brand-primary-soft' : 'text-ink-primary'}`}
          >
            <span className={value === 'all' ? 'font-black' : 'font-bold'}>All games</span>
            {value === 'all' && (
              <svg className="w-4 h-4 text-brand-primary-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </button>
          {options.map(o => {
            const active = o.gameId === value;
            return (
              <button
                key={o.gameId}
                type="button"
                onClick={() => { onChange(o.gameId); setOpen(false); }}
                className={`text-left py-3 px-1 flex items-center justify-between gap-3 ${active ? 'text-brand-primary-soft' : 'text-ink-primary'}`}
              >
                <span className={`truncate ${active ? 'font-black' : 'font-bold'}`}>{labelFor(o)}</span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className={`text-xs ${active ? 'text-brand-primary-soft/80' : 'text-ink-secondary'}`}>{fmtDate(o.date)}</span>
                  {active && (
                    <svg className="w-4 h-4 text-brand-primary-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </Sheet>
    </>
  );
};

export default GameFilterSheet;
