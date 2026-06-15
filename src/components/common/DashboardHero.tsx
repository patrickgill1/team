import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarEvent } from '../../types';
import { WeatherSummary } from '../../utils/weather';

// Dashboard hero — navy stadium scene at the current time of day,
// holding the day's at-a-glance info. Pitch silhouette + sky shift,
// moon + stars after dark. No floodlights (they crossed through the
// greeting type and didn't add enough to justify the visual cost).

type Phase =
  | 'predawn'
  | 'morning'
  | 'midday'
  | 'afternoon'
  | 'goldenHour'
  | 'sunset'
  | 'dusk'
  | 'night';

interface SceneSpec {
  phase: Phase;
  gradient: string;
  stars: boolean;
  moon: boolean;
  /** Optional real stadium photo behind the gradient. Files live in
   *  /public/images/hero/{morning,noon,sunset,night}.jpg. The gradient
   *  + overlay are kept ON TOP at reduced opacity so greeting text
   *  stays legible regardless of which photo loads. */
  bgImage?: string;
}

function sceneFor(hour: number): SceneSpec {
  if (hour < 5.5) return { phase: 'night',      gradient: 'from-slate-950/85 via-slate-950/70 to-slate-900/85',          stars: true,  moon: true,  bgImage: '/images/hero/night.jpg' };
  if (hour < 7)   return { phase: 'predawn',    gradient: 'from-slate-900/80 via-indigo-950/70 to-slate-800/80',         stars: true,  moon: false, bgImage: '/images/hero/night.jpg' };
  if (hour < 10)  return { phase: 'morning',    gradient: 'from-slate-900/70 via-slate-800/55 to-slate-700/65',          stars: false, moon: false, bgImage: '/images/hero/morning.jpg' };
  if (hour < 16)  return { phase: 'midday',     gradient: 'from-slate-900/55 via-slate-800/40 to-slate-700/55',          stars: false, moon: false, bgImage: '/images/hero/noon.jpg' };
  if (hour < 19)  return { phase: 'sunset',     gradient: 'from-slate-950/70 via-slate-900/55 to-rose-900/40',           stars: false, moon: false, bgImage: '/images/hero/sunset.jpg' };
  if (hour < 22)  return { phase: 'dusk',       gradient: 'from-slate-950/80 via-slate-900/70 to-slate-800/80',          stars: true,  moon: true,  bgImage: '/images/hero/night.jpg' };
  return            { phase: 'night',      gradient: 'from-slate-950/85 via-slate-950/70 to-slate-900/85',          stars: true,  moon: true,  bgImage: '/images/hero/night.jpg' };
}

interface Props {
  greeting: string;
  firstName: string;
  nextEvent: CalendarEvent | null;
  goingCount: number;
  pendingRsvpCount: number;
  whenText: string;          // pre-formatted "Tomorrow at 9:00 AM"
  newMessagesCount: number;
  weather: WeatherSummary | null;
  /** Used by the no-event state so the hero doesn't look empty when
   *  the team has nothing on the calendar. */
  playerCount: number;
  isCoach: boolean;
  hourOverride?: number;
}

const MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const DOWS_SHORT   = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

