/**
 * Trip attribution — resolves whether a stat write belongs to a Trip
 * (tournament) bucket or the season bucket at write time.
 *
 * Rule of thumb
 * ─────────────
 * • Coach's manual override on the game wins over everything.
 *   - 'season' or 'none' → no tripId (season / neither).
 *   - 'trip' → use the game's tripId directly (must already be set).
 * • Otherwise query trips: teamId + status='active' + startDate <= gameDate;
 *   client-side filter endDate >= gameDate. First hit wins (earliest
 *   startDate on the rare overlap).
 * • Timezone: America/Denver. An 11:59 PM Sunday game still counts as
 *   inside a Fri–Sun trip window.
 *
 * Kept client-side for v1 (per Design Contract §5) — the eventual
 * worker path just reuses the same shape. No secrets involved: this is
 * a read-only resolver against a public-to-team collection.
 */

import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import type { Trip } from '../types';

// Small in-memory cache — the same coach's UI resolves the trip list
// for a team dozens of times a session (every stat write). We cache
// for 30 seconds so trip creates / edits still reflect within a
// reasonable window without spamming Firestore.
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; trips: Trip[] }>();

/** Best-effort clear — call after /trips/create or /trips/update so
 *  the next resolver hit sees the fresh data. */
export function clearTripCache(teamId?: string): void {
  if (teamId) cache.delete(teamId);
  else cache.clear();
}

function asDate(v: any): Date {
  if (!v) return new Date(0);
  if (v instanceof Date) return v;
  if (typeof v?.toDate === 'function') return v.toDate();
  return new Date(v);
}

/** Return the ACTIVE trips (status='active' + isActive!==false) for a
 *  team, cached for 30s. Only trips whose window has any chance of
 *  intersecting today +/- a broad guardrail — we still filter by
 *  gameDate at the call site. */
export async function getActiveTripsForTeam(teamId: string): Promise<Trip[]> {
  if (!teamId) return [];
  const hit = cache.get(teamId);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.trips;
  try {
    // Single simple query — no composite index needed. Client-side
    // filter for status/active flag keeps the surface tiny.
    const q = query(collection(db, 'trips'), where('teamId', '==', teamId));
    const snap = await getDocs(q);
    const trips: Trip[] = snap.docs
      .map(d => {
        const v: any = d.data();
        return {
          id: d.id,
          teamId: v.teamId,
          clubId: v.clubId,
          createdBy: v.createdBy,
          createdByName: v.createdByName,
          createdAt: asDate(v.createdAt),
          updatedAt: v.updatedAt ? asDate(v.updatedAt) : undefined,
          isActive: v.isActive !== false,
          name: String(v.name || ''),
          startDate: asDate(v.startDate),
          endDate: asDate(v.endDate),
          description: v.description,
          attendingPlayerIds: Array.isArray(v.attendingPlayerIds) ? v.attendingPlayerIds : [],
          status: v.status === 'archived' ? 'archived' : 'active',
          shareToken: v.shareToken,
        } as Trip;
      })
      .filter(t => t.isActive !== false && t.status === 'active');
    cache.set(teamId, { at: now, trips });
    return trips;
  } catch (err) {
    console.warn('[tripAttribution] getActiveTripsForTeam failed', err);
    return [];
  }
}

/** Timezone-safe (America/Denver) end-of-day for a Date. Because
 *  Firestore stores absolute instants, "endDate 11:59:59 PM Denver"
 *  needs to be computed from the same date-part the coach picked. */
function endOfDayDenver(d: Date): Date {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const y = Number(parts.find(p => p.type === 'year')?.value || 0);
    const m = Number(parts.find(p => p.type === 'month')?.value || 0);
    const day = Number(parts.find(p => p.type === 'day')?.value || 0);
    // Construct a Date at 23:59:59.999 UTC for the Denver calendar day.
    // Denver is UTC-7 (MST) or UTC-6 (MDT). We add a generous 7-hour
    // buffer so the midnight boundary is inside the window regardless
    // of DST — a game at Denver 11:59 PM is at most 06:59 UTC next day.
    return new Date(Date.UTC(y, m - 1, day, 23 + 7, 59, 59, 999));
  } catch {
    // Fallback — treat as end of the same UTC day.
    const c = new Date(d);
    c.setHours(23, 59, 59, 999);
    return c;
  }
}

