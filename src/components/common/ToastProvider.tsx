import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Unified toast + undo surface. Replaces the fragmented feedback
// pattern where some actions used window.alert(), some rendered
// inline banners, and some were silent. Every action can now confirm
// itself with a single call:
//
//   const toast = useToast();
//   toast.success('Kudos sent');
//   toast.error("Couldn't save. Try again.");
//   toast.undo('Comment deleted', { onUndo: () => restore() });
//
// Destructive ops that expose onUndo actually DEFER the write for
// the toast's lifetime — the caller passes a `commit` fn that only
// fires if the toast dismisses without the user tapping Undo.
// Prevents accidental deletes without needing a confirm dialog for
// every one-off action (kudos delete, comment delete, message
// delete). Undo pattern mirrors Gmail / Slack / iMessage.

type ToastKind = 'success' | 'error' | 'info';
const DEFAULT_MS = 4000;
const ACTION_MS = 6000;

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  kind?: ToastKind;
  durationMs?: number;
  action?: ToastAction;
}

/** Deferred-commit shape: pass an onUndo to expose Undo AND a commit
 *  fn that only fires if the toast dismisses without tapping Undo.
 *  Caller doesn't have to sequence anything — just wire the two. */
export interface UndoOptions {
  /** Undo label. Defaults to "Undo". */
  label?: string;
  /** Runs when the toast auto-dismisses without the user tapping
   *  Undo. This is where you actually run the destructive write. */
  commit: () => void | Promise<void>;
  /** Runs when the user taps Undo — usually a state restore. Never
   *  runs in the same lifetime as commit. */
  onUndo: () => void;
  /** How long the user has to hit Undo before commit fires. */
  durationMs?: number;
}

interface ToastEntry {
  id: number;
  message: string;
  kind: ToastKind;
  durationMs: number;
  action?: ToastAction;
  /** Set when the toast is deferred-commit (undo pattern). Held
   *  here so the timer can fire commit() OR the tap can cancel it. */
  commit?: () => void | Promise<void>;
}

interface ToastApi {
  success: (message: string, opts?: Omit<ToastOptions, 'kind'>) => void;
  error: (message: string, opts?: Omit<ToastOptions, 'kind'>) => void;
  info: (message: string, opts?: Omit<ToastOptions, 'kind'>) => void;
  /** Fires an action toast — same as info() but expects an action. */
  action: (message: string, action: ToastAction, opts?: Omit<ToastOptions, 'kind' | 'action'>) => void;
  /** Deferred-commit undo pattern. The write only lands if the toast
   *  auto-dismisses. If the user hits Undo, commit never runs and
   *  onUndo fires instead. Returns a manual dismiss fn if the caller
   *  needs to close the toast early (e.g., navigation). */
  undo: (message: string, opts: UndoOptions) => () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let idSeq = 1;

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [entries, setEntries] = useState<ToastEntry[]>([]);
  // Track timers per-id so we can cancel on Undo.
  const timers = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number, runCommit: boolean) => {
    setEntries((prev) => {
      const entry = prev.find((e) => e.id === id);
      if (!prev.some((e) => e.id === id)) return prev;
      // Fire commit on auto-dismiss for undo-pattern toasts. If the
      // user tapped Undo, runCommit is false and the write is dropped.
      if (runCommit && entry?.commit) {
        try { void entry.commit(); } catch (err) { console.warn('[toast] commit threw', err); }
      }
      const t = timers.current.get(id);
      if (t) { window.clearTimeout(t); timers.current.delete(id); }
      return prev.filter((e) => e.id !== id);
    });
  }, []);

  const push = useCallback((entry: Omit<ToastEntry, 'id'>) => {
    const id = idSeq++;
    setEntries((prev) => [...prev, { ...entry, id }]);
    const t = window.setTimeout(() => dismiss(id, true), entry.durationMs);
    timers.current.set(id, t);
    return id;
  }, [dismiss]);

  const api = useRef<ToastApi>({
    success: (message, opts) => { push({ message, kind: 'success', durationMs: opts?.durationMs ?? DEFAULT_MS, action: opts?.action }); },
    error: (message, opts) => { push({ message, kind: 'error', durationMs: opts?.durationMs ?? DEFAULT_MS, action: opts?.action }); },
    info: (message, opts) => { push({ message, kind: 'info', durationMs: opts?.durationMs ?? DEFAULT_MS, action: opts?.action }); },
    action: (message, action, opts) => { push({ message, kind: 'info', durationMs: opts?.durationMs ?? ACTION_MS, action }); },
    undo: (message, opts) => {
      const id = push({
        message,
        kind: 'info',
        durationMs: opts.durationMs ?? ACTION_MS,
        action: {
          label: opts.label ?? 'Undo',
          onClick: () => {
            try { opts.onUndo(); } catch (err) { console.warn('[toast] onUndo threw', err); }
            dismiss(id, false);
          },
        },
        commit: opts.commit,
      });
      return () => dismiss(id, false);
    },
  });

  useEffect(() => {
    return () => {
      // Clear pending timers on provider unmount. Don't fire commits —
      // provider unmount = app teardown, all writes should be dropped.
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current.clear();
    };
  }, []);

  if (typeof document === 'undefined') {
    return <ToastContext.Provider value={api.current}>{children}</ToastContext.Provider>;
  }

  return (
    <ToastContext.Provider value={api.current}>
      {children}
      {createPortal(
        <div
          className="fixed inset-x-0 bottom-0 z-[95] pointer-events-none flex flex-col items-center gap-2 pb-4"
          style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
          aria-live="polite"
          aria-atomic="false"
        >
          {entries.map((entry) => (
            <ToastRow key={entry.id} entry={entry} onDismiss={() => dismiss(entry.id, true)} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
};

const ToastRow: React.FC<{ entry: ToastEntry; onDismiss: () => void }> = ({ entry, onDismiss }) => {
  const accent =
    entry.kind === 'success' ? 'ring-emerald-500/40 text-emerald-300' /* theme-ok: semantic success accent */
    : entry.kind === 'error' ? 'ring-brand-primary-soft/50 text-brand-primary'
    : 'ring-line-default/20 text-ink-primary/80';
  return (
    <div
      className={`pointer-events-auto max-w-sm w-[92%] sm:w-auto bg-surface-elevated ring-1 ${accent} shadow-2xl rounded-2xl px-4 py-2.5 flex items-center gap-3 animate-slide-up`}
      role="status"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink-primary leading-snug truncate">{entry.message}</p>
      </div>
      {entry.action && (
        <button
          type="button"
          onClick={entry.action.onClick}
          className="shrink-0 text-xs font-black uppercase tracking-widest text-brand-primary hover:text-brand-primary-soft transition"
        >
          {entry.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-ink-primary/50 hover:text-ink-primary hover:bg-line-default/10 transition"
        aria-label="Dismiss"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
};

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Graceful fallback: if the provider isn't mounted (tests, early
    // boot), degrade to no-op success / error paths that log so the
    // caller sees SOMETHING in the console instead of a silent miss.
    // Undo returns a no-op dismiss + fires commit immediately so
    // destructive writes still happen if a caller uses the API
    // before mount.
    return {
      success: (m) => console.info('[toast]', m),
      error: (m) => console.warn('[toast:error]', m),
      info: (m) => console.info('[toast]', m),
      action: (m) => console.info('[toast]', m),
      undo: (m, opts) => { try { void opts.commit(); } catch { /* ignore */ } return () => {}; },
    };
  }
  return ctx;
}
