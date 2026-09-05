import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Themed confirm dialog. Replaces window.confirm() so destructive
// actions read as intentional GoalKickr UI, not a jarring native
// browser alert. Drop-in async API:
//
//   const confirm = useConfirm();
//   if (!(await confirm({ body: 'Delete this photo?' }))) return;
//
// For truly destructive ops (delete team wholesale, cancel
// subscription), pass `destructive: true` — the primary button
// flips to brand-primary red to signal weight. Optional
// `requireTypedText` (e.g. team name) makes the confirm button
// stay disabled until the user types the exact string, matching
// the "type this repo name to delete" pattern GitHub uses.

export interface ConfirmOptions {
  title?: string;
  body: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
  /** When set, the confirm button stays disabled until the user
   *  types this exact string (case-insensitive). For irreversible
   *  ops where a mis-tap would be catastrophic. */
  requireTypedText?: string;
}

type ConfirmResolver = (ok: boolean) => void;

interface ConfirmState extends ConfirmOptions {
  resolve: ConfirmResolver;
}

const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<ConfirmState | null>(null);
  const [typed, setTyped] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setTyped('');
      setState({ ...opts, resolve });
      // Auto-focus the required-text input on next tick so
      // typing works without an extra tap.
      if (opts.requireTypedText) {
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    if (!state) return;
    const r = state.resolve;
    setState(null);
    setTyped('');
    r(ok);
  }, [state]);

  // Keyboard: esc cancels; enter confirms (unless required-text
  // guard blocks). Attached on the dialog root, not window, so
  // background esc-listeners in the app don't fight.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(false); }
    else if (e.key === 'Enter' && !e.shiftKey) {
      const required = state?.requireTypedText || '';
      if (required && typed.trim().toLowerCase() !== required.toLowerCase()) return;
      e.stopPropagation();
      close(true);
    }
  };

  const canConfirm = !state?.requireTypedText
    || typed.trim().toLowerCase() === state.requireTypedText.toLowerCase();

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {state && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in p-4" /* theme-ok: modal backdrop */
          role="dialog"
          aria-modal="true"
          onClick={() => close(false)}
          onKeyDown={onKeyDown}
          tabIndex={-1}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-surface-elevated rounded-2xl ring-1 ring-line-default/15 shadow-2xl overflow-hidden animate-slide-up"
          >
            <div className="px-5 pt-5 pb-4">
              {state.title && (
                <h2 className="text-base font-black text-ink-primary leading-tight mb-1.5">
                  {state.title}
                </h2>
              )}
              <p className="text-sm text-ink-primary/80 leading-snug whitespace-pre-wrap">
                {state.body}
              </p>
              {state.requireTypedText && (
                <div className="mt-3">
                  <label className="block text-[10px] font-black uppercase tracking-widest text-ink-primary/55 mb-1">
                    Type <span className="text-ink-primary">{state.requireTypedText}</span> to confirm
                  </label>
                  <input
                    ref={inputRef}
                    type="text"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-surface-base ring-1 ring-line-default/20 text-ink-primary placeholder:text-ink-primary/40 outline-none focus:ring-brand-primary-soft text-sm"
                    placeholder={state.requireTypedText}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
              )}
            </div>
            <div className="px-4 pb-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => close(false)}
                className="px-4 py-2 rounded-full text-sm font-bold text-ink-primary/70 hover:bg-line-default/[0.05] transition"
              >
                {state.cancelText || 'Cancel'}
              </button>
              <button
                type="button"
                onClick={() => close(true)}
                disabled={!canConfirm}
                className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-bold transition disabled:opacity-40 disabled:cursor-not-allowed ${
                  state.destructive
                    ? 'bg-brand-primary text-white hover:bg-brand-primary/90 shadow-sm' /* theme-ok: destructive CTA is brand red in both themes */
                    : 'bg-ink-primary text-surface-elevated hover:bg-ink-primary/90'
                }`}
              >
                {state.confirmText || (state.destructive ? 'Delete' : 'Confirm')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </ConfirmContext.Provider>
  );
};

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    // Graceful fallback: if the provider isn't mounted (e.g. tests,
    // early boot), fall back to window.confirm so the app still
    // works instead of crashing.
    return (opts: ConfirmOptions) => Promise.resolve(
      typeof window !== 'undefined'
        ? window.confirm(opts.title ? `${opts.title}\n\n${opts.body}` : opts.body)
        : true,
    );
  }
  return ctx;
}
