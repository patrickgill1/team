import React, { useState } from 'react';
import type { CalendarEvent, Player } from '../../types';

export type DatePreset = 'all' | '7d' | '30d' | 'season';
export type SortMode = 'newest' | 'oldest' | 'popular';

export interface PhotoFilters {
  playerIds: string[];
  eventId: string | null;
  datePreset: DatePreset;
  untaggedOnly: boolean;
  sort: SortMode;
  search: string;
}

export const DEFAULT_FILTERS: PhotoFilters = {
  playerIds: [],
  eventId: null,
  datePreset: 'all',
  untaggedOnly: false,
  sort: 'newest',
  search: '',
};

interface Props {
  filters: PhotoFilters;
  onChange: (next: PhotoFilters) => void;
  players: Player[];
  events: CalendarEvent[];
  totalCount: number;
  visibleCount: number;
}

const PhotoFilterBar: React.FC<Props> = ({ filters, onChange, players, events, totalCount, visibleCount }) => {
  const [playerPickerOpen, setPlayerPickerOpen] = useState(false);
  const [playerSearch, setPlayerSearch] = useState('');
  const [eventPickerOpen, setEventPickerOpen] = useState(false);

  const activeCount =
    filters.playerIds.length +
    (filters.eventId ? 1 : 0) +
    (filters.datePreset !== 'all' ? 1 : 0) +
    (filters.untaggedOnly ? 1 : 0) +
    (filters.search.trim() ? 1 : 0);

  const filteredPlayers = players.filter((p) => {
    const q = playerSearch.trim().toLowerCase();
    return !q || p.name.toLowerCase().includes(q);
  });

  return (
    <div className="sticky top-0 z-20 bg-surface-base/95 backdrop-blur-md border-b border-line-default/10 px-3 pt-3 pb-2 space-y-2">
      {/* Search + count */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-primary/40" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197M15.803 15.803A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
          <input
            type="text"
            value={filters.search}
            onChange={(e) => onChange({ ...filters, search: e.target.value })}
            placeholder="Search captions..."
            className="w-full pl-9 pr-3 py-2 bg-surface-elevated border border-line-default/10 rounded-lg text-sm text-ink-primary placeholder:text-ink-primary/40 focus:outline-none focus:border-cyan-500/50"
          />
        </div>
        <select
          value={filters.sort}
          onChange={(e) => onChange({ ...filters, sort: e.target.value as SortMode })}
          className="bg-surface-elevated border border-line-default/10 rounded-lg text-xs font-semibold px-2 py-2 text-ink-primary focus:outline-none focus:border-cyan-500/50"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="popular">Most loved</option>
        </select>
      </div>

      {/* Filter chip row */}
      <div className="flex items-center gap-2 overflow-x-auto -mx-3 px-3 pb-1 scrollbar-thin">
        <Chip active={filters.datePreset === 'all'} onClick={() => onChange({ ...filters, datePreset: 'all' })}>
          All time
        </Chip>
        <Chip active={filters.datePreset === '7d'} onClick={() => onChange({ ...filters, datePreset: '7d' })}>
          Past week
        </Chip>
        <Chip active={filters.datePreset === '30d'} onClick={() => onChange({ ...filters, datePreset: '30d' })}>
          Past month
        </Chip>
        <Chip active={filters.datePreset === 'season'} onClick={() => onChange({ ...filters, datePreset: 'season' })}>
          Season
        </Chip>
        <span className="h-5 w-px bg-line-default/20 shrink-0" />
        <Chip
          active={filters.playerIds.length > 0}
          onClick={() => setPlayerPickerOpen((v) => !v)}
        >
          {filters.playerIds.length === 0 ? 'Player' : `${filters.playerIds.length} player${filters.playerIds.length > 1 ? 's' : ''}`}
          <svg className="ml-1 w-3 h-3 opacity-60" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
        </Chip>
        <Chip
          active={!!filters.eventId}
          onClick={() => setEventPickerOpen((v) => !v)}
        >
          {filters.eventId ? (events.find((e) => e.id === filters.eventId)?.title || 'Event').slice(0, 24) : 'Event'}
          <svg className="ml-1 w-3 h-3 opacity-60" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
        </Chip>
        <Chip active={filters.untaggedOnly} onClick={() => onChange({ ...filters, untaggedOnly: !filters.untaggedOnly })}>
          Untagged only
        </Chip>
        {activeCount > 0 && (
          <button
            onClick={() => onChange({ ...DEFAULT_FILTERS, sort: filters.sort })}
            className="ml-auto text-[11px] font-bold uppercase tracking-widest text-ink-primary/60 hover:text-ink-primary shrink-0"
          >
            Clear
          </button>
        )}
      </div>

      {/* Result count */}
      <div className="text-[11px] font-bold uppercase tracking-widest text-ink-primary/50">
        {visibleCount === totalCount
          ? `${totalCount} photo${totalCount !== 1 ? 's' : ''}`
          : `${visibleCount} of ${totalCount} photos`}
      </div>

      {/* Player picker popover */}
      {playerPickerOpen && (
        <div className="absolute left-3 right-3 top-full mt-1 z-30 bg-surface-elevated border border-line-default/15 rounded-xl shadow-2xl p-3 max-h-[60vh] overflow-y-auto">
          <div className="flex items-center gap-2 mb-2">
            <input
              autoFocus
              value={playerSearch}
              onChange={(e) => setPlayerSearch(e.target.value)}
              placeholder="Search players..."
              className="flex-1 bg-surface-base border border-line-default/10 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-cyan-500/50"
            />
            <button onClick={() => setPlayerPickerOpen(false)} className="text-[10px] font-bold uppercase tracking-widest text-ink-primary/60 hover:text-ink-primary px-2">Done</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {filteredPlayers.map((p) => {
              const selected = filters.playerIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => onChange({
                    ...filters,
                    playerIds: selected
                      ? filters.playerIds.filter((id) => id !== p.id)
                      : [...filters.playerIds, p.id],
                  })}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition ${
                    selected
                      ? 'bg-cyan-600 text-white border-cyan-600'
                      : 'bg-surface-base text-ink-primary/85 border-line-default/15 hover:border-cyan-500/40'
                  }`}
                >
                  {p.name}
                </button>
              );
            })}
            {filteredPlayers.length === 0 && (
              <p className="text-xs text-ink-primary/50 italic py-1">No matches.</p>
            )}
          </div>
        </div>
      )}

      {/* Event picker popover */}
      {eventPickerOpen && (
        <div className="absolute left-3 right-3 top-full mt-1 z-30 bg-surface-elevated border border-line-default/15 rounded-xl shadow-2xl p-3 max-h-[60vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-ink-primary/50">Filter by event</p>
            <button onClick={() => setEventPickerOpen(false)} className="text-[10px] font-bold uppercase tracking-widest text-ink-primary/60 hover:text-ink-primary">Done</button>
          </div>
          <div className="space-y-1">
            <button
              onClick={() => { onChange({ ...filters, eventId: null }); setEventPickerOpen(false); }}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm ${!filters.eventId ? 'bg-cyan-600/20 text-cyan-100' : 'hover:bg-line-default/[0.06] text-ink-primary'}`}
            >
              All events
            </button>
            {events.slice(0, 100).map((e) => (
              <button
                key={e.id}
                onClick={() => { onChange({ ...filters, eventId: e.id }); setEventPickerOpen(false); }}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate ${filters.eventId === e.id ? 'bg-cyan-600/20 text-cyan-100' : 'hover:bg-line-default/[0.06] text-ink-primary'}`}
              >
                <span className="font-semibold">{e.title}</span>
                <span className="ml-2 text-[10px] uppercase tracking-widest text-ink-primary/50">
                  {new Date(e.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const Chip: React.FC<{ active?: boolean; onClick?: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`inline-flex items-center px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-widest transition whitespace-nowrap shrink-0 ${
      active
        ? 'bg-cyan-600 text-white border border-cyan-600'
        : 'bg-surface-elevated text-ink-primary/70 border border-line-default/10 hover:border-line-default/25'
    }`}
  >
    {children}
  </button>
);

export default PhotoFilterBar;
