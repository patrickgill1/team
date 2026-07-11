// Public league page — /l/:leagueId. Read-only view of a league:
// standings table, fixtures grouped by matchday, list of teams.
// Anyone with the link can see it (Firestore rule allows public
// reads on leagues.isPublic===true + fixtures/standings unrestricted).
// Coaches / league admins bounce to the League Console for edits.

import React, { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { doc, getDoc, collection, query, where, getDocs, orderBy } from 'firebase/firestore';
import { db } from '../utils/firebase';
import type { League, Fixture, StandingsDoc } from '../types';

const PublicLeague: React.FC = () => {
  const { leagueId } = useParams<{ leagueId: string }>();
  const [league, setLeague] = useState<League | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [standings, setStandings] = useState<StandingsDoc | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!leagueId) return;
    let cancelled = false;
    (async () => {
      try {
        const [leagueSnap, standingsSnap, fxSnap] = await Promise.all([
          getDoc(doc(db, 'leagues', leagueId)),
          getDoc(doc(db, 'standings', leagueId)),
          getDocs(query(
            collection(db, 'fixtures'),
            where('leagueId', '==', leagueId),
            orderBy('date', 'asc'),
          )),
        ]);
        if (cancelled) return;
        if (!leagueSnap.exists()) { setNotFound(true); return; }
        const l: any = { id: leagueSnap.id, ...leagueSnap.data() };
        l.createdAt = l.createdAt?.toDate?.() || new Date();
        setLeague(l as League);
        const s: any = standingsSnap.exists() ? { id: standingsSnap.id, ...standingsSnap.data() } : null;
        if (s?.updatedAt?.toDate) s.updatedAt = s.updatedAt.toDate();
        setStandings(s as StandingsDoc | null);
        const fx: Fixture[] = fxSnap.docs.map(d => {
          const data: any = d.data();
          return {
            id: d.id,
            ...data,
            date: data.date?.toDate?.() || new Date(data.date),
          };
        });
        setFixtures(fx);
      } catch (err) {
        console.error('[public-league] load failed', err);
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [leagueId]);

  const grouped = useMemo(() => {
    const map = new Map<string, Fixture[]>();
    for (const f of fixtures) {
      const key = f.matchday ? `Matchday ${f.matchday}` : f.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const arr = map.get(key) || [];
      arr.push(f);
      map.set(key, arr);
    }
    return Array.from(map.entries());
  }, [fixtures]);

  if (notFound) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center px-6">
        <div className="text-center">
          <p className="text-lg font-black text-ink-primary mb-2">League not found</p>
          <p className="text-sm text-ink-primary/60">The link may be invalid or the league was made private.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-base text-ink-primary pb-16">
      <header className="border-b border-line-default/10 px-4 sm:px-6 pt-6 pb-4">
        <div className="max-w-4xl mx-auto">
          <p className="text-[10px] font-black uppercase tracking-widest text-brand-primary-soft mb-1">League</p>
          <h1 className="text-2xl sm:text-3xl font-black text-ink-primary">{loading ? 'Loading…' : (league?.name || 'League')}</h1>
          {league?.season && (
            <p className="text-sm text-ink-primary/60 mt-1">{league.season}</p>
          )}
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Standings */}
        <section>
          <h2 className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60 mb-2">Standings</h2>
          {standings && standings.rows && standings.rows.length > 0 ? (
            <div className="overflow-x-auto rounded-xl ring-1 ring-line-default/10">
              <table className="w-full text-sm">
                <thead className="bg-surface-elevated text-[10px] font-black uppercase tracking-widest text-ink-primary/60">
                  <tr>
                    <th className="text-left px-3 py-2 w-8">#</th>
                    <th className="text-left px-3 py-2">Team</th>
                    <th className="text-right px-2 py-2">P</th>
                    <th className="text-right px-2 py-2">W</th>
                    <th className="text-right px-2 py-2">D</th>
                    <th className="text-right px-2 py-2">L</th>
                    <th className="text-right px-2 py-2">GF</th>
                    <th className="text-right px-2 py-2">GA</th>
                    <th className="text-right px-2 py-2">GD</th>
                    <th className="text-right px-2 py-2 font-black">Pts</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.rows.map((row, i) => (
                    <tr key={row.teamId} className={i % 2 === 0 ? 'bg-surface-base' : 'bg-surface-elevated/40'}>
                      <td className="px-3 py-2 text-ink-primary/50 font-mono text-xs">{i + 1}</td>
                      <td className="px-3 py-2 font-semibold truncate max-w-[180px]">{row.teamName}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{row.played}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{row.wins}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{row.draws}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{row.losses}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{row.goalsFor}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{row.goalsAgainst}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{row.goalDifference > 0 ? '+' : ''}{row.goalDifference}</td>
                      <td className="px-2 py-2 text-right font-black tabular-nums">{row.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-ink-primary/50 italic">No games played yet.</p>
          )}
        </section>

        {/* Fixtures */}
        <section>
          <h2 className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60 mb-2">Fixtures</h2>
          {grouped.length === 0 ? (
            <p className="text-sm text-ink-primary/50 italic">No fixtures scheduled.</p>
          ) : (
            <div className="space-y-4">
              {grouped.map(([label, group]) => (
                <div key={label}>
                  <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/45 mb-1">{label}</p>
                  <div className="space-y-1.5">
                    {group.map(f => (
                      <div key={f.id} className="flex items-center justify-between rounded-lg bg-surface-elevated ring-1 ring-line-default/10 px-3 py-2.5 text-sm">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <span className="truncate font-semibold">{f.homeTeamName}</span>
                          <span className="text-ink-primary/40 text-xs shrink-0">vs</span>
                          <span className="truncate font-semibold">{f.awayTeamName}</span>
                        </div>
                        <div className="shrink-0 ml-3 text-right">
                          {f.status === 'final' ? (
                            <span className="text-base font-black tabular-nums">
                              {f.homeScore} <span className="text-ink-primary/30">–</span> {f.awayScore}
                            </span>
                          ) : (
                            <span className="text-[10px] font-black uppercase tracking-widest text-ink-primary/50">
                              {f.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                              {' · '}
                              {f.date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <p className="text-[10px] text-ink-primary/40 text-center pt-4">
          Powered by <Link to="/" className="text-brand-primary-soft hover:underline">GoalKickr</Link>
        </p>
      </div>
    </div>
  );
};

export default PublicLeague;