/** Timezone-safe start-of-day (America/Denver) for a Date. */
function startOfDayDenver(d: Date): Date {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const y = Number(parts.find(p => p.type === 'year')?.value || 0);
    const m = Number(parts.find(p => p.type === 'month')?.value || 0);
    const day = Number(parts.find(p => p.type === 'day')?.value || 0);
    // Denver midnight is at UTC 07:00 (MST) or 06:00 (MDT); use 00:00
    // UTC on the same calendar day as a permissive lower bound so
    // early-morning games (rare) still land inside the window.
    return new Date(Date.UTC(y, m - 1, day, 0, 0, 0, 0));
  } catch {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c;
  }
}

export interface ResolveTripInput {
  teamId: string;
  gameDate: Date;
  /** Optional override read off the game doc. When set, this short-
   *  circuits the auto-detect. */
  tripAssignmentOverride?: 'season' | 'trip' | 'none';
  /** Optional pre-known tripId on the game — used when override='trip'. */
  gameTripId?: string;
}

export interface ResolveTripResult {
  /** The tripId to stamp on the stat write, if any. */
  tripId?: string;
  /** Which decision path we took. Callers use this for logging /
   *  future analytics. */
  reason: 'override_none' | 'override_season' | 'override_trip'
    | 'auto_match' | 'auto_no_match' | 'no_active_trips' | 'error';
}

/**
 * Resolve the tripId for a stat write. Never throws — falls through to
 * the season bucket on any error.
 */
export async function resolveTripIdForGame(
  input: ResolveTripInput,
): Promise<ResolveTripResult> {
  const { teamId, gameDate, tripAssignmentOverride, gameTripId } = input;
  if (!teamId || !(gameDate instanceof Date) || isNaN(gameDate.getTime())) {
    return { reason: 'auto_no_match' };
  }

  // Coach override wins.
  if (tripAssignmentOverride === 'none') return { reason: 'override_none' };
  if (tripAssignmentOverride === 'season') return { reason: 'override_season' };
  if (tripAssignmentOverride === 'trip') {
    return { tripId: gameTripId, reason: 'override_trip' };
  }

  try {
    const trips = await getActiveTripsForTeam(teamId);
    if (trips.length === 0) return { reason: 'no_active_trips' };
    const matches = trips
      .filter(t => {
        const start = startOfDayDenver(t.startDate);
        const end = endOfDayDenver(t.endDate);
        return gameDate.getTime() >= start.getTime() && gameDate.getTime() <= end.getTime();
      })
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
    if (matches.length === 0) return { reason: 'auto_no_match' };
    if (matches.length > 1) {
      console.warn('[tripAttribution] overlapping trips — earliest wins', matches.map(m => m.id));
    }
    return { tripId: matches[0].id, reason: 'auto_match' };
  } catch (err) {
    console.warn('[tripAttribution] resolveTripIdForGame failed', err);
    return { reason: 'error' };
  }
}

/** Convenience: resolve a tripId directly from an event/game doc id.
 *  Reads the doc, extracts date + override + teamId. Used by paths
 *  that only carry a gameId (StatsTracker, clip credit). Returns
 *  undefined tripId on any miss. */
export async function resolveTripIdByEventId(
  eventId: string,
  fallbackTeamId?: string,
): Promise<ResolveTripResult> {
  if (!eventId || eventId.startsWith('clip_') || eventId.startsWith('adjust_') || eventId.startsWith('trip_')) {
    // Synthetic ids never carry a game date — skip resolution and let
    // the caller stay in the season bucket by default.
    return { reason: 'auto_no_match' };
  }
  try {
    const snap = await getDoc(doc(db, 'events', eventId));
    if (!snap.exists()) return { reason: 'auto_no_match' };
    const v: any = snap.data();
    const teamId = String(v.teamId || fallbackTeamId || '');
    const gameDate = asDate(v.date);
    return resolveTripIdForGame({
      teamId,
      gameDate,
      tripAssignmentOverride: v.tripAssignmentOverride,
      gameTripId: v.tripId,
    });
  } catch (err) {
    console.warn('[tripAttribution] resolveTripIdByEventId failed', err);
    return { reason: 'error' };
  }
}

/** Utility used by read-side filters. Returns true when the stat row
 *  should be included in the SEASON bucket (i.e. NO tripId set). Keeps
 *  the call sites terse. */
export function isSeasonStat(row: { tripId?: string | null } | undefined | null): boolean {
  if (!row) return true;
  return !row.tripId;
}
