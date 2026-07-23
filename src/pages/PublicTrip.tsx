import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { hasWorkerConfig } from '../utils/workerFetch';

/**
 * Public Trip Recap — /trip/:id?token=…
 *
 * Anonymous read-only view of a Trip. Serves the "Share recap" link
 * the coach copies out. No PII beyond player names + high-level totals.
 * Auth is the shareToken in the query string, verified server-side by
 * /trips/public-info.
 *
 * v1.1 fills in the tournament story grandparents actually want to
 * see: date range, roster count, per-game results, and the trip's
 * top scorer. Numbers come from the worker (server-aggregated stat
 * rows scoped by tripId). If the worker's enrichment fails, we still
 * render the base envelope + a soft note.
 */

interface PublicTripGame {
  id: string;
  date: string | null;
  opponent: string;
  homeAway: 'home' | 'away' | null;
  homeScore: number | null;
  awayScore: number | null;
  result: 'win' | 'loss' | 'tie' | null;
}

interface PublicTripStats {
  totalGoals: number;
  totalAssists: number;
  totalSaves: number;
  topScorerName: string | null;
  topScorerGoals: number;
}

interface PublicTripView {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  description: string | null;
  status: string;
  attendingPlayerIds: string[];
  teamName: string;
  games: PublicTripGame[];
  stats: PublicTripStats | null;
  richDataAvailable: boolean;
}

const asDate = (v: string | undefined): Date => v ? new Date(v) : new Date(0);

const fmtRange = (start: Date, end: Date): string => {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: 'America/Denver',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  };
  const s = new Intl.DateTimeFormat('en-US', opts).format(start);
  const e = new Intl.DateTimeFormat('en-US', opts).format(end);
  return `${s} to ${e}`;
};

const fmtGameDate = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(d);
};

const RESULT_STYLES: Record<'win' | 'loss' | 'tie', string> = {
  win: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 ring-1 ring-emerald-500/30',
  loss: 'bg-rose-500/15 text-rose-800 dark:text-rose-300 ring-1 ring-rose-500/30',
  tie: 'bg-amber-500/15 text-amber-800 dark:text-amber-300 ring-1 ring-amber-500/30',
};

const RESULT_LETTER: Record<'win' | 'loss' | 'tie', string> = {
  win: 'W',
  loss: 'L',
  tie: 'T',
};

