import React, { useEffect, useState } from 'react';

// Tiny ambient skyscape that sits behind the dashboard greeting.
// Replaces the old multi-palette gradient with something that
// actually *looks* like the time of day: sun arcs across the top
// during the day, moon + stars after sunset. No device location
// involved — we approximate the day window as 6am→8pm in the
// user's local clock, which is close enough for "vibe."

type Phase =
  | 'predawn'
  | 'sunrise'
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
  // tailwind gradient classes — top to bottom (sky → horizon).
  gradient: string;
  // hex for the sun/moon disc.
  bodyColor: string;
  bodyGlow: string;
  // text color for the label, with enough contrast against the gradient.
  labelClass: string;
  isNight: boolean;
}

function sceneFor(hour: number): SceneSpec {
  if (hour < 5)
    return {
      phase: 'night',
      label: 'Late night',
      gradient: 'from-slate-950 via-indigo-950 to-slate-900',
      bodyColor: '#e2e8f0',
      bodyGlow: 'rgba(226,232,240,0.35)',
      labelClass: 'text-slate-200',
      isNight: true,
    };
  if (hour < 6.5)
    return {
      phase: 'predawn',
      label: 'Pre-dawn',
      gradient: 'from-indigo-950 via-purple-800 to-orange-300',
      bodyColor: '#fde68a',
      bodyGlow: 'rgba(253,230,138,0.5)',
      labelClass: 'text-amber-100',
      isNight: false,
    };
  if (hour < 8)
    return {
      phase: 'sunrise',
      label: 'Sunrise',
      gradient: 'from-orange-300 via-pink-300 to-sky-200',
      bodyColor: '#fef3c7',
      bodyGlow: 'rgba(254,243,199,0.7)',
      labelClass: 'text-rose-900',
      isNight: false,
    };
  if (hour < 11)
    return {
      phase: 'morning',
      label: 'Morning',
      gradient: 'from-sky-400 via-sky-300 to-sky-100',
      bodyColor: '#fef9c3',
      bodyGlow: 'rgba(254,249,195,0.6)',
      labelClass: 'text-sky-900',
      isNight: false,
    };
  if (hour < 14)
    return {
      phase: 'midday',
      label: 'Midday',
      gradient: 'from-sky-500 via-sky-400 to-sky-200',
      bodyColor: '#fef08a',
      bodyGlow: 'rgba(254,240,138,0.65)',
      labelClass: 'text-sky-950',
      isNight: false,
    };
  if (hour < 16.5)
    return {
      phase: 'afternoon',
      label: 'Afternoon',
      gradient: 'from-sky-400 via-amber-100 to-amber-200',
      bodyColor: '#fde68a',
      bodyGlow: 'rgba(253,230,138,0.65)',
      labelClass: 'text-amber-900',
      isNight: false,
    };
  if (hour < 18.5)
    return {
      phase: 'goldenHour',
      label: 'Golden hour',
      gradient: 'from-amber-300 via-orange-400 to-rose-300',
      bodyColor: '#fed7aa',
      bodyGlow: 'rgba(254,215,170,0.75)',
      labelClass: 'text-amber-900',
      isNight: false,
    };
  if (hour < 20)
    return {
      phase: 'sunset',
      label: 'Sunset',
      gradient: 'from-rose-400 via-orange-500 to-purple-700',
      bodyColor: '#fdba74',
      bodyGlow: 'rgba(253,186,116,0.7)',
      labelClass: 'text-rose-50',
      isNight: false,
    };
  if (hour < 21.5)
    return {
      phase: 'dusk',
      label: 'Dusk',
      gradient: 'from-purple-800 via-indigo-800 to-slate-900',
      bodyColor: '#e9d5ff',
      bodyGlow: 'rgba(233,213,255,0.4)',
      labelClass: 'text-purple-100',
      isNight: false,
    };
  return {
    phase: 'night',
    label: 'Night',
    gradient: 'from-slate-950 via-indigo-950 to-slate-900',
    bodyColor: '#e2e8f0',
    bodyGlow: 'rgba(226,232,240,0.35)',
    labelClass: 'text-slate-200',
    isNight: true,
  };
}

// Sun/moon X (0..1 left→right) and Y (0..1 top→bottom, lower=higher in sky).
// Day arc: 6am sunrise on the left, 8pm sunset on the right, peak at ~1pm.
// Night arc: 8pm rise on the right (visually mirrored), peak at midnight.
function bodyPosition(hour: number, isNight: boolean): { x: number; y: number } {
  if (!isNight) {
    const t = Math.min(1, Math.max(0, (hour - 6) / 14));
    const x = t * 100;
    const y = 90 - Math.sin(t * Math.PI) * 70; // arc, 90% bottom → 20% top → 90% bottom
    return { x, y };
  }
  // Night: map 20→5 (next day) onto 0..1, run the moon right→left so it
  // doesn't look like the sun re-set.
  const nh = hour >= 20 ? hour - 20 : hour + 4;
  const t = Math.min(1, nh / 9);
  const x = 100 - t * 100;
  const y = 75 - Math.sin(t * Math.PI) * 55;
  return { x, y };
}

interface Props {
  // Optional: pin a specific hour for previews / Storybook. Defaults to now.
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
  const { x, y } = bodyPosition(hour, scene.isNight);

  // Star field — only at night. Fixed positions so it doesn't twinkle-jitter.
  const stars = scene.isNight ? STAR_POSITIONS : [];

  return (
    <div
      aria-hidden
      className={`relative h-24 sm:h-28 overflow-hidden bg-gradient-to-b ${scene.gradient}`}
    >
      {/* stars (night only) */}
      {stars.map((s, i) => (
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

      {/* sun or moon */}
      <span
        className="absolute rounded-full"
        style={{
          left: `calc(${x}% - 14px)`,
          top: `${y}%`,
          width: 28,
          height: 28,
          background: scene.bodyColor,
          boxShadow: `0 0 24px 8px ${scene.bodyGlow}`,
        }}
      />

      {/* moon crater detail */}
      {scene.isNight && (
        <span
          className="absolute rounded-full"
          style={{
            left: `calc(${x}% - 6px)`,
            top: `calc(${y}% + 4px)`,
            width: 8,
            height: 8,
            background: 'rgba(100,116,139,0.45)',
          }}
        />
      )}

      {/* horizon haze fading to the page background */}
      <div className="absolute inset-x-0 bottom-0 h-6 bg-gradient-to-b from-transparent to-white/60" />

      {/* phase label */}
      <div
        className={`absolute bottom-1.5 left-3 sm:left-4 text-[11px] sm:text-xs font-semibold tracking-wide uppercase ${scene.labelClass} drop-shadow-sm`}
      >
        {scene.label}
      </div>
    </div>
  );
};

const STAR_POSITIONS = [
  { x: 8, y: 18, size: 2, opacity: 0.9 },
  { x: 15, y: 35, size: 1, opacity: 0.7 },
  { x: 22, y: 12, size: 1.5, opacity: 0.85 },
  { x: 30, y: 28, size: 2, opacity: 0.8 },
  { x: 42, y: 20, size: 1, opacity: 0.6 },
  { x: 55, y: 14, size: 1.5, opacity: 0.85 },
  { x: 63, y: 30, size: 2, opacity: 0.9 },
  { x: 72, y: 22, size: 1, opacity: 0.65 },
  { x: 80, y: 38, size: 1.5, opacity: 0.8 },
  { x: 88, y: 16, size: 2, opacity: 0.95 },
  { x: 92, y: 30, size: 1, opacity: 0.6 },
];

export default SkyHeader;
