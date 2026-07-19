import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, orderBy, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import type { GameStat, Trip } from '../../types';

/**
 * PlayerTripsCard — Tournaments section on Player Profile → Stats.
 *
 * Renders one row per Trip the player has stats in, showing per-trip
 * goals / assists / saves. Empty state hides the section entirely so
 * players who've never been on a tournament roster don't see a stub.
 *
 * Read shape:
 *   1. Fetch all `stats/{id}` with playerId == this player.
 *   2. Bucket by tripId (rows without one are the season path — ignored).
 *   3. Fetch the trip docs for those tripIds to render names + dates.
 *
 * No new indexes. Rows count is bounded (a player has a handful of
 * trips a year); the per-player query already exists in
 * getStatsByPlayer.
 */

interface Bucket {
  tripId: string;
  goals: number;
  assists: number;
  saves: number;
  games: Set<string>;
}

const asDate = (v: any): Date => v?.toDate?.() || (v ? new Date(v) : new Date(0));

const fmtRange = (start: Date, end: Date): string => {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: 'America/Denver',
    month: 'short',
    day: 'numeric',
  };
  const s = new Intl.DateTimeFormat('en-US', opts).format(start);
  const e = new Intl.DateTimeFormat('en-US', {
    ...opts,
    year: start.getFullYear() === end.getFullYear() ? undefined : 'numeric',
  }).format(end);
  return `${s} to ${e}`;
};

interface Props {
  playerId: string;
  /** When set, only this coach's trips render (parents see just the
   *  trips their kid was on, not the full team history). */
  canLinkToTrip?: boolean;
}

const PlayerTripsCard: React.FC<Props> = ({ playerId, canLinkToTrip = true }) => {
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [tripsById, setTripsById] = useState<Record<string, Trip>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!playerId) return;
    let cancelled = false;
    (async () => {
      try {
        const q = query(
          collection(db, 'stats'),
          where('playerId', '==', playerId),
          orderBy('createdAt', 'desc'),
        );
        const snap = await getDocs(q);
        const rows: GameStat[] = snap.docs.map(d => {
          const data: any = d.data();
          return {
            id: d.id,
            ...data,
            gameDate: asDate(data.gameDate),
            createdAt: asDate(data.createdAt),
          } as GameStat;
        });
        const byTrip = new Map<string, Bucket>();
        for (const r of rows) {
          const tripId = (r as any).tripId as string | undefined;
          if (!tripId) continue;
          if (!byTrip.has(tripId)) {
            byTrip.set(tripId, {
              tripId,
              goals: 0, assists: 0, saves: 0,
              games: new Set<string>(),
            });
          }
          const b = byTrip.get(tripId)!;
          b.goals += r.goals || 0;
          b.assists += r.assists || 0;
          b.saves += r.saves || 0;
          const gid = r.gameId || '';
          if (gid && !gid.startsWith('clip_') && !gid.startsWith('adjust_')) {
            b.games.add(gid);
          }
        }
        const arr = Array.from(byTrip.values());
        // Fetch each trip doc — small N (unique tripIds per player).
        const tripEntries = await Promise.all(arr.map(async b => {
          try {
            const s2 = await getDoc(doc(db, 'trips', b.tripId));
            if (!s2.exists()) return null;
            const v: any = s2.data();
            return [b.tripId, {
              id: s2.id,
              teamId: v.teamId,
              createdBy: v.createdBy,
              createdAt: asDate(v.createdAt),
              isActive: v.isActive !== false,
              name: v.name || '',
              startDate: asDate(v.startDate),
              endDate: asDate(v.endDate),
              description: v.description,
              attendingPlayerIds: Array.isArray(v.attendingPlayerIds) ? v.attendingPlayerIds : [],
              status: v.status === 'archived' ? 'archived' : 'active',
              shareToken: v.shareToken,
            } as Trip] as const;
          } catch { return null; }
        }));
        const map: Record<string, Trip> = {};
        for (const t of tripEntries) if (t) map[t[0]] = t[1];
        if (cancelled) return;
        // Sort by trip startDate desc; drop buckets whose trip we
        // couldn't resolve (rare — trip archived + deleted).
        arr.sort((a, b) => {
          const at = map[a.tripId]?.startDate?.getTime() || 0;
          const bt = map[b.tripId]?.startDate?.getTime() || 0;
          return bt - at;
        });
        setBuckets(arr.filter(b => !!map[b.tripId]));
        setTripsById(map);
        setLoaded(true);
      } catch (err) {
        console.warn('[player-trips-card] load failed', err);
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [playerId]);

  const rows = useMemo(() => buckets.map(b => ({ b, trip: tripsById[b.tripId] })).filter(r => r.trip), [buckets, tripsById]);

  // Empty state — hide entirely so surface stays clean for kids who've
  // never traveled.
  if (!loaded || rows.length === 0) return null;

  return (
    <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-black uppercase tracking-widest text-brand-primary-soft">
          Tournaments
        </p>
        <span className="text-[10px] text-ink-primary/40">{rows.length}</span>
      </div>
      <div className="space-y-2">
        {rows.map(({ b, trip }) => {
          const body = (
            <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-line-default/[0.04]">
              <div className="min-w-0">
                <p className="text-sm font-black text-ink-primary truncate">{trip.name}</p>
                <p className="text-[11px] text-ink-primary/55">
                  {fmtRange(trip.startDate, trip.endDate)}
                </p>
              </div>
              <div className="flex items-center gap-3 text-[11px] font-black uppercase tracking-widest">
                <StatChip label="G" value={b.goals} />
                <StatChip label="A" value={b.assists} />
                <StatChip label="Sv" value={b.saves} />
              </div>
            </div>
          );
          return canLinkToTrip ? (
            <Link key={b.tripId} to={`/coach/trips/${b.tripId}`} className="block hover:opacity-90 transition">
              {body}
            </Link>
          ) : (
            <div key={b.tripId}>{body}</div>
          );
        })}
      </div>
    </div>
  );
};

const StatChip: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="flex flex-col items-end">
    <span className="text-sm text-ink-primary tabular-nums">{value}</span>
    <span className="text-[9px] text-ink-primary/40">{label}</span>
  </div>
);

export default PlayerTripsCard;
