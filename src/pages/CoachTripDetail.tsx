import React, { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { collection, doc, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoachOfTeam } from '../utils/helpers';
import Header from '../components/common/Header';
import type { GameStat, Player, Trip } from '../types';
import { workerFetch } from '../utils/workerFetch';
import { clearTripCache } from '../utils/tripAttribution';
import { getShareOrigin } from '../utils/origin';

/**
 * Coach Trip Detail — /coach/trips/:tripId
 *
 * Roster, tournament leaders, trip totals, share-recap link, archive.
 * Coach-only — parents see the read-only mirror at /trip/:id.
 */

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

const CoachTripDetail: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeam, selectedTeamId } = useTeam();
  const { id: tripId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [stats, setStats] = useState<GameStat[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copyOk, setCopyOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!tripId) return;
    const unsub = onSnapshot(doc(db, 'trips', tripId), (snap) => {
      if (!snap.exists()) { setTrip(null); setLoaded(true); return; }
      const v: any = snap.data();
      setTrip({
        id: snap.id,
        teamId: v.teamId,
        clubId: v.clubId,
        createdBy: v.createdBy,
        createdByName: v.createdByName,
        createdAt: asDate(v.createdAt),
        updatedAt: v.updatedAt ? asDate(v.updatedAt) : undefined,
        isActive: v.isActive !== false,
        name: v.name || '',
        startDate: asDate(v.startDate),
        endDate: asDate(v.endDate),
        description: v.description,
        attendingPlayerIds: Array.isArray(v.attendingPlayerIds) ? v.attendingPlayerIds : [],
        status: v.status === 'archived' ? 'archived' : 'active',
        shareToken: v.shareToken,
      } as Trip);
      setLoaded(true);
    }, () => setLoaded(true));
    return () => unsub();
  }, [tripId]);

  useEffect(() => {
    if (!trip) return;
    (async () => {
      try {
        const q = query(collection(db, 'stats'), where('teamId', '==', trip.teamId), where('tripId', '==', trip.id));
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
        setStats(rows);
      } catch (err) {
        console.warn('[coach-trip-detail] stats load failed', err);
      }
    })();
  }, [trip]);

  useEffect(() => {
    if (!trip) return;
    (async () => {
      try {
        const q = query(collection(db, 'players'), where('teamIds', 'array-contains', trip.teamId));
        const snap = await getDocs(q);
        setPlayers(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as Player[]);
      } catch (err) {
        console.warn('[coach-trip-detail] roster load failed', err);
      }
    })();
  }, [trip]);

  const coachOnThisTeam = isCoachOfTeam(userData as any, selectedTeam as any);

  const totals = useMemo(() => {
    let goals = 0, assists = 0, saves = 0;
    const goalsByPid: Record<string, number> = {};
    const nameByPid: Record<string, string> = {};
    const gameIds = new Set<string>();
    for (const r of stats) {
      goals += r.goals || 0;
      assists += r.assists || 0;
      saves += r.saves || 0;
      if (r.playerId) {
        goalsByPid[r.playerId] = (goalsByPid[r.playerId] || 0) + (r.goals || 0);
        if (r.playerName) nameByPid[r.playerId] = r.playerName;
      }
      if (r.gameId && !r.gameId.startsWith('clip_') && !r.gameId.startsWith('adjust_')) {
        gameIds.add(r.gameId);
      }
    }
    let topScorer: { pid: string; name: string; goals: number } | null = null;
    for (const pid of Object.keys(goalsByPid)) {
      const g = goalsByPid[pid];
      if (!topScorer || g > topScorer.goals) {
        topScorer = { pid, name: nameByPid[pid] || 'Player', goals: g };
      }
    }
    return { goals, assists, saves, gamesCounted: gameIds.size, topScorer };
  }, [stats]);

  const roster = useMemo(() => {
    if (!trip) return [];
    const set = new Set(trip.attendingPlayerIds);
    return players
      .filter(p => set.has(p.id))
      .sort((a, b) => (a.jerseyNumber ?? 999) - (b.jerseyNumber ?? 999));
  }, [trip, players]);

  if (!selectedTeamId) return <Navigate to="/coach" replace />;
  if (!coachOnThisTeam) return <Navigate to="/coach" replace />;
  if (loaded && !trip) return <Navigate to="/coach/trips" replace />;
  if (!trip) return null;

  const archive = async () => {
    if (!trip) return;
    setBusy(true);
    setErr(null);
    try {
      const restore = trip.status === 'archived';
      const res = await workerFetch('/trips/archive', {
        method: 'POST',
        body: JSON.stringify({ tripId: trip.id, restore }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) setErr(data?.hint || data?.error || 'Could not update the trip.');
      clearTripCache(trip.teamId);
    } catch {
      setErr('Could not update the trip.');
    } finally {
      setBusy(false);
    }
  };

  const shareUrl = trip.shareToken
    ? `${getShareOrigin()}/trip/${trip.id}?token=${trip.shareToken}`
    : '';

  const copyShare = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyOk(true);
      window.setTimeout(() => setCopyOk(false), 2000);
    } catch {
      setErr('Could not copy the link. Long-press to copy from the input.');
    }
  };

  return (
    <div className="min-h-screen bg-surface-base">
      <Header title={trip.name} subtitle={fmtRange(trip.startDate, trip.endDate)} />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 space-y-4">
        {/* Trip totals */}
        <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-black uppercase tracking-widest text-brand-primary-soft">
              Trip totals
            </p>
            <span className="text-[10px] font-black uppercase tracking-widest text-ink-primary/40">
              {trip.status === 'archived' ? 'Archived' : 'Active'}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-2 mt-3">
            <TotalTile label="Goals" value={totals.goals} />
            <TotalTile label="Assists" value={totals.assists} />
            <TotalTile label="Saves" value={totals.saves} />
            <TotalTile label="Games" value={totals.gamesCounted} />
          </div>
          {totals.topScorer && totals.topScorer.goals > 0 && (
            <p className="text-xs text-ink-primary/70 mt-4">
              Top scorer: <span className="font-black text-ink-primary">{totals.topScorer.name}</span>
              {' '}with {totals.topScorer.goals} {totals.topScorer.goals === 1 ? 'goal' : 'goals'}.
            </p>
          )}
          {trip.description && (
            <p className="text-xs text-ink-primary/70 mt-3 whitespace-pre-wrap">{trip.description}</p>
          )}
        </div>

        {/* Roster */}
        <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-black text-ink-primary">Traveling squad</p>
            <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/40">
              {roster.length} {roster.length === 1 ? 'player' : 'players'}
            </span>
          </div>
          {roster.length === 0 ? (
            <p className="text-xs text-ink-primary/55 py-4 text-center">
              No one on the traveling roster yet. Edit the trip to add players.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {roster.map(p => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-line-default/[0.04]"
                >
                  <span className="w-6 h-6 rounded-full bg-line-default/[0.08] flex items-center justify-center text-[10px] font-black text-ink-primary/70">
                    {p.jerseyNumber ?? '·'}
                  </span>
                  <span className="text-xs font-bold text-ink-primary truncate">{p.name}</span>
                  {(p as any).isGuest && (
                    <span className="text-[9px] font-black uppercase tracking-widest text-amber-500 ml-auto">G</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Share recap */}
        {shareUrl && (
          <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
            <p className="text-sm font-black text-ink-primary">Share recap</p>
            <p className="text-[11px] text-ink-primary/55 mt-0.5">
              Anyone with this link can view a read-only recap. No sign-in needed.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                type="text"
                readOnly
                value={shareUrl}
                onFocus={e => e.currentTarget.select()}
                className="flex-1 px-3 py-2 rounded-lg bg-surface-base ring-1 ring-line-default/20 text-ink-primary/70 text-xs outline-none"
              />
              <button
                type="button"
                onClick={copyShare}
                className="px-3 py-2 rounded-lg bg-brand-primary text-white text-xs font-black uppercase tracking-widest hover:bg-brand-primary/90 transition"
              >
                {copyOk ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        {err && (
          <div className="rounded-2xl bg-red-500/10 ring-1 ring-red-500/30 p-3 text-sm text-red-500">
            {err}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => navigate('/coach/trips')}
            className="text-xs font-black uppercase tracking-widest text-ink-primary/60 hover:text-ink-primary"
          >
            ← All trips
          </button>
          <button
            type="button"
            onClick={archive}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg ring-1 ring-line-default/20 text-xs font-black uppercase tracking-widest text-ink-primary/70 hover:bg-line-default/[0.06] transition disabled:opacity-40"
          >
            {trip.status === 'archived' ? 'Reactivate' : 'Archive'}
          </button>
        </div>
      </div>
    </div>
  );
};

const TotalTile: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="rounded-lg bg-line-default/[0.04] p-3 text-center">
    <p className="text-xl font-black text-ink-primary tabular-nums">{value}</p>
    <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/50 mt-0.5">{label}</p>
  </div>
);

export default CoachTripDetail;
