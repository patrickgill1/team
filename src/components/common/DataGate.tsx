// @ts-nocheck
import React, { useEffect, useState } from 'react';
import type { AtomicState } from '../../hooks/useAtomicData';

interface Props {
  /** Combined state from useAtomicData (or combineAtomicStates). */
  when: AtomicState;
  /** Optional error to show on the error card. */
  error?: Error | null;
  /** Optional retry callback wired to the error card's Try-again button. */
  reload?: () => void;
  /** Skip the in-page error UI and silently render nothing on error.
   *  Use for tertiary surfaces where an error shouldn't show a card. */
  silentError?: boolean;
  /** How long to wait before showing a progress hint during loading.
   *  Default: 400ms — matches the atomic-render memory rule (empty
   *  silence first, gentle progress hint, then atomic fade-in). */
  progressDelayMs?: number;
  /** Optional class applied to the wrapper that animates content in. */
  className?: string;
  /** Optional — surface contents to show when ready. When omitted,
   *  DataGate is just a loading/error indicator (use as a standalone
   *  placeholder). */
  children?: React.ReactNode;
}

/**
 * Atomic-render gate. Renders nothing while loading (or a quiet
 * progress hint after `progressDelayMs`), atomically fades in
 * children once ready, and shows an inline error card on failure.
 *
 * Mirrors Apple/Linear/Notion's load discipline: empty -> hint ->
 * content, never partial state. See memory:
 *   feedback_atomic_render_over_skeletons.
 */
const DataGate: React.FC<Props> = ({
  when,
  error,
  reload,
  silentError,
  progressDelayMs = 400,
  className,
  children,
}) => {
  const [showProgress, setShowProgress] = useState(false);

  useEffect(() => {
    if (when !== 'loading') { setShowProgress(false); return; }
    const t = window.setTimeout(() => setShowProgress(true), progressDelayMs);
    return () => window.clearTimeout(t);
  }, [when, progressDelayMs]);

  if (when === 'loading') {
    if (!showProgress) return null;
    return (
      <div className="flex items-center justify-center py-6">
        <div className="h-1 w-32 bg-white/[0.06] overflow-hidden rounded-full">
          <div className="h-full w-1/3 bg-brand-primary/70 animate-progress-slide" />
        </div>
      </div>
    );
  }

  if (when === 'error') {
    if (silentError) return null;
    return (
      <div className="rounded-2xl bg-charcoal-900 ring-1 ring-amber-500/30 p-5 text-center">
        <p className="text-bone/85 font-semibold mb-1">Couldn&apos;t load this</p>
        <p className="text-bone/55 text-sm mb-4">{error?.message || 'Something went wrong fetching the data.'}</p>
        {reload && (
          <button
            type="button"
            onClick={reload}
            className="text-[11px] font-extrabold tracking-widest uppercase text-brand-primary-soft hover:text-bone"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  // Ready: atomic fade-in. animate-fade-in is already defined in
  // tailwind.config — same animation used elsewhere for poster /
  // chat / etc atomic landings.
  return (
    <div className={`animate-fade-in ${className || ''}`}>
      {children}
    </div>
  );
};

export default DataGate;
