// @ts-nocheck
import React from 'react';

/**
 * Primitive surface card. Every page in the app wraps content in
 * charcoal-900 + thin white ring + rounded-2xl + padding. This
 * locks that vocabulary so the dozens of ad-hoc wrappers can
 * collapse to one.
 *
 * Variants ↓
 *   default — bg-charcoal-900, ring-white/10 (the standard dark card)
 *   raised  — bg-charcoal-900, ring-white/10, shadow (use for elevated
 *             surfaces like modals, the dashboard hero)
 *   subtle  — bg-white/[0.04], ring-white/5 (background filler, hint
 *             cards, secondary panels)
 *   accent  — gradient crimson tint + ring (for promotional surfaces:
 *             SubscribeBanner, upgrade nudges)
 *
 * Padding ↓
 *   none — no inset, caller controls
 *   sm   — p-3 (compact list-row card)
 *   md   — p-4 (default)
 *   lg   — p-5
 *
 * Title + actions slots ↓
 *   When `title` is set, renders a kicker + title row across the top
 *   with a thin divider. `actions` slot floats top-right. Saves the
 *   "small kicker, bigger title, action button on the right" pattern
 *   from being rewritten on every page.
 */

export type CardVariant = 'default' | 'raised' | 'subtle' | 'accent';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

interface Props {
  variant?: CardVariant;
  padding?: CardPadding;
  /** Small uppercase kicker shown above the title. */
  kicker?: string;
  /** Bold title shown across the top of the card. */
  title?: string;
  /** Right-aligned slot in the header row (buttons, chips, etc). */
  actions?: React.ReactNode;
  /** When true, the card itself is tappable — adds focus + hover. */
  interactive?: boolean;
  onClick?: () => void;
  className?: string;
  children?: React.ReactNode;
}

const VARIANTS: Record<CardVariant, string> = {
  default: 'bg-charcoal-900 ring-1 ring-white/10',
  raised:  'bg-charcoal-900 ring-1 ring-white/10 shadow-xl shadow-black/30',
  subtle:  'bg-white/[0.04] ring-1 ring-white/5',
  accent:
    'bg-gradient-to-br from-crimson-950/40 via-charcoal-900 to-charcoal-900 ' +
    'ring-1 ring-crimson-700/40',
};

const PADDINGS: Record<CardPadding, string> = {
  none: '',
  sm:   'p-3',
  md:   'p-4',
  lg:   'p-5',
};

const Card: React.FC<Props> = ({
  variant = 'default',
  padding = 'md',
  kicker,
  title,
  actions,
  interactive = false,
  onClick,
  className,
  children,
}) => {
  const wrapper = [
    'rounded-2xl overflow-hidden',
    VARIANTS[variant],
    interactive ? 'cursor-pointer hover:ring-white/20 transition-shadow active:scale-[0.998]' : '',
    className || '',
  ].filter(Boolean).join(' ');

  const hasHeader = !!(kicker || title || actions);

  return (
    <div className={wrapper} onClick={interactive ? onClick : undefined} role={interactive ? 'button' : undefined}>
      {hasHeader && (
        <div className="px-5 py-4 border-b border-white/5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {kicker && (
              <p className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-400 mb-1">
                {kicker}
              </p>
            )}
            {title && (
              <h2 className="text-bone font-bold leading-tight">{title}</h2>
            )}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
      )}
      {children !== undefined && (
        <div className={hasHeader ? PADDINGS[padding] : PADDINGS[padding]}>
          {children}
        </div>
      )}
    </div>
  );
};

export default Card;
