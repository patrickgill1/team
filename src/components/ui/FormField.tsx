// @ts-nocheck
import React from 'react';

/**
 * FormField — the labeled-input wrapper. Owns the label / hint /
 * error structure that every form in the app re-declares. Use it
 * around any <input>, <textarea>, <select>, or even a custom
 * control via render-prop children.
 *
 * Pattern:
 *
 *   <FormField label="Team name" hint="You can change this later">
 *     <input
 *       value={name}
 *       onChange={e => setName(e.target.value)}
 *       className={fieldInputClass}
 *     />
 *   </FormField>
 *
 * For consistent input styling, use `fieldInputClass` (exported
 * below) on the inner input. Drops the dozens of one-off
 * `className="mt-1 w-full rounded-md bg-surface-base ring-1..."`
 * declarations.
 */

interface Props {
  /** Small uppercase label shown above the field. Pass empty to omit. */
  label?: string;
  /** Optional one-line subtitle under the label (e.g., usage hint). */
  hint?: string;
  /** Optional error message shown below the field in rose. */
  error?: string | null;
  /** When true, append a small '(optional)' tag after the label. */
  optional?: boolean;
  /** When true, append a red asterisk after the label. */
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

/** Shared input className. Apply to any <input>/<textarea>/<select>
 *  inside a FormField for the canonical look + focus state. */
export const fieldInputClass =
  'mt-1 w-full rounded-md bg-surface-base ring-1 ring-line-default/10 ' +
  'focus:ring-2 focus:ring-brand-primary focus:outline-none ' +
  'px-3 py-2.5 text-ink-primary placeholder-charcoal-500 text-sm ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

const FormField: React.FC<Props> = ({
  label,
  hint,
  error,
  optional,
  required,
  className,
  children,
}) => (
  <label className={`block ${className || ''}`}>
    {(label || hint) && (
      <div className="mb-0.5">
        {label && (
          <span className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/55">
            {label}
            {required && <span className="text-brand-primary-soft ml-0.5" aria-hidden>*</span>}
            {optional && <span className="text-ink-primary/35 ml-1.5 normal-case font-normal tracking-normal">(optional)</span>}
          </span>
        )}
        {hint && (
          <p className="text-[11px] text-ink-primary/45 leading-snug mt-0.5">{hint}</p>
        )}
      </div>
    )}
    {children}
    {error && (
      <p className="text-[11px] text-rose-600 dark:text-rose-300 mt-1.5 leading-snug">{error}</p>
    )}
  </label>
);

export default FormField;
