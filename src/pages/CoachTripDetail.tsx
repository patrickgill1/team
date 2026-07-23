import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { collection, doc, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoachOfTeam } from '../utils/helpers';
import { isGuestActive } from '../types';
import Header from '../components/common/Header';
import type { CalendarEvent, GameStat, Player, Trip } from '../types';
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

// Format a Date as YYYY-MM-DD in America/Denver (matches
// CoachTripCreate). Used to hydrate the <input type="date"> in the
// edit modal without timezone drift.
function toDenverIsoDate(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const y = parts.find(p => p.type === 'year')?.value || '';
  const m = parts.find(p => p.type === 'month')?.value || '';
  const day = parts.find(p => p.type === 'day')?.value || '';
  return `${y}-${m}-${day}`;
}

// Warm date label for the games list: "Fri Aug 8" — no year, since
// the enclosing card already scopes to the trip window.
function fmtGameDay(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

// Time-only formatter: "5:30 PM".
function fmtGameTime(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

const CoachTripDetail: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeam, selectedTeamId } = useTeam();
  const { id: tripId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [stats, setStats] = useState<GameStat[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [games, setGames] = useState<CalendarEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copyOk, setCopyOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

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

  // Games in the trip window. One live-subscribed query on
  // events.teamId (Firestore doesn't compose date+type range filters
  // cleanly without a composite index, and the count per team is tiny)
  // — filter by type + date + isCancelled/isActive on the client.
  // Re-runs whenever the trip window shifts after an edit-modal save.
  useEffect(() => {
    if (!trip) return;
    const qEvents = query(collection(db, 'events'), where('teamId', '==', trip.teamId));
    const unsub = onSnapshot(qEvents, (snap) => {
      const startMs = trip.startDate.getTime();
      const endMs = trip.endDate.getTime();
      const rows: CalendarEvent[] = [];
      snap.forEach(d => {
        const data: any = d.data();
        if (data.type !== 'game') return;
        if (data.isActive === false) return;
        if (data.isCancelled === true) return;
        const dateMs = (data.date?.toDate?.() ?? new Date(data.date || 0)).getTime?.() || 0;
        if (!dateMs) return;
        if (dateMs < startMs || dateMs > endMs) return;
        rows.push({
          id: d.id,
          ...data,
          date: data.date?.toDate?.() || new Date(data.date),
        } as CalendarEvent);
      });
      rows.sort((a, b) => a.date.getTime() - b.date.getTime());
      setGames(rows);
    }, (err) => console.warn('[coach-trip-detail] games load failed', err));
    return () => unsub();
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
        {/* Games — scheduled first so coach sees the plan before the totals. */}
        <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-black text-ink-primary">Games</p>
            <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/40">
              {games.length} {games.length === 1 ? 'game' : 'games'}
            </span>
          </div>
          {games.length === 0 ? (
            <p className="text-xs text-ink-primary/55 py-4 text-center">
              No games in this window yet. Add games to your calendar for {fmtRange(trip.startDate, trip.endDate)} to see them here.
            </p>
          ) : (
            <div className="space-y-1">
              {games.map(g => {
                // Prefer event.result (coach-typed final, e.g. "W 3-1"
                // or "3-1"). Fall back to a numeric ourScore/oppScore
                // if the endGame flow ever snapshots them onto events —
                // this stays forward-compatible without requiring it.
                const resultStr = typeof g.result === 'string' ? g.result.trim() : '';
                const ours = (g as any).ourScore;
                const theirs = (g as any).oppScore;
                const numericScore = typeof ours === 'number' && typeof theirs === 'number'
                  ? `${ours}-${theirs}` : '';
                const scoreLabel = resultStr || numericScore;
                const opp = g.opponent || 'Opponent TBA';
                const homeAway = g.homeAway === 'home' ? 'vs' : g.homeAway === 'away' ? 'at' : 'vs';
                const isPast = g.date.getTime() < Date.now();
                return (
                  <Link
                    key={g.id}
                    to={`/events/${g.id}`}
                    className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg hover:bg-line-default/[0.06] transition min-h-11"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-ink-primary truncate">
                        {homeAway} {opp}
                      </p>
                      <p className="text-[11px] text-ink-primary/55 mt-0.5">
                        {fmtGameDay(g.date)} · {isPast ? `Kicked off at ${fmtGameTime(g.date)}` : `Kickoff at ${fmtGameTime(g.date)}`}
                      </p>
                    </div>
                    {scoreLabel ? (
                      <span className="text-sm font-black text-ink-primary tabular-nums shrink-0">
                        {scoreLabel}
                      </span>
                    ) : (
                      <span className="text-[10px] font-black uppercase tracking-widest text-ink-primary/40 shrink-0">
                        {isPast ? 'Final' : 'Scheduled'}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          )}
        </div>

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
            className="min-h-11 text-xs font-black uppercase tracking-widest text-ink-primary/60 hover:text-ink-primary"
          >
            ← All trips
          </button>
          <div className="flex items-center gap-2">
            {trip.status !== 'archived' && (
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="min-h-11 px-3 py-1.5 rounded-lg ring-1 ring-line-default/20 text-xs font-black uppercase tracking-widest text-ink-primary/70 hover:bg-line-default/[0.06] transition"
              >
                Edit trip
              </button>
            )}
            <button
              type="button"
              onClick={archive}
              disabled={busy}
              className="min-h-11 px-3 py-1.5 rounded-lg ring-1 ring-line-default/20 text-xs font-black uppercase tracking-widest text-ink-primary/70 hover:bg-line-default/[0.06] transition disabled:opacity-40"
            >
              {trip.status === 'archived' ? 'Restore' : 'Archive'}
            </button>
          </div>
        </div>
      </div>
      {editOpen && (
        <EditTripModal
          trip={trip}
          players={players}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            // Trip doc onSnapshot picks up the write; clear the
            // resolver cache so any in-flight endGame stamps see the
            // fresh window / roster within the 30s cache TTL.
            clearTripCache(trip.teamId);
            setEditOpen(false);
          }}
        />
      )}
    </div>
  );
};

const TotalTile: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="rounded-lg bg-line-default/[0.04] p-3 text-center">
    <p className="text-xl font-black text-ink-primary tabular-nums">{value}</p>
    <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/50 mt-0.5">{label}</p>
  </div>
);

/**
 * Edit trip modal — coach edits name, window, notes, traveling squad.
 *
 * Save strategy:
 *   - Roster deltas (added / removed players) go through
 *     POST /trips/attend, which uses arrayUnion/arrayRemove transforms
 *     server-side. A concurrent parent-flow write to the same trip
 *     won't clobber the coach's edits (or vice versa).
 *   - Scalar fields (name / window / notes) only fire /trips/update if
 *     they actually changed, so an untouched edit is a no-op.
 *
 * The original attending roster is snapshotted on mount so a live
 * onSnapshot refresh mid-edit doesn't confuse the diff — the coach
 * saves what they saw.
 */
const EditTripModal: React.FC<{
  trip: Trip;
  players: Player[];
  onClose: () => void;
  onSaved: () => void;
}> = ({ trip, players, onClose, onSaved }) => {
  const [name, setName] = useState(trip.name);
  const [description, setDescription] = useState(trip.description || '');
  const [startDate, setStartDate] = useState(toDenverIsoDate(trip.startDate));
  const [endDate, setEndDate] = useState(toDenverIsoDate(trip.endDate));
  // Snapshot the original roster once on mount. If the live trip
  // subscription refreshes while the coach is editing, the diff we
  // send is still relative to what they opened, not what shifted
  // under them.
  const originalAttendingRef = useRef<string[]>(
    Array.isArray(trip.attendingPlayerIds) ? [...trip.attendingPlayerIds] : [],
  );
  const originalNameRef = useRef<string>(trip.name || '');
  const originalDescriptionRef = useRef<string>(trip.description || '');
  const originalStartIsoRef = useRef<string>(toDenverIsoDate(trip.startDate));
  const originalEndIsoRef = useRef<string>(toDenverIsoDate(trip.endDate));
  const [pickedIds, setPickedIds] = useState<Set<string>>(
    () => new Set(originalAttendingRef.current),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Active roster picker — mirrors CoachTripCreate exactly so the
  // shape of the checklist doesn't change on edit.
  const roster = useMemo(() => {
    const list = players
      .filter((p: any) => p.isActive !== false && isGuestActive(p))
      .slice();
    list.sort((a: any, b: any) => {
      const ja = a.jerseyNumber ?? 999;
      const jb = b.jerseyNumber ?? 999;
      if (ja !== jb) return ja - jb;
      return (a.name || '').localeCompare(b.name || '');
    });
    return list;
  }, [players]);

  const canSubmit = useMemo(() => {
    return name.trim().length > 0 && !!startDate && !!endDate && startDate <= endDate && !busy;
  }, [name, startDate, endDate, busy]);

  const togglePlayer = (pid: string) => {
    setPickedIds(prev => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      // Diff the scalar fields — only fire /trips/update if any of
      // them actually changed. Prevents an accidental "Save" from
      // rewriting fields on a trip a parent flow may have touched.
      const trimmedName = name.trim();
      const trimmedDescription = description.trim();
      const patch: Record<string, any> = {};
      if (trimmedName !== originalNameRef.current.trim()) {
        patch.name = trimmedName;
      }
      if (trimmedDescription !== (originalDescriptionRef.current || '').trim()) {
        patch.description = trimmedDescription;
      }
      if (startDate !== originalStartIsoRef.current) {
        // Same Denver-anchored ISO conversion as CoachTripCreate — a
        // coach in Utah picking "Aug 6" gets Denver-midnight on the 6th.
        patch.startDate = new Date(`${startDate}T00:00:00-07:00`).toISOString();
      }
      if (endDate !== originalEndIsoRef.current) {
        patch.endDate = new Date(`${endDate}T23:59:59-06:00`).toISOString();
      }

      // Roster diff. Compute added / removed against the snapshot
      // taken when the modal opened, then fire per-player attend calls.
      // /trips/attend uses arrayUnion/arrayRemove server-side so
      // concurrent writes from a parent RSVP flow don't clobber the
      // coach's edits (and vice versa).
      const originalSet = new Set(originalAttendingRef.current);
      const nextSet = pickedIds;
      const added: string[] = [];
      const removed: string[] = [];
      nextSet.forEach(id => { if (!originalSet.has(id)) added.push(id); });
      originalSet.forEach(id => { if (!nextSet.has(id)) removed.push(id); });

      // Scalar patch first — cheap and helps the user see the header
      // update reflect immediately. Skip the call entirely if nothing
      // scalar changed.
      if (Object.keys(patch).length > 0) {
        const res = await workerFetch('/trips/update', {
          method: 'POST',
          body: JSON.stringify({ tripId: trip.id, patch }),
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          setErr(data?.hint || data?.error || 'Could not save the trip. Try again.');
          return;
        }
      }

      // Roster deltas. If any attend call fails, surface a toast and
      // bail — local state stays intact so the coach sees exactly what
      // they had picked and can retry. onSnapshot will reconcile any
      // deltas that did land.
      const attendCalls = [
        ...added.map(playerId => ({ playerId, going: true })),
        ...removed.map(playerId => ({ playerId, going: false })),
      ];
      const failures: string[] = [];
      for (const call of attendCalls) {
        try {
          const res = await workerFetch('/trips/attend', {
            method: 'POST',
            body: JSON.stringify({ tripId: trip.id, playerId: call.playerId, going: call.going }),
          });
          const data: any = await res.json().catch(() => ({}));
          if (!res.ok || !data?.ok) failures.push(call.playerId);
        } catch {
          failures.push(call.playerId);
        }
      }
      if (failures.length > 0) {
        setErr(
          failures.length === attendCalls.length
            ? 'Could not update the traveling squad. Try again.'
            : `Saved partially — ${failures.length} roster ${failures.length === 1 ? 'change' : 'changes'} didn't stick. Try again.`,
        );
        return;
      }

      onSaved();
    } catch (e) {
      console.error(e);
      setErr('Could not save the trip. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="bg-surface-elevated w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl ring-1 ring-line-default/15 max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-4 sm:px-5 pt-4 pb-2 shrink-0">
          <p className="text-sm font-black text-ink-primary truncate">
            Edit {trip.name}
          </p>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-11 min-w-11 text-xs font-black uppercase tracking-widest text-ink-primary/50 hover:text-ink-primary disabled:opacity-40"
            aria-label="Close"
          >
            Close
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 sm:px-5 pb-3 space-y-4">
          <div>
            <label className="block text-[11px] font-black uppercase tracking-widest text-ink-primary/60 mb-1">
              Trip name
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-surface-base ring-1 ring-line-default/20 focus:ring-brand-primary/60 text-ink-primary text-sm outline-none min-h-11"
              maxLength={120}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-black uppercase tracking-widest text-ink-primary/60 mb-1">
                First day
              </label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-surface-base ring-1 ring-line-default/20 focus:ring-brand-primary/60 text-ink-primary text-sm outline-none min-h-11"
              />
            </div>
            <div>
              <label className="block text-[11px] font-black uppercase tracking-widest text-ink-primary/60 mb-1">
                Last day
              </label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-surface-base ring-1 ring-line-default/20 focus:ring-brand-primary/60 text-ink-primary text-sm outline-none min-h-11"
              />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-black uppercase tracking-widest text-ink-primary/60 mb-1">
              Notes (optional)
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Anything the traveling families should know."
              className="w-full px-3 py-2 rounded-lg bg-surface-base ring-1 ring-line-default/20 focus:ring-brand-primary/60 text-ink-primary text-sm outline-none min-h-[80px]"
              maxLength={2000}
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-sm font-black text-ink-primary">Traveling squad</p>
                <p className="text-[11px] text-ink-primary/55 mt-0.5">
                  Add or remove anyone; the trip totals will re-scope automatically.
                </p>
              </div>
              <span className="text-[11px] font-black uppercase tracking-widest text-brand-primary-soft shrink-0">
                {pickedIds.size} of {roster.length}
              </span>
            </div>
            {roster.length === 0 ? (
              <p className="text-xs text-ink-primary/55 py-4 text-center">
                No active players on the roster yet.
              </p>
            ) : (
              <div className="space-y-1">
                {roster.map(p => {
                  const on = pickedIds.has(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => togglePlayer(p.id)}
                      className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-left transition min-h-11 ${
                        on ? 'bg-brand-primary/10 ring-1 ring-brand-primary/30' : 'hover:bg-line-default/[0.06] ring-1 ring-transparent'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-6 h-6 rounded-full bg-line-default/[0.08] flex items-center justify-center text-[10px] font-black text-ink-primary/70">
                          {p.jerseyNumber ?? '·'}
                        </span>
                        <span className="text-sm font-bold text-ink-primary truncate">{p.name}</span>
                        {(p as any).isGuest && (
                          <span className="text-[9px] font-black uppercase tracking-widest text-amber-500">
                            Guest
                          </span>
                        )}
                      </div>
                      <span
                        className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black ${
                          on ? 'bg-brand-primary text-white' : 'bg-line-default/[0.15] text-ink-primary/40'
                        }`}
                        aria-hidden
                      >
                        {on && (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {err && (
            <div className="rounded-2xl bg-red-500/10 ring-1 ring-red-500/30 p-3 text-sm text-red-500">
              {err}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 sm:px-5 py-3 border-t border-line-default/10 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-11 px-4 py-2 rounded-lg text-sm font-black uppercase tracking-widest text-ink-primary/60 hover:text-ink-primary disabled:opacity-40"
          >
            Nevermind
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="min-h-11 px-4 py-2 rounded-lg bg-brand-primary text-white text-sm font-black uppercase tracking-widest disabled:opacity-40 hover:bg-brand-primary/90 transition"
          >
            {busy ? 'Saving' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CoachTripDetail;
