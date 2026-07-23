/**
 * Event → Trip context — shared surface for rendering the "Premier Cup"
 * chip on event cards and event detail.
 *
 * Two pieces:
 *   • getTripForEvent(event, activeTrips) — sync, pure, no I/O. Returns
 *     the matching Trip for an event given a pre-loaded active-trips
 *     list. Mirrors the auto-detect rule in tripAttribution.ts
 *     (Denver-anchored window, earliest-start-wins on overlap) plus
 *     event.tripId short-circuit.
 *   • useActiveTripsForTeam(teamId) — React hook. One shared Firestore
 *     onSnapshot subscription per teamId, ref-counted across all mount
 *     sites so a list of cards doesn't spin up N listeners for the
 *     same team.
 *
 * We intentionally do NOT re-use tripAttribution.getActiveTripsForTeam
 * here — that helper is a one-shot getDocs with a 30s memo, tuned for
 * write-path resolution during GameDay finalize. Card surfaces want
 * live updates (create a trip → chips appear without a hard refresh)
 * and the read-path traffic is fine to spend on a snapshot listener.
 */

import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from './firebase';
import type { CalendarEvent, Trip } from '../types';

// ---------------------------------------------------------------------
// Sync resolver
// ---------------------------------------------------------------------

function asDate(v: any): Date | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v?.toDate === 'function') {
    try {
      const d = v.toDate();
      return isNaN(d.getTime()) ? null : d;
    } catch {
      return null;
    }
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// --- Denver-anchored windowing (mirror of tripAttribution.ts) -------

function denverOffsetHours(y: number, m: number, day: number): number {
  try {
    const probe = new Date(Date.UTC(y, m - 1, day, 12, 0, 0));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      hour: '2-digit', hour12: false,
    }).formatToParts(probe);
    const raw = parts.find(p => p.type === 'hour')?.value || '05';
    const denverHour = Number(raw) % 24;
    return 12 - denverHour;
  } catch {
    return 7; // MST fallback
  }
}

function denverYMD(d: Date): { y: number; m: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  return {
    y: Number(parts.find(p => p.type === 'year')?.value || 0),
    m: Number(parts.find(p => p.type === 'month')?.value || 0),
    day: Number(parts.find(p => p.type === 'day')?.value || 0),
  };
}

function startOfDayDenver(d: Date): Date {
  try {
    const { y, m, day } = denverYMD(d);
    const off = denverOffsetHours(y, m, day);
    return new Date(Date.UTC(y, m - 1, day, off, 0, 0, 0));
  } catch {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c;
  }
}

function endOfDayDenver(d: Date): Date {
  try {
    const { y, m, day } = denverYMD(d);
    const off = denverOffsetHours(y, m, day);
    return new Date(Date.UTC(y, m - 1, day, 23 + off, 59, 59, 999));
  } catch {
    const c = new Date(d);
    c.setHours(23, 59, 59, 999);
    return c;
  }
}

/**
 * Resolve the Trip an event belongs to, if any. Sync — the caller
 * passes in the trips list (typically from useActiveTripsForTeam).
 *
 * Resolution order:
 *   1) event.tripId — authoritatively stamped at endGame (GameDay
 *      mirrors resolveTripIdForGame's answer onto the event doc).
 *      This is the cheapest / most correct signal when present.
 *   2) event.tripAssignmentOverride === 'season' | 'none' —
 *      coach explicitly took this game out of any trip bucket.
 *      Return null even if the date falls inside a window.
 *   3) event.tripAssignmentOverride === 'trip' with no tripId — the
 *      coach wants THIS event on a trip; fall through to date match.
 *   4) Auto: earliest-start-wins active trip on the SAME team whose
 *      Denver window contains event.date.
 */
export function getTripForEvent(
  event: Pick<CalendarEvent, 'id' | 'teamId' | 'date' | 'type'> & {
    tripId?: string;
    tripAssignmentOverride?: 'season' | 'trip' | 'none';
  } | null | undefined,
  activeTrips: Trip[] | null | undefined,
): Trip | null {
  if (!event) return null;
  const trips = Array.isArray(activeTrips) ? activeTrips : [];
  if (trips.length === 0) return null;

  // Trip = tournament, and tournaments are games. A practice that
  // happens to fall inside a trip window is still just a practice;
  // showing the trip chip there would mislead. Gate every match path
  // on event.type === 'game' before either the explicit-id or the
  // date-window branch can return a hit.
  if ((event as any).type !== 'game') return null;

  // 1) Explicit binding wins. Guard team match so a mis-stamped id
  //    can't bleed a chip in from another team.
  const explicitId = (event as any).tripId as string | undefined;
  if (explicitId) {
    const hit = trips.find(t => t.id === explicitId && t.teamId === event.teamId);
    if (hit) return hit;
    // If explicitId is set but not in the active list (archived, etc.)
    // fall through — we still want to reflect the date-based membership
    // for a valid active trip if there is one, rather than render nothing.
  }

  // 2) Coach opted this event out of any trip bucket.
  const override = (event as any).tripAssignmentOverride as
    | 'season' | 'trip' | 'none' | undefined;
  if (override === 'season' || override === 'none') return null;

  // 3 & 4) Date window match on the same team, earliest start wins.
  const when = asDate((event as any).date);
  if (!when) return null;

  const matches = trips
    .filter(t => t.teamId === event.teamId)
    .filter(t => {
      const start = startOfDayDenver(t.startDate);
      const end = endOfDayDenver(t.endDate);
      return when.getTime() >= start.getTime() && when.getTime() <= end.getTime();
    })
    .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());

  return matches[0] || null;
}

