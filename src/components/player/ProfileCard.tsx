import React from 'react';

// ProfileCard — the single shell every card on the player profile
// renders inside. Enforces the Card Contract from the 2026-07-15
// redesign plan: one radius, one surface, one border treatment, one
// header shape (eyebrow + title + optional action), one padding
// scale. If two cards can't be told apart as "same app" at a glance,
// this shell is broken.
//
// Token locks (per plan):
//   - Radius: rounded-2xl (16px). Never rounded-xl, never rounded-3xl.
//   - Surface: bg-surface-elevated. Never a gradient wash.
//   - Border: ring-1 ring-line-default/15. Never `border`, never shadow-*.
//   - Padding: p-4 sm:p-5. Compact tiles get p-3 sm:p-4 via `compact`.
//   - Internal gap: gap-3 flex-col.
//
// The four variants collapse into two structural shapes here:
//   - Default: header + body (+ optional footer). Feed/Metric layouts
//     compose inside `children`.
//   - Callout: `centered` prop swaps the body alignment for an empty
//     state or CTA.

interface Props {
  /** Small uppercase kicker above the title. Optional — Identity
   *  variant renders without one. */
  eyebrow?: React.ReactNode;
  /** Main heading. Usually a short noun phrase ("Season stats",
   *  "Player circle"). Renders text-base + font-semibold per the
   *  contract. */
  title?: React.ReactNode;
  /** Right-aligned action slot in the header (button, link, count
   *  chip). Truncates before the title does. */
  action?: React.ReactNode;
  /** Body content. Rendered in text-sm text-ink-secondary. */
  children?: React.ReactNode;
  /** Optional footer row for hint text or a secondary action. */
  footer?: React.ReactNode;
  /** Compact padding (p-3 sm:p-4) for tile-grid children. */
  compact?: boolean;
  /** Callout variant: centers body content. */
  centered?: boolean;
  /** Extra classes to hang on the section root (rare — prefer
   *  keeping the shell uniform). */
  className?: string;
  /** Ref forwarded to the section for scrollIntoView anchors. */
  sectionRef?: React.Ref<HTMLElement>;
  /** DOM id — used by legacy ?tab= deep-links to scroll to a
   *  specific section (Awards, Shouts, Dev Plans). */
  id?: string;
}

const ProfileCard: React.FC<Props> = ({
  eyebrow,
  title,
  action,
  children,
  footer,
  compact,
  centered,
  className,
  sectionRef,
  id,
}) => {
  const pad = compact ? 'p-3 sm:p-4' : 'p-4 sm:p-5';
  const showHeader = !!(eyebrow || title || action);

  return (
    <section
      ref={sectionRef}
      id={id}
      className={[
        'rounded-2xl bg-surface-elevated ring-1 ring-line-default/15',
        pad,
        'flex flex-col gap-3',
        className || '',
      ].join(' ')}
    >
      {showHeader && (
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {eyebrow && (
              <p className="text-[11px] font-black uppercase tracking-widest text-ink-primary/55">
                {eyebrow}
              </p>
            )}
            {title && (
              <h3 className="text-base font-semibold text-ink-primary truncate">
                {title}
              </h3>
            )}
          </div>
          {action && (
            <div className="shrink-0 text-sm font-medium text-brand-primary-soft">
              {action}
            </div>
          )}
        </header>
      )}

      <div
        className={[
          'text-sm text-ink-primary/85 leading-relaxed',
          centered ? 'flex flex-col items-center text-center gap-2' : '',
        ].join(' ')}
      >
        {children}
      </div>

      {footer && (
        <footer className="flex items-center justify-between pt-1 text-xs text-ink-primary/50">
          {footer}
        </footer>
      )}
    </section>
  );
};

export default ProfileCard;
