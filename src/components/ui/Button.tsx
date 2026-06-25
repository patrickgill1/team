// @ts-nocheck
import React from 'react';

/**
 * Primitive button. Locks the visual vocabulary so every CTA across
 * the app renders consistently without each call site rewriting the
 * Tailwind soup.
 *
 * Variants ↓
 *   primary  — crimson filled. The main CTA (Save, Send, Create, Subscribe).
 *   outline  — ring-only, transparent bg. Secondary action next to a primary.
 *   ghost    — text only, no border. Tertiary: Cancel, Dismiss, dismiss links.
 *   danger   — rose/crimson filled. Destructive (Delete, Cancel team).
 *   success  — emerald filled. Confirmations (Mark complete, Accept).
 *
 * Sizes ↓
 *   sm — 12px text, py-1.5 (chips, dense lists)
 *   md — 14px text, py-2  (default)
 *   lg — 15px text, py-3  (hero CTAs, primary modal actions)
 *
 * Other props ↓
 *   loading    — disables + shows spinner, keeps width stable
 *   fullWidth  — block-level
 *   leftIcon / rightIcon — slots for icon nodes
 *
 * Migration note: prefer `<Button>` to ad-hoc Tailwind classes. New
 * features should never reach for `bg-crimson-600` directly when a
 * variant exists.
 */

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface Props extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  children?: React.ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-crimson-600 hover:bg-crimson-500 text-white shadow-lg shadow-crimson-900/30 ' +
    'disabled:bg-crimson-900 disabled:text-white/55 disabled:shadow-none',
  outline:
    'bg-transparent ring-1 ring-white/15 text-bone hover:bg-white/5 hover:ring-white/30 ' +
    'disabled:opacity-40',
  ghost:
    'bg-transparent text-bone/70 hover:text-bone hover:bg-white/5 ' +
    'disabled:opacity-40',
  danger:
    'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-900/30 ' +
    'disabled:bg-rose-900 disabled:text-white/55 disabled:shadow-none',
  success:
    'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/30 ' +
    'disabled:bg-emerald-900 disabled:text-white/55 disabled:shadow-none',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md gap-1.5',
  md: 'text-sm font-bold px-4 py-2 rounded-lg gap-2',
  lg: 'text-[15px] font-bold px-5 py-3 rounded-xl gap-2',
};

const Spinner: React.FC<{ className?: string }> = ({ className }) => (
  <span
    className={`inline-block animate-spin rounded-full border-2 border-current border-r-transparent ${className || ''}`}
    aria-hidden
  />
);

const SPINNER_SIZE: Record<ButtonSize, string> = {
  sm: 'h-3 w-3',
  md: 'h-3.5 w-3.5',
  lg: 'h-4 w-4',
};

const Button = React.forwardRef<HTMLButtonElement, Props>(
  ({
    variant = 'primary',
    size = 'md',
    loading = false,
    fullWidth = false,
    leftIcon,
    rightIcon,
    disabled,
    children,
    className,
    type = 'button',
    ...rest
  }, ref) => {
    const isDisabled = disabled || loading;
    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        className={[
          'inline-flex items-center justify-center transition-colors select-none',
          'disabled:cursor-not-allowed',
          fullWidth ? 'w-full' : '',
          SIZES[size],
          VARIANTS[variant],
          className || '',
        ].filter(Boolean).join(' ')}
        {...rest}
      >
        {loading ? (
          <Spinner className={SPINNER_SIZE[size]} />
        ) : leftIcon ? (
          <span className="inline-flex shrink-0">{leftIcon}</span>
        ) : null}
        {children && <span className={loading ? 'opacity-70' : ''}>{children}</span>}
        {!loading && rightIcon && (
          <span className="inline-flex shrink-0">{rightIcon}</span>
        )}
      </button>
    );
  },
);

Button.displayName = 'Button';
export default Button;
