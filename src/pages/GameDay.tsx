// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { doc, getDoc, onSnapshot, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { isCoach } from '../utils/helpers';

type StatKind = 'goal' | 'owngoal' | 'assist' | 'save' | 'yellow' | 'red' | 'sub' | 'note';

interface TimelineEntry {
  id: string;
  at: number;          // unix ms
  minute: number;      // game clock minute
  kind: StatKind;
  playerId?: string;
  playerName?: string;
  jerseyNumber?: number;
  note?: string;
  recordedBy?: string;
  recordedByName?: string;
  // Stat-dedup glue: 'live' (default) when a coach tapped it, 'clip' when a
  // parent's video upload created the entry. clipUrl/clipMediaId may also be
  // present on a 'live' entry once a matching clip is uploaded and attached.
  source?: 'live' | 'clip';
  clipUrl?: string;
  clipMediaId?: string;
}

interface LiveGameDoc {
  eventId: string;
  teamId: string;
  opponent: string;
  homeAway?: 'home' | 'away';
  ourScore: number;
  oppScore: number;
  status: 'scheduled' | 'live' | 'halftime' | 'final';
  clockSecondsAtStart?: number; // Date.now() when current period started
  clockOffsetSeconds?: number;  // accumulated seconds from previous periods
  period?: 1 | 2 | 'OT';
  timeline: TimelineEntry[];
  lineup?: LineupState;
  updatedAt?: any;
  startedBy?: string;
  startedByName?: string;
}

interface OnFieldSlot {
  playerId: string;
  enteredAtSec: number; // game-clock seconds when this player came on
}

interface LineupState {
  onField: OnFieldSlot[];
  benchIds: string[];
  minutes: Record<string, number>; // accumulated seconds (does NOT include current shift)
  shiftSeconds: number;            // rotation bell interval
  lastBellAtSec?: number;          // game-clock seconds when bell last rang
  bellEnabled?: boolean;
}

const KIND_META: Record<StatKind, { label: string; emoji: string; color: string }> = {
  goal:    { label: 'Goal',     emoji: '⚽', color: 'bg-emerald-500' },
  owngoal: { label: 'Own Goal', emoji: '🥅', color: 'bg-rose-500' },
  assist:  { label: 'Assist',   emoji: '🅰️', color: 'bg-cyan-500' },
  save:    { label: 'Save',     emoji: '🧘', color: 'bg-blue-500' },
  yellow:  { label: 'Yellow',   emoji: '🟨', color: 'bg-yellow-500' },
  red:     { label: 'Red',      emoji: '🟥', color: 'bg-red-600' },
  sub:     { label: 'Sub',      emoji: '🔄', color: 'bg-purple-500' },
  note:    { label: 'Note',     emoji: '📝', color: 'bg-gray-500' },
};

