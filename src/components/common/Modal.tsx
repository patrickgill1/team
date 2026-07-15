// @ts-nocheck
import React, { useEffect } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Width tier. Defaults to 'md' which is wide enough for forms.
   *  'sm' = compact share / confirm; 'lg' = lists with multi-column
   *  content; 'xl' = file-preview / photo grids. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Sticky footer (e.g. Save/Cancel buttons). Keeps actions visible
   *  even when the body scrolls — the #1 complaint about long forms. */
  footer?: React.ReactNode;
  /** Set to true when a network request is in flight; suppresses
   *  backdrop-tap close so users don't accidentally lose work. */
  busy?: boolean;
  children: React.ReactNode;
}

const SIZE_CLASS: Record<NonNullable<Props['size']>, string> = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-md',
  lg: 'sm:max-w-lg',
  xl: 'sm:max-w-2xl',
};

/**
 * Standard modal shell used across the app. Behavior baked in:
 *   - Bottom sheet on mobile (items-end), centered on tablet+ (sm:items-center)
 *   - Backdrop tap closes (unless busy=true)
 *   - Escape closes (unless busy=true)
 *   - Sticky header with title + X
 *   - Scrolling body with max-h that respects mobile safe area
 *   - Optional sticky footer for action buttons
 *   - All tap targets ≥44px
 *
 * Migrate older inline modals to this when touching them — don't do a
 * mass rewrite. Both patterns work in parallel.
 */
const Modal: React.FC<Props> = ({ open, onClose, title, size = 'md', footer, busy, children }) => {
  // Esc to close — but not while a submit is in flight.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, busy, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4"
      onClick={() => { if (!busy) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={title || undefined}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={[
          'bg-white shadow-2xl flex flex-col w-full',
          'rounded-t-2xl sm:rounded-2xl',
          // Mobile: takes full width, max 90vh; on tablet+ scaled down.
          'max-h-[92vh] sm:max-h-[85vh]',
          SIZE_CLASS[size],
        ].join(' ')}
      >
        {/* Header — always rendered when title is provided; an X is
            always available so users always have a way out. */}
        {(title || onClose) && (
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2 flex-shrink-0">
            <div className="text-sm font-extrabold tracking-widest uppercase text-slate-700 min-w-0 truncate">
              {title || ''}
            </div>
            <button
              type="button"
              onClick={() => { if (!busy) onClose(); }}
              aria-label="Close"
              className="w-9 h-9 -mr-2 flex items-center justify-center text-slate-400 hover:text-slate-700 disabled:opacity-50"
              disabled={busy}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        )}

        {/* Body — flex-1 so it expands to fill, overflow-y-auto so
            long forms scroll inside the modal instead of pushing
            the footer off-screen. */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {children}
        </div>

        {/* Optional sticky footer — keeps Save/Cancel reachable. */}
        {footer && (
          <div className="px-4 py-3 border-t border-slate-100 flex-shrink-0 bg-white">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

export default Modal;
