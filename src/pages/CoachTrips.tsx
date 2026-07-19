import React, { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoachOfTeam } from '../utils/helpers';
import Header from '../components/common/Header';
import type { Trip } from '../types';

/**
 * Coach Trips — /coach/trips
 *
 * List view of every Trip on the selected team. Two tabs: Active
 * (default) and Archived. Cards show name, window, attendee count.
 *
 * Trips are the stat-scoping container for tournaments / weekend
 * trips. Stats recorded during the window auto-attribute to the trip
 * bucket (excluded from season aggregates). See design contract.
 *
 * Atomic-render pattern: 400ms silence → progress → fade-in.
 */

const CoachTrips: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeam, selectedTeamId } = useTeam();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [tab, setTab] = useState<'active' | 'archived'>('active');

  useEffect(() => {
    if (loaded) { setShowProgress(false); return; }
    const t = window.setTimeout(() => setShowProgress(true), 400);
    return () => window.clearTimeout(t);
  }, [loaded]);

  useEffect(() => {
    if (!selectedTeamId) { setLoaded(true); return; }
    const q = query(
      collection(db, 'trips'),
      where('teamId', '==', selectedTeamId),
      orderBy('startDate', 'desc'),
    );
    const unsub = onSnapshot(q, (snap) => {
      const rows: Trip[] = snap.docs.map(d => {
        const data: any = d.data();
        const asDate = (v: any) => v?.toDate?.() || (v ? new Date(v) : new Date(0));
        return {
          id: d.id,
          teamId: data.teamId,
          clubId: data.clubId,
          createdBy: data.createdBy,
          createdByName: data.createdByName,
          createdAt: asDate(data.createdAt),
          updatedAt: data.updatedAt ? asDate(data.updatedAt) : undefined,
          isActive: data.isActive !== false,
          name: data.name || '',
          startDate: asDate(data.startDate),
          endDate: asDate(data.endDate),
          description: data.description,
          attendingPlayerIds: Array.isArray(data.attendingPlayerIds) ? data.attendingPlayerIds : [],
          status: data.status === 'archived' ? 'archived' : 'active',
          shareToken: data.shareToken,
        } as Trip;
      }).filter(t => t.isActive !== false);
      setTrips(rows);
      setLoaded(true);
    }, (err) => {
      console.warn('[coach-trips] snapshot failed', err);
      setLoaded(true);
    });
    return () => unsub();
  }, [selectedTeamId]);

  const coachOnThisTeam = isCoachOfTeam(userData as any, selectedTeam as any);

  const filtered = useMemo(() => trips.filter(t => t.status === tab), [trips, tab]);

  if (!coachOnThisTeam) {
    return <Navigate to="/coach" replace />;
  }

  return (
    <div className="min-h-screen bg-surface-base">
      <Header
        title="Trips"
        subtitle={selectedTeam ? selectedTeam.name : 'No team selected'}
      />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="inline-flex rounded-full bg-line-default/[0.06] ring-1 ring-line-default/15 p-1">
            <button
              type="button"
              onClick={() => setTab('active')}
              className={`px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-widest transition ${
                tab === 'active'
                  ? 'bg-brand-primary text-white'
                  : 'text-ink-primary/60 hover:text-ink-primary'
              }`}
            >
              Active
            </button>
            <button
              type="button"
              onClick={() => setTab('archived')}
              className={`px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-widest transition ${
                tab === 'archived'
                  ? 'bg-brand-primary text-white'
                  : 'text-ink-primary/60 hover:text-ink-primary'
              }`}
            >
              Archived
            </button>
          </div>
          <Link
            to="/coach/trips/new"
            className="px-4 py-2 rounded-lg bg-brand-primary text-white text-sm font-black uppercase tracking-widest hover:bg-brand-primary/90 transition"
          >
            New
          </Link>
        </div>

        {showProgress && !loaded && (
          <div className="h-0.5 bg-brand-primary/15 overflow-hidden rounded-full">
            <div className="h-full w-1/3 bg-brand-primary animate-progress-slide" />
          </div>
        )}

        <div className={`transition-opacity duration-300 ease-out ${loaded ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
          {loaded && filtered.length === 0 && (
            <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-6 text-center">
              <p className="text-ink-primary/85 font-black text-sm">
                {tab === 'active' ? 'No trips yet.' : 'Nothing archived yet.'}
              </p>
              <p className="text-ink-primary/55 text-xs mt-1">
                {tab === 'active'
                  ? 'Set up a trip for your next tournament. Stats logged during the window get their own bucket.'
                  : 'Wrapped-up trips will land here so season stats stay clean.'}
              </p>
              {tab === 'active' && (
                <Link
                  to="/coach/trips/new"
                  className="inline-block mt-4 px-4 py-2 rounded-lg bg-brand-primary text-white text-xs font-black uppercase tracking-widest hover:bg-brand-primary/90 transition"
                >
                  Plan a trip
                </Link>
              )}
            </div>
          )}
          <div className="space-y-2">
            {filtered.map(t => (
              <TripRow key={t.id} t={t} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

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

const TripRow: React.FC<{ t: Trip }> = ({ t }) => {
  const inWindow = useMemo(() => {
    const now = Date.now();
    return now >= t.startDate.getTime() && now <= t.endDate.getTime();
  }, [t.startDate, t.endDate]);
  const count = t.attendingPlayerIds?.length || 0;
  return (
    <Link
      to={`/coach/trips/${t.id}`}
      className="block rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 hover:ring-brand-primary/30 transition p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-extrabold uppercase tracking-widest text-brand-primary-soft">
              Trip
            </span>
            {inWindow && t.status === 'active' && (
              <span className="text-[10px] font-extrabold uppercase tracking-widest text-emerald-500">
                Live
              </span>
            )}
            {t.status === 'archived' && (
              <span className="text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/40">
                Archived
              </span>
            )}
          </div>
          <p className="text-sm font-black text-ink-primary leading-tight">{t.name}</p>
          <p className="text-[11px] text-ink-primary/55 mt-1">
            {fmtRange(t.startDate, t.endDate)} · {count} {count === 1 ? 'player' : 'players'}
          </p>
        </div>
      </div>
    </Link>
  );
};

export default CoachTrips;
