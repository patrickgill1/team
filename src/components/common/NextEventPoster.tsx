// The dashboard's anchor card. Replaces the old DashboardHero
// (which used the time-of-day photo as ambient wallpaper). The
// photo is now the bg of THIS card and only this card, with the
// next-event info layered on top and inline RSVP buttons. The
// chrome above is allowed to be flat charcoal — no photo bleed
// gymnastics, no hard-line problem. Patrick: "if we can find a
// way to utilize the photo, I would love that. I love the rsvp
// thing, that's been hard."

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarEvent } from '../../types';
import { WeatherSummary } from '../../utils/weather';

type RsvpStatus = 'going' | 'maybe' | 'no';

interface Props {
  greeting: string;
  firstName: string;
  nextEvent: CalendarEvent | null;
  whenText: string;
  weather: WeatherSummary | null;
  goingCount: number;
  pendingCount: number;
  /** Roster size or other empty-state context. */
  playerCount: number;
  isCoach: boolean;
  /** Current user's RSVP for the event, if any. For coaches and
   *  parents-with-no-linked-kids this is their own status. For
   *  parents with linked kids it's the GROUP status (only set when
   *  all linked kids share a status, otherwise null). */
  currentStatus: RsvpStatus | null;
  /** Label to show ON the Going button when not active — varies
   *  with kid-mode ("Hunter going" / "All going" / "I'm going"). */
  goingLabel: string;
  /** Same for Can't. ("Can't go" / "None going") */
  noLabel: string;
  onRsvp: (status: RsvpStatus) => void | Promise<void>;
  /** Coach attendance (separate from the kid RSVP). Only passed
   *  when the user is a coach AND has linked kids — in that case
   *  the primary RSVP buttons stamp the KID's attendance and this
   *  toggle adds the coach's own attendance independently.
   *  Patrick 2026-06-21: 'i am going to need to also be able to
   *  rsvp and show coach is going separate from my son.' */
  coachStatus?: RsvpStatus | null;
  onCoachRsvp?: (status: RsvpStatus | null) => void | Promise<void>;
  hourOverride?: number;
}

const MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const DOWS_SHORT   = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

type Scene = { phase: string; bgImage: string };
function sceneFor(hour: number): Scene {
  if (hour < 5.5) return { phase: 'night',   bgImage: '/images/hero/night.jpg' };
  if (hour < 7)   return { phase: 'predawn', bgImage: '/images/hero/night.jpg' };
  if (hour < 10)  return { phase: 'morning', bgImage: '/images/hero/morning.jpg' };
  if (hour < 16)  return { phase: 'midday',  bgImage: '/images/hero/noon.jpg' };
  if (hour < 19)  return { phase: 'sunset',  bgImage: '/images/hero/sunset.jpg' };
  if (hour < 22)  return { phase: 'dusk',    bgImage: '/images/hero/night.jpg' };
  return            { phase: 'night',   bgImage: '/images/hero/night.jpg' };
}

