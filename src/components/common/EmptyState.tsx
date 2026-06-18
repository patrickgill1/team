import React from 'react';
import { Link } from 'react-router-dom';

// One empty-state surface used across the app. Replaces the ~50
// hand-rolled "Nothing here yet" / "No X yet" cards with a single
// component so spacing, typography, icon weight, and CTA chrome are
// consistent everywhere.

interface Props {
  /** Monoline SVG (24×24). Lives in a small circular ring tile above
   *  the title. Tone defaults to cyan but accepts amber / slate for
   *  semantic context (awards = amber, archive = slate). */
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  /** Optional CTA. If `to` is set, renders as a router Link; if
   *  `onClick` is set, a button; pass both to your own peril. */
  cta?: {
    label: string;
    to?: string;
    onClick?: () => void;
  };
  /** Surface tone. 'light' = white card (default), 'dark' = glass on
   *  the dark hero bands so it doesn't pop against the gradient. */
  tone?: 'light' | 'dark';
  /** Compact = smaller padding / type, for use inside small cards. */
  compact?: boolean;
}

const EmptyState: React.FC<Props> = ({ icon, title, description, cta, tone = 'light', compact }) => {
  const isDark = tone === 'dark';
  const wrapper = isDark
    ? 'bg-white/[0.04] backdrop-blur ring-1 ring-white/10 rounded-2xl'
    : 'bg-white rounded-2xl shadow-sm ring-1 ring-gray-100';
  const pad = compact ? 'px-5 py-6' : 'px-6 py-10';
  const titleClass = isDark ? 'text-white' : 'text-slate-900';
  const descClass = isDark ? 'text-white/60' : 'text-slate-500';
  const iconTile = isDark
    ? 'bg-crimson-500/15 ring-1 ring-crimson-400/30 text-crimson-300'
    : 'bg-crimson-50 ring-1 ring-crimson-100 text-crimson-600';

  return (
    <div className={`${wrapper} ${pad} text-center`}>
      {icon && (
        <div className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-3 ${iconTile}`}>
          {icon}
        </div>
      )}
      <h3 className={`text-base sm:text-lg font-bold ${titleClass}`}>{title}</h3>
      {description && (
        <p className={`text-sm mt-1 max-w-xs mx-auto ${descClass}`}>{description}</p>
      )}
      {cta && (
        <div className="mt-4">
          {cta.to ? (
            <Link
              to={cta.to}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-crimson-600 hover:bg-crimson-500 text-white text-sm font-bold transition"
            >
              {cta.label} →
            </Link>
          ) : (
            <button
              type="button"
              onClick={cta.onClick}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-crimson-600 hover:bg-crimson-500 text-white text-sm font-bold transition"
            >
              {cta.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default EmptyState;
