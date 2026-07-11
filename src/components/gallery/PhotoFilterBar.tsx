import React, { useState } from 'react';
import { createPortal } from 'react-dom';
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
  /** Topic tag filter — e.g. only photos tagged 'game' or 'celebration'. */
  topicTags: string[];
}

export const DEFAULT_FILTERS: PhotoFilters = {
  playerIds: [],
  eventId: null,
  datePreset: 'all',
  untaggedOnly: false,
  sort: 'newest',
  search: '',
  topicTags: [],
};

const TOPIC_TAG_OPTIONS = ['game', 'practice', 'team', 'celebration', 'tournament', 'training', 'awards'];

interface Props {
  filters: PhotoFilters;
  onChange: (next: PhotoFilters) => void;
  players: Player[];
  events: CalendarEvent[];
  totalCount: number;
  visibleCount: number;
}

// Inline pill layout, wrapping (never side-scrolling — memory rule).
// Two clean rows so the layout stays organized instead of chaotic:
//   Row 1: search + sort + result count
//   Row 2: date-preset segmented control (fixed 4-up)
//   Row 3: filter chips that wrap — player, event, topic tags, untagged
// Player and event chips open popover pickers when tapped. Everything
// visible at a glance; nothing hidden behind a "Filters" button.
const PhotoFilterBar: React.FC<Props> = ({ filters, onChange, players, events, totalCount, visibleCount }) => {
  const [playerOpen, setPlayerOpen] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  const [topicOpen, setTopicOpen] = useState(false);
  const [playerSearch, setPlayerSearch] = useState('');
  const [eventSearch, setEventSearch] = useState('');

  const activeCount =
    filters.playerIds.length +
    (filters.eventId ? 1 : 0) +
    (filters.datePreset !== 'all' ? 1 : 0) +
    (filters.untaggedOnly ? 1 : 0) +
    (filters.topicTags?.length || 0);

  const activeEventTitle = filters.eventId
    ? events.find((e) => e.id === filters.eventId)?.title || 'Event'
    : null;

  const resetAll = () => onChange({ ...DEFAULT_FILTERS, sort: filters.sort, search: filters.search });

  return (
    <div className="sticky top-0 z-20 bg-surface-base/95 backdrop-blur-md border-b border-line-default/10 px-3 pt-3 pb-3 space-y-2.5">
      {/* Row 1: search + sort */}
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
      </div>

      {/* Row 2: date preset segmented control (fixed 4-up, no scroll,
                no wrap surprises) */}
      <div className="grid grid-cols-4 gap-1 bg-surface-elevated/60 rounded-lg p-1 border border-line-default/10">
        {(['all', '7d', '30d', 'season'] as DatePreset[]).map((p) => (
          <button
            key={p}
            onClick={() => onChange({ ...filters, datePreset: p })}
            className={`py-1.5 rounded-md text-[11px] font-black uppercase tracking-widest transition ${
              filters.datePreset === p
                ? 'bg-brand-primary text-brand-primary-fg'
                : 'text-ink-primary/70 hover:bg-line-default/[0.06]'
            }`}
          >
            {p === 'all' ? 'All time' : p === '7d' ? 'Week' : p === '30d' ? 'Month' : 'Season'}
          </button>
        ))}
      </div>

      {/* Row 3: filter chips — wrap naturally, never side-scroll */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip
          active={filters.playerIds.length > 0}
          onClick={() => setPlayerOpen((v) => !v)}
        >
          {filters.playerIds.length === 0
            ? 'Player'
            : `${filters.playerIds.length} player${filters.playerIds.length > 1 ? 's' : ''}`}
          <Caret />
        </Chip>
        <Chip
          active={!!filters.eventId}
          onClick={() => setEventOpen((v) => !v)}
        >
          {activeEventTitle ? truncate(activeEventTitle, 22) : 'Event'}
          <Caret />
        </Chip>
        <Chip
          active={(filters.topicTags || []).length > 0}
          onClick={() => setTopicOpen((v) => !v)}
        >
          {(filters.topicTags || []).length === 0
            ? 'Topic'
            : `${(filters.topicTags || []).length} topic${(filters.topicTags || []).length > 1 ? 's' : ''}`}
          <Caret />
        </Chip>
        <Chip
          active={filters.untaggedOnly}
          onClick={() => onChange({ ...filters, untaggedOnly: !filters.untaggedOnly })}
        >
          Untagged
        </Chip>
        {activeCount > 0 && (
          <button
            onClick={resetAll}
            className="ml-auto text-[11px] font-black uppercase tracking-widest text-ink-primary/60 hover:text-ink-primary shrink-0"
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

      {/* Popover pickers */}
      {playerOpen && (
        <Popover onClose={() => setPlayerOpen(false)} title="Player">
          <input
            autoFocus
            value={playerSearch}
            onChange={(e) => setPlayerSearch(e.target.value)}
            placeholder="Search players..."
            className="w-full bg-surface-base border border-line-default/10 rounded-lg px-3 py-1.5 text-sm text-ink-primary placeholder:text-ink-primary/40 focus:outline-none focus:border-brand-primary/50 mb-2"
          />
          <div className="flex flex-wrap gap-1.5">
            {players
              .filter((p) => !playerSearch.trim() || p.name.toLowerCase().includes(playerSearch.trim().toLowerCase()))
              .map((p) => {
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
        </Popover>
      )}

      {eventOpen && (
        <Popover onClose={() => setEventOpen(false)} title="Event">
          <input
            value={eventSearch}
            onChange={(e) => setEventSearch(e.target.value)}
            placeholder="Search games..."
            className="w-full bg-surface-base border border-line-default/10 rounded-lg px-3 py-1.5 text-sm text-ink-primary placeholder:text-ink-primary/40 focus:outline-none focus:border-brand-primary/50 mb-2"
          />
          <div className="space-y-1">
            <EventOption
              label="All events"
              selected={!filters.eventId}
              onClick={() => { onChange({ ...filters, eventId: null }); setEventOpen(false); }}
            />
            {events
              .filter((e) => !eventSearch.trim() || e.title.toLowerCase().includes(eventSearch.trim().toLowerCase()))
              .map((e) => (
                <EventOption
                  key={e.id}
                  selected={filters.eventId === e.id}
                  onClick={() => { onChange({ ...filters, eventId: e.id }); setEventOpen(false); }}
                  label={e.title}
                  date={e.date}
                  type={(e as any).type}
                />
              ))}
            {events.length === 0 && (
              <p className="py-4 text-center text-xs text-ink-primary/50 italic">
                No games in the last 6 months. Photos can still be uploaded — they just won't be linked to a specific game.
              </p>
            )}
          </div>
        </Popover>
      )}

      {topicOpen && (
        <Popover onClose={() => setTopicOpen(false)} title="Topic">
          <div className="flex flex-wrap gap-1.5">
            {TOPIC_TAG_OPTIONS.map((t) => {
              const selected = (filters.topicTags || []).includes(t);
              return (
                <button
                  key={t}
                  onClick={() => onChange({
                    ...filters,
                    topicTags: selected
                      ? (filters.topicTags || []).filter((x) => x !== t)
                      : [...(filters.topicTags || []), t],
                  })}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition capitalize ${
                    selected
                      ? 'bg-brand-primary text-brand-primary-fg border-brand-primary'
                      : 'bg-surface-base text-ink-primary/85 border-line-default/15 hover:border-brand-primary/40'
                  }`}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </Popover>
      )}
    </div>
  );
};

const Chip: React.FC<{ active?: boolean; onClick?: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[11px] font-black uppercase tracking-widest transition whitespace-nowrap ${
      active
        ? 'bg-brand-primary text-brand-primary-fg border border-brand-primary'
        : 'bg-surface-elevated text-ink-primary/70 border border-line-default/10 hover:border-line-default/25'
    }`}
  >
    {children}
  </button>
);

const Caret: React.FC = () => (
  <svg className="ml-0.5 w-3 h-3 opacity-60" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
);

// Bottom sheet-shaped popover so mobile taps get a proper full-width
// picker and desktop gets a centered modal.
//
// Portalled to document.body so it escapes the sticky filter bar's
// containing block. The bar uses backdrop-blur, which creates a
// containing block for `fixed` descendants (CSS spec quirk) and was
// causing the Done button to render behind the app header — no way
// out. Portal renders directly under body, back to true viewport
// positioning.
const Popover: React.FC<{ onClose: () => void; title: string; children: React.ReactNode }> = ({ onClose, title, children }) => {
  const node = (
    <div
      className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
      onClick={onClose}
    >
      <div
        className="bg-surface-elevated w-full sm:max-w-md max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 bg-surface-elevated flex items-center justify-between px-4 py-3 border-b border-line-default/10">
          <h3 className="text-sm font-black uppercase tracking-widest text-ink-primary/70">{title}</h3>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-brand-primary hover:bg-brand-primary-hov text-brand-primary-fg text-[11px] font-black uppercase tracking-widest"
          >
            Done
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {children}
        </div>
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
};

interface EventOptionProps {
  label: string;
  selected: boolean;
  onClick: () => void;
  date?: Date;
  type?: string;
}

const EventOption: React.FC<EventOptionProps> = ({ label, selected, onClick, date, type }) => {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 text-left px-3 py-2 rounded-lg text-sm transition ${
        selected
          ? 'bg-brand-primary text-brand-primary-fg'
          : 'hover:bg-line-default/[0.06] text-ink-primary/85'
      }`}
    >
      {type && (
        <span className={`shrink-0 text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded ${
          selected
            ? 'bg-white/20 text-brand-primary-fg'
            : type === 'game'
            ? 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30'
            : type === 'practice'
            ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
            : 'bg-line-default/10 text-ink-primary/60 ring-1 ring-line-default/15'
        }`}>
          {type === 'game' ? 'G' : type === 'practice' ? 'P' : 'E'}
        </span>
      )}
      <span className="font-semibold truncate flex-1">{label}</span>
      {date && (
        <span className={`shrink-0 text-[10px] uppercase tracking-widest ${selected ? 'text-brand-primary-fg/80' : 'text-ink-primary/50'}`}>
          {new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </span>
      )}
    </button>
  );
};

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export default PhotoFilterBar;
