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
  const developmentFocus: string = ((nextEvent as any)?.developmentFocus || '').trim();

  // Empty state — no events on the calendar yet. Patrick: "can it
  // still show the field picture at the top during the process? I
  // think that really gives it from flare." A brand-new coach feels
  // the app's presence most when the hero photo greets them; the
  // small compact card we used to render here read as "nothing
  // happening." Now we render the SAME time-of-day photo + same
  // overlay treatment as the event card, just without the event-
  // specific bits and with a "Schedule your first event" CTA.
  if (!nextEvent || !eventDate) {
    return (
      <section className="px-3 sm:px-4 pt-3">
        <article
          className="next-event-poster relative overflow-hidden rounded-2xl ring-1 ring-line-default/10 shadow-2xl shadow-black/40 min-h-[300px] sm:min-h-[340px] flex flex-col"
        >
          <img
            src={scene.bgImage}
            alt=""
            aria-hidden
            loading="eager"
            className="absolute inset-0 w-full h-full object-cover brightness-125 saturate-110"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
          <div
            aria-hidden
            className="absolute inset-0 bg-gradient-to-b from-black/25 via-black/20 to-black/65 pointer-events-none"
          />
          <div
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-[58%] bg-gradient-to-t from-black/80 via-black/50 to-transparent pointer-events-none"
          />

          {/* Header row: kicker + greeting */}
          <div className="relative px-5 pt-5 sm:pt-6">
            <p className="text-[10px] font-extrabold tracking-[0.25em] uppercase text-brand-primary-soft">
              {isCoach ? 'Welcome' : 'Hi'}
            </p>
            <p className="mt-1 text-sm text-white/80 drop-shadow">{greeting}, {firstName}</p>
          </div>

          <div className="flex-1" />

          {/* Body: copy + roster chip + CTA */}
          <div className="relative px-5 pb-5 sm:pb-6 space-y-3">
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight leading-tight [text-shadow:0_2px_8px_rgba(0,0,0,0.95),0_0_1px_rgba(0,0,0,0.9)]">
                {isCoach ? "Let's get your team going." : 'No upcoming events yet.'}
              </h1>
              <p className="mt-1 text-sm font-medium text-white/90 [text-shadow:0_1px_5px_rgba(0,0,0,0.9)]">
                {isCoach
                  ? 'Add players, schedule a practice, invite parents. Then your dashboard fills in.'
                  : 'Check back soon for your next game or practice.'}
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Link
                to="/people"
                aria-label={`${playerCount} ${playerCount === 1 ? 'player' : 'players'} on roster`}
                className="shrink-0 flex flex-col items-center justify-center w-14 h-14 rounded-xl bg-black/40 ring-1 ring-line-default/15 backdrop-blur-sm"
              >
                <span className="text-xl font-extrabold text-white leading-none tabular-nums">{playerCount}</span>
                <span className="text-[9px] font-bold tracking-widest text-white/70 mt-1">ROSTER</span>
              </Link>
              {isCoach && (
                <Link
                  to="/calendar"
                  className="inline-flex items-center justify-center px-4 py-2.5 rounded-md font-bold text-sm bg-brand-primary hover:bg-brand-primary text-white shadow-lg shadow-brand-primary-dim/40 ring-1 ring-brand-primary-soft/20 transition"
                >
                  Schedule your first event
                </Link>
              )}
            </div>
          </div>
        </article>
      </section>
    );
  }

  return (
    <section className="px-3 sm:px-4 pt-3">
      <article
        className="next-event-poster relative overflow-hidden rounded-2xl ring-1 ring-line-default/10 shadow-2xl shadow-black/40 min-h-[440px] sm:min-h-[480px] flex flex-col"
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
          className="absolute inset-0 w-full h-full object-cover brightness-125 saturate-110"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
        {/* Cinematic overlay: dim middle, deeper bottom so the
            event title + RSVP zone sits on guaranteed dark
            surface regardless of photo content. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-b from-black/25 via-black/20 to-black/65 pointer-events-none"
        />
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[58%] bg-gradient-to-t from-black/90 via-black/50 to-transparent pointer-events-none"
        />

        {/* Header row: greeting (left) + weather chip (right) */}
        <div className="relative flex items-start justify-between px-5 pt-5 sm:pt-6">
          <div>
            <p className="text-[10px] font-extrabold tracking-[0.25em] uppercase text-brand-primary-soft">Next Up</p>
            <p className="mt-1 text-sm text-white/80 drop-shadow">{greeting}, {firstName}</p>
          </div>
          {weather && (
            <div className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-black/40 ring-1 ring-line-default/10 px-2.5 py-1 backdrop-blur-sm">
              <span aria-hidden className="text-base leading-none">{weather.icon}</span>
              <span className="text-[12px] font-bold text-white tabular-nums drop-shadow">{weather.tempMaxF}°/{weather.tempMinF}°</span>
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
              className="shrink-0 flex flex-col items-center justify-center w-[68px] h-[68px] sm:w-[76px] sm:h-[76px] rounded-2xl bg-black/50 ring-1 ring-line-default/15 backdrop-blur-md"
            >
              <span className="text-[10px] font-extrabold tracking-widest text-brand-primary-soft">{eventMonth}</span>
              <span className="text-3xl sm:text-[34px] font-black text-white leading-none [text-shadow:0_2px_7px_rgba(0,0,0,0.95),0_0_1px_rgba(0,0,0,0.9)]">{eventDay}</span>
              <span className="text-[9px] font-bold tracking-widest text-white/70 mt-0.5">{eventDow}</span>
            </Link>
            <div className="min-w-0 flex-1">
              <Link to={`/events/${nextEvent.id}`} className="block">
                <h2 className="text-2xl sm:text-3xl font-black text-white leading-tight truncate [text-shadow:0_3px_10px_rgba(0,0,0,0.95),0_0_1px_rgba(0,0,0,0.9)]">
                  {nextEvent.title}
                </h2>
                <p className="mt-1 text-sm sm:text-base font-semibold text-white/90 truncate [text-shadow:0_2px_7px_rgba(0,0,0,0.9)]">{whenText}</p>
                {location && (
                  <p className="mt-0.5 text-xs sm:text-sm font-semibold text-white/90 truncate [text-shadow:0_2px_7px_rgba(0,0,0,0.95),0_0_1px_rgba(0,0,0,0.9)]">
                    <span aria-hidden className="mr-1">·</span>{location}
                  </p>
                )}
                {developmentFocus && (
                  <p className="mt-1 inline-flex max-w-full items-center rounded-full bg-black/50 ring-1 ring-white/10 px-2 py-1 text-[10px] sm:text-[11px] font-extrabold uppercase tracking-widest text-brand-primary-soft truncate backdrop-blur-sm [text-shadow:0_2px_6px_rgba(0,0,0,0.85)]">
                    Today: {developmentFocus}
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

          {/* Coach attendance toggle removed from the hero
              (Patrick 2026-06-21: 'i want to clean up the
              header'). Now lives on the EventDetail page in a
              dedicated 'Coach attendance' card visible to coaches
              with linked kids. Hero stays focused on the kid RSVP
              path, which is what 95% of users actually tap. */}

          {/* Going / pending tally line. Quiet, just-the-facts. */}
          <p className="mt-3 text-center text-[12px] text-white/70 drop-shadow">
            <span className="font-bold text-white">{goingCount}</span> going
            {pendingCount > 0 && (
              <>
                {' · '}
                <span className="font-bold text-white">{pendingCount}</span> pending
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
  const inactiveStyles = 'bg-black/50 text-white/90 ring-1 ring-white/10 backdrop-blur-md hover:bg-black/60';
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
