// League Console — admin surface for a league. Create fixtures,
// report scores. Standings recompute automatically on each score
// report. Access is gated by League.adminUids / ownerUid — the
// worker enforces on write, and the client hides admin controls
// when the user isn't in that list.

import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { doc, getDoc, collection, query, where, getDocs, orderBy } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import type { League, Fixture } from '../types';

const LeagueConsole: React.FC = () => {
  const { leagueId } = useParams<{ leagueId: string }>();
  const { userData } = useAuth();
  const [league, setLeague] = useState<League | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create-fixture form state
  const [newHome, setNewHome] = useState('');
  const [newAway, setNewAway] = useState('');
  const [newDate, setNewDate] = useState('');
  const [newTime, setNewTime] = useState('19:00');
  const [newLocation, setNewLocation] = useState('');
  const [newMatchday, setNewMatchday] = useState('');
  const [busy, setBusy] = useState(false);

  // Score reporter state (keyed by fixture id)
  const [scoreDraft, setScoreDraft] = useState<Record<string, { home: string; away: string }>>({});

  const reload = async () => {
    if (!leagueId) return;
    setLoading(true);
    try {
      const [leagueSnap, fxSnap] = await Promise.all([
        getDoc(doc(db, 'leagues', leagueId)),
        getDocs(query(
          collection(db, 'fixtures'),
          where('leagueId', '==', leagueId),
          orderBy('date', 'asc'),
        )),
      ]);
      if (!leagueSnap.exists()) { setError('League not found'); return; }
      const l: any = { id: leagueSnap.id, ...leagueSnap.data() };
      setLeague(l as League);
      const fx: Fixture[] = fxSnap.docs.map(d => {
        const data: any = d.data();
        return {
          id: d.id,
          ...data,
          date: data.date?.toDate?.() || new Date(data.date),
        };
      });
      setFixtures(fx);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); /* eslint-disable-line */ }, [leagueId]);

  const isAdmin = !!league && !!userData?.uid && (
    league.ownerUid === userData.uid || (league.adminUids || []).includes(userData.uid)
  );

  const handleCreateFixture = async () => {
    if (!newHome || !newAway || !newDate) {
      setError('Home team, away team, and date required.');
      return;
    }
    if (newHome === newAway) {
      setError('Home and away must be different teams.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { workerFetch } = await import('../utils/workerFetch');
      const dt = new Date(`${newDate}T${newTime || '19:00'}`);
      const res = await workerFetch('/leagues/fixture-create', {
        method: 'POST',
        body: JSON.stringify({
          leagueId,
          homeTeamId: newHome,
          awayTeamId: newAway,
          dateMs: dt.getTime(),
          location: newLocation.trim() || undefined,
          matchday: newMatchday ? Number(newMatchday) : undefined,
        }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setError(data?.error || 'Create failed');
        return;
      }
      setNewHome('');
      setNewAway('');
      setNewLocation('');
      setNewMatchday('');
      await reload();
    } catch (err: any) {
      setError(err?.message || 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  const handleReportScore = async (fixtureId: string) => {
    const draft = scoreDraft[fixtureId];
    if (!draft || !draft.home || !draft.away) {
      alert('Enter both scores.');
      return;
    }
    setBusy(true);
    try {
      const { workerFetch } = await import('../utils/workerFetch');
      const res = await workerFetch('/leagues/report-score', {
        method: 'POST',
        body: JSON.stringify({
          fixtureId,
          homeScore: Number(draft.home),
          awayScore: Number(draft.away),
          status: 'final',
        }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        alert(data?.error || 'Report failed');
        return;
      }
      setScoreDraft(prev => { const next = { ...prev }; delete next[fixtureId]; return next; });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface-base text-ink-primary pb-16">
      <header className="border-b border-line-default/10 px-4 sm:px-6 pt-6 pb-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-brand-primary-soft mb-1">League Console</p>
            <h1 className="text-2xl sm:text-3xl font-black text-ink-primary truncate">{league?.name || 'Loading…'}</h1>
          </div>
          <Link
            to={`/l/${leagueId}`}
            className="shrink-0 text-[11px] font-black uppercase tracking-widest px-3 py-1.5 rounded-lg bg-surface-elevated ring-1 ring-line-default/10 hover:ring-brand-primary/40 transition"
          >
            View public →
          </Link>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {error && (
          <div className="rounded-lg bg-rose-500/10 ring-1 ring-rose-500/30 px-3 py-2 text-sm text-rose-200">{error}</div>
        )}

        {!isAdmin && !loading && (
          <div className="rounded-lg bg-amber-500/10 ring-1 ring-amber-500/30 px-3 py-2 text-sm text-amber-200">
            Read-only view — you're not a league admin. Reach out to the league owner if you should be.
          </div>
        )}

        {isAdmin && league && (
          <section className="rounded-xl bg-surface-elevated ring-1 ring-line-default/10 p-4">
            <h2 className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60 mb-3">Add fixture</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
              <select value={newHome} onChange={(e) => setNewHome(e.target.value)} className="bg-surface-base border border-line-default/10 rounded-lg px-3 py-2 text-sm text-ink-primary focus:outline-none focus:border-brand-primary/50">
                <option value="">Home team</option>
                {(league.teamIds || []).map(tid => <option key={tid} value={tid}>{tid}</option>)}
              </select>
              <select value={newAway} onChange={(e) => setNewAway(e.target.value)} className="bg-surface-base border border-line-default/10 rounded-lg px-3 py-2 text-sm text-ink-primary focus:outline-none focus:border-brand-primary/50">
                <option value="">Away team</option>
                {(league.teamIds || []).map(tid => <option key={tid} value={tid}>{tid}</option>)}
              </select>
              <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className="bg-surface-base border border-line-default/10 rounded-lg px-3 py-2 text-sm text-ink-primary [color-scheme:dark]" />
              <input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} className="bg-surface-base border border-line-default/10 rounded-lg px-3 py-2 text-sm text-ink-primary [color-scheme:dark]" />
              <input type="text" value={newLocation} onChange={(e) => setNewLocation(e.target.value)} placeholder="Location (optional)" className="bg-surface-base border border-line-default/10 rounded-lg px-3 py-2 text-sm text-ink-primary" />
              <input type="number" value={newMatchday} onChange={(e) => setNewMatchday(e.target.value)} placeholder="Matchday # (optional)" className="bg-surface-base border border-line-default/10 rounded-lg px-3 py-2 text-sm text-ink-primary" />
            </div>
            <button onClick={handleCreateFixture} disabled={busy} className="w-full py-2 rounded-lg bg-brand-primary hover:bg-brand-primary-hov text-brand-primary-fg text-sm font-black uppercase tracking-widest disabled:opacity-40">
              {busy ? 'Saving…' : 'Add fixture'}
            </button>
          </section>
        )}

        <section>
          <h2 className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60 mb-2">Fixtures</h2>
          {loading ? (
            <p className="text-sm text-ink-primary/50 italic">Loading…</p>
          ) : fixtures.length === 0 ? (
            <p className="text-sm text-ink-primary/50 italic">No fixtures yet.</p>
          ) : (
            <div className="space-y-1.5">
              {fixtures.map(f => {
                const draft = scoreDraft[f.id] || { home: '', away: '' };
                return (
                  <div key={f.id} className="rounded-lg bg-surface-elevated ring-1 ring-line-default/10 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <div className="flex items-center gap-2 min-w-0 flex-1 text-sm font-semibold">
                        <span className="truncate">{f.homeTeamName}</span>
                        <span className="text-ink-primary/40 text-xs shrink-0">vs</span>
                        <span className="truncate">{f.awayTeamName}</span>
                      </div>
                      <span className="text-[10px] font-black uppercase tracking-widest text-ink-primary/50 shrink-0">
                        {f.status === 'final' ? `${f.homeScore} – ${f.awayScore}` : f.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                    {isAdmin && f.status !== 'final' && (
                      <div className="flex items-center gap-2 mt-2">
                        <input type="number" min={0} value={draft.home} onChange={(e) => setScoreDraft(p => ({ ...p, [f.id]: { ...draft, home: e.target.value } }))} placeholder="H" className="w-14 bg-surface-base border border-line-default/10 rounded-lg px-2 py-1 text-sm text-ink-primary tabular-nums" />
                        <span className="text-ink-primary/40">–</span>
                        <input type="number" min={0} value={draft.away} onChange={(e) => setScoreDraft(p => ({ ...p, [f.id]: { ...draft, away: e.target.value } }))} placeholder="A" className="w-14 bg-surface-base border border-line-default/10 rounded-lg px-2 py-1 text-sm text-ink-primary tabular-nums" />
                        <button onClick={() => handleReportScore(f.id)} disabled={busy} className="ml-auto px-3 py-1 rounded-lg bg-brand-primary hover:bg-brand-primary-hov text-brand-primary-fg text-[11px] font-black uppercase tracking-widest disabled:opacity-40">
                          Save score
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default LeagueConsole;
