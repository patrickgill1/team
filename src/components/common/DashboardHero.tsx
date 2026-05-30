import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarEvent } from '../../types';
import { WeatherSummary } from '../../utils/weather';

// Dashboard hero — the always-navy stadium scene from SkyHeader, but
// upgraded from a decorative band to a real summary card. Shows
// the next event's "going" count, name + time, and a stack of
// "new messages / new photos" badges. Pitch silhouette + floodlights
// stay (they toggle on at dusk → night), so the band still senses
// time of day, but the space is now also useful at a glance.

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
  label: string;
  // Top→bottom sky gradient. Always navy-rooted.
  gradient: string;
  litness: 'off' | 'warming' | 'on';
  stars: boolean;
  moon: boolean;
}

function sceneFor(hour: number): SceneSpec {
  if (hour < 5.5)
    return { phase: 'night', label: 'Late night', gradient: 'from-slate-950 via-slate-950 to-slate-900', litness: 'on', stars: true, moon: true };
  if (hour < 7)
    return { phase: 'predawn', label: 'Pre-dawn', gradient: 'from-slate-900 via-indigo-950 to-slate-800', litness: 'on', stars: true, moon: false };
  if (hour < 11)
    return { phase: 'morning', label: 'Morning', gradient: 'from-slate-900 via-slate-800 to-slate-700', litness: 'off', stars: false, moon: false };
  if (hour < 14)
    return { phase: 'midday', label: 'Midday', gradient: 'from-slate-800 via-slate-700 to-slate-600', litness: 'off', stars: false, moon: false };
  if (hour < 17)
    return { phase: 'afternoon', label: 'Afternoon', gradient: 'from-slate-900 via-slate-800 to-slate-700', litness: 'off', stars: false, moon: false };
  if (hour < 19)
    return { phase: 'goldenHour', label: 'Golden hour', gradient: 'from-slate-900 via-slate-800 to-amber-900/40', litness: 'warming', stars: false, moon: false };
  if (hour < 20.5)
    return { phase: 'sunset', label: 'Sunset', gradient: 'from-slate-950 via-slate-900 to-rose-900/40', litness: 'on', stars: false, moon: false };
  if (hour < 22)
    return { phase: 'dusk', label: 'Dusk', gradient: 'from-slate-950 via-slate-900 to-slate-800', litness: 'on', stars: true, moon: true };
  return { phase: 'night', label: 'Night', gradient: 'from-slate-950 via-slate-950 to-slate-900', litness: 'on', stars: true, moon: true };
}

interface Props {
  greeting: string;
  firstName: string;
  nextEvent: CalendarEvent | null;
  goingCount: number;
  whenText: string; // pre-formatted "Sat, May 30 · 9:00 AM" string
  newMessagesCount: number;
  weather: WeatherSummary | null;
  hourOverride?: number;
}

