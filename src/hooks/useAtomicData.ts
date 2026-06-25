// @ts-nocheck
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Atomic data-loading contract. Returns one of three stable states
 * — loading / ready / error — so consumers never render partial /
 * default state during the in-flight window.
 *
 * Pairs with <DataGate> which renders nothing during loading (or a
 * gentle progress hint after a delay) and fades data in once ready.
 * The hook + gate together encode Patrick's atomic-render rule
 * (memory: feedback_atomic_render_over_skeletons) so future surfaces
 * inherit the behavior structurally instead of remembering to
 * implement it per-page.
 *
 * Usage:
 *   const { state, data, error, reload } = useAtomicData(async () => {
 *     const snap = await getDocs(...);
 *     return snap.docs.map(d => d.data());
 *   }, [teamId]);
 *
 *   return (
 *     <DataGate when={state} error={error} reload={reload}>
 *       <YourSurface data={data} />
 *     </DataGate>
 *   );
 */

export type AtomicState = 'loading' | 'ready' | 'error';

export interface AtomicResult<T> {
  state: AtomicState;
  data: T | null;
  error: Error | null;
  reload: () => void;
}

export function useAtomicData<T>(
  loader: () => Promise<T>,
  deps: any[] = [],
): AtomicResult<T> {
  const [state, setState] = useState<AtomicState>('loading');
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // reload increment forces a refetch without changing the user's deps
  const [reloadKey, setReloadKey] = useState(0);
  // Latest-wins guard — when deps change quickly, prior in-flight
  // loads shouldn't clobber the current one on resolve.
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    setState('loading');
    setError(null);
    let cancelled = false;
    (async () => {
      try {
        const result = await loader();
        if (cancelled || seq !== seqRef.current) return;
        setData(result);
        setError(null);
        setState('ready');
      } catch (err: any) {
        if (cancelled || seq !== seqRef.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setState('error');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadKey]);

  const reload = useCallback(() => setReloadKey(k => k + 1), []);
  return { state, data, error, reload };
}

/**
 * Helper for surfaces that depend on multiple async sources. Combines
 * their states into a single AtomicState — 'loading' if any are
 * loading, 'error' if any errored, 'ready' if all are ready.
 *
 *   const subs = useSubscription();
 *   const team = useAtomicData(...);
 *   const combined = combineAtomicStates(
 *     subs.loading ? 'loading' : 'ready',
 *     team.state,
 *   );
 */
export function combineAtomicStates(...states: AtomicState[]): AtomicState {
  if (states.some(s => s === 'error')) return 'error';
  if (states.some(s => s === 'loading')) return 'loading';
  return 'ready';
}
