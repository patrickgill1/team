// WeekAheadRail — MATCHWEEK fixture ladder. Reads the week the way
// FotMob / ESPN / OneFootball read a fixture strip: matches earn
// full billing (kit stripe, opponent short code, kickoff time),
// training sessions get a compact bib tile, rest days shrink to
// whitespace. Saturday's game against Houston should visually
// dominate a Tuesday rest day the way it dominates the emotional
// week — the current equal-column layout fought that.
//
// Design brief: Patrick 2026-07-13 rail redesign. Direction A from
// the panel: "League Fixture Ladder." Wins on legibility (broadcast
// fixture card is the highest-trust soccer UI in the world),
// meaningful motion (live kickoff countdown, not decorative pulse),
// and one-designed-system continuity with PlayerXpCard via the
// kit-stripe shimmer treatment.
//
// Copy note: kicker is MATCHWEEK, not "Week ahead" — per the
// vocab-swagger rule, broadcast-native beats generic SaaS-speak.

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEvent } from '../../types';

interface Props {
  events: CalendarEvent[];
  /** Number of days to render. Default 7 for a weekly rhythm. */
  days?: number;
}

interface DayCell {
  date: Date;
  dayKey: string;
  dayLetter: string;     // 'M' etc — for rest tiles
  dayLetterLong: string; // 'MON' etc — for event tiles
  dateNumber: number;
  isToday: boolean;
  events: CalendarEvent[];
  primary: CalendarEvent | null;
  primaryType: 'game' | 'practice' | 'event' | null;
}

const DAY_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_LONG = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function toDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Prefer game > practice > event when a day holds multiple events. */
function pickPrimary(events: CalendarEvent[]): { event: CalendarEvent | null; type: DayCell['primaryType'] } {
  const game = events.find((e) => e.type === 'game');
  if (game) return { event: game, type: 'game' };
  const practice = events.find((e) => e.type === 'practice');
  if (practice) return { event: practice, type: 'practice' };
  if (events.length > 0) return { event: events[0], type: 'event' };
  return { event: null, type: null };
}

/** Broadcast-style opponent short code. "Houston Explosion" → "HOU".
 *  Falls back to first 3 chars of title if no opponent. */
function opponentShort(event: CalendarEvent | null): string {
  if (!event) return '';
  const opp = String((event as any).opponent || '').trim();
  const src = opp || String(event.title || '').trim();
  if (!src) return '—';
  // Multi-word: initials up to 3 chars.
  const words = src.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 3).map((w) => w[0]!.toUpperCase()).join('').slice(0, 3);
  return src.slice(0, 3).toUpperCase();
}

function formatKickoff(d: Date): string {
  const s = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return s.replace(':00', '');
}

/** Countdown label anchored to the next event.
 *  Distant  → "in 2d 14h"
 *  Same day → "in 3h 22m"
 *  Kickoff  → "KICKOFF Hh:MM"  (T-15 to T+0)
 *  Live     → "LIVE"           (T+0 to end)
 *  After    → "FULL TIME"      (event over, same day) */
function countdownLabel(now: Date, nextEvent: CalendarEvent): string {
  const t = nextEvent.date.getTime();
  const endMs = (nextEvent as any).endDate?.getTime?.() ?? t + 2 * 60 * 60 * 1000; // 2h default
  const diff = t - now.getTime();
  const past = -diff;
  if (diff > 60_000) {
    if (diff > 24 * 60 * 60 * 1000) {
      const d = Math.floor(diff / (24 * 60 * 60 * 1000));
      const h = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
      return `in ${d}d ${h}h`;
    }
    if (diff > 60 * 60 * 1000) {
      const h = Math.floor(diff / (60 * 60 * 1000));
      const m = Math.floor((diff % (60 * 60 * 1000)) / 60_000);
      return `in ${h}h ${m}m`;
    }
    const m = Math.max(1, Math.floor(diff / 60_000));
    if (m <= 15) return `KICKOFF ${formatKickoff(nextEvent.date)}`;
    return `in ${m}m`;
  }
  if (past < endMs - t) return 'LIVE';
  if (isSameDay(now, nextEvent.date)) return 'FULL TIME';
  return `in ${Math.floor(-diff / (24 * 60 * 60 * 1000))}d`;
}

