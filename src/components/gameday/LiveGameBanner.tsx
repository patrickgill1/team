import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useTeam } from '../../contexts/TeamContext';

/**
 * Persistent "there's a live game running" banner. Sticks to the top
 * of the page shell whenever the selected team has an active
 * live_games doc. Tap navigates back to GameDay for that event.
 *
 * Why this exists: coaches switching to another tab mid-game (chat,
 * calendar) lose sight of the running game. State isn't lost —
 * live_games is Firestore-backed — but "how do I get back?" was
 * enough friction to generate hostile reviews.
 *
 * Scoped to the currently-selected team; a coach juggling two teams
 * has to switch teams to see the other's banner. That trade-off keeps
 * the query to a single per-team snapshot instead of an in-query
 * against every team the user touches.
 */

interface LiveRow {
  eventId: string;
  ourScore: number;
  oppScore: number;
  opponent: string;
  clockSecondsAtStart?: number;
  clockOffsetSeconds?: number;
  period?: 1 | 2 | 'OT';
}

const formatClock = (secs: number): string => {
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
};

const LiveGameBanner: React.FC = () => {
  const { selectedTeamId } = useTeam();
  const navigate = useNavigate();
  const location = useLocation();
  const [live, setLive] = useState<LiveRow | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!selectedTeamId) { setLive(null); return; }
    const q = query(
      collection(db, 'live_games'),
      where('teamId', '==', selectedTeamId),
      where('status', '==', 'live'),
    );
    const unsub = onSnapshot(q, snap => {
      const doc = snap.docs[0];
      if (!doc) { setLive(null); return; }
      const d = doc.data() as any;
      setLive({
        eventId: doc.id,
        ourScore: d.ourScore || 0,
        oppScore: d.oppScore || 0,
        opponent: d.opponent || 'Opponent',
        clockSecondsAtStart: d.clockSecondsAtStart,
        clockOffsetSeconds: d.clockOffsetSeconds || 0,
        period: d.period,
      });
    }, () => setLive(null));
    return unsub;
  }, [selectedTeamId]);

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
  const clockSecs = offset + running;
  const periodLabel = live.period === 'OT' ? 'OT' : live.period === 2 ? '2ND' : '1ST';

  return (
    <button
      type="button"
      onClick={() => navigate(`/game-day/${live.eventId}`)}
      className="sticky top-0 z-40 w-full flex items-center justify-center gap-3 px-4 py-1.5 bg-red-600 text-white text-[13px] font-bold shadow-md active:opacity-90 transition-opacity"
      style={{ paddingTop: 'max(6px, env(safe-area-inset-top))' }}
    >
      <span className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
        <span className="tracking-widest text-[11px] font-black">LIVE</span>
      </span>
      <span className="tabular-nums">
        {live.ourScore} – {live.oppScore}
      </span>
      <span className="opacity-80 text-[11px] font-bold tracking-wide">
        vs {live.opponent}
      </span>
      <span className="tabular-nums opacity-90 text-[11px] font-black">
        {periodLabel} {formatClock(clockSecs)}
      </span>
      <span className="ml-auto opacity-90 text-[11px] font-black tracking-wide">
        RESUME ›
      </span>
    </button>
  );
};

export default LiveGameBanner;