const DashboardHero: React.FC<Props> = ({
  greeting,
  firstName,
  nextEvent,
  goingCount,
  pendingRsvpCount,
  whenText,
  newMessagesCount,
  weather,
  playerCount,
  isCoach,
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

  return (
    <section
      // Min-height ramps up on larger viewports so the hero
      // proportionally fills the screen — on a 1784px tall monitor
      // the stadium photo was rendering as a thin strip with empty
      // dark space below the cards. Mobile keeps its natural height.
      className="relative overflow-hidden bg-slate-950 sm:min-h-[260px] lg:min-h-[360px] xl:min-h-[440px]"
      aria-label={`${greeting}, ${firstName}`}
    >
      {/* Time-of-day stadium photo behind the gradient. img errors are
          swallowed (file missing) so the hero still renders cleanly
          on the gradient alone — drop the JPEGs in and they take
          over automatically. */}
      {scene.bgImage && (
        <img
          src={scene.bgImage}
          alt=""
          aria-hidden
          loading="eager"
          className="absolute inset-0 w-full h-full object-cover"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      )}
      {/* Gradient overlay on top so the greeting text always reads. */}
      <div className={`absolute inset-0 bg-gradient-to-b ${scene.gradient}`} aria-hidden />
      {/* Soft fade from the bottom of the hero into the page bg
          (slate-950) so the transition into the dashboard content
          area below isn't a hard horizon line. Patrick: "any way to
          make the header image from the dashboard a little less
          harsh on the transition to the profile card". */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-slate-950 pointer-events-none"
      />
      {/* (Painted stars / moon / pitch-perspective SVG removed — the
          real time-of-day stadium photo behind the gradient already
          conveys the scene. Patrick: "we don't need the old banner
          field that was on there".) */}

      {/* Content — kept compact: a glance, not a hero. On taller
          desktops the section min-height pushes the bottom edge
          down, so we let the content stretch with the section
          (no absolute positioning) and bump greeting size up at lg+. */}
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 pt-3 pb-4 sm:pt-4 sm:pb-5 lg:pt-8 lg:pb-10 h-full flex flex-col justify-end">
        <h1 className="text-base sm:text-lg lg:text-2xl xl:text-3xl font-bold text-white">
          {greeting}, {firstName}!
        </h1>
        <p className="text-[11px] sm:text-xs lg:text-sm text-slate-300">
          Here's what's happening with your team.
        </p>

        {nextEvent && eventDate && (
          <div className="mt-3 grid grid-cols-[auto_1fr_auto] gap-3 sm:gap-4 items-center">
            {/* Date badge — replaces the people circle (no more duplicate count) */}
            <Link
              to={`/events/${nextEvent.id}`}
              aria-label={`${nextEvent.title} on ${eventMonth} ${eventDay} ${eventDow}`}
              className="flex flex-col items-center justify-center w-16 h-16 sm:w-[72px] sm:h-[72px] rounded-2xl bg-slate-900/55 ring-1 ring-cyan-400/40 shadow-lg shadow-cyan-500/10"
            >
              <span className="text-[10px] font-bold tracking-wider text-cyan-300">{eventMonth}</span>
              <span className="text-2xl sm:text-3xl font-extrabold text-white leading-none">{eventDay}</span>
              <span className="text-[9px] font-semibold tracking-wider text-slate-300 mt-0.5">{eventDow}</span>
            </Link>

            {/* Event title + metadata (when · weather · going count) */}
            <Link to={`/events/${nextEvent.id}`} className="min-w-0 group">
              <p className="text-base sm:text-lg font-bold text-cyan-300 group-hover:underline leading-tight truncate">
                {nextEvent.title}
              </p>
              <p className="mt-0.5 text-xs sm:text-sm text-slate-200 truncate">
                {whenText}
                {weather && (
                  <span className="text-slate-300">
                    {' · '}
                    <span aria-hidden>{weather.icon}</span> {weather.tempMaxF}°/{weather.tempMinF}°
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-[11px] sm:text-xs text-slate-400">
                {goingCount} going
                {pendingRsvpCount > 0 ? ` · ${pendingRsvpCount} pending` : ''}
              </p>
            </Link>

            {/* Right column — actionable counts */}
            <div className="flex flex-col gap-2 sm:gap-3">
              <Link
                to="/chat"
                className="flex items-center gap-2 group"
                aria-label={`${newMessagesCount} new messages`}
              >
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-cyan-500/20 text-cyan-300">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 12a8 8 0 11-3.41-6.55L21 4v6h-6" />
                  </svg>
                </span>
                <div className="leading-tight">
                  <div className="text-base sm:text-lg font-bold text-white">{newMessagesCount}</div>
                  <div className="text-[10px] sm:text-xs text-slate-300 -mt-0.5">new messages</div>
                </div>
              </Link>

              <Link
                to={`/events/${nextEvent.id}`}
                className="flex items-center gap-2 group"
                aria-label={`${pendingRsvpCount} awaiting RSVP`}
              >
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/20 text-amber-300">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5h6a2 2 0 012 2v12l-5-3-5 3V7a2 2 0 012-2z" />
                  </svg>
                </span>
                <div className="leading-tight">
                  <div className="text-base sm:text-lg font-bold text-white">{pendingRsvpCount}</div>
                  <div className="text-[10px] sm:text-xs text-slate-300 -mt-0.5">awaiting RSVP</div>
                </div>
              </Link>
            </div>
          </div>
        )}

        {!nextEvent && (
          <div className="mt-3 grid grid-cols-[auto_1fr_auto] gap-3 sm:gap-4 items-center">
            {/* Left: roster badge — "X PLAYERS / ON ROSTER" so the
                hero never reads as empty even when nothing's scheduled. */}
            <Link
              to="/players"
              aria-label={`${playerCount} players on roster`}
              className="flex flex-col items-center justify-center w-16 h-16 sm:w-[72px] sm:h-[72px] rounded-2xl bg-slate-900/55 ring-1 ring-cyan-400/40 shadow-lg shadow-cyan-500/10"
            >
              <span className="text-2xl sm:text-3xl font-extrabold text-white leading-none">{playerCount}</span>
              <span className="text-[9px] font-semibold tracking-wider text-slate-300 mt-1">ROSTER</span>
            </Link>

            {/* Middle: friendly empty state + CTA */}
            <div className="min-w-0">
              <p className="text-base sm:text-lg font-bold text-cyan-300 leading-tight">All quiet for now</p>
              <p className="mt-0.5 text-xs sm:text-sm text-slate-300">
                No upcoming events on the calendar.
              </p>
              {isCoach && (
                <Link
                  to="/calendar"
                  className="mt-1.5 inline-flex items-center gap-1 text-[11px] sm:text-xs font-extrabold tracking-widest uppercase text-cyan-400 hover:text-cyan-300"
                >
                  + Schedule one
                </Link>
              )}
            </div>

            {/* Right: messages stays so the chrome doesn't collapse */}
            <div className="flex flex-col gap-2 sm:gap-3">
              <Link
                to="/chat"
                className="flex items-center gap-2 group"
                aria-label={`${newMessagesCount} new messages`}
              >
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-cyan-500/20 text-cyan-300">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 12a8 8 0 11-3.41-6.55L21 4v6h-6" />
                  </svg>
                </span>
                <div className="leading-tight">
                  <div className="text-base sm:text-lg font-bold text-white">{newMessagesCount}</div>
                  <div className="text-[10px] sm:text-xs text-slate-300 -mt-0.5">new messages</div>
                </div>
              </Link>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

const STAR_POSITIONS = [
  { x: 8,  y: 18, size: 1.5, opacity: 0.9  },
  { x: 18, y: 32, size: 1,   opacity: 0.7  },
  { x: 28, y: 14, size: 1.5, opacity: 0.85 },
  { x: 38, y: 26, size: 1,   opacity: 0.6  },
  { x: 50, y: 12, size: 1.5, opacity: 0.9  },
  { x: 58, y: 30, size: 1,   opacity: 0.65 },
  { x: 72, y: 18, size: 1.5, opacity: 0.85 },
  { x: 82, y: 28, size: 1,   opacity: 0.7  },
];

export default DashboardHero;
