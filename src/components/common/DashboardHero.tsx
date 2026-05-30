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
}

function sceneFor(hour: number): SceneSpec {
  if (hour < 5.5) return { phase: 'night',      gradient: 'from-slate-950 via-slate-950 to-slate-900',          stars: true,  moon: true  };
  if (hour < 7)   return { phase: 'predawn',    gradient: 'from-slate-900 via-indigo-950 to-slate-800',         stars: true,  moon: false };
  if (hour < 11)  return { phase: 'morning',    gradient: 'from-slate-900 via-slate-800 to-slate-700',          stars: false, moon: false };
  if (hour < 14)  return { phase: 'midday',     gradient: 'from-slate-800 via-slate-700 to-slate-600',          stars: false, moon: false };
  if (hour < 17)  return { phase: 'afternoon',  gradient: 'from-slate-900 via-slate-800 to-slate-700',          stars: false, moon: false };
  if (hour < 19)  return { phase: 'goldenHour', gradient: 'from-slate-900 via-slate-800 to-amber-900/40',       stars: false, moon: false };
  if (hour < 20.5)return { phase: 'sunset',     gradient: 'from-slate-950 via-slate-900 to-rose-900/40',        stars: false, moon: false };
  if (hour < 22)  return { phase: 'dusk',       gradient: 'from-slate-950 via-slate-900 to-slate-800',          stars: true,  moon: true  };
  return            { phase: 'night',      gradient: 'from-slate-950 via-slate-950 to-slate-900',          stars: true,  moon: true  };
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
      className={`relative overflow-hidden bg-gradient-to-b ${scene.gradient}`}
      aria-label={`${greeting}, ${firstName}`}
    >
      {/* Stars (night) */}
      {scene.stars &&
        STAR_POSITIONS.map((s, i) => (
          <span
            key={i}
            aria-hidden
            className="absolute rounded-full bg-white pointer-events-none"
            style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.size, height: s.size, opacity: s.opacity }}
          />
        ))}

      {/* Moon (night) — tucked top-right above the content area */}
      {scene.moon && (
        <span
          aria-hidden
          className="absolute rounded-full pointer-events-none"
          style={{
            right: '5%',
            top: '10%',
            width: 16,
            height: 16,
            background: '#e2e8f0',
            boxShadow: '0 0 12px 4px rgba(226,232,240,0.3)',
          }}
        />
      )}

      {/* Pitch perspective at the bottom */}
      <svg
        aria-hidden
        className="absolute inset-x-0 bottom-0 w-full pointer-events-none"
        viewBox="0 0 400 80"
        preserveAspectRatio="none"
        style={{ height: '45%' }}
      >
        <path d="M 0 80 L 60 8 L 340 8 L 400 80 Z" fill="rgba(15,23,42,0.45)" />
        <path d="M 0 80 L 60 8 L 340 8 L 400 80" fill="none" stroke="rgba(148,163,184,0.3)" strokeWidth="0.6" />
        <line x1="200" y1="8" x2="200" y2="80" stroke="rgba(148,163,184,0.25)" strokeWidth="0.5" />
        <ellipse cx="200" cy="44" rx="50" ry="11" fill="none" stroke="rgba(148,163,184,0.3)" strokeWidth="0.5" />
      </svg>

      {/* Content — kept compact: a glance, not a hero. */}
      <div className="relative max-w-5xl mx-auto px-4 sm:px-6 pt-3 pb-4 sm:pt-4 sm:pb-5">
        <h1 className="text-base sm:text-lg font-bold text-white">
          {greeting}, {firstName}!
        </h1>
        <p className="text-[11px] sm:text-xs text-slate-300">
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