const DashboardHero: React.FC<Props> = ({
  greeting,
  firstName,
  nextEvent,
  goingCount,
  whenText,
  newMessagesCount,
  weather,
  hourOverride,
}) => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (hourOverride !== undefined) return;
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, [hourOverride]);

  const hour =
    hourOverride !== undefined ? hourOverride : now.getHours() + now.getMinutes() / 60;
  const scene = sceneFor(hour);

  const lampColor =
    scene.litness === 'on' ? '#fef3c7'
    : scene.litness === 'warming' ? '#fde68a'
    : '#475569';
  const lampGlow =
    scene.litness === 'on' ? '0 0 22px 8px rgba(254,243,199,0.5)'
    : scene.litness === 'warming' ? '0 0 12px 4px rgba(253,230,138,0.3)'
    : 'none';

  return (
    <section
      className={`relative overflow-hidden bg-gradient-to-b ${scene.gradient}`}
      aria-label={`${greeting}, ${firstName}`}
    >
      {/* Stars (night only) */}
      {scene.stars &&
        STAR_POSITIONS.map((s, i) => (
          <span
            key={i}
            aria-hidden
            className="absolute rounded-full bg-white pointer-events-none"
            style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.size, height: s.size, opacity: s.opacity }}
          />
        ))}

      {/* Moon — only at night, tucked top-right so it doesn't clash with content */}
      {scene.moon && (
        <span
          aria-hidden
          className="absolute rounded-full pointer-events-none"
          style={{
            right: '6%',
            top: '12%',
            width: 16,
            height: 16,
            background: '#e2e8f0',
            boxShadow: '0 0 12px 4px rgba(226,232,240,0.3)',
          }}
        />
      )}

      {/* Pitch perspective at the bottom — faint, just enough to read as a field */}
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

      {/* Floodlight poles + lamps */}
      <span
        aria-hidden
        className="absolute pointer-events-none"
        style={{ left: '6%', bottom: '20%', width: 1.5, height: '60%', background: 'rgba(100,116,139,0.6)' }}
      />
      <span
        aria-hidden
        className="absolute pointer-events-none"
        style={{ right: '6%', bottom: '20%', width: 1.5, height: '60%', background: 'rgba(100,116,139,0.6)' }}
      />
      <span
        aria-hidden
        className="absolute rounded-sm pointer-events-none"
        style={{
          left: 'calc(6% - 6px)',
          top: '18%',
          width: 14,
          height: 5,
          background: lampColor,
          boxShadow: lampGlow,
        }}
      />
      <span
        aria-hidden
        className="absolute rounded-sm pointer-events-none"
        style={{
          right: 'calc(6% - 6px)',
          top: '18%',
          width: 14,
          height: 5,
          background: lampColor,
          boxShadow: lampGlow,
        }}
      />

      {/* Content */}
      <div className="relative max-w-5xl mx-auto px-4 sm:px-6 pt-5 pb-6 sm:pt-6 sm:pb-7">
        <h1 className="text-lg sm:text-xl font-bold text-white">
          {greeting}, {firstName}!
        </h1>
        <p className="mt-0.5 text-xs sm:text-sm text-slate-300">
          Here's what's happening with your team.
        </p>

        {/* Summary row — RSVP going | event name + when | messages + photos.
            Stacks on small screens. */}
        {nextEvent && (
          <div className="mt-4 grid grid-cols-[auto_1fr_auto] gap-3 sm:gap-5 items-center">
            {/* Going count */}
            <Link
              to={`/event/${nextEvent.id}`}
              className="group flex flex-col items-center justify-center w-16 h-16 sm:w-20 sm:h-20 rounded-full border-2 border-cyan-400/40 bg-slate-900/50 hover:bg-slate-900/70 transition shadow-lg shadow-cyan-500/10"
              aria-label={`${goingCount} players going to ${nextEvent.title}`}
            >
              <svg className="w-5 h-5 sm:w-6 sm:h-6 text-cyan-300" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19a3 3 0 00-6 0M12 11a4 4 0 100-8 4 4 0 000 8zm6 0a3 3 0 100-6 3 3 0 000 6zm-12 0a3 3 0 100-6 3 3 0 000 6z" />
              </svg>
              <span className="mt-0.5 text-xs sm:text-sm font-bold text-white leading-none">{goingCount}</span>
            </Link>

            {/* Event name + when */}
            <Link to={`/event/${nextEvent.id}`} className="min-w-0 group">
              <p className="text-base sm:text-lg font-bold text-white leading-tight truncate">
                {goingCount} {goingCount === 1 ? 'player is' : 'players are'} going to{' '}
                <span className="text-cyan-300 group-hover:underline">{nextEvent.title}</span>
              </p>
              <p className="mt-1 text-xs sm:text-sm text-slate-300 flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="9" />
                  <path strokeLinecap="round" d="M12 7v5l3 2" />
                </svg>
                {whenText}
              </p>
            </Link>

            {/* Stats stack */}
            <div className="flex flex-col gap-2 sm:gap-3">
              <Link to="/chat" className="flex items-center gap-2 group" aria-label={`${newMessagesCount} new messages`}>
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-cyan-500/20 text-cyan-300">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12a9 9 0 11-2.6-6.3L21 3v6h-6" />
                  </svg>
                </span>
                <div className="leading-tight">
                  <div className="text-base sm:text-lg font-bold text-white">{newMessagesCount}</div>
                  <div className="text-[10px] sm:text-xs text-slate-300 -mt-0.5">new messages</div>
                </div>
              </Link>
              {weather && (
                <Link
                  to={`/event/${nextEvent.id}`}
                  className="flex items-center gap-2 group"
                  aria-label={`Event weather ${weather.tempMaxF} high ${weather.tempMinF} low, ${weather.label}`}
                >
                  <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-cyan-500/20 text-base">
                    {weather.icon}
                  </span>
                  <div className="leading-tight">
                    <div className="text-base sm:text-lg font-bold text-white">
                      {weather.tempMaxF}° <span className="text-slate-400 font-medium">/ {weather.tempMinF}°</span>
                    </div>
                    <div className="text-[10px] sm:text-xs text-slate-300 -mt-0.5">
                      {weather.precipChance >= 30
                        ? `${weather.precipChance}% rain`
                        : weather.label.toLowerCase()}
                    </div>
                  </div>
                </Link>
              )}
            </div>
          </div>
        )}

        {/* No-event fallback — keeps the hero from looking empty if the
            team hasn't scheduled anything yet. */}
        {!nextEvent && (
          <div className="mt-4 rounded-xl bg-slate-900/40 ring-1 ring-slate-700/60 px-4 py-3 text-sm text-slate-200">
            No upcoming events. Add one from the Events tab to get rolling.
          </div>
        )}
      </div>
    </section>
  );
};

const STAR_POSITIONS = [
  { x: 8, y: 18, size: 1.5, opacity: 0.9 },
  { x: 18, y: 32, size: 1, opacity: 0.7 },
  { x: 28, y: 14, size: 1.5, opacity: 0.85 },
  { x: 38, y: 26, size: 1, opacity: 0.6 },
  { x: 50, y: 12, size: 1.5, opacity: 0.9 },
  { x: 58, y: 30, size: 1, opacity: 0.65 },
  { x: 72, y: 18, size: 1.5, opacity: 0.85 },
  { x: 82, y: 28, size: 1, opacity: 0.7 },
];

export default DashboardHero;