// ── Monoline SVGs ───────────────────────────────────────────────

const HomeGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    <path d="M4 11l8-7 8 7" />
    <path d="M6 10v10h12V10" />
  </svg>
);

const AwayGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    {/* Plane silhouette — universally reads as "away/travel." */}
    <path d="M3 12l6-2 4-6 2 1-2 5 5-1 3-4 2 1-2 5 4 2-4 2-3-4-4 6-2-1 2-5-5 1z" />
  </svg>
);

const BallGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    {/* Three visible pentagon-panel hints — read as a soccer ball
        even at 10-12px, unlike the earlier attempt which read as a
        person's head. */}
    <path d="M12 6l3 2-1 4-4 0-1-4z" />
    <path d="M12 22l-3-5" />
    <path d="M12 22l3-5" />
    <path d="M6 10l2 4" />
    <path d="M18 10l-2 4" />
  </svg>
);

const BibGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    {/* Training bib — armhole + hem outline + horizontal band across
        chest. Reads as "training kit" not "generic shirt." */}
    <path d="M7 5l3-1 4 0 3 1 2 2-1 3-2 0v11h-8V10H6l-1-3z" />
    <path d="M8 13h8" />
  </svg>
);

// ── Live-now hook ───────────────────────────────────────────────

/** Cheap 60s tick. Updates only while the rail is mounted; no work
 *  when the dashboard is closed. */
function useNowTick(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ── Component ────────────────────────────────────────────────────

const WeekAheadRail: React.FC<Props> = ({ events, days = 7 }) => {
  const now = useNowTick(60_000);

  const cells = useMemo<DayCell[]>(() => {
    const nowMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(nowMid);
      d.setDate(nowMid.getDate() + i);
      const dayEvents = events.filter((e) => e.date instanceof Date && isSameDay(e.date, d));
      const { event, type } = pickPrimary(dayEvents);
      return {
        date: d,
        dayKey: toDayKey(d),
        dayLetter: DAY_SHORT[d.getDay()],
        dayLetterLong: DAY_LONG[d.getDay()],
        dateNumber: d.getDate(),
        isToday: i === 0,
        events: dayEvents,
        primary: event,
        primaryType: type,
      };
    });
  }, [events, days, now]);

  const hasAnyEvent = cells.some((c) => c.events.length > 0);
  if (!hasAnyEvent) return null;

  // Next event (for the countdown chip). Preference: today's event,
  // else the nearest future event within the window.
  const nextEvent = useMemo<CalendarEvent | null>(() => {
    const t = now.getTime();
    let best: CalendarEvent | null = null;
    for (const c of cells) {
      for (const e of c.events) {
        if (!(e.date instanceof Date)) continue;
        const et = e.date.getTime();
        // Games in progress (started within last 2h) still count.
        if (et + 2 * 60 * 60 * 1000 < t) continue;
        if (!best || e.date.getTime() < best.date.getTime()) best = e;
      }
    }
    return best;
  }, [cells, now]);

  // Kicker: MATCHWEEK when there's at least one game, else FIXTURES.
  const hasGame = cells.some((c) => c.primaryType === 'game');
  const kicker = hasGame ? 'MATCHWEEK' : 'FIXTURES';

  return (
    <section
      aria-label="Matchweek fixtures"
      className="relative rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 shadow-lg shadow-black/5 overflow-hidden"
    >
      {/* Header: kicker left, live countdown chip right */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3">
        <div className="text-[10px] font-black uppercase tracking-[0.32em] text-ink-primary/60">
          {kicker}
        </div>
        {nextEvent && (
          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-brand-primary/10 ring-1 ring-brand-primary/25 text-brand-primary-soft text-[10px] font-black tracking-widest uppercase tabular-nums">
            <span
              className="w-1.5 h-1.5 rounded-full bg-brand-primary-soft animate-pulse"
              style={{ boxShadow: '0 0 6px 1.5px rgba(241,114,130,0.7)' }}
              aria-hidden
            />
            {countdownLabel(now, nextEvent)}
          </div>
        )}
      </div>

      {/* Fixture strip — horizontal scroll fallback for stacked weeks */}
      <div className="px-2 pb-3 overflow-x-auto no-scrollbar">
        <div className="flex items-stretch gap-1.5 min-w-max">
          {cells.map((c) => (
            <FixtureCell key={c.dayKey} cell={c} isNextEvent={!!nextEvent && c.primary?.id === nextEvent.id} />
          ))}
        </div>
      </div>
    </section>
  );
};