const NextEventPoster: React.FC<Props> = ({
  greeting,
  firstName,
  nextEvent,
  whenText,
  weather,
  goingCount,
  pendingCount,
  playerCount,
  isCoach,
  currentStatus,
  goingLabel,
  noLabel,
  onRsvp,
  coachStatus,
  onCoachRsvp,
  hourOverride,
}) => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (hourOverride !== undefined) return;
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, [hourOverride]);

  const hour = hourOverride !== undefined ? hourOverride : now.getHours() + now.getMinutes() / 60;
  const scene = sceneFor(hour);

  const eventDate = nextEvent ? new Date(nextEvent.date) : null;
  const eventMonth = eventDate ? MONTHS_SHORT[eventDate.getMonth()] : '';
  const eventDay   = eventDate ? eventDate.getDate() : 0;
  const eventDow   = eventDate ? DOWS_SHORT[eventDate.getDay()] : '';
  const location: string = (nextEvent as any)?.location || '';

  // Empty state — no events on the calendar. Compact and quiet,
  // no big photo (the photo belongs to the next event, not as
  // wallpaper). Coaches get a CTA to schedule one.
  if (!nextEvent || !eventDate) {
    return (
      <section className="px-3 sm:px-4 pt-3">
        <div className="rounded-2xl ring-1 ring-white/10 bg-charcoal-900 px-5 py-6">
          <div className="flex items-center gap-4">
            <Link
              to="/players"
              aria-label={`${playerCount} players on roster`}
              className="shrink-0 flex flex-col items-center justify-center w-16 h-16 rounded-2xl bg-charcoal-800 ring-1 ring-white/10"
            >
              <span className="text-2xl font-extrabold text-white leading-none">{playerCount}</span>
              <span className="text-[9px] font-bold tracking-widest text-bone/60 mt-1">ROSTER</span>
            </Link>
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-bold text-bone">{greeting}, {firstName}.</h1>
              <p className="text-sm text-bone/60 mt-0.5">All quiet for now. No upcoming events.</p>
              {isCoach && (
                <Link
                  to="/calendar"
                  className="mt-2 inline-flex items-center gap-1 text-xs font-extrabold tracking-widest uppercase text-crimson-400 hover:text-crimson-300"
                >
                  + Schedule an event
                </Link>
              )}
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="px-3 sm:px-4 pt-3">
      <article
        className="relative overflow-hidden rounded-2xl ring-1 ring-white/10 shadow-2xl shadow-black/40 min-h-[440px] sm:min-h-[480px] flex flex-col"
        aria-label={`Next up: ${nextEvent.title} on ${eventMonth} ${eventDay}`}
      >
        {/* Time-of-day photo as the poster bg. Object-cover so the
            scene fills the card; the overlay below ensures all
            content reads cleanly on any time of day. */}
        <img
          src={scene.bgImage}
          alt=""
          aria-hidden
          loading="eager"
          className="absolute inset-0 w-full h-full object-cover"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
        {/* Cinematic overlay: dim middle, deeper bottom so the
            event title + RSVP zone sits on guaranteed dark
            surface regardless of photo content. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-b from-black/35 via-black/40 to-black/85 pointer-events-none"
        />

        {/* Header row: greeting (left) + weather chip (right) */}
        <div className="relative flex items-start justify-between px-5 pt-5 sm:pt-6">
          <div>
            <p className="text-[10px] font-extrabold tracking-[0.25em] uppercase text-crimson-300">Next Up</p>
            <p className="mt-1 text-sm text-bone/80">{greeting}, {firstName}</p>
          </div>
          {weather && (
            <div className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-black/35 ring-1 ring-white/10 px-2.5 py-1 backdrop-blur-sm">
              <span aria-hidden className="text-base leading-none">{weather.icon}</span>
              <span className="text-[12px] font-bold text-bone tabular-nums">{weather.tempMaxF}°/{weather.tempMinF}°</span>
            </div>
          )}
        </div>

        {/* Spacer pushes the body to the bottom of the poster */}
        <div className="flex-1" />

        {/* Body: date badge + title + when + location, then RSVP */}
        <div className="relative px-5 pb-5 sm:pb-6">
          <div className="flex items-end gap-4">
            <Link
              to={`/events/${nextEvent.id}`}
              aria-label={`${nextEvent.title} on ${eventMonth} ${eventDay} ${eventDow}`}
              className="shrink-0 flex flex-col items-center justify-center w-[68px] h-[68px] sm:w-[76px] sm:h-[76px] rounded-2xl bg-black/45 ring-1 ring-white/15 backdrop-blur-md"
            >
              <span className="text-[10px] font-extrabold tracking-widest text-crimson-300">{eventMonth}</span>
              <span className="text-3xl sm:text-[34px] font-black text-white leading-none">{eventDay}</span>
              <span className="text-[9px] font-bold tracking-widest text-bone/70 mt-0.5">{eventDow}</span>
            </Link>
            <div className="min-w-0 flex-1">
              <Link to={`/events/${nextEvent.id}`} className="block">
                <h2 className="text-2xl sm:text-3xl font-black text-white leading-tight drop-shadow-md truncate">
                  {nextEvent.title}
                </h2>
                <p className="mt-1 text-sm sm:text-base text-bone/85 truncate">{whenText}</p>
                {location && (
                  <p className="mt-0.5 text-xs sm:text-sm text-bone/65 truncate">
                    <span aria-hidden className="mr-1">·</span>{location}
                  </p>
                )}
              </Link>
            </div>
          </div>

          {/* RSVP row — single tap, no nav. The whole point. */}
          <div className="mt-4 grid grid-cols-3 gap-2">
            <RsvpButton
              tone="going"
              active={currentStatus === 'going'}
              label={currentStatus === 'going' ? 'Going' : goingLabel}
              onClick={() => onRsvp('going')}
            />
            <RsvpButton
              tone="maybe"
              active={currentStatus === 'maybe'}
              label="Maybe"
              onClick={() => onRsvp('maybe')}
            />
            <RsvpButton
              tone="no"
              active={currentStatus === 'no'}
              label={noLabel}
              onClick={() => onRsvp('no')}
            />
          </div>

          {/* Coach attendance toggle — only rendered when the
              user is a coach AND has linked kids. The primary
              buttons above RSVP the kid (e.g., Hunter going); this
              row tracks the COACH's own attendance independently
              (Patrick going as coach). Three small chips since
              coach attendance is usually 'Going / Can't' with a
              short tap path. */}
          {onCoachRsvp && (
            <div className="mt-3 flex items-center justify-center gap-1.5">
              <span className="text-[10px] font-extrabold tracking-widest uppercase text-bone/55 mr-1">Coach attendance</span>
              {(['going', 'maybe', 'no'] as RsvpStatus[]).map((s) => {
                const active = coachStatus === s;
                const label = s === 'going' ? 'Going' : s === 'maybe' ? 'Maybe' : "Can't";
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onCoachRsvp(active ? null : s)}
                    className={`text-[11px] font-extrabold tracking-wide uppercase px-2.5 py-1 rounded-full ring-1 transition-colors ${
                      active
                        ? 'bg-crimson-500/85 ring-crimson-400 text-white'
                        : 'bg-charcoal-950/40 ring-white/15 text-bone/70 hover:bg-white/10'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Going / pending tally line. Quiet, just-the-facts. */}
          <p className="mt-3 text-center text-[12px] text-bone/65">
            <span className="font-bold text-bone">{goingCount}</span> going
            {pendingCount > 0 && (
              <>
                {' · '}
                <span className="font-bold text-bone">{pendingCount}</span> pending
              </>
            )}
          </p>
        </div>
      </article>
    </section>
  );
};

function RsvpButton({ tone, active, label, onClick }: {
  tone: RsvpStatus;
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  const base = 'inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-[12px] font-extrabold uppercase tracking-widest transition-colors duration-150 active:scale-[0.97]';
  const activeStyles: Record<RsvpStatus, string> = {
    going: 'bg-emerald-500 text-white ring-1 ring-emerald-300/60 shadow-lg shadow-emerald-500/30',
    maybe: 'bg-amber-400 text-charcoal-950 ring-1 ring-amber-300/60 shadow-lg shadow-amber-500/30',
    no:    'bg-rose-500 text-white ring-1 ring-rose-300/60 shadow-lg shadow-rose-500/30',
  };
  const inactiveStyles = 'bg-black/40 text-bone/85 ring-1 ring-white/15 backdrop-blur-md hover:bg-black/55';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${base} ${active ? activeStyles[tone] : inactiveStyles}`}
    >
      {active && (
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
          <polyline points="5 12 10 17 19 7" />
        </svg>
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

export default NextEventPoster;
