// WeekAheadRail — 7-day quest-map strip. Each day is a node:
// event day = compact tile with day letter + date + event glyph
// (crossed swords for game, cone for practice, dot for other);
// rest day = subtle small circle. TODAY carries a pulsing brand-
// primary-soft tip (same treatment as the XP progress rail on
// PlayerXpCard) so the eye anchors on "you are here."
//
// Dashed connector between nodes implies a path/journey. Taps jump
// to that day on /calendar (?date=YYYY-MM-DD). Piggybacks on the
// existing video-game-map aesthetic already established by
// PlayerXpCard — no new visual language, extends what works.
//
// Design brief: Patrick 2026-07-13 dashboard audit. "This week
// ahead" pitched as fresh + fun. Rail sits above NextEventPoster,
// below active banners.

import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEvent } from '../../types';

interface Props {
  events: CalendarEvent[];
  /** Number of days to render. Default 7 for a weekly rhythm. */
  days?: number;
}

interface DayNode {
  date: Date;
  dayKey: string;              // YYYY-MM-DD for /calendar deep link
  dayLetter: string;
  dateNumber: number;
  isToday: boolean;
  events: CalendarEvent[];
  primaryType: 'game' | 'practice' | 'event' | null;
}

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function toDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** When multiple events land on the same day, prefer game > practice
 *  > event so the glyph reflects the "biggest" thing that day. */
function pickPrimaryType(events: CalendarEvent[]): DayNode['primaryType'] {
  if (events.some(e => e.type === 'game')) return 'game';
  if (events.some(e => e.type === 'practice')) return 'practice';
  if (events.length > 0) return 'event';
  return null;
}

const GameGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    {/* Soccer ball — pentagonal panel + circle. Game-native, no
        "crossed swords" ambiguity that could read as combat. */}
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3l2.5 4L12 10 9.5 7L12 3z" />
    <path d="M12 10L15.5 12M12 10L8.5 12M12 21L12 15" />
  </svg>
);

const PracticeGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    {/* Cone — universally reads as practice/drill. */}
    <path d="M12 3L6 20h12L12 3z" />
    <path d="M8 15h8" />
  </svg>
);

const EventGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
  </svg>
);

const WeekAheadRail: React.FC<Props> = ({ events, days = 7 }) => {
  const nodes = useMemo<DayNode[]>(() => {
    // Anchor on today at midnight local. Roll forward `days` days.
    const now = new Date();
    const anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(anchor);
      d.setDate(anchor.getDate() + i);
      const dayEvents = events.filter(e => e.date instanceof Date && isSameDay(e.date, d));
      return {
        date: d,
        dayKey: toDayKey(d),
        dayLetter: DAY_LETTERS[d.getDay()],
        dateNumber: d.getDate(),
        isToday: i === 0,
        events: dayEvents,
        primaryType: pickPrimaryType(dayEvents),
      };
    });
  }, [events, days]);

  const hasAnyEvent = nodes.some(n => n.events.length > 0);
  // If no events at all in the next `days` days, hide the rail so
  // it doesn't render a strip of dashes with nothing to do — the
  // NextEventPoster's empty state already handles that beat.
  if (!hasAnyEvent) return null;

  return (
    <section
      aria-label={`The next ${days} days at a glance`}
      className="relative rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 shadow-lg shadow-black/5 overflow-hidden"
    >
      {/* Kicker + relative-day header */}
      <div className="px-4 pt-3 pb-2 flex items-baseline justify-between">
        <div className="text-[10px] font-extrabold uppercase tracking-[0.28em] text-ink-primary/55">
          Week ahead
        </div>
        <div className="text-[10px] text-ink-primary/35 tabular-nums">
          {nodes[0].dayKey.slice(5).replace('-', '/')} &mdash; {nodes[nodes.length - 1].dayKey.slice(5).replace('-', '/')}
        </div>
      </div>

      {/* Rail */}
      <div className="relative px-3 pb-4 pt-1">
        {/* Dashed connector behind the nodes. Sits at the vertical
            center of the node row. Purely decorative — implies
            "path/journey" without competing with the nodes. */}
        <div
          className="absolute left-6 right-6 top-1/2 -translate-y-1/2 border-t border-dashed border-line-default/25 pointer-events-none"
          aria-hidden
        />

        <div className="relative flex items-stretch justify-between gap-1">
          {nodes.map((n) => {
            const eventCount = n.events.length;
            const type = n.primaryType;
            const isEvent = eventCount > 0;
            const timeLabel = isEvent
              ? n.events[0].date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '')
              : null;

            // Node classes — event tile vs rest circle. Today wins
            // over both with the pulsing brand-primary-soft tip.
            const tileBase = 'relative flex flex-col items-center justify-center gap-0.5 rounded-lg transition';
            const eventCls = type === 'game'
              ? 'bg-brand-primary/15 ring-1 ring-brand-primary/40 text-brand-primary-soft'
              : type === 'practice'
                ? 'bg-emerald-500/15 ring-1 ring-emerald-400/40 text-emerald-300'
                : 'bg-line-default/10 ring-1 ring-line-default/25 text-ink-primary/70';
            const restCls = 'bg-transparent ring-1 ring-line-default/15 text-ink-primary/40';

            return (
              <Link
                key={n.dayKey}
                to={`/calendar?date=${encodeURIComponent(n.dayKey)}`}
                aria-label={
                  isEvent
                    ? `${n.date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} — ${eventCount} event${eventCount === 1 ? '' : 's'}`
                    : `${n.date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} — rest`
                }
                className="flex-1 min-w-0 flex flex-col items-center gap-1 group"
              >
                {/* Day letter */}
                <span className={`text-[9px] font-bold tracking-wider ${n.isToday ? 'text-brand-primary-soft' : 'text-ink-primary/45'}`}>
                  {n.dayLetter}
                </span>

                {/* Node */}
                {isEvent ? (
                  <div className={`${tileBase} ${eventCls} w-full py-1.5 px-1 ${n.isToday ? 'shadow-[0_0_0_2px_rgba(241,114,130,0.35)]' : ''} group-hover:brightness-110`}>
                    {type === 'game' && <GameGlyph className="w-4 h-4" />}
                    {type === 'practice' && <PracticeGlyph className="w-4 h-4" />}
                    {type === 'event' && <EventGlyph className="w-4 h-4" />}
                    <span className="text-[10px] font-black leading-none tabular-nums">{n.dateNumber}</span>
                    {eventCount > 1 && (
                      <span className="absolute -top-1 -right-1 min-w-[14px] h-3.5 px-1 rounded-full bg-brand-primary text-white text-[8px] font-black leading-none flex items-center justify-center ring-2 ring-surface-elevated tabular-nums">
                        {eventCount}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className={`${tileBase} ${restCls} w-5 h-5 mx-auto rounded-full ${n.isToday ? '' : 'group-hover:ring-line-default/40'}`}>
                    <span className="text-[9px] font-black leading-none tabular-nums">{n.dateNumber}</span>
                  </div>
                )}

                {/* Today gets a pulsing tip — matches PlayerXpCard's
                    XP-rail leading edge. Absolutely-positioned below
                    the node so the tile itself stays clean. */}
                {n.isToday && (
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-brand-primary-soft animate-pulse"
                    style={{ boxShadow: '0 0 6px 1.5px rgba(241,114,130,0.7)' }}
                    aria-hidden
                  />
                )}

                {/* Compact time under event tiles when present */}
                {timeLabel && !n.isToday && (
                  <span className="text-[8px] tabular-nums text-ink-primary/45 leading-none mt-0.5">
                    {timeLabel}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default WeekAheadRail;
