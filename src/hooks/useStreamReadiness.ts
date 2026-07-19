// useStreamReadiness — polls /api/stream-status until a Cloudflare Stream
// video finishes transcoding, so callers can gate iframe mount on the
// switch instead of racing the SDK against CF's pre-ready CORS window.
//
// See /api/stream-status.mjs for the "why" — CF's manifest endpoint
// returns 500 without Access-Control-Allow-Origin between "bytes
// accepted" and "transcode registered", which the browser reports as a
// CORS error and which leaves the iframe stuck on a broken player.
//
// Contract:
//   - Empty / undefined uid → { ready: true, isPolling: false }.
//     Callers can render photos or non-Stream videos through the same
//     component without a special case.
//   - `initialReady: true` → { ready: true, isPolling: false } with no
//     network call. Any doc already stamped with streamReady:true skips
//     the poll (backwards-compat with existing 51 videos).
//   - Otherwise: polls every 3s up to 40 tries (2 minutes). On any
//     successful poll returning ready:true, stops and reports ready.
//   - If the 40-poll ceiling is hit without ready, reports
//     { ready: false, isPolling: false, timedOut: true }. Callers can
//     surface a "still processing, refresh in a bit" hint.
//   - Unmount / uid change / initialReady flip all abort the loop.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getStreamStatus } from '../utils/streamUpload';

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 40; // 2 minutes total

export interface UseStreamReadinessOptions {
  /** When true, skip polling entirely — the caller already knows the
   *  video is ready (either from a persisted `streamReady:true` on the
   *  doc, or because they just watched a peer poll flip). */
  initialReady?: boolean;
  /** Called exactly once, the moment readiness flips true via polling.
   *  NOT called when `initialReady:true` short-circuits (there was no
   *  transition to observe). Use for "stamp streamReady:true on the
   *  Firestore doc so future viewers skip the poll." */
  onReady?: () => void;
  /** Set true to skip all work — useful when the caller is inside a
   *  collapsed accordion / non-visible tab and doesn't want to burn
   *  polls. Flipping back to false resumes. */
  paused?: boolean;
}

export interface UseStreamReadinessReturn {
  ready: boolean;
  pctComplete: number;
  isPolling: boolean;
  timedOut: boolean;
}

export function useStreamReadiness(
  uid: string | undefined | null,
  opts: UseStreamReadinessOptions = {}
): UseStreamReadinessReturn {
  const { initialReady = false, onReady, paused = false } = opts;

  const [ready, setReady] = useState<boolean>(initialReady || !uid);
  const [pctComplete, setPctComplete] = useState<number>(initialReady || !uid ? 100 : 0);
  const [isPolling, setIsPolling] = useState<boolean>(false);
  const [timedOut, setTimedOut] = useState<boolean>(false);

  // Keep the latest onReady in a ref so we don't retrigger the effect
  // when the parent re-renders with a fresh inline callback.
  const onReadyRef = useRef<(() => void) | undefined>(onReady);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);

  useEffect(() => {
    // Short-circuits: no uid → treat as ready (photo, YouTube, etc.).
    // initialReady → no work; caller already knows.
    if (!uid) {
      setReady(true);
      setPctComplete(100);
      setIsPolling(false);
      setTimedOut(false);
      return;
    }
    if (initialReady) {
      setReady(true);
      setPctComplete(100);
      setIsPolling(false);
      setTimedOut(false);
      return;
    }
    if (paused) {
      setIsPolling(false);
      return;
    }

    let cancelled = false;
    let pollCount = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    setReady(false);
    setPctComplete(0);
    setIsPolling(true);
    setTimedOut(false);

    const tick = async () => {
      if (cancelled) return;
      pollCount += 1;
      try {
        const status = await getStreamStatus(uid);
        if (cancelled) return;
        if (typeof status.pctComplete === 'number') {
          setPctComplete(status.pctComplete);
        }
        if (status.ready) {
          setReady(true);
          setPctComplete(100);
          setIsPolling(false);
          try { onReadyRef.current?.(); } catch (err) { console.warn('useStreamReadiness onReady threw', err); }
          return;
        }
      } catch (err) {
        // Transient network / auth error. Keep polling — the ceiling
        // will bail us out. Log once per failure so we're not silent if
        // the endpoint is misbehaving.
        console.warn('[useStreamReadiness] status poll failed', err);
      }
      if (cancelled) return;
      if (pollCount >= MAX_POLLS) {
        setIsPolling(false);
        setTimedOut(true);
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    // Kick off immediately — for uploads that finished transcoding fast
    // (short clips), the first poll often returns ready and we skip the
    // Processing card entirely.
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [uid, initialReady, paused]);

  // Stable ready/state for callers.
  return { ready, pctComplete, isPolling, timedOut };
}

/** Client-side helper wired up by callers that want to stamp the
 *  persisted `streamReady:true` marker on a Firestore doc so future
 *  viewers skip the polling round-trip. Pulled out so a doc-write
 *  failure never crashes the render path. */
export function makeStampStreamReady(
  patchDoc: (patch: { streamReady: true; streamReadyAt: Date }) => Promise<void> | void
): () => void {
  let fired = false;
  return () => {
    if (fired) return;
    fired = true;
    try {
      const result = patchDoc({ streamReady: true, streamReadyAt: new Date() });
      if (result && typeof (result as any).catch === 'function') {
        (result as Promise<void>).catch((err) => {
          console.warn('stamp streamReady failed', err);
        });
      }
    } catch (err) {
      console.warn('stamp streamReady threw', err);
    }
  };
}
