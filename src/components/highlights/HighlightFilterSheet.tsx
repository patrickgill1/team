// Bottom-sheet filter for the Netflix Highlights tab. Collapses every
// old chrome row (media-type pills, tag chips, browse-by-player scroll,
// search input) into one radical entry point. Sections stack:
//   - Search
//   - Player picker (with per-player clip counts)
//   - Content type
//   - Date range
// Footer shows a live "Show N clips" primary button plus a "Clear all"
// escape hatch. Not URL-synced in v1 — sheet is transient.

import React, { useMemo, useState } from 'react';
import type { Player, PlayerMedia as PlayerMediaType } from '../../types';
import { mediaBelongsToPlayer } from '../../utils/mediaAttribution';

export type ContentTypeFilter = 'all' | 'goal' | 'assist' | 'big_play' | 'highlight' | 'photo';
export type DateRangeFilter = 'all' | '7d' | '30d' | 'season';

export interface FilterState {
  playerId: string | null;
  contentType: ContentTypeFilter;
  dateRange: DateRangeFilter;
  searchQuery: string;
}

export const EMPTY_FILTER: FilterState = {
  playerId: null,
  contentType: 'all',
  dateRange: 'all',
  searchQuery: '',
};

export function isFilterActive(f: FilterState): boolean {
  return (
    f.playerId !== null ||
    f.contentType !== 'all' ||
    f.dateRange !== 'all' ||
    f.searchQuery.trim().length > 0
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  players: Player[];
  media: PlayerMediaType[];
  value: FilterState;
  onChange: (next: FilterState) => void;
  // Live count of clips matching the CURRENT filter (parent computes it
  // so the sheet doesn't have to know the row logic).
  matchCount: number;
}

const CONTENT_OPTS: { key: ContentTypeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'goal', label: 'Goals' },
  { key: 'assist', label: 'Assists' },
  { key: 'big_play', label: 'Big plays' },
  { key: 'highlight', label: 'Highlights' },
  { key: 'photo', label: 'Photos' },
];

const DATE_OPTS: { key: DateRangeFilter; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'season', label: 'This season' },
];

