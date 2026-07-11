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

// Compact top bar. Search + sort + single Filters button + count.
// Filters button opens a bottom sheet with all the categories in one
// organized place, so we don't crowd the header with a slideable pill
// strip (memory: never side-scroll a row of pills) OR a wrapping wall
// of chips that lands in a random rhythm.
const PhotoFilterBar: React.FC<Props> = ({ filters, onChange, players, events, totalCount, visibleCount }) => {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [playerSearch, setPlayerSearch] = useState('');
  const [eventSearch, setEventSearch] = useState('');

  const activeCount =
    filters.playerIds.length +
    (filters.eventId ? 1 : 0) +
    (filters.datePreset !== 'all' ? 1 : 0) +
    (filters.untaggedOnly ? 1 : 0);

  const filteredPlayers = players.filter((p) => {
    const q = playerSearch.trim().toLowerCase();
    return !q || p.name.toLowerCase().includes(q);
  });

  const filteredEvents = events.filter((e) => {
    const q = eventSearch.trim().toLowerCase();
    return !q || (e.title || '').toLowerCase().includes(q);
  });

  const resetFilters = () => onChange({ ...DEFAULT_FILTERS, sort: filters.sort, search: filters.search });
  const activePlayerNames = filters.playerIds
    .map((id) => players.find((p) => p.id === id)?.name)
    .filter(Boolean)
    .join(', ');
  const activeEventTitle = filters.eventId ? events.find((e) => e.id === filters.eventId)?.title : null;

  return (
    <div className="sticky top-0 z-20 bg-surface-base/95 backdrop-blur-md border-b border-line-default/10 px-3 py-3">
      {/* Row 1: search + sort + filters button */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-primary/40" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197M15.803 15.803A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
          <input
            type="text"
            value={filters.search}
            onChange={(e) => onChange({ ...filters, search: e.target.value })}
            placeholder="Search photos..."
            className="w-full pl-9 pr-3 py-2 bg-surface-elevated border border-line-default/10 rounded-lg text-sm text-ink-primary placeholder:text-ink-primary/40 focus:outline-none focus:border-brand-primary/50"
          />
        </div>
        <select
          value={filters.sort}
          onChange={(e) => onChange({ ...filters, sort: e.target.value as SortMode })}
          className="shrink-0 bg-surface-elevated border border-line-default/10 rounded-lg text-xs font-semibold px-2 py-2 text-ink-primary focus:outline-none focus:border-brand-primary/50"
          aria-label="Sort"
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="popular">Most loved</option>
        </select>
        <button
          onClick={() => setFiltersOpen(true)}
          className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition ${
            activeCount > 0
              ? 'bg-brand-primary text-brand-primary-fg border border-brand-primary'
              : 'bg-surface-elevated text-ink-primary/80 border border-line-default/10 hover:border-line-default/25'
          }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" /></svg>
          Filters
          {activeCount > 0 && (
            <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-white/25 text-[10px] font-black">
              {activeCount}
            </span>
          )}
        </button>
      </div>

      {/* Row 2: result count + active-filter summary + clear */}
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
        <div className="font-bold uppercase tracking-widest text-ink-primary/50 truncate">
          {visibleCount === totalCount
            ? `${totalCount} photo${totalCount !== 1 ? 's' : ''}`
            : `${visibleCount} of ${totalCount}`}
          {activeCount > 0 && (
            <>
              <span className="mx-1.5 opacity-60">·</span>
              <span className="text-brand-primary-soft">
                {[
                  filters.datePreset !== 'all' && DATE_LABELS[filters.datePreset],
                  activePlayerNames && `${filters.playerIds.length} player${filters.playerIds.length > 1 ? 's' : ''}`,
                  activeEventTitle,
                  filters.untaggedOnly && 'untagged',
                ].filter(Boolean).join(' · ')}
              </span>
            </>
          )}
        </div>
        {activeCount > 0 && (
          <button
            onClick={resetFilters}
            className="shrink-0 font-bold uppercase tracking-widest text-ink-primary/60 hover:text-ink-primary"
          >
            Clear
          </button>
        )}
      </div>

      {/* Filter sheet */}
      {filtersOpen && (
        <FilterSheet
          filters={filters}
          onChange={onChange}
          players={players}
          events={events}
          onClose={() => setFiltersOpen(false)}
          onReset={resetFilters}
          activeCount={activeCount}
          filteredPlayers={filteredPlayers}
          filteredEvents={filteredEvents}
          playerSearch={playerSearch}
          setPlayerSearch={setPlayerSearch}
          eventSearch={eventSearch}
          setEventSearch={setEventSearch}
        />
      )}
    </div>
  );
};

const DATE_LABELS: Record<DatePreset, string> = {
  all: 'All time',
  '7d': 'Past week',
  '30d': 'Past month',
  season: 'Season',
};

interface SheetProps {
  filters: PhotoFilters;
  onChange: (next: PhotoFilters) => void;
  players: Player[];
  events: CalendarEvent[];
  onClose: () => void;
  onReset: () => void;
  activeCount: number;
  filteredPlayers: Player[];
  filteredEvents: CalendarEvent[];
  playerSearch: string;
  setPlayerSearch: (s: string) => void;
  eventSearch: string;
  setEventSearch: (s: string) => void;
}

const FilterSheet: React.FC<SheetProps> = ({
  filters, onChange, players: _players, events: _events, onClose, onReset, activeCount,
  filteredPlayers, filteredEvents, playerSearch, setPlayerSearch, eventSearch, setEventSearch,
}) => {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-surface-elevated w-full sm:max-w-md max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between px-4 py-3 border-b border-line-default/10 bg-surface-elevated">
          <h3 className="text-base font-black text-ink-primary tracking-tight">Filter photos</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-line-default/[0.08] text-ink-primary/60"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* Time range — segmented control */}
          <section>
            <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/50 mb-2">Time range</p>
            <div className="grid grid-cols-4 gap-1 bg-surface-base rounded-lg p-1 border border-line-default/10">
              {(['all', '7d', '30d', 'season'] as DatePreset[]).map((p) => (
                <button
                  key={p}
                  onClick={() => onChange({ ...filters, datePreset: p })}
                  className={`py-2 rounded-md text-[11px] font-black uppercase tracking-widest transition ${
                    filters.datePreset === p
                      ? 'bg-brand-primary text-brand-primary-fg'
                      : 'text-ink-primary/70 hover:bg-line-default/[0.06]'
                  }`}
                >
                  {p === 'all' ? 'All' : p === '7d' ? 'Week' : p === '30d' ? 'Month' : 'Season'}
                </button>
              ))}
            </div>
          </section>

          {/* Untagged toggle */}
          <section>
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <p className="text-sm font-bold text-ink-primary">Untagged only</p>
                <p className="text-[11px] text-ink-primary/55">Photos with no player tagged yet.</p>
              </div>
              <button
                onClick={() => onChange({ ...filters, untaggedOnly: !filters.untaggedOnly })}
                className={`relative w-11 h-6 rounded-full transition ${filters.untaggedOnly ? 'bg-brand-primary' : 'bg-line-default/25'}`}
                aria-pressed={filters.untaggedOnly}
                aria-label="Toggle untagged only"
              >
                <span
                  className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                    filters.untaggedOnly ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </label>
          </section>

          {/* Players */}
          <section>
            <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/50 mb-2">
              Player{filters.playerIds.length > 0 && ` · ${filters.playerIds.length} selected`}
            </p>
            <input
              type="text"
              value={playerSearch}
              onChange={(e) => setPlayerSearch(e.target.value)}
              placeholder="Search players..."
              className="w-full bg-surface-base border border-line-default/10 rounded-lg px-3 py-2 text-sm text-ink-primary placeholder:text-ink-primary/40 focus:outline-none focus:border-brand-primary/50 mb-2"
            />
            <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto">
              {filteredPlayers.length === 0 && (
                <p className="text-xs text-ink-primary/50 italic py-1">No matches.</p>
              )}
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
                        ? 'bg-brand-primary text-brand-primary-fg border-brand-primary'
                        : 'bg-surface-base text-ink-primary/85 border-line-default/15 hover:border-brand-primary/40'
                    }`}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Event */}
          {filteredEvents.length > 0 && (
            <section>
              <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/50 mb-2">
                Event{filters.eventId ? ' · 1 selected' : ''}
              </p>
              <input
                type="text"
                value={eventSearch}
                onChange={(e) => setEventSearch(e.target.value)}
                placeholder="Search events..."
                className="w-full bg-surface-base border border-line-default/10 rounded-lg px-3 py-2 text-sm text-ink-primary placeholder:text-ink-primary/40 focus:outline-none focus:border-brand-primary/50 mb-2"
              />
              <div className="space-y-1 max-h-48 overflow-y-auto">
                <button
                  onClick={() => onChange({ ...filters, eventId: null })}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition ${
                    !filters.eventId ? 'bg-brand-primary/15 text-brand-primary-soft' : 'hover:bg-line-default/[0.06] text-ink-primary/80'
                  }`}
                >
                  All events
                </button>
                {filteredEvents.slice(0, 40).map((e) => (
                  <button
                    key={e.id}
                    onClick={() => onChange({ ...filters, eventId: e.id })}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition ${
                      filters.eventId === e.id ? 'bg-brand-primary/15 text-brand-primary-soft' : 'hover:bg-line-default/[0.06] text-ink-primary/85'
                    }`}
                  >
                    <span className="font-semibold">{e.title}</span>
                    <span className="ml-2 text-[10px] uppercase tracking-widest text-ink-primary/50">
                      {new Date(e.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Sticky footer */}
        <div className="sticky bottom-0 border-t border-line-default/10 bg-surface-elevated p-3 flex items-center gap-2">
          <button
            onClick={onReset}
            disabled={activeCount === 0}
            className="flex-1 py-2.5 rounded-lg bg-surface-base text-ink-primary/80 text-sm font-bold disabled:opacity-40"
          >
            Clear all
          </button>
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-lg bg-brand-primary hover:bg-brand-primary-hov text-brand-primary-fg text-sm font-black transition"
          >
            Show {activeCount > 0 ? 'filtered' : 'all'} photos
          </button>
        </div>
      </div>
    </div>
  );
};

export default PhotoFilterBar;
