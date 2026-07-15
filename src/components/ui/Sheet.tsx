// @ts-nocheck
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import Button from './Button';

/**
 * Sheet — the unified modal/sheet primitive. Renders as a bottom
 * sheet on mobile (slides up from the bottom), as a centered card
 * on tablet/desktop (fades in). Single primitive replaces the
 * TrialGateModal / TierPickerSheet / InvitePersonModal / etc.
 * one-off sheet shells scattered across the app.
 *
 * Owns:
 *   - Backdrop with click-to-dismiss
 *   - Portal to document.body
 *   - Escape key to dismiss
 *   - Body scroll lock while open
 *   - Slide-up (mobile) / fade-in (desktop) animation
 *   - Optional header (kicker + title + close button)
 *   - Optional footer slot (action button row)
 *
 * Pattern at call sites:
 *
 *   <Sheet
 *     open={picker}
 *     onClose={() => setPicker(false)}
 *     kicker="Pick a plan"
 *     title="What are you running?"
 *     footer={
 *       <>
 *         <Button variant="ghost" onClick={() => setPicker(false)}>Cancel</Button>
 *         <Button variant="primary" onClick={confirm}>Continue</Button>
 *       </>
 *     }
 *   >
 *     <p>...body content...</p>
 *   </Sheet>
 *
 * Apple-safe: the `onClose` always fires on backdrop/escape so the
 * user can dismiss without going through an action button.
 */

export type SheetSize = 'sm' | 'md' | 'lg';
export type SheetPosition = 'auto' | 'bottom' | 'center' | 'fullscreen';

interface Props {
  /** Controlled open state. */
  open: boolean;
  /** Fires when the user dismisses (backdrop, ESC, or X). */
  onClose: () => void;
  /** Optional small uppercase kicker label above the title. */
  kicker?: string;
  /** Optional bold title shown across the top. */
  title?: string;
  /** Optional one-line subtitle below the title. */
  subtitle?: string;
  /** Optional footer slot — typically a Button or two. */
  footer?: React.ReactNode;
  /** Max width tier. Defaults to 'md' (28rem). */
  size?: SheetSize;
  /** Layout. 'auto' picks bottom on mobile + center on desktop. */
  position?: SheetPosition;
  /** Hide the X close button in the header. Defaults to false. */
  hideCloseButton?: boolean;
  /** Tag included in any analytics / logging hook (future). */
  label?: string;
  children?: React.ReactNode;
}

const SIZE_CLASS: Record<SheetSize, string> = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-md',
  lg: 'sm:max-w-lg',
};

const POSITION_CLASS: Record<SheetPosition, string> = {
  auto:       'items-end sm:items-center',
  bottom:     'items-end',
  center:     'items-center',
  fullscreen: 'items-stretch',
};

const PANEL_CLASS: Record<SheetPosition, string> = {
  auto:       'rounded-t-2xl sm:rounded-2xl',
  bottom:     'rounded-t-2xl',
  center:     'rounded-2xl',
  fullscreen: '',
};

const Sheet: React.FC<Props> = ({
  open,
  onClose,
  kicker,
  title,
  subtitle,
  footer,
  size = 'md',
  position = 'auto',
  hideCloseButton = false,
  children,
}) => {
  // ESC to dismiss
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Body scroll lock — prevents the page behind from scrolling while
  // the sheet is open. Restores prior overflow on close.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const hasHeader = !!(kicker || title || !hideCloseButton);

  return createPortal(
    <div
      className={`fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex justify-center p-0 sm:p-4 animate-fade-in ${POSITION_CLASS[position]}`}
      onClick={onClose}
      aria-modal
      role="dialog"
    >
      <div
        className={[
          'bg-surface-elevated ring-1 ring-line-default/10 shadow-2xl flex flex-col w-full',
          'animate-sheet-up sm:animate-pop-in',
          SIZE_CLASS[size],
          PANEL_CLASS[position],
          position === 'fullscreen' ? 'h-full' : 'max-h-[92vh] sm:max-h-[85vh]',
        ].filter(Boolean).join(' ')}
        onClick={(e) => e.stopPropagation()}
      >
        {hasHeader && (
          <div className="px-5 sm:px-6 pt-5 sm:pt-6 pb-3 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              {kicker && (
                <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-1.5">
                  {kicker}
                </p>
              )}
              {title && (
                <h3 className="text-ink-primary text-lg sm:text-xl font-bold leading-tight">{title}</h3>
              )}
              {subtitle && (
                <p className="text-ink-primary/65 text-sm mt-2 leading-snug">{subtitle}</p>
              )}
            </div>
            {!hideCloseButton && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="shrink-0 -mt-1 -mr-1 w-8 h-8 rounded-full text-ink-primary/55 hover:text-ink-primary hover:bg-line-default/5 flex items-center justify-center transition"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        )}

        <div className="px-5 sm:px-6 py-2 sm:py-3 overflow-y-auto flex-1">
          {children}
        </div>

        {footer && (
          <div className="px-5 sm:px-6 py-4 border-t border-line-default/5 flex items-center justify-end gap-2 flex-wrap">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default Sheet;