const formatClock = (totalSec: number) => {
  const m = Math.max(0, Math.floor(totalSec / 60));
  const s = Math.max(0, totalSec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

const GameDay: React.FC = () => {
  const { eventId } = useParams<{ eventId: string }>();
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getDocument, getPlayersByTeam, addGameStat, updatePlayerStats } = useFirestore();
  const isQuickGame = !!eventId && eventId.startsWith('quick_');
  const [event, setEvent] = useState<any | null>(null);
  const [game, setGame] = useState<LiveGameDoc | null>(null);
  const [players, setPlayers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pickerKind, setPickerKind] = useState<StatKind | null>(null);
  const [noteText, setNoteText] = useState('');
  const [now, setNow] = useState(Date.now());

  const isUserCoach = userData ? isCoach(userData.role) : false;

  // 1Hz tick for clock
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Load event + players, subscribe to live game
  useEffect(() => {
    if (!eventId) {
      setError('Missing event id');
      setLoading(false);
      return;
    }
    let unsub: (() => void) | undefined;
    (async () => {
      try {
        let ev: any = null;
        if (isQuickGame) {
          // Quick game — no calendar event. Synthesize from selected team.
          if (!selectedTeamId) { setError('No team selected'); setLoading(false); return; }
          // Try to seed opponent from an existing live_games doc
          let opponent = 'Opponent';
          try {
            const existing = await getDoc(doc(db, 'live_games', eventId));
            if (existing.exists()) opponent = (existing.data() as any).opponent || opponent;
          } catch {}
          ev = {
            id: eventId,
            teamId: selectedTeamId,
            opponent,
            type: 'game',
            date: new Date(),
            title: `Quick game vs ${opponent}`,
          };
          setEvent(ev);
        } else {
          ev = await getDocument('events', eventId);
          if (!ev) { setError('Event not found'); setLoading(false); return; }
          setEvent(ev);
        }
        const teamPlayers = await getPlayersByTeam(ev.teamId);
        setPlayers(teamPlayers);
        unsub = onSnapshot(doc(db, 'live_games', eventId), snap => {
          if (snap.exists()) {
            setGame(snap.data() as LiveGameDoc);
          } else {
            setGame(null);
          }
          setLoading(false);
        }, err => {
          console.error('live_games snapshot err', err);
          setLoading(false);
        });
      } catch (err) {
        console.error(err);
        setError('Failed to load game.');
        setLoading(false);
      }
    })();
    return () => { if (unsub) unsub(); };
  }, [eventId, isQuickGame, selectedTeamId, getDocument, getPlayersByTeam]);

  // Derived clock
  const liveSeconds = useMemo(() => {
    if (!game) return 0;
    const offset = game.clockOffsetSeconds || 0;
    if (game.status === 'live' && game.clockSecondsAtStart) {
      return offset + Math.floor((now - game.clockSecondsAtStart) / 1000);
    }
    return offset;
  }, [game, now]);

  const minute = Math.floor(liveSeconds / 60) + 1;

  const ensureGameDoc = async (): Promise<LiveGameDoc> => {
    if (!eventId || !event) throw new Error('No event');
    if (game) return game;
    const initial: LiveGameDoc = {
      eventId,
      teamId: event.teamId,
      opponent: event.opponent || 'Opponent',
      homeAway: event.homeAway,
      ourScore: 0,
      oppScore: 0,
      status: 'scheduled',
      clockOffsetSeconds: 0,
      period: 1,
      timeline: [],
      startedBy: userData?.uid,
      startedByName: userData?.name || userData?.email || 'Coach',
    };
    await setDoc(doc(db, 'live_games', eventId), { ...initial, updatedAt: serverTimestamp() });
    return initial;
  };

  const patch = async (updates: Partial<LiveGameDoc>) => {
    if (!eventId) return;
    await ensureGameDoc();
    await updateDoc(doc(db, 'live_games', eventId), { ...updates, updatedAt: serverTimestamp() } as any);
  };

  const startClock = async () => {
    const g = await ensureGameDoc();
    await patch({
      status: 'live',
      clockSecondsAtStart: Date.now(),
      clockOffsetSeconds: g.clockOffsetSeconds || 0,
    });
  };
  const pauseClock = async () => {
    if (!game) return;
    await patch({
      status: 'halftime',
      clockOffsetSeconds: liveSeconds,
      clockSecondsAtStart: 0,
    });
  };
  const finalizeGame = async () => {
    if (!game) return;
    if (game.status === 'final') {
      alert('This game is already finalized. Season stats were written when it was finalized.');
      return;
    }
    if (!window.confirm('End the game? This will mark it Final and write per-player stats to season totals.')) return;
    await patch({
      status: 'final',
      clockOffsetSeconds: liveSeconds,
      clockSecondsAtStart: 0,
    });
    // Write season-aggregate stats
    try {
      const counts: Record<string, { goals: number; assists: number; saves: number; yellow: number; red: number; name: string }> = {};
      (game.timeline || []).forEach(t => {
        if (!t.playerId) return;
        const c = counts[t.playerId] || (counts[t.playerId] = { goals: 0, assists: 0, saves: 0, yellow: 0, red: 0, name: t.playerName || '' });
        if (t.kind === 'goal') c.goals++;
        if (t.kind === 'assist') c.assists++;
        if (t.kind === 'save') c.saves++;
        if (t.kind === 'yellow') c.yellow++;
        if (t.kind === 'red') c.red++;
      });
      for (const pid of Object.keys(counts)) {
        const c = counts[pid];
        const player = players.find(p => p.id === pid);
        if (!player) continue;
        const prev = player.stats || { goals: 0, assists: 0, saves: 0, yellowCards: 0, redCards: 0, gamesPlayed: 0, minutesPlayed: 0 };
        await updatePlayerStats(pid, {
          ...prev,
          goals: (prev.goals || 0) + c.goals,
          assists: (prev.assists || 0) + c.assists,
          saves: (prev.saves || 0) + c.saves,
          yellowCards: (prev.yellowCards || 0) + c.yellow,
          redCards: (prev.redCards || 0) + c.red,
          gamesPlayed: (prev.gamesPlayed || 0) + 1,
        });
        await addGameStat({
          playerId: pid,
          playerName: c.name,
          gameId: eventId!,
          gameDate: new Date(event.date?.toDate ? event.date.toDate() : event.date),
          opponent: event.opponent || 'Opponent',
          minutesPlayed: 0,
          goals: c.goals,
          assists: c.assists,
          yellowCards: c.yellow,
          redCards: c.red,
          saves: c.saves,
          recordedBy: userData?.uid,
          recordedByName: userData?.name || 'Coach',
          teamId: event.teamId,
        } as any);
      }
    } catch (err) {
      console.error('Failed to write season stats:', err);
      alert('Game ended, but season totals failed to update. Check console.');
    }
  };

  const incScore = async (side: 'our' | 'opp', delta: number) => {
    await ensureGameDoc();
    if (!game && delta < 0) return;
    const cur = game ? (side === 'our' ? game.ourScore : game.oppScore) : 0;
    const next = Math.max(0, cur + delta);
    await patch({ [side === 'our' ? 'ourScore' : 'oppScore']: next } as any);
  };

  const addTimelineEntry = async (kind: StatKind, opts: { player?: any; note?: string } = {}) => {
    await ensureGameDoc();
    const entry: TimelineEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(),
      minute,
      kind,
      playerId: opts.player?.id,
      playerName: opts.player?.name,
      jerseyNumber: opts.player?.jerseyNumber,
      note: opts.note,
      recordedBy: userData?.uid,
      recordedByName: userData?.name || 'Coach',
    };
    const newTimeline = [...(game?.timeline || []), entry];
    const update: Partial<LiveGameDoc> = { timeline: newTimeline };
    if (kind === 'goal' || kind === 'owngoal') {
      update.ourScore = (game?.ourScore || 0) + 1;
    }
    await patch(update);
  };

  const removeTimelineEntry = async (id: string) => {
    if (!game) return;
    const target = game.timeline.find(t => t.id === id);
    if (!target) return;
    if (!window.confirm('Remove this entry?')) return;
    const newTimeline = game.timeline.filter(t => t.id !== id);
    const update: Partial<LiveGameDoc> = { timeline: newTimeline };
    if ((target.kind === 'goal' || target.kind === 'owngoal') && (game.ourScore || 0) > 0) {
      update.ourScore = game.ourScore - 1;
    }
    await patch(update);
  };

  // ─── LINEUP / SUBS ──────────────────────────────────────────────────────
  const lineup: LineupState = game?.lineup || {
    onField: [],
    benchIds: [],
    minutes: {},
    shiftSeconds: 300,
    bellEnabled: true,
  };
  const onFieldIds = new Set(lineup.onField.map(s => s.playerId));
  const minutesFor = (pid: string): number => {
    const base = lineup.minutes?.[pid] || 0;
    const slot = lineup.onField.find(s => s.playerId === pid);
    if (!slot) return base;
    if (game?.status !== 'live') return base;
    return base + Math.max(0, liveSeconds - slot.enteredAtSec);
  };

  const persistLineup = async (next: LineupState, syncTimeline?: TimelineEntry) => {
    await ensureGameDoc();
    const update: any = { lineup: next };
    if (syncTimeline) update.timeline = [...(game?.timeline || []), syncTimeline];
    await patch(update);
  };

  const initRosterToBench = async () => {
    if (lineup.onField.length || lineup.benchIds.length) return;
    const next: LineupState = {
      ...lineup,
      benchIds: players.map(p => p.id),
    };
    await persistLineup(next);
  };

  const subOn = async (playerId: string) => {
    if (onFieldIds.has(playerId)) return;
    const next: LineupState = {
      ...lineup,
      onField: [...lineup.onField, { playerId, enteredAtSec: liveSeconds }],
      benchIds: lineup.benchIds.filter(id => id !== playerId),
    };
    const p = players.find(x => x.id === playerId);
    const entry: TimelineEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(), minute, kind: 'sub',
      playerId, playerName: p?.name, jerseyNumber: p?.jerseyNumber,
      note: 'on',
      recordedBy: userData?.uid, recordedByName: userData?.name || 'Coach',
    };
    await persistLineup(next, entry);
  };

  const subOff = async (playerId: string) => {
    const slot = lineup.onField.find(s => s.playerId === playerId);
    if (!slot) return;
    const accrued = game?.status === 'live' ? Math.max(0, liveSeconds - slot.enteredAtSec) : 0;
    const next: LineupState = {
      ...lineup,
      onField: lineup.onField.filter(s => s.playerId !== playerId),
      benchIds: [...lineup.benchIds, playerId],
      minutes: {
        ...(lineup.minutes || {}),
        [playerId]: (lineup.minutes?.[playerId] || 0) + accrued,
      },
    };
    const p = players.find(x => x.id === playerId);
    const entry: TimelineEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(), minute, kind: 'sub',
      playerId, playerName: p?.name, jerseyNumber: p?.jerseyNumber,
      note: 'off',
      recordedBy: userData?.uid, recordedByName: userData?.name || 'Coach',
    };
    await persistLineup(next, entry);
  };

  const setShiftSeconds = async (sec: number) => {
    await persistLineup({ ...lineup, shiftSeconds: sec, lastBellAtSec: liveSeconds });
  };
  const toggleBell = async () => {
    await persistLineup({ ...lineup, bellEnabled: !lineup.bellEnabled, lastBellAtSec: liveSeconds });
  };
  const acknowledgeBell = async () => {
    await persistLineup({ ...lineup, lastBellAtSec: liveSeconds });
  };

  // Bell trigger
  const bellAlerted = useRef<number>(0);
  useEffect(() => {
    if (!isUserCoach) return;
    if (game?.status !== 'live') return;
    if (!lineup.bellEnabled) return;
    const since = liveSeconds - (lineup.lastBellAtSec || 0);
    if (since >= lineup.shiftSeconds && bellAlerted.current !== Math.floor(liveSeconds / lineup.shiftSeconds)) {
      bellAlerted.current = Math.floor(liveSeconds / lineup.shiftSeconds);
      try { (navigator as any).vibrate && (navigator as any).vibrate([200, 80, 200, 80, 400]); } catch {}
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('🔔 Time to rotate!', { body: `Shift complete (${lineup.shiftSeconds / 60} min)`, tag: 'gameday-bell' });
        }
      } catch {}
    }
  }, [liveSeconds, lineup.shiftSeconds, lineup.lastBellAtSec, lineup.bellEnabled, game?.status, isUserCoach]);

  useEffect(() => {
    if (!isUserCoach) return;
    if ('Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch {}
    }
  }, [isUserCoach]);

  // Suggested next sub: bench player with fewest minutes
  const suggestedNext = useMemo(() => {
    if (lineup.benchIds.length === 0) return null;
    const sorted = [...lineup.benchIds].sort((a, b) => minutesFor(a) - minutesFor(b));
    return sorted[0];
  }, [lineup.benchIds, lineup.minutes, lineup.onField, liveSeconds]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-cyan-200 border-t-cyan-500" />
      </div>
    );
  }
  if (error || !event) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 text-white">
        <div className="text-center">
          <div className="text-5xl mb-4">⚽</div>
          <p className="mb-4">{error || 'Event not found'}</p>
          <Link to="/calendar" className="px-4 py-2 bg-cyan-600 rounded-lg">Back to Calendar</Link>
        </div>
      </div>
    );
  }

  const ourScore = game?.ourScore ?? 0;
  const oppScore = game?.oppScore ?? 0;
  const status = game?.status || 'scheduled';
  const sortedTimeline = [...(game?.timeline || [])].sort((a, b) => b.at - a.at);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-black text-white pb-32">
      {/* Header / Scoreboard */}
      <header className="sticky top-0 z-20 bg-black/60 backdrop-blur-md border-b border-white/10">
        <div className="max-w-3xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <Link to="/calendar" className="text-xs text-white/60 hover:text-white">← Calendar</Link>
            <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold ${
              status === 'live' ? 'bg-red-500/20 text-red-300 ring-1 ring-red-500/40 animate-pulse' :
              status === 'halftime' ? 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40' :
              status === 'final' ? 'bg-gray-500/20 text-gray-300 ring-1 ring-gray-500/40' :
              'bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-500/40'
            }`}>
              {status === 'live' ? '● LIVE' : status === 'halftime' ? 'PAUSED' : status === 'final' ? 'FINAL' : 'SCHEDULED'}
            </span>
          </div>
          <div className="grid grid-cols-3 items-center text-center gap-2">
            <div>
              <div className="text-xs text-white/60 truncate">Fire FC</div>
              <div className="text-5xl font-black tabular-nums">{ourScore}</div>
              {isUserCoach && (
                <div className="flex justify-center gap-1 mt-1">
                  <button onClick={() => incScore('our', -1)} className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 text-sm font-bold">−</button>
                  <button onClick={() => incScore('our', 1)} className="w-7 h-7 rounded bg-emerald-600 hover:bg-emerald-500 text-sm font-bold">+</button>
                </div>
              )}
            </div>
            <div>
              <div className="text-xs text-white/60 mb-1">{event.homeAway === 'away' ? '@ Away' : event.homeAway === 'home' ? 'Home' : ''}</div>
              <div className="text-2xl font-mono tabular-nums">{formatClock(liveSeconds)}</div>
              <div className="text-[10px] text-white/40 mt-0.5">Min {minute}</div>
            </div>
            <div>
              <div className="text-xs text-white/60 truncate">{event.opponent || 'Opponent'}</div>
              <div className="text-5xl font-black tabular-nums">{oppScore}</div>
              {isUserCoach && (
                <div className="flex justify-center gap-1 mt-1">
                  <button onClick={() => incScore('opp', -1)} className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 text-sm font-bold">−</button>
                  <button onClick={() => incScore('opp', 1)} className="w-7 h-7 rounded bg-rose-600 hover:bg-rose-500 text-sm font-bold">+</button>
                </div>
              )}
            </div>
          </div>
          {isUserCoach && status !== 'final' && (
            <div className="flex gap-2 mt-3">
              {status !== 'live' ? (
                <button onClick={startClock} className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-semibold">
                  ▶ {status === 'halftime' ? 'Resume' : 'Start'}
                </button>
              ) : (
                <button onClick={pauseClock} className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 rounded-lg text-sm font-semibold">
                  ⏸ Pause / Halftime
                </button>
              )}
              <button onClick={finalizeGame} className="flex-1 py-2 bg-rose-700 hover:bg-rose-600 rounded-lg text-sm font-semibold">
                🏁 End Game
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 pt-4 space-y-4">
        {/* Quick action chips (coaches only) */}
        {isUserCoach && status !== 'final' && (
          <section>
            <h3 className="text-xs uppercase tracking-wider text-white/40 mb-2">Tap to record</h3>
            <div className="grid grid-cols-4 gap-2">
              {(['goal', 'owngoal', 'assist', 'save', 'yellow', 'red', 'sub', 'note'] as StatKind[]).map(k => (
                <button
                  key={k}
                  onClick={async () => {
                    if (k === 'owngoal') {
                      if (!window.confirm('Mark Own Goal? +1 to us, no player credit. (You can still tap Assist for the kicker.)')) return;
                      await addTimelineEntry('owngoal', { note: 'Opponent own goal' });
                      return;
                    }
                    setPickerKind(k);
                    setNoteText('');
                  }}
                  className={`flex flex-col items-center gap-1 py-2.5 rounded-xl ring-1 ring-white/10 hover:ring-white/30 ${KIND_META[k].color} bg-opacity-15`}
                  style={{ backgroundColor: undefined }}
                >
                  <span className="text-2xl">{KIND_META[k].emoji}</span>
                  <span className="text-[11px] font-medium text-white/90">{KIND_META[k].label}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Lineup & Subs (coaches only) */}
        {isUserCoach && status !== 'final' && (
          <section className="rounded-2xl bg-white/5 ring-1 ring-white/10 p-3 sm:p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs uppercase tracking-wider text-white/60 font-bold">Lineup &amp; Subs</h3>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-white/40">Shift</span>
                <select
                  value={lineup.shiftSeconds}
                  onChange={e => setShiftSeconds(parseInt(e.target.value, 10))}
                  className="bg-white/10 ring-1 ring-white/20 rounded px-1.5 py-0.5 text-white text-[11px]"
                >
                  <option value={180}>3 min</option>
                  <option value={300}>5 min</option>
                  <option value={420}>7 min</option>
                  <option value={600}>10 min</option>
                </select>
                <button
                  onClick={toggleBell}
                  className={`px-2 py-0.5 rounded font-semibold ${lineup.bellEnabled ? 'bg-emerald-600/30 text-emerald-200 ring-1 ring-emerald-500/50' : 'bg-white/10 text-white/50 ring-1 ring-white/20'}`}
                  title="Toggle rotation bell"
                >🔔 {lineup.bellEnabled ? 'On' : 'Off'}</button>
              </div>
            </div>

            {/* Bell countdown */}
            {game?.status === 'live' && lineup.bellEnabled && (
              <div className="mb-3">
                {(() => {
                  const remaining = Math.max(0, lineup.shiftSeconds - (liveSeconds - (lineup.lastBellAtSec || 0)));
                  const pct = Math.min(100, ((lineup.shiftSeconds - remaining) / lineup.shiftSeconds) * 100);
                  return (
                    <div>
                      <div className="flex items-center justify-between text-[11px] text-white/60 mb-1">
                        <span>Next rotation in {formatClock(remaining)}</span>
                        <button onClick={acknowledgeBell} className="text-cyan-300 hover:text-cyan-200">Reset</button>
                      </div>
                      <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-emerald-500 to-amber-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Quick init */}
            {lineup.onField.length === 0 && lineup.benchIds.length === 0 && (
              <button
                onClick={initRosterToBench}
                className="w-full py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 font-semibold text-sm"
              >Load roster to bench</button>
            )}

            {(lineup.onField.length > 0 || lineup.benchIds.length > 0) && (
              <div className="grid grid-cols-2 gap-3">
                {/* On field */}
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-emerald-400 font-bold mb-1.5">On Field ({lineup.onField.length})</div>
                  <div className="space-y-1.5">
                    {lineup.onField.map(slot => {
                      const p = players.find(pp => pp.id === slot.playerId);
                      if (!p) return null;
                      const mins = Math.floor(minutesFor(slot.playerId) / 60);
                      return (
                        <button
                          key={slot.playerId}
                          onClick={() => subOff(slot.playerId)}
                          className="w-full flex items-center gap-2 p-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 ring-1 ring-emerald-500/30 text-left"
                          title="Tap to sub OFF"
                        >
                          <span className="w-7 h-7 rounded-full bg-emerald-600 text-white text-[10px] font-black flex items-center justify-center flex-shrink-0">
                            {p.jerseyNumber != null ? `#${p.jerseyNumber}` : (p.name || '?').charAt(0)}
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="block text-xs font-semibold truncate">{p.name}</span>
                            <span className="block text-[10px] text-emerald-300 tabular-nums">{mins} min</span>
                          </span>
                        </button>
                      );
                    })}
                    {lineup.onField.length === 0 && <div className="text-[11px] text-white/40 italic px-1">No one on the field.</div>}
                  </div>
                </div>

                {/* Bench (sorted by least minutes) */}
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-amber-400 font-bold mb-1.5">Bench ({lineup.benchIds.length})</div>
                  <div className="space-y-1.5">
                    {[...lineup.benchIds]
                      .sort((a, b) => minutesFor(a) - minutesFor(b))
                      .map(pid => {
                        const p = players.find(pp => pp.id === pid);
                        if (!p) return null;
                        const mins = Math.floor(minutesFor(pid) / 60);
                        const isNext = pid === suggestedNext;
                        return (
                          <button
                            key={pid}
                            onClick={() => subOn(pid)}
                            className={`w-full flex items-center gap-2 p-1.5 rounded-lg ring-1 text-left ${isNext ? 'bg-amber-500/15 ring-amber-500/50 hover:bg-amber-500/25' : 'bg-white/5 ring-white/10 hover:bg-white/10'}`}
                            title="Tap to sub ON"
                          >
                            <span className={`w-7 h-7 rounded-full text-white text-[10px] font-black flex items-center justify-center flex-shrink-0 ${isNext ? 'bg-amber-600' : 'bg-slate-600'}`}>
                              {p.jerseyNumber != null ? `#${p.jerseyNumber}` : (p.name || '?').charAt(0)}
                            </span>
                            <span className="flex-1 min-w-0">
                              <span className="block text-xs font-semibold truncate flex items-center gap-1">
                                {p.name}
                                {isNext && <span className="text-[9px] bg-amber-600 px-1 rounded text-white">NEXT</span>}
                              </span>
                              <span className="block text-[10px] text-white/50 tabular-nums">{mins} min</span>
                            </span>
                          </button>
                        );
                      })}
                    {lineup.benchIds.length === 0 && <div className="text-[11px] text-white/40 italic px-1">Bench empty.</div>}
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Timeline */}
        <section>
          <h3 className="text-xs uppercase tracking-wider text-white/40 mb-2">
            Timeline ({sortedTimeline.length})
          </h3>
          {sortedTimeline.length === 0 ? (
            <div className="text-center py-10 text-white/40 text-sm rounded-xl bg-white/5 ring-1 ring-white/10">
              No events yet. {isUserCoach ? 'Tap an action above.' : 'Coaches will record events live.'}
            </div>
          ) : (
            <ul className="space-y-2">
              {sortedTimeline.map(t => (
                <li key={t.id} className="flex items-center gap-3 p-3 rounded-xl bg-white/5 ring-1 ring-white/10">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg ${KIND_META[t.kind].color}/30`}>
                    {KIND_META[t.kind].emoji}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm">
                      <span className="font-bold">{KIND_META[t.kind].label}</span>
                      {t.playerName && (
                        <>
                          {' · '}
                          <span className="text-cyan-300">
                            {t.jerseyNumber != null ? `#${t.jerseyNumber} ` : ''}{t.playerName}
                          </span>
                        </>
                      )}
                    </div>
                    {t.note && <div className="text-xs text-white/70 mt-0.5">{t.note}</div>}
                    {t.clipUrl && (
                      <a
                        href={t.clipUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 mt-1 text-[11px] text-cyan-300 hover:text-cyan-200"
                      >
                        🎬 {t.source === 'clip' ? 'Clip credit' : 'Watch clip'}
                      </a>
                    )}
                    <div className="text-[10px] text-white/40 mt-0.5">
                      Min {t.minute} · {new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      {t.recordedByName ? ` · by ${t.recordedByName}` : ''}
                    </div>
                  </div>
                  {isUserCoach && (
                    <button
                      onClick={() => removeTimelineEntry(t.id)}
                      className="text-white/40 hover:text-red-400 text-sm"
                      title="Remove"
                    >✕</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Per-player live tally */}
        <section>
          <h3 className="text-xs uppercase tracking-wider text-white/40 mb-2">Live Stat Sheet</h3>
          <div className="rounded-xl bg-white/5 ring-1 ring-white/10 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-white/5 text-white/60 text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="text-left px-3 py-2">Player</th>
                  <th className="px-2 py-2">⚽</th>
                  <th className="px-2 py-2">🅰️</th>
                  <th className="px-2 py-2">🧤</th>
                  <th className="px-2 py-2">🟨</th>
                  <th className="px-2 py-2">🟥</th>
                </tr>
              </thead>
              <tbody>
                {players.map(p => {
                  const tally = (game?.timeline || []).reduce((acc: any, t) => {
                    if (t.playerId !== p.id) return acc;
                    if (t.kind === 'goal') acc.goals++;
                    if (t.kind === 'assist') acc.assists++;
                    if (t.kind === 'save') acc.saves++;
                    if (t.kind === 'yellow') acc.yellow++;
                    if (t.kind === 'red') acc.red++;
                    return acc;
                  }, { goals: 0, assists: 0, saves: 0, yellow: 0, red: 0 });
                  const hasAny = tally.goals + tally.assists + tally.saves + tally.yellow + tally.red > 0;
                  return (
                    <tr key={p.id} className={`border-t border-white/5 ${hasAny ? 'text-white' : 'text-white/40'}`}>
                      <td className="px-3 py-2 truncate">
                        {p.jerseyNumber != null ? <span className="text-cyan-300 font-bold mr-1">#{p.jerseyNumber}</span> : null}
                        {p.name}
                      </td>
                      <td className="text-center tabular-nums">{tally.goals || ''}</td>
                      <td className="text-center tabular-nums">{tally.assists || ''}</td>
                      <td className="text-center tabular-nums">{tally.saves || ''}</td>
                      <td className="text-center tabular-nums">{tally.yellow || ''}</td>
                      <td className="text-center tabular-nums">{tally.red || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* Player picker modal */}
      {pickerKind && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setPickerKind(null)}>
          <div className="bg-slate-900 ring-1 ring-white/10 rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
              <h3 className="font-bold flex items-center gap-2">
                <span>{KIND_META[pickerKind].emoji}</span>
                <span>{KIND_META[pickerKind].label}</span>
                <span className="text-xs text-white/40 font-normal">· Min {minute}</span>
              </h3>
              <button onClick={() => setPickerKind(null)} className="text-white/60 hover:text-white text-xl leading-none">✕</button>
            </div>
            {pickerKind === 'note' ? (
              <div className="p-4 space-y-3">
                <textarea
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  placeholder="What happened? (e.g. great defensive stop, weather break)"
                  rows={4}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  autoFocus
                />
                <button
                  onClick={async () => {
                    if (!noteText.trim()) return;
                    await addTimelineEntry('note', { note: noteText.trim() });
                    setPickerKind(null);
                    setNoteText('');
                  }}
                  className="w-full py-2.5 bg-cyan-600 hover:bg-cyan-500 rounded-lg font-semibold"
                >Save Note</button>
              </div>
            ) : (
              <div className="overflow-y-auto p-2 grid grid-cols-2 gap-2">
                {players.length === 0 ? (
                  <div className="col-span-2 p-6 text-center text-white/40 text-sm">No players on this team.</div>
                ) : players.map(p => (
                  <button
                    key={p.id}
                    onClick={async () => {
                      await addTimelineEntry(pickerKind, { player: p });
                      setPickerKind(null);
                    }}
                    className="flex items-center gap-2 p-2 rounded-lg bg-white/5 hover:bg-white/10 ring-1 ring-white/10 text-left"
                  >
                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white text-xs font-black flex-shrink-0">
                      {p.jerseyNumber != null ? `#${p.jerseyNumber}` : (p.name || '?').charAt(0)}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">{p.name}</div>
                      {p.position && <div className="text-[10px] text-white/40 truncate">{p.position}</div>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default GameDay;