// ── Cell ────────────────────────────────────────────────────────

const FixtureCell: React.FC<{ cell: DayCell; isNextEvent: boolean }> = ({ cell, isNextEvent }) => {
  const { date, dayLetter, dayLetterLong, dateNumber, isToday, events, primary, primaryType } = cell;
  const isGame = primaryType === 'game';
  const isPractice = primaryType === 'practice';
  const isEvent = primaryType === 'event';
  const isRest = !primaryType;

  // Multi-event chip only when there IS a primary and there are more
  // events beyond it. Games can co-exist with practices on the same
  // day (rare but valid).
  const extraCount = events.length > 1 ? events.length - 1 : 0;

  const dayKey = date.toISOString().slice(0, 10);
  const href = `/calendar?date=${encodeURIComponent(dayKey)}`;

  // Rest tile — the "whitespace" that lets game tiles breathe.
  if (isRest) {
    return (
      <Link
        to={href}
        aria-label={`${date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} — rest`}
        className={`relative flex flex-col items-center justify-between w-8 py-2 rounded-lg group ${isToday ? '' : 'hover:bg-line-default/[0.03]'}`}
      >
        <span className={`text-[10px] font-bold tracking-widest uppercase ${isToday ? 'text-brand-primary underline decoration-brand-primary decoration-1 underline-offset-2' : 'text-ink-primary/40'}`}>
          {dayLetter}
        </span>
        <span className="text-[9px] font-black tabular-nums text-ink-primary/30 leading-none">—</span>
        <span className={`text-[10px] font-bold tabular-nums ${isToday ? 'text-ink-primary' : 'text-ink-primary/45'}`}>
          {dateNumber}
        </span>
      </Link>
    );
  }

  // Event tile shared shell — practice vs game vary in width + inner
  // content, but the border/rounded/hover treatment is common.
  const width = isGame ? 'w-[88px]' : 'w-[52px]';
  const homeAway = (primary as any)?.homeAway as 'home' | 'away' | undefined;
  const shortCode = opponentShort(primary);
  const time = primary?.date ? formatKickoff(primary.date) : '';

  return (
    <Link
      to={href}
      aria-label={
        isGame
          ? `${dayLetterLong} — ${homeAway === 'away' ? 'away' : 'home'} vs ${shortCode} at ${time}`
          : `${dayLetterLong} — training at ${time}`
      }
      className={`relative flex flex-col ${width} h-[72px] rounded-lg overflow-hidden ring-1 ${
        isGame
          ? 'bg-surface-input/50 ring-brand-primary/30 hover:ring-brand-primary/60'
          : isPractice
            ? 'bg-surface-input/40 ring-emerald-400/25 hover:ring-emerald-400/50'
            : 'bg-surface-input/40 ring-line-default/15 hover:ring-line-default/30'
      } transition-shadow`}
    >
      {/* Left kit stripe (game only). Today's tile gets a shimmering
          gradient — same DNA as the XP-rail leading edge. */}
      {isGame && (
        <div
          className={`absolute inset-y-0 left-0 w-1 ${isToday ? 'wa-shimmer' : 'bg-brand-primary'}`}
          aria-hidden
        />
      )}
      {/* Today's non-game accent — a thin brand-primary bar so today
          reads consistently across game/practice tiles. */}
      {isToday && !isGame && (
        <div className="absolute inset-y-0 left-0 w-1 bg-brand-primary" aria-hidden />
      )}

      {/* Top row: H/A glyph + day letter */}
      <div className={`flex items-center justify-between px-1.5 pt-1.5 gap-1 ${isGame ? 'pl-2' : ''}`}>
        {isGame && homeAway === 'away' ? (
          <AwayGlyph className="w-2.5 h-2.5 text-ink-primary/55" />
        ) : isGame ? (
          <HomeGlyph className="w-2.5 h-2.5 text-ink-primary/55" />
        ) : (
          <span aria-hidden className="w-2.5 h-2.5" />
        )}
        <span className={`text-[9px] font-black uppercase tracking-widest ${isToday ? 'text-brand-primary' : 'text-ink-primary/50'}`}>
          {isGame ? dayLetterLong.slice(0, 3) : dayLetter}
        </span>
      </div>

      {/* Middle row: opponent short code (game) or bib icon (practice) */}
      <div className={`flex-1 flex items-center justify-center ${isGame ? 'px-2' : 'px-1'}`}>
        {isGame ? (
          <span className="text-[16px] font-black tracking-tight text-ink-primary leading-none truncate">
            {shortCode}
          </span>
        ) : isPractice ? (
          <BibGlyph className="w-4 h-4 text-emerald-300" />
        ) : (
          <span className="text-[14px] font-black tabular-nums text-ink-primary/70 leading-none">
            {dateNumber}
          </span>
        )}
      </div>

      {/* Bottom row: kickoff time + micro ball glyph (game only) */}
      <div className={`flex items-center justify-between px-1.5 pb-1.5 gap-1 ${isGame ? 'pl-2' : ''}`}>
        <span className="text-[9px] font-bold tabular-nums text-ink-primary/55 leading-none">
          {time}
        </span>
        {isGame ? (
          <BallGlyph className="w-2.5 h-2.5 text-ink-primary/40" />
        ) : (
          <span className="text-[9px] font-bold tabular-nums text-ink-primary/40 leading-none">{dateNumber}</span>
        )}
      </div>

      {/* Multi-event chip (top-right) */}
      {extraCount > 0 && (
        <span className="absolute top-1 right-1 min-w-[16px] h-3.5 px-1 rounded-full bg-brand-primary text-white text-[8px] font-black leading-none flex items-center justify-center ring-2 ring-surface-elevated tabular-nums">
          +{extraCount}
        </span>
      )}

      {/* Countdown-anchor visual signal on the next-upcoming event
          (subtle brand-primary hairline glow behind the tile). */}
      {isNextEvent && !isToday && (
        <div
          className="absolute inset-0 rounded-lg pointer-events-none"
          style={{ boxShadow: 'inset 0 0 0 1px rgba(200,32,44,0.35)' }}
          aria-hidden
        />
      )}

      {/* Local keyframes for the kit-stripe shimmer on today's game
          tile. Scoped-inline so we don't need a global CSS edit. */}
      <style>{`
        @keyframes wa-shimmer {
          0%   { background-position: 0% 0%; }
          100% { background-position: 0% 100%; }
        }
        /* 2026-07-15: swapped the Fire FC crimson survivor
           (#c8202c → #f17282 → #c8202c) for a same-family
           amber-brand ceremony shimmer that reads at the
           reminder-bell moment without shipping the legacy
           pre-rebrand red. */
        .wa-shimmer {
          background-image: linear-gradient(180deg, rgb(217 119 6) 0%, rgb(251 191 36) 50%, rgb(217 119 6) 100%);
          background-size: 100% 200%;
          animation: wa-shimmer 2s linear infinite;
        }
      `}</style>
    </Link>
  );
};

export default WeekAheadRail;
