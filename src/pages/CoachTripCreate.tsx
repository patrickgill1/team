import React, { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoachOfTeam } from '../utils/helpers';
import { isGuestActive } from '../types';
import Header from '../components/common/Header';
import type { Player } from '../types';
import { workerFetch } from '../utils/workerFetch';
import { clearTripCache } from '../utils/tripAttribution';

/**
 * Coach Trip Create — /coach/trips/new
 *
 * Coach creates a Trip: name, window, roster subset, optional
 * description. Stats logged during the window on this team will
 * auto-attribute to the trip bucket (excluded from season aggregates).
 *
 * Warm copy per feedback_copy_voice. Never "tournament event";
 * consistently "trip". Roster picker starts empty because a trip's
 * traveling squad is almost always smaller than the full team.
 */

// Format a Date as YYYY-MM-DD in America/Denver so the input default
// respects the user's local calendar day, not UTC.
function todayInDenverIso(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year')?.value || '';
  const m = parts.find(p => p.type === 'month')?.value || '';
  const d = parts.find(p => p.type === 'day')?.value || '';
  return `${y}-${m}-${d}`;
}

function isoPlusDaysDenver(days: number): string {
  const today = new Date();
  today.setDate(today.getDate() + days);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(today);
  const y = parts.find(p => p.type === 'year')?.value || '';
  const m = parts.find(p => p.type === 'month')?.value || '';
  const d = parts.find(p => p.type === 'day')?.value || '';
  return `${y}-${m}-${d}`;
}

const CoachTripCreate: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeam, selectedTeamId } = useTeam();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState(todayInDenverIso());
  const [endDate, setEndDate] = useState(isoPlusDaysDenver(2));
  const [roster, setRoster] = useState<Player[]>([]);
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedTeamId) { setRoster([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const q = query(collection(db, 'players'), where('teamIds', 'array-contains', selectedTeamId));
        const snap = await getDocs(q);
        const list = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter((p: any) => p.isActive !== false && isGuestActive(p)) as Player[];
        list.sort((a, b) => {
          const ja = a.jerseyNumber ?? 999;
          const jb = b.jerseyNumber ?? 999;
          if (ja !== jb) return ja - jb;
          return (a.name || '').localeCompare(b.name || '');
        });
        if (!cancelled) setRoster(list);
      } catch (err) {
        console.warn('[coach-trip-create] roster load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId]);

  const coachOnThisTeam = isCoachOfTeam(userData as any, selectedTeam as any);

  const canSubmit = useMemo(() => {
    return name.trim().length > 0 && !!startDate && !!endDate && startDate <= endDate;
  }, [name, startDate, endDate]);

  if (!coachOnThisTeam) return <Navigate to="/coach" replace />;

  const submit = async () => {
    if (!canSubmit || !selectedTeamId) return;
    setBusy(true);
    setErr(null);
    try {
      // Interpret dates at America/Denver so a coach in Utah picking
      // "March 12" gets a window that starts at midnight Denver, not
      // wherever the browser locale defaulted.
      // Store the raw YYYY-MM-DD chosen as local-midnight ISO;
      // the worker treats them as absolute instants + the attribution
      // helper expands to end-of-day Denver on read.
      const body = {
        teamId: selectedTeamId,
        name: name.trim(),
        startDate: new Date(`${startDate}T00:00:00-07:00`).toISOString(),
        endDate: new Date(`${endDate}T23:59:59-06:00`).toISOString(),
        description: description.trim() || undefined,
        attendingPlayerIds: Array.from(pickedIds),
      };
      const res = await workerFetch('/trips/create', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setErr(data?.hint || data?.error || 'Could not create the trip. Try again.');
        return;
      }
      clearTripCache(selectedTeamId);
      navigate(`/coach/trips/${data.id}`);
    } catch (e) {
      console.error(e);
      setErr('Could not create the trip. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const togglePlayer = (pid: string) => {
    setPickedIds(prev => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-surface-base">
      <Header title="New trip" subtitle={selectedTeam ? selectedTeam.name : ''} />
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-4 space-y-4">
        <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5 space-y-4">
          <div>
            <label className="block text-[11px] font-black uppercase tracking-widest text-ink-primary/60 mb-1">
              Trip name
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Vegas Cup 2026"
              className="w-full min-h-11 px-3 py-3 rounded-lg bg-surface-base ring-1 ring-line-default/20 focus:ring-brand-primary/60 text-ink-primary text-sm outline-none"
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
                className="w-full min-h-11 px-3 py-3 rounded-lg bg-surface-base ring-1 ring-line-default/20 focus:ring-brand-primary/60 text-ink-primary text-sm outline-none"
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
                className="w-full min-h-11 px-3 py-3 rounded-lg bg-surface-base ring-1 ring-line-default/20 focus:ring-brand-primary/60 text-ink-primary text-sm outline-none"
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
              className="w-full px-3 py-3 rounded-lg bg-surface-base ring-1 ring-line-default/20 focus:ring-brand-primary/60 text-ink-primary text-sm outline-none min-h-[80px]"
              maxLength={2000}
            />
          </div>
        </div>

        <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-sm font-black text-ink-primary">Traveling squad</p>
              <p className="text-[11px] text-ink-primary/55 mt-0.5">
                Pick who is actually going. Includes guest players.
              </p>
            </div>
            <span className="text-[11px] font-black uppercase tracking-widest text-brand-primary-soft">
              {pickedIds.size} of {roster.length}
            </span>
          </div>
          {roster.length === 0 && (
            <p className="text-xs text-ink-primary/55 py-4 text-center">
              No active players on the roster yet.
            </p>
          )}
          <div className="space-y-1 max-h-[420px] overflow-y-auto">
            {roster.map(p => {
              const on = pickedIds.has(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => togglePlayer(p.id)}
                  className={`w-full min-h-11 flex items-center justify-between gap-3 px-3 py-3 rounded-lg text-left transition ${
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
        </div>

        {err && (
          <div className="rounded-2xl bg-red-500/10 ring-1 ring-red-500/30 p-3 text-sm text-red-500">
            {err}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => navigate('/coach/trips')}
            className="inline-flex items-center min-h-11 px-4 py-3 rounded-lg text-sm font-black uppercase tracking-widest text-ink-primary/60 hover:text-ink-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit || busy}
            onClick={submit}
            className="inline-flex items-center min-h-11 px-4 py-3 rounded-lg bg-brand-primary text-white text-sm font-black uppercase tracking-widest disabled:opacity-40 hover:bg-brand-primary/90 transition"
          >
            {busy ? 'Creating…' : 'Create trip'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CoachTripCreate;
