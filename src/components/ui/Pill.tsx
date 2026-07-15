// @ts-nocheck
import React from 'react';

/**
 * Pill / chip / badge primitive. The app has dozens of small uppercase
 * labels — role chips, status tags, count badges, "ARCHIVED",
 * "ADMIN", "COACH", etc. Right now each one re-declares its own
 * Tailwind classes and they drift over time. One primitive locks the
 * vocabulary.
 *
 * Tones ↓
 *   neutral  — bone/charcoal grey (default for inactive labels)
 *   crimson  — brand primary (Admin, primary actions in chip form)
 *   amber    — warning / pending state
 *   emerald  — success / active / online
 *   rose     — error / past-due
 *   sky      — informational / "Manager" role / cool callouts
 *   violet   — special status (offer, premium, secondary highlights)
 *
 * Sizes ↓
 *   xs — 9px text, narrow padding (dense chip rows in tables)
 *   sm — 10px text (default, matches existing "ARCHIVED" / "COACH" pills)
 *   md — 11px text (heavier badges in card headers)
 *
 * Optional dot — small filled circle in the brand tone, useful for
 * status indicators ("• Active", "• Live").
 */

export type PillTone =
  | 'neutral'
  | 'crimson'
  | 'amber'
  | 'emerald'
  | 'rose'
  | 'sky'
  | 'violet';

export type PillSize = 'xs' | 'sm' | 'md';

interface Props {
  tone?: PillTone;
  size?: PillSize;
  dot?: boolean;
  uppercase?: boolean;
  className?: string;
  children: React.ReactNode;
}

// Tone -> tailwind triplet (text color / bg fill / ring). Soft-fill
// look (semi-transparent bg + matching ring) — same pattern that
// already shows up most often in the existing codebase.
// 2026-07-15: split the text color per theme. Prior single-token
// text-<hue>-200 rendered as light-yellow / light-green / etc — fine
// on dark bg, invisible on light bg. Dark:200 stays, light:700 is
// the readable equivalent on a light card. Same shift for every
// tone. bg-<hue>-500/15 works in both themes because it's semi-
// transparent tint over the theme surface.
const TONES: Record<PillTone, string> = {
  neutral: 'text-ink-primary/65 bg-line-default/[0.08] ring-1 ring-line-default/10',
  crimson: 'text-brand-primary-soft bg-brand-primary/15 ring-1 ring-brand-primary/30',
  amber:   'text-amber-700 dark:text-amber-200 bg-amber-500/15 ring-1 ring-amber-400/30',
  emerald: 'text-emerald-700 dark:text-emerald-200 bg-emerald-500/15 ring-1 ring-emerald-400/30',
  rose:    'text-rose-700 dark:text-rose-200 bg-rose-500/15 ring-1 ring-rose-400/30',
  sky:     'text-sky-700 dark:text-sky-200 bg-sky-500/15 ring-1 ring-sky-400/30',
  violet:  'text-violet-700 dark:text-violet-200 bg-violet-500/15 ring-1 ring-violet-400/30',
};

const DOT_TONES: Record<PillTone, string> = {
  neutral: 'bg-bone/55',
  crimson: 'bg-brand-primary-soft',
  amber:   'bg-amber-400',
  emerald: 'bg-emerald-400',
  rose:    'bg-rose-400',
  sky:     'bg-sky-400',
  violet:  'bg-violet-400',
};

const SIZES: Record<PillSize, string> = {
  xs: 'text-[9px]  font-extrabold px-1.5 py-0.5 rounded',
  sm: 'text-[10px] font-extrabold px-2   py-0.5 rounded',
  md: 'text-[11px] font-extrabold px-2.5 py-1   rounded-md',
};

const DOT_SIZE: Record<PillSize, string> = {
  xs: 'h-1.5 w-1.5',
  sm: 'h-1.5 w-1.5',
  md: 'h-2   w-2',
};

const Pill: React.FC<Props> = ({
  tone = 'neutral',
  size = 'sm',
  dot = false,
  uppercase = true,
  className,
  children,
}) => {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 tracking-widest',
        uppercase ? 'uppercase' : '',
        SIZES[size],
        TONES[tone],
        className || '',
      ].filter(Boolean).join(' ')}
    >
      {dot && <span className={`inline-block rounded-full ${DOT_SIZE[size]} ${DOT_TONES[tone]}`} aria-hidden />}
      {children}
    </span>
  );
};

export default Pill;
