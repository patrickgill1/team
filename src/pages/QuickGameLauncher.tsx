import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoach } from '../utils/helpers';

const QuickGameLauncher: React.FC = () => {
  const navigate = useNavigate();
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const [opponent, setOpponent] = useState('');
  const [homeAway, setHomeAway] = useState<'home' | 'away'>('home');
  const [busy, setBusy] = useState(false);

  if (!isCoach(userData?.role || '')) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-charcoal-950 via-charcoal-800 to-charcoal-950 text-white flex items-center justify-center p-6">
        <div className="text-center">
          <div className="text-5xl mb-3">🔒</div>
          <p className="text-white/70">Only coaches can start a game.</p>
          <Link to="/dashboard" className="mt-4 inline-block text-crimson-400 hover:text-bone text-sm">← Dashboard</Link>
        </div>
      </div>
    );
  }

  const start = async () => {
    if (!selectedTeamId) { alert('No team selected.'); return; }
    setBusy(true);
    try {
      const id = `quick_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await setDoc(doc(db, 'live_games', id), {
        eventId: id,
        teamId: selectedTeamId,
        opponent: opponent.trim() || 'Opponent',
        homeAway,
        ourScore: 0,
        oppScore: 0,
        status: 'scheduled',
        clockOffsetSeconds: 0,
        period: 1,
        timeline: [],
        startedBy: userData?.uid,
        startedByName: userData?.name || userData?.email || 'Coach',
        isQuickGame: true,
        updatedAt: serverTimestamp(),
      });
      navigate(`/game-day/${id}`);
    } catch (err) {
      console.error(err);
      alert('Could not start the game. Try again.');
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-charcoal-950 text-white">
      <header className="px-4 py-4 border-b border-white/10 flex items-center justify-between">
        <Link to="/dashboard" className="text-white/60 hover:text-white text-sm">← Back</Link>
        <h1 className="text-lg font-bold">⚡ Quick Game</h1>
        <div className="w-12" />
      </header>
      <main className="max-w-md mx-auto px-4 pt-8 space-y-5">
        <div className="rounded-2xl bg-white/5 ring-1 ring-white/10 p-5 space-y-4">
          <p className="text-sm text-white/70">
            Start Game Day right now without putting it on the calendar. Useful for scrimmages, friendlies, or anything you forgot to schedule.
          </p>
          {selectedTeam?.name && (
            <div className="text-xs text-white/50">Team: <span className="text-white/80 font-semibold">{selectedTeam.name}</span></div>
          )}
          <div>
            <label className="text-xs uppercase tracking-wider text-white/60 font-bold">Opponent</label>
            <input
              type="text"
              value={opponent}
              onChange={e => setOpponent(e.target.value)}
              placeholder="e.g. Lightning FC"
              className="mt-1 w-full px-3 py-2 bg-white/10 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-crimson-500"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider text-white/60 font-bold">Home / Away</label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {(['home', 'away'] as const).map(v => (
                <button
                  key={v}
                  onClick={() => setHomeAway(v)}
                  className={`py-2 rounded-lg text-sm font-semibold ring-1 ${homeAway === v ? 'bg-crimson-600 ring-crimson-400 text-white' : 'bg-white/5 ring-white/10 text-white/70 hover:bg-white/10'}`}
                >{v === 'home' ? '🏠 Home' : '✈️ Away'}</button>
              ))}
            </div>
          </div>
          <button
            onClick={start}
            disabled={busy}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg font-bold"
          >{busy ? 'Starting…' : '⚡ Start Game'}</button>
          <p className="text-[11px] text-white/40">
            Stats finalize the same way as a calendar game when you tap End Game. No event will be created on the calendar.
          </p>
        </div>
      </main>
    </div>
  );
};

export default QuickGameLauncher;
