import React, { useEffect, useState } from 'react';

// Ambient skyscape behind the dashboard greeting. Always brand-navy
// rooted — instead of a generic weather-app sky, this reads as
// "Fire FC's home pitch at the current time of day": floodlights
// glow at dusk + night, a few stars come out, and a phase label
// gives the moment a name. No device location involved.

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
  // Top→bottom sky gradient. Always navy-anchored.
  gradient: string;
  // Whether the stadium floodlights are visibly on.
  litness: 'off' | 'warming' | 'on';
  // Whether to render the star field.
  stars: boolean;
  // Whether to render the moon (vs nothing during the day).
  moon: boolean;
  // Label text color.
  labelClass: string;
}

function sceneFor(hour: number): SceneSpec {
  if (hour < 5.5)
    return {
      phase: 'night',
      label: 'Late night',
      gradient: 'from-slate-950 via-slate-950 to-slate-900',
      litness: 'on',
      stars: true,
      moon: true,
      labelClass: 'text-slate-300',
    };
  if (hour < 7)
    return {
      phase: 'predawn',
      label: 'Pre-dawn',
      gradient: 'from-slate-900 via-indigo-950 to-slate-800',
      litness: 'on',
      stars: true,
      moon: false,
      labelClass: 'text-slate-300',
    };
  if (hour < 11)
    return {
      phase: 'morning',
      label: 'Morning',
      gradient: 'from-slate-800 via-slate-700 to-slate-600',
      litness: 'off',
      stars: false,
      moon: false,
      labelClass: 'text-slate-200',
    };
  if (hour < 14)
    return {
      phase: 'midday',
      label: 'Midday',
      gradient: 'from-slate-700 via-slate-600 to-slate-500',
      litness: 'off',
      stars: false,
      moon: false,
      labelClass: 'text-slate-100',
    };
  if (hour < 17)
    return {
      phase: 'afternoon',
      label: 'Afternoon',
      gradient: 'from-slate-800 via-slate-700 to-slate-600',
      litness: 'off',
      stars: false,
      moon: false,
      labelClass: 'text-slate-200',
    };
  if (hour < 19)
    return {
      phase: 'goldenHour',
      label: 'Golden hour',
      gradient: 'from-slate-900 via-slate-800 to-amber-900/40',
      litness: 'warming',
      stars: false,
      moon: false,
      labelClass: 'text-amber-200',
    };
  if (hour < 20.5)
    return {
      phase: 'sunset',
      label: 'Sunset',
      gradient: 'from-slate-950 via-slate-900 to-rose-900/40',
      litness: 'on',
      stars: false,
      moon: false,
      labelClass: 'text-rose-200',
    };
  if (hour < 22)
    return {
      phase: 'dusk',
      label: 'Dusk',
      gradient: 'from-slate-950 via-slate-900 to-slate-800',
      litness: 'on',
      stars: true,
      moon: true,
      labelClass: 'text-slate-300',
    };
  return {
    phase: 'night',
    label: 'Night',
    gradient: 'from-slate-950 via-slate-950 to-slate-900',
    litness: 'on',
    stars: true,
    moon: true,
    labelClass: 'text-slate-300',
  };
}

interface Props {
  // Optional: pin a specific hour for previews. Defaults to now.
  hourOverride?: number;
}

