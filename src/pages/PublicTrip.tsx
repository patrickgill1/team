import React, { useEffect, useState } from 'react';
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
 * For v1 this page renders the trip envelope (name, dates, notes,
 * roster count) rather than a full stats aggregate — the coach detail
 * view has the numbers. v1.1: fold the stats surface in.
 */

interface PublicTripView {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  description: string | null;
  status: string;
  attendingPlayerIds: string[];
  teamName: string;
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

const PublicTrip: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [trip, setTrip] = useState<PublicTripView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!id) { setErr('This link is missing a trip id.'); setLoaded(true); return; }
    (async () => {
      // Path A: signed-in team members can read the doc directly via
      // Firestore rules (allow read: request.auth != null). No token
      // required. Try this first — it's one round-trip, no worker hop.
      try {
        const snap = await getDoc(doc(db, 'trips', id));
        if (snap.exists()) {
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
          });
          setLoaded(true);
          return;
        }
      } catch { /* fall through to public path */ }

      // Path B: anonymous share link. Requires token + worker config.
      if (!token) { setErr('This link is missing its token.'); setLoaded(true); return; }
      if (!hasWorkerConfig()) { setErr('Recap link is not configured.'); setLoaded(true); return; }
      const url = `${process.env.REACT_APP_NOTIFY_URL || ''}/trips/public-info`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tripId: id, shareToken: token }),
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          setErr(data?.hint || 'This recap link is not available.');
        } else {
          setTrip(data.trip as PublicTripView);
        }
      } catch {
        setErr('Could not load the recap. Try again.');
      } finally {
        setLoaded(true);
      }
    })();
  }, [id, token]);

  return (
    <div className="min-h-screen bg-surface-base flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        {!loaded && (
          <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-6 text-center">
            <p className="text-xs text-ink-primary/55">Loading recap…</p>
          </div>
        )}
        {loaded && err && (
          <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-6 text-center">
            <p className="text-sm font-black text-ink-primary">Recap unavailable</p>
            <p className="text-xs text-ink-primary/55 mt-1">{err}</p>
          </div>
        )}
        {loaded && trip && (
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
            <div className="mt-5 rounded-lg bg-line-default/[0.04] p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/50">
                Traveling squad
              </p>
              <p className="text-sm font-black text-ink-primary mt-1">
                {trip.attendingPlayerIds?.length || 0}{' '}
                {(trip.attendingPlayerIds?.length || 0) === 1 ? 'player' : 'players'}
              </p>
            </div>
            <p className="text-[10px] text-ink-primary/40 mt-6 text-center">
              Shared via GoalKickr
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default PublicTrip;
