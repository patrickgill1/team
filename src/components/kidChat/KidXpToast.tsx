// @ts-nocheck
// KidXpToast — the reveal moment for a live coach grant. Watches
// player_xp_events for the active kid; anything with createdAt >
// player.lastSeenXpAt shows a stackable toast with a count-up and
// the coach's reason. Dismiss (auto after 8s or manual) advances
// player.lastSeenXpAt so a returning kid doesn't see the same
// toast twice.
//
// Two review-flagged fixes vs the initial draft (audit 2026-07-11):
//  1. Query is bounded with orderBy('createdAt','desc') + limit(10) +
//     where('createdAt','>',cursor) so a kid with a season of events
//     doesn't pull down 500+ docs per mount.
//  2. Source filter is 'coach_live' ONLY. coach_recognition is a
//     private parent-facing whisper by design; surfacing it as a
//     kid-facing toast would collapse the whole recognition/toast
//     distinction the system was built around.

import React, { useEffect, useRef, useState } from 'react';
import {
  collection,
  doc,
  limit as fsLimit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../../utils/firebase';

interface QueuedEvent {
  id: string;
  xp: number;
  reason: string;
  awardedByName: string;
  createdAtMs: number;
}

interface Props {
  playerId: string;
}

const AUTO_DISMISS_MS = 8000;
const COUNT_UP_MS = 600;

function toMillis(raw: any): number {
  if (!raw) return 0;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw?.toDate === 'function') { try { return raw.toDate().getTime(); } catch { return 0; } }
  if (typeof raw?.seconds === 'number') return raw.seconds * 1000;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') { const d = new Date(raw); return Number.isNaN(d.getTime()) ? 0 : d.getTime(); }
  return 0;
}

const KidXpToast: React.FC<Props> = ({ playerId }) => {
  // Session floor: on first mount we don't want to flash a toast for
  // every historical event before lastSeenXpAt loads. Mount-instant
  // is our floor; the real lastSeenXpAt overrides it once known
  // (only if larger — never regress backward).
  const mountMsRef = useRef<number>(Date.now());
  const [lastSeenMs, setLastSeenMs] = useState<number | null>(null);
  const [queue, setQueue] = useState<QueuedEvent[]>([]);
  const seenIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!playerId) return;
    const unsub = onSnapshot(doc(db, 'players', playerId), (snap) => {
      if (!snap.exists()) { setLastSeenMs(mountMsRef.current); return; }
      const ms = toMillis((snap.data() as any)?.lastSeenXpAt);
      setLastSeenMs(Math.max(ms, mountMsRef.current));
    }, () => setLastSeenMs(mountMsRef.current));
    return () => unsub();
  }, [playerId]);

  useEffect(() => {
    if (!playerId || lastSeenMs === null) return;
    // Server-side bounded query. Without the cursor + orderBy + limit
    // a kid with a season of events would download hundreds of docs
    // per KidDashboard mount just to filter down to 0-3 fresh ones.
    const q = query(
      collection(db, 'player_xp_events'),
      where('playerId', '==', playerId),
      where('createdAt', '>', new Date(lastSeenMs)),
      orderBy('createdAt', 'desc'),
      fsLimit(10),
    );
    const unsub = onSnapshot(q, (snap) => {
      const fresh: QueuedEvent[] = [];
      snap.docs.forEach(d => {
        if (seenIdsRef.current.has(d.id)) return;
        const data: any = d.data();
        // coach_live only — coach_recognition is a private whisper
        // to parents, not a kid-facing celebration. All other sources
        // (auto goal, attendance, streak milestone) fire via badges +
        // wall posts, so no need to double-notify the kid.
        if (data.source !== 'coach_live') return;
        const t = toMillis(data.createdAt);
        if (t <= lastSeenMs) return;
        seenIdsRef.current.add(d.id);
        fresh.push({
          id: d.id,
          xp: Number(data.xp) || 0,
          reason: String(data.note || '').trim(),
          awardedByName: String(data.awardedByName || 'Coach'),
          createdAtMs: t,
        });
      });
      if (fresh.length === 0) return;
      fresh.sort((a, b) => a.createdAtMs - b.createdAtMs);
      setQueue(prev => [...prev, ...fresh]);
    }, err => console.warn('kid xp toast listener failed', err));
    return () => unsub();
  }, [playerId, lastSeenMs]);

  const dismiss = async (eventId: string) => {
    setQueue(prev => prev.filter(q => q.id !== eventId));
    try {
      await updateDoc(doc(db, 'players', playerId), { lastSeenXpAt: serverTimestamp() });
    } catch (err) {
      console.warn('kid xp toast dismiss write failed', err);
    }
  };

  const head = queue[0];
  if (!head) return null;

  return (
    <div className="fixed left-0 right-0 z-[70] flex justify-center px-4" style={{ top: 'calc(env(safe-area-inset-top) + 68px)' }}>
      <XpToastCard key={head.id} event={head} onDismiss={() => dismiss(head.id)} />
    </div>
  );
};

interface CardProps {
  event: QueuedEvent;
  onDismiss: () => void;
}

const XpToastCard: React.FC<CardProps> = ({ event, onDismiss }) => {
  const [displayXp, setDisplayXp] = useState(0);

  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / COUNT_UP_MS);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplayXp(Math.round(event.xp * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [event.xp]);

  useEffect(() => {
    const t = window.setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [onDismiss]);

  return (
    <div className="pointer-events-auto w-full max-w-sm rounded-2xl bg-brand-primary text-white shadow-2xl ring-1 ring-white/20 px-4 py-3 flex items-start gap-3">
      <div className="shrink-0 w-12 h-12 rounded-xl bg-white/15 ring-1 ring-white/25 flex items-center justify-center">
        <span className="text-lg font-black tabular-nums leading-none">+{displayXp}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-widest font-bold text-white/80 leading-none mb-1">XP</p>
        <p className="text-sm font-bold leading-tight truncate">
          {event.awardedByName} gave you {event.xp} XP
        </p>
        {event.reason && (
          <p className="text-[12px] text-white/85 leading-snug mt-0.5 line-clamp-2">{event.reason}</p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 -mt-0.5 -mr-1 w-7 h-7 rounded-full text-white/75 hover:text-white hover:bg-white/15 flex items-center justify-center transition"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
};

export default KidXpToast;