const SkyHeader: React.FC<Props> = ({ hourOverride }) => {
  // Re-tick every minute so the scene drifts. Cheap — just bumps state.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (hourOverride !== undefined) return;
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, [hourOverride]);

  const hour =
    hourOverride !== undefined
      ? hourOverride
      : now.getHours() + now.getMinutes() / 60;
  const scene = sceneFor(hour);

  const lampColor =
    scene.litness === 'on'
      ? '#fef3c7' // amber-100
      : scene.litness === 'warming'
      ? '#fde68a' // amber-200, slightly cooler
      : '#475569'; // slate-600 = unlit
  const lampGlow =
    scene.litness === 'on'
      ? '0 0 18px 6px rgba(254,243,199,0.55)'
      : scene.litness === 'warming'
      ? '0 0 10px 3px rgba(253,230,138,0.3)'
      : 'none';

  return (
    <div
      aria-hidden
      className={`relative h-24 sm:h-28 overflow-hidden bg-gradient-to-b ${scene.gradient}`}
    >
      {/* Star field — only when stars=true */}
      {scene.stars &&
        STAR_POSITIONS.map((s, i) => (
          <span
            key={i}
            className="absolute rounded-full bg-white"
            style={{
              left: `${s.x}%`,
              top: `${s.y}%`,
              width: s.size,
              height: s.size,
              opacity: s.opacity,
            }}
          />
        ))}

      {/* Moon — small, top-right, only at night */}
      {scene.moon && (
        <span
          className="absolute rounded-full"
          style={{
            right: '12%',
            top: '20%',
            width: 20,
            height: 20,
            background: '#e2e8f0',
            boxShadow: '0 0 14px 4px rgba(226,232,240,0.3)',
          }}
        />
      )}

      {/* Pitch — perspective trapezoid at the bottom 45% of the band,
          with the center circle + halfway line as faint markings. */}
      <svg
        className="absolute inset-x-0 bottom-0 w-full"
        viewBox="0 0 400 60"
        preserveAspectRatio="none"
        style={{ height: '55%' }}
      >
        {/* turf */}
        <path
          d="M 0 60 L 60 6 L 340 6 L 400 60 Z"
          fill="rgba(15,23,42,0.55)"
        />
        {/* outline */}
        <path
          d="M 0 60 L 60 6 L 340 6 L 400 60"
          fill="none"
          stroke="rgba(148,163,184,0.35)"
          strokeWidth="0.6"
        />
        {/* halfway line */}
        <line
          x1="200"
          y1="6"
          x2="200"
          y2="60"
          stroke="rgba(148,163,184,0.3)"
          strokeWidth="0.5"
        />
        {/* center circle (squashed by perspective) */}
        <ellipse
          cx="200"
          cy="33"
          rx="42"
          ry="10"
          fill="none"
          stroke="rgba(148,163,184,0.35)"
          strokeWidth="0.5"
        />
      </svg>

      {/* Left floodlight pole + lamp */}
      <span
        className="absolute"
        style={{
          left: '8%',
          bottom: '22%',
          width: 1.5,
          height: 'calc(60% - 4px)',
          background: 'rgba(100,116,139,0.7)',
        }}
      />
      <span
        className="absolute rounded-sm"
        style={{
          left: 'calc(8% - 5px)',
          top: '24%',
          width: 12,
          height: 4,
          background: lampColor,
          boxShadow: lampGlow,
        }}
      />

      {/* Right floodlight pole + lamp */}
      <span
        className="absolute"
        style={{
          right: '8%',
          bottom: '22%',
          width: 1.5,
          height: 'calc(60% - 4px)',
          background: 'rgba(100,116,139,0.7)',
        }}
      />
      <span
        className="absolute rounded-sm"
        style={{
          right: 'calc(8% - 5px)',
          top: '24%',
          width: 12,
          height: 4,
          background: lampColor,
          boxShadow: lampGlow,
        }}
      />

      {/* Soft fade to the page background so the band joins cleanly. */}
      <div className="absolute inset-x-0 bottom-0 h-4 bg-gradient-to-b from-transparent to-white/40" />

      {/* Phase label */}
      <div
        className={`absolute bottom-1.5 left-3 sm:left-4 text-[10px] sm:text-[11px] font-semibold tracking-[0.15em] uppercase ${scene.labelClass}`}
      >
        {scene.label}
      </div>
    </div>
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
  { x: 82, y: 32, size: 1, opacity: 0.7 },
  { x: 92, y: 20, size: 1.5, opacity: 0.95 },
];

export default SkyHeader;
