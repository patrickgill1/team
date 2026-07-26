import React from 'react';

// Four-tile stats band that sits directly under the redesigned hero.
// Glanceable numbers + label, with restrained neutral surfaces so it
// works in light mode, dark mode, and grey club-brand palettes. We
// deliberately pick metrics that REALLY exist on Fire FC
// data rather than the mockup's "Overall Season Rating" (made-up
// composite) so the numbers are trustworthy.

interface Props {
  potmWins: number;
  streakDays: number;
  /** 0-100. Computed from playerRsvps on recent practice/game events
   *  in the player's team(s). */
  attendancePct: number | null;
  jugglesBest: number;
  /** Adult teams: hide the juggle tile (kid-flavored feature) and
   *  drop the grid to 3 columns. */
  hideJuggles?: boolean;
}

const ProfileStatsStrip: React.FC<Props> = ({ potmWins, streakDays, attendancePct, jugglesBest, hideJuggles }) => {
  return (
    <section className="bg-surface-base px-4 sm:px-6 py-4 border-b border-line-default/10">
      <div className={`max-w-6xl mx-auto grid grid-cols-2 ${hideJuggles ? 'sm:grid-cols-3' : 'sm:grid-cols-4'} gap-2 sm:gap-3`}>
        <StatTile
          accent="amber"
          icon={<TrophyIcon />}
          value={String(potmWins)}
          label="POTM"
          sub="Awards"
        />
        <StatTile
          accent="emerald"
          icon={<FlameIcon />}
          value={String(streakDays)}
          label="Day"
          sub="Streak"
        />
        <StatTile
          accent="cyan"
          icon={<CheckIcon />}
          value={attendancePct != null ? `${attendancePct}%` : '—'}
          label="Practice"
          sub="Attendance"
        />
        {!hideJuggles && (
          <StatTile
            accent="cyan"
            icon={<BallIcon />}
            value={String(jugglesBest)}
            label="Juggle"
            sub="Personal best"
          />
        )}
      </div>
    </section>
  );
};

// Neutralized outlines 2026-07-14 (Patrick: "we should at least make
// the color consistent in the actual profile"). All four tiles now
// share the same quiet ring so the strip reads as one composed unit;
// icons keep their semantic color (amber trophy, emerald flame,
// crimson check) so the metric is still visible at a glance.
const ACCENT: Record<string, { bg: string; ring: string; badge: string; text: string }> = {
  amber: { bg: 'bg-surface-elevated/80', ring: 'ring-line-default/15', badge: 'bg-amber-400', text: 'text-ink-primary' },
  emerald: { bg: 'bg-surface-elevated/80', ring: 'ring-line-default/15', badge: 'bg-emerald-400', text: 'text-ink-primary' },
  cyan: { bg: 'bg-surface-elevated/80', ring: 'ring-line-default/15', badge: 'bg-brand-primary-soft', text: 'text-ink-primary' },
};

const StatTile: React.FC<{
  accent: keyof typeof ACCENT;
  icon: React.ReactNode;
  value: string;
  label: string;
  sub: string;
}> = ({ accent, icon, value, label, sub }) => {
  const a = ACCENT[accent];
  return (
    <div className={`relative overflow-hidden rounded-2xl ${a.bg} ring-1 ${a.ring} p-3 sm:p-4 shadow-sm shadow-black/5`}>
      <div className="flex items-center gap-2 mb-1">
        <span className={`inline-flex items-center justify-center w-7 h-7 sm:w-9 sm:h-9 rounded-full ${a.badge} text-slate-950 shadow-inner`}>
          {icon}
        </span>
        <span className={`text-3xl sm:text-4xl font-black tabular-nums leading-none ${a.text}`}>{value}</span>
      </div>
      <div className="text-[10px] sm:text-[11px] font-extrabold uppercase tracking-widest text-ink-primary/90 leading-tight">{label}</div>
      <div className="text-[9px] sm:text-[10px] font-bold uppercase tracking-widest text-ink-primary/50">{sub}</div>
    </div>
  );
};

const TrophyIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M5 4h14v2h2v4a4 4 0 0 1-4 4h-.55A6 6 0 0 1 13 18v2h2v2H9v-2h2v-2a6 6 0 0 1-3.45-4H7a4 4 0 0 1-4-4V6h2zm0 4v2a2 2 0 0 0 2 2V8zm14 0v4a2 2 0 0 0 2-2V8z" /></svg>
);
const FlameIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14a8 8 0 0 0 16 0c0-4.07-1.95-7.7-5-9.93l-.49-.62z" /></svg>
);
const CheckIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
);
const BallIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path fill="white" d="M12 6l2.5 2-.75 3h-3.5l-.75-3z" /></svg>
);

export default ProfileStatsStrip;
