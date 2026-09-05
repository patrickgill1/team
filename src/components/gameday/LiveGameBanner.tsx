import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { collection, doc, onSnapshot, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useTeam } from '../../contexts/TeamContext';
import { clearWatchGameSession } from '../../utils/watchGameBridge';
import { useConfirm } from '../common/ConfirmDialog';

/**
 * Persistent "there's a live game running" banner. Sticks to the top
 * of the page shell whenever the selected team has an active
 * live_games doc. Tap navigates back to GameDay for that event; the
 * small × dismisses the zombie by force-ending it.
 *
 * Zombie protection (2026-07-01): banner picks the FRESHEST live
 * game (max updatedAt) and ignores anything last-touched more than 6
 * hours ago. Without this, an abandoned test game from a week ago
 * kept surfacing with a 37-hour clock, since Firestore returned
 * whichever doc it felt like from the multi-match query.
 */

const ZOMBIE_CUTOFF_HOURS = 6;

interface LiveRow {
  eventId: string;
  ourScore: number;
  oppScore: number;
  opponent: string;
  clockSecondsAtStart?: number;
  clockOffsetSeconds?: number;
  period?: 1 | 2 | 'OT';
  updatedAtMs: number;
}

const formatClock = (secs: number): string => {
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
};

const extractUpdatedAtMs = (data: any): number => {
  const u = data?.updatedAt;
  if (!u) return 0;
  if (typeof u.toMillis === 'function') return u.toMillis();
  if (typeof u.seconds === 'number') return u.seconds * 1000;
  if (u instanceof Date) return u.getTime();
  if (typeof u === 'number') return u;
  return 0;
};

const LiveGameBanner: React.FC = () => {
  const { selectedTeamId } = useTeam();
  const navigate = useNavigate();
  const location = useLocation();
  const [live, setLive] = useState<LiveRow | null>(null);
  const [now, setNow] = useState(Date.now());
  const confirm = useConfirm();
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    if (!selectedTeamId) { setLive(null); return; }
    // Snapshot pathname at effect-setup time so the onSnapshot
    // callback closes over the pathname of the moment; React's
    // location.pathname would be captured stale otherwise.
    const currentPath = location.pathname;
    const q = query(
      collection(db, 'live_games'),
      where('teamId', '==', selectedTeamId),
      where('status', '==', 'live'),
    );
    const unsub = onSnapshot(q, snap => {
      const cutoff = Date.now() - ZOMBIE_CUTOFF_HOURS * 60 * 60 * 1000;
      // Client-side rank: freshest updatedAt wins. Anything older
      // than the zombie cutoff is ignored — the coach ended their
      // session but forgot to hit End Game. Better to hide than to
      // pin a 37-hour-old game to every page.
      let best: LiveRow | null = null;
      snap.docs.forEach(d => {
        const data = d.data() as any;
        const updatedAtMs = extractUpdatedAtMs(data);
        if (updatedAtMs && updatedAtMs < cutoff) return;
        const row: LiveRow = {
          eventId: d.id,
          ourScore: data.ourScore || 0,
          oppScore: data.oppScore || 0,
          opponent: data.opponent || 'Opponent',
          clockSecondsAtStart: data.clockSecondsAtStart,
          clockOffsetSeconds: data.clockOffsetSeconds || 0,
          period: data.period,
          updatedAtMs,
        };
        if (!best || row.updatedAtMs > best.updatedAtMs) best = row;
      });
      setLive(best);
      // If there's no fresh live game AND the user isn't currently
      // ON GameDay for some event, clear the Watch session. This
      // catches the "opened phone to Dashboard, Watch still shows
      // yesterday's game" zombie case.
      //
      // Skip when the pathname is a game-day route: GameDay owns the
      // Watch session while it's mounted, and it publishes 'scheduled'
      // sessions before the coach taps Start. Without this skip we
      // race with GameDay's publish and clear a session it just
      // pushed — the coach starts a fresh game and the Watch flips
      // straight to idle.
      if (!best && !currentPath.startsWith('/game-day/')) {
        void clearWatchGameSession().catch(() => undefined);
      }
    }, () => setLive(null));
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeamId, location.pathname]);

  // Ticker only when a live game exists — avoids waking the render
  // loop every second on regular pages.
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  if (!live) return null;

  // If we're already on GameDay for this event, don't render the
  // banner — you're already in the room.
  if (location.pathname.includes(`/game-day/${live.eventId}`) ||
      location.pathname.includes(`/gameday/${live.eventId}`)) {
    return null;
  }

  const offset = live.clockOffsetSeconds || 0;
  const started = live.clockSecondsAtStart || 0;
  const running = started ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  // Hard cap on displayed clock. If the doc has a bad clockSecondsAtStart
  // (from a stale session) we don't want 37:00:00 on screen. Real
  // matches never exceed 3 hours end to end.
  const clockSecs = Math.min(offset + running, 3 * 60 * 60);
  const periodLabel = live.period === 'OT' ? 'OT' : live.period === 2 ? '2ND' : '1ST';

  const forceEnd = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (dismissing) return;
    if (!(await confirm({
      body: 'Force-end this game? It stays in your history — the banner just clears.',
      destructive: true,
      confirmText: 'End game',
    }))) return;
    setDismissing(true);
    try {
      await updateDoc(doc(db, 'live_games', live.eventId), {
        status: 'final',
        clockStartedAtMs: null,
        updatedAt: serverTimestamp(),
      } as any);
    } catch (err) {
      console.error('[live-banner] force-end failed', err);
      setDismissing(false);
    }
  };

  return (
    <div
      className="sticky top-0 z-40 w-full flex items-stretch bg-red-600 text-white text-[13px] font-bold shadow-md"
      style={{ paddingTop: 'max(6px, env(safe-area-inset-top))' }}
    >
      <button
        type="button"
        onClick={() => navigate(`/game-day/${live.eventId}`)}
        className="flex-1 flex items-center justify-center gap-3 px-4 py-1.5 active:opacity-90 transition-opacity"
      >
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          <span className="tracking-widest text-[11px] font-black">LIVE</span>
        </span>
        <span className="tabular-nums">
          {live.ourScore} – {live.oppScore}
        </span>
        <span className="opacity-80 text-[11px] font-bold tracking-wide truncate max-w-[40%]">
          vs {live.opponent}
        </span>
        <span className="tabular-nums opacity-90 text-[11px] font-black">
          {periodLabel} {formatClock(clockSecs)}
        </span>
        <span className="opacity-90 text-[11px] font-black tracking-wide">
          RESUME ›
        </span>
      </button>
      <button
        type="button"
        onClick={forceEnd}
        disabled={dismissing}
        aria-label="Force-end this game"
        className="px-3 flex items-center justify-center border-l border-white/25 hover:bg-red-700 active:bg-red-800 transition-colors disabled:opacity-50"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
};

export default LiveGameBanner;