const PublicTrip: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [trip, setTrip] = useState<PublicTripView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!id) { setErr('This link is missing a trip id.'); setLoaded(true); return; }
    let cancelled = false;

    (async () => {
      // Strategy: hydrate the base envelope FAST from the direct
      // Firestore read (works for signed-in team members via rules),
      // then upgrade with the worker enrichment when the token is
      // present. Anonymous visitors skip straight to the worker path.
      let hydratedFromClient = false;
      try {
        const snap = await getDoc(doc(db, 'trips', id));
        if (!cancelled && snap.exists()) {
          const v: any = snap.data();
          setTrip({
            id: snap.id,
            name: String(v.name || ''),
            startDate: v.startDate?.toDate ? v.startDate.toDate().toISOString() : String(v.startDate || ''),
            endDate: v.endDate?.toDate ? v.endDate.toDate().toISOString() : String(v.endDate || ''),
            description: v.description || null,
            status: v.status || 'active',
            attendingPlayerIds: Array.isArray(v.attendingPlayerIds) ? v.attendingPlayerIds : [],
            teamName: '',
            games: [],
            stats: null,
            richDataAvailable: false,
          });
          hydratedFromClient = true;
          setLoaded(true);
        }
      } catch { /* rules blocked — fall through to worker path */ }

      // Enriched worker call. Anonymous share-link visitors NEED the
      // token; signed-in team members can also upgrade if a token is
      // present (Share sheet always appends it). Skip the call when
      // there's no token AND no worker config — nothing to fetch.
      if (!token) {
        if (!hydratedFromClient) {
          setErr('This link is missing its token.');
          setLoaded(true);
        }
        return;
      }
      if (!hasWorkerConfig()) {
        if (!hydratedFromClient) {
          setErr('Recap link is not configured.');
          setLoaded(true);
        }
        return;
      }
      const url = `${process.env.REACT_APP_NOTIFY_URL || ''}/trips/public-info`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tripId: id, shareToken: token }),
        });
        const data: any = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !data?.ok) {
          if (!hydratedFromClient) {
            setErr(data?.hint || 'This recap link is not available.');
          }
        } else {
          const t = data.trip || {};
          setTrip({
            id: String(t.id || id),
            name: String(t.name || ''),
            startDate: typeof t.startDate === 'string' ? t.startDate : (t.startDate?.toDate?.().toISOString?.() || ''),
            endDate: typeof t.endDate === 'string' ? t.endDate : (t.endDate?.toDate?.().toISOString?.() || ''),
            description: t.description || null,
            status: t.status || 'active',
            attendingPlayerIds: Array.isArray(t.attendingPlayerIds) ? t.attendingPlayerIds : [],
            teamName: String(t.teamName || ''),
            games: Array.isArray(t.games) ? t.games as PublicTripGame[] : [],
            stats: t.stats || null,
            richDataAvailable: t.richDataAvailable !== false,
          });
        }
      } catch {
        if (!hydratedFromClient) {
          setErr('Could not load the recap. Try again.');
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();

    return () => { cancelled = true; };
  }, [id, token]);

  const finalGames = useMemo(() => {
    if (!trip?.games) return { record: null as string | null, finalCount: 0 };
    let w = 0, l = 0, t = 0;
    for (const g of trip.games) {
      if (g.result === 'win') w++;
      else if (g.result === 'loss') l++;
      else if (g.result === 'tie') t++;
    }
    const finalCount = w + l + t;
    if (finalCount === 0) return { record: null, finalCount: 0 };
    const record = t > 0 ? `${w} W · ${l} L · ${t} T` : `${w} W · ${l} L`;
    return { record, finalCount };
  }, [trip]);

  return (
    <div className="min-h-screen bg-surface-base flex items-start sm:items-center justify-center px-4 py-8 sm:py-10">
      <div className="w-full max-w-lg">
        {!loaded && (
          <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-6 text-center">
            <p className="text-xs text-ink-primary/55">Loading recap</p>
          </div>
        )}
        {loaded && err && !trip && (
          <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-6 text-center">
            <p className="text-sm font-black text-ink-primary">Recap unavailable</p>
            <p className="text-xs text-ink-primary/55 mt-1">{err}</p>
          </div>
        )}
        {loaded && trip && (
          <div className="space-y-4">
            {/* Header card — team, name, dates, description, roster count. */}
            <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-5 sm:p-6">
              <p className="text-[10px] font-black uppercase tracking-widest text-brand-primary-soft">
                {trip.teamName || 'Team'}
              </p>
              <h1 className="text-xl sm:text-2xl font-black text-ink-primary mt-1 leading-tight">
                {trip.name}
              </h1>
              <p className="text-xs text-ink-primary/60 mt-1">
                {fmtRange(asDate(trip.startDate), asDate(trip.endDate))}
              </p>
              {trip.description && (
                <p className="text-sm text-ink-primary/80 mt-4 whitespace-pre-wrap">{trip.description}</p>
              )}
              <div className="mt-5 grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-line-default/[0.04] p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/50">
                    Traveling squad
                  </p>
                  <p className="text-sm font-black text-ink-primary mt-1">
                    {trip.attendingPlayerIds?.length || 0}{' '}
                    {(trip.attendingPlayerIds?.length || 0) === 1 ? 'player' : 'players'}
                  </p>
                </div>
                {finalGames.record && (
                  <div className="rounded-lg bg-line-default/[0.04] p-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/50">
                      Record
                    </p>
                    <p className="text-sm font-black text-ink-primary mt-1">
                      {finalGames.record}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Stats totals — only when the worker returned aggregate. */}
            {trip.stats && (trip.stats.totalGoals > 0 || trip.stats.totalAssists > 0 || trip.stats.totalSaves > 0) && (
              <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-5 sm:p-6">
                <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/50">
                  How it went
                </p>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <TotalTile label="Goals" value={trip.stats.totalGoals} />
                  <TotalTile label="Assists" value={trip.stats.totalAssists} />
                  <TotalTile label="Saves" value={trip.stats.totalSaves} />
                </div>
                {trip.stats.topScorerName && trip.stats.topScorerGoals > 0 && (
                  <p className="text-xs text-ink-primary/70 mt-4">
                    Top scorer:{' '}
                    <span className="font-black text-ink-primary">{trip.stats.topScorerName}</span>{' '}
                    with {trip.stats.topScorerGoals}{' '}
                    {trip.stats.topScorerGoals === 1 ? 'goal' : 'goals'}
                  </p>
                )}
              </div>
            )}

            {/* Games list — each row shows date, matchup, score badge. */}
            {trip.games && trip.games.length > 0 && (
              <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-5 sm:p-6">
                <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/50">
                  Games
                </p>
                <ul className="mt-3 divide-y divide-line-default/10">
                  {trip.games.map((g) => (
                    <li key={g.id} className="py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-black text-ink-primary truncate">
                          {trip.teamName || 'Us'} vs {g.opponent}
                        </p>
                        <p className="text-[11px] text-ink-primary/55 mt-0.5">
                          {fmtGameDate(g.date)}
                          {g.homeAway && (
                            <>
                              <span className="mx-1.5 text-ink-primary/30">·</span>
                              {g.homeAway === 'home' ? 'Home' : 'Away'}
                            </>
                          )}
                        </p>
                      </div>
                      {g.result && g.homeScore != null && g.awayScore != null ? (
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-black text-ink-primary tabular-nums">
                            {g.homeScore}-{g.awayScore}
                          </span>
                          <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full ${RESULT_STYLES[g.result]}`}>
                            {RESULT_LETTER[g.result]}
                          </span>
                        </div>
                      ) : (
                        <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-line-default/10 text-ink-primary/60 ring-1 ring-line-default/15">
                          Upcoming
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Soft fallback note when the worker couldn't enrich. Keeps
                the shared link from looking broken — grandparent still
                sees name / dates / roster count above. */}
            {!trip.richDataAvailable && trip.games.length === 0 && !trip.stats && (
              <p className="text-[11px] text-ink-primary/45 text-center">
                Game results will show up here once the coach finishes them.
              </p>
            )}

            <p className="text-[10px] text-ink-primary/40 text-center pt-1">
              Shared via GoalKickr
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

const TotalTile: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="rounded-lg bg-line-default/[0.04] p-3 text-center">
    <p className="text-2xl font-black text-ink-primary tabular-nums">{value}</p>
    <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/50 mt-0.5">{label}</p>
  </div>
);

export default PublicTrip;