const HighlightFilterSheet: React.FC<Props> = ({
  open,
  onClose,
  players,
  media,
  value,
  onChange,
  matchCount,
}) => {
  const [playerSearch, setPlayerSearch] = useState('');

  // Per-player clip counts, computed against ALL team media so the
  // numbers match what parents see on Browse-by-Player (the legacy
  // surface being replaced). Sorted by count desc so the most-featured
  // players float to the top of the picker.
  const playerRows = useMemo(() => {
    const q = playerSearch.trim().toLowerCase();
    const rows = players
      .map(p => ({ player: p, count: media.filter(m => mediaBelongsToPlayer(m, p.id)).length }))
      .filter(r => r.count > 0);
    const filtered = q
      ? rows.filter(r => r.player.name.toLowerCase().includes(q))
      : rows;
    return filtered.sort((a, b) => b.count - a.count);
  }, [players, media, playerSearch]);

  if (!open) return null;

  const set = <K extends keyof FilterState>(k: K, v: FilterState[K]) =>
    onChange({ ...value, [k]: v });

  const active = isFilterActive(value);

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close filters"
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />
      {/* Sheet */}
      <div className="absolute inset-x-0 bottom-0 max-h-[85vh] flex flex-col rounded-t-2xl bg-surface-elevated border-t border-line-default/15 shadow-2xl">
        {/* Drag handle */}
        <div className="pt-2 pb-1 flex justify-center">
          <span className="block w-10 h-1 rounded-full bg-ink-secondary/30" aria-hidden />
        </div>
        <div className="px-4 pb-2 flex items-center justify-between">
          <h2 className="text-base font-black text-ink-primary">Filter highlights</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 rounded-full flex items-center justify-center text-ink-secondary hover:text-ink-primary hover:bg-line-default/10"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-6">
          {/* Search */}
          <section>
            <h3 className="text-[10px] font-black uppercase tracking-widest text-ink-secondary mb-2">Search</h3>
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-secondary" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
              </svg>
              <input
                type="text"
                value={value.searchQuery}
                onChange={e => set('searchQuery', e.target.value)}
                placeholder="Caption, player, tag..."
                className="w-full pl-9 pr-3 py-2.5 bg-surface-input border border-line-default/20 rounded-lg text-sm text-ink-primary placeholder:text-ink-secondary focus:outline-none focus:ring-2 focus:ring-brand-primary/50"
              />
            </div>
          </section>

          {/* Player picker */}
          <section>
            <div className="flex items-baseline justify-between mb-2">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-ink-secondary">Player</h3>
              {value.playerId && (
                <button
                  type="button"
                  onClick={() => set('playerId', null)}
                  className="text-[11px] font-bold text-brand-primary-soft hover:text-ink-primary"
                >
                  Clear
                </button>
              )}
            </div>
            <input
              type="text"
              value={playerSearch}
              onChange={e => setPlayerSearch(e.target.value)}
              placeholder="Find a player..."
              className="w-full mb-2 px-3 py-2 bg-surface-input border border-line-default/20 rounded-lg text-sm text-ink-primary placeholder:text-ink-secondary focus:outline-none focus:ring-2 focus:ring-brand-primary/50"
            />
            <div className="max-h-64 overflow-y-auto rounded-lg ring-1 ring-line-default/15 divide-y divide-line-default/10">
              <button
                type="button"
                onClick={() => set('playerId', null)}
                className={`w-full text-left px-3 py-2.5 flex items-center gap-3 text-sm ${value.playerId === null ? 'bg-brand-primary/10 text-ink-primary font-bold' : 'text-ink-primary/80 hover:bg-line-default/5'}`}
              >
                <span className="flex-1">All players</span>
                <span className="text-xs text-ink-secondary">{media.length}</span>
              </button>
              {playerRows.map(({ player, count }) => {
                const on = value.playerId === player.id;
                return (
                  <button
                    key={player.id}
                    type="button"
                    onClick={() => set('playerId', player.id)}
                    className={`w-full text-left px-3 py-2.5 flex items-center gap-3 text-sm ${on ? 'bg-brand-primary/10 text-ink-primary font-bold' : 'text-ink-primary/80 hover:bg-line-default/5'}`}
                  >
                    {player.profilePhotoUrl ? (
                      <img src={player.profilePhotoUrl} alt="" className="w-8 h-8 rounded-full object-cover" loading="lazy" />
                    ) : (
                      <span className="w-8 h-8 rounded-full bg-line-default/10 flex items-center justify-center text-[10px] font-black text-ink-primary/70">
                        {(player.jerseyNumber != null ? String(player.jerseyNumber) : player.name.charAt(0))}
                      </span>
                    )}
                    <span className="flex-1 truncate">{player.name}</span>
                    <span className="text-xs text-ink-secondary">{count}</span>
                  </button>
                );
              })}
              {playerRows.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-ink-secondary">No players match.</div>
              )}
            </div>
          </section>

          {/* Content type */}
          <section>
            <h3 className="text-[10px] font-black uppercase tracking-widest text-ink-secondary mb-2">Content type</h3>
            <div className="flex flex-wrap gap-2">
              {CONTENT_OPTS.map(opt => {
                const on = value.contentType === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => set('contentType', opt.key)}
                    className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition ring-1 ${on ? 'bg-brand-primary text-white ring-brand-primary' : 'bg-surface-input text-ink-primary/75 ring-line-default/20 hover:bg-line-default/10'}`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Date range */}
          <section>
            <h3 className="text-[10px] font-black uppercase tracking-widest text-ink-secondary mb-2">Date</h3>
            <div className="flex flex-wrap gap-2">
              {DATE_OPTS.map(opt => {
                const on = value.dateRange === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => set('dateRange', opt.key)}
                    className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition ring-1 ${on ? 'bg-brand-primary text-white ring-brand-primary' : 'bg-surface-input text-ink-primary/75 ring-line-default/20 hover:bg-line-default/10'}`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        {/* Footer */}
        <div
          className="border-t border-line-default/15 px-4 py-3 flex items-center gap-3 bg-surface-elevated"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <button
            type="button"
            disabled={!active}
            onClick={() => onChange(EMPTY_FILTER)}
            className={`text-sm font-bold ${active ? 'text-ink-secondary hover:text-ink-primary' : 'text-ink-secondary/40 cursor-not-allowed'}`}
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto px-5 py-2.5 rounded-lg bg-brand-primary hover:bg-brand-primary-dim text-white text-sm font-black shadow-sm"
          >
            {active ? `Show ${matchCount} clip${matchCount === 1 ? '' : 's'}` : 'Done'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default HighlightFilterSheet;