// ---------------------------------------------------------------------
// Shared onSnapshot subscription per teamId (ref-counted)
// ---------------------------------------------------------------------

type Listener = (trips: Trip[]) => void;

interface Entry {
  trips: Trip[];
  loaded: boolean;
  listeners: Set<Listener>;
  unsub: (() => void) | null;
}

const entries = new Map<string, Entry>();

function normalizeTrip(id: string, v: any): Trip {
  return {
    id,
    teamId: v.teamId,
    clubId: v.clubId,
    createdBy: v.createdBy,
    createdByName: v.createdByName,
    createdAt: asDate(v.createdAt) || new Date(0),
    updatedAt: v.updatedAt ? (asDate(v.updatedAt) || undefined) : undefined,
    isActive: v.isActive !== false,
    name: String(v.name || ''),
    startDate: asDate(v.startDate) || new Date(0),
    endDate: asDate(v.endDate) || new Date(0),
    description: v.description,
    attendingPlayerIds: Array.isArray(v.attendingPlayerIds) ? v.attendingPlayerIds : [],
    status: v.status === 'archived' ? 'archived' : 'active',
    shareToken: v.shareToken,
  } as Trip;
}

function ensureEntry(teamId: string): Entry {
  const existing = entries.get(teamId);
  if (existing) return existing;
  const entry: Entry = {
    trips: [],
    loaded: false,
    listeners: new Set(),
    unsub: null,
  };
  entries.set(teamId, entry);

  try {
    // Simple single-field query — no composite index. Filter status +
    // isActive client-side (same shape as tripAttribution.ts).
    const q = query(collection(db, 'trips'), where('teamId', '==', teamId));
    entry.unsub = onSnapshot(
      q,
      snap => {
        const next: Trip[] = [];
        snap.forEach(doc => {
          const v: any = doc.data();
          const trip = normalizeTrip(doc.id, v);
          if (trip.isActive !== false && trip.status === 'active') {
            next.push(trip);
          }
        });
        entry.trips = next;
        entry.loaded = true;
        entry.listeners.forEach(l => {
          try { l(next); } catch { /* listener owns its own errors */ }
        });
      },
      err => {
        console.warn('[eventTripContext] trips onSnapshot failed', err);
        entry.loaded = true;
        entry.trips = [];
        entry.listeners.forEach(l => {
          try { l([]); } catch { /* noop */ }
        });
      },
    );
  } catch (err) {
    console.warn('[eventTripContext] failed to subscribe to trips', err);
    entry.loaded = true;
  }
  return entry;
}

function releaseEntry(teamId: string, listener: Listener): void {
  const entry = entries.get(teamId);
  if (!entry) return;
  entry.listeners.delete(listener);
  if (entry.listeners.size === 0) {
    try { entry.unsub?.(); } catch { /* noop */ }
    entries.delete(teamId);
  }
}

/**
 * Subscribe to the active trips for a team. Shared listener per teamId:
 * ten EventListCards for the same team share one Firestore subscription.
 *
 * Returns [] when teamId is missing or before the first snapshot lands
 * (kept intentionally simple — no separate loading flag; the chip just
 * doesn't render on the first paint if data hasn't arrived yet).
 */
export function useActiveTripsForTeam(
  teamId: string | null | undefined,
): Trip[] {
  const [trips, setTrips] = useState<Trip[]>(() => {
    if (!teamId) return [];
    const hit = entries.get(teamId);
    return hit?.trips || [];
  });

  useEffect(() => {
    if (!teamId) { setTrips([]); return; }
    const entry = ensureEntry(teamId);
    // Seed with the current cache in case another mount already loaded.
    setTrips(entry.trips);
    const listener: Listener = next => setTrips(next);
    entry.listeners.add(listener);
    return () => releaseEntry(teamId, listener);
  }, [teamId]);

  return trips;
}

/**
 * Truncate the trip name for chip display. Chips read best under ~18
 * chars; anything longer gets an ellipsis so the row doesn't blow out.
 */
export function truncateTripName(name: string, max: number = 18): string {
  const s = String(name || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}
