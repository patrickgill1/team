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
      <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-input to-surface-base text-white flex items-center justify-center p-6">
        <div className="text-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-12 h-12 mx-auto mb-3 text-white/40">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
          <p className="text-white/70">Coaches only — kickoff is a coach-side action.</p>
          <Link to="/dashboard" className="mt-4 inline-block text-brand-primary-soft hover:text-ink-primary text-sm">← Team HQ</Link>
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
    <div className="min-h-screen bg-gradient-to-br from-surface-base via-surface-elevated to-surface-base text-white">
      <header className="px-4 py-4 border-b border-line-default/10 flex items-center justify-between">
        <Link to="/dashboard" className="text-white/60 hover:text-white text-sm">← Back</Link>
        <h1 className="text-lg font-bold">⚡ Quick Game</h1>
        <div className="w-12" />
      </header>
      <main className="max-w-md mx-auto px-4 pt-8 space-y-5">
        <div className="rounded-2xl bg-line-default/5 ring-1 ring-line-default/10 p-5 space-y-4">
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
              className="mt-1 w-full px-3 py-2 bg-line-default/10 border border-line-default/10 rounded-lg text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-brand-primary"
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
                  className={`py-2 rounded-lg text-sm font-semibold ring-1 ${homeAway === v ? 'bg-brand-primary ring-brand-primary-soft text-white' : 'bg-line-default/5 ring-line-default/10 text-white/70 hover:bg-line-default/10'}`}
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
