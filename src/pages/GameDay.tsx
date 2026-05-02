// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { doc, getDoc, onSnapshot, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { isCoach } from '../utils/helpers';

type StatKind = 'goal' | 'assist' | 'save' | 'yellow' | 'red' | 'sub' | 'note';

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
  updatedAt?: any;
  startedBy?: string;
  startedByName?: string;
}

const KIND_META: Record<StatKind, { label: string; emoji: string; color: string }> = {
  goal:   { label: 'Goal',    emoji: '⚽', color: 'bg-emerald-500' },
  assist: { label: 'Assist',  emoji: '🅰️', color: 'bg-cyan-500' },
  save:   { label: 'Save',    emoji: '🧤', color: 'bg-blue-500' },
  yellow: { label: 'Yellow',  emoji: '🟨', color: 'bg-yellow-500' },
  red:    { label: 'Red',     emoji: '🟥', color: 'bg-red-600' },
  sub:    { label: 'Sub',     emoji: '🔄', color: 'bg-purple-500' },
  note:   { label: 'Note',    emoji: '📝', color: 'bg-gray-500' },
};

const formatClock = (totalSec: number) => {
  const m = Math.max(0, Math.floor(totalSec / 60));
  const s = Math.max(0, totalSec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

const GameDay: React.FC = () => {
  const { eventId } = useParams<{ eventId: string }>();
  const { userData } = useAuth();
  const { getDocument, getPlayersByTeam, addGameStat, updatePlayerStats } = useFirestore();
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
        const ev = await getDocument('events', eventId);
        if (!ev) { setError('Event not found'); setLoading(false); return; }
        setEvent(ev);
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
  }, [eventId, getDocument, getPlayersByTeam]);

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
    if (kind === 'goal') {
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
    if (target.kind === 'goal' && (game.ourScore || 0) > 0) {
      update.ourScore = game.ourScore - 1;
    }
    await patch(update);
  };

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
              {(['goal', 'assist', 'save', 'yellow', 'red', 'sub', 'note'] as StatKind[]).map(k => (
                <button
                  key={k}
                  onClick={() => { setPickerKind(k); setNoteText(''); }}
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
