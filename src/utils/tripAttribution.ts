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

/** Return America/Denver's UTC offset in hours (6 for MDT, 7 for MST)
 *  for the calendar day (y, m, day). Computed by asking Intl what hour
 *  it is in Denver at 12:00 UTC of that day: MST 12:00 UTC = 5am
 *  Denver → offset 7; MDT 12:00 UTC = 6am Denver → offset 6. 12:00 UTC
 *  is safely inside the DST regime on both transition days (spring
 *  forward at 2am, fall back at 2am both flip well before). */
function denverOffsetHours(y: number, m: number, day: number): number {
  try {
    const probe = new Date(Date.UTC(y, m - 1, day, 12, 0, 0));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      hour: '2-digit', hour12: false,
    }).formatToParts(probe);
    const raw = parts.find(p => p.type === 'hour')?.value || '05';
    // en-US with h12:false can emit "24" for midnight — normalise.
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

/** Timezone-safe (America/Denver) end-of-day for a Date. Uses the
 *  actual Denver UTC offset for that calendar day so an 11:59 PM
 *  Denver game lands INSIDE the window and an early-morning game the
 *  next day does NOT get pulled in. */
function endOfDayDenver(d: Date): Date {
  try {
    const { y, m, day } = denverYMD(d);
    const off = denverOffsetHours(y, m, day);
    // Denver 23:59:59.999 → UTC (23 + off) : 59 : 59 . 999
    return new Date(Date.UTC(y, m - 1, day, 23 + off, 59, 59, 999));
  } catch {
    const c = new Date(d);
    c.setHours(23, 59, 59, 999);
    return c;
  }
}

/** Timezone-safe start-of-day (America/Denver) for a Date. Returns
 *  the exact UTC instant of Denver midnight on that calendar day —
 *  NOT 00:00 UTC (which is 6–7 hours BEFORE Denver midnight and
 *  would pull the previous-evening's regulation game into the
 *  window). */
function startOfDayDenver(d: Date): Date {
  try {
    const { y, m, day } = denverYMD(d);
    const off = denverOffsetHours(y, m, day);
    // Denver 00:00 → UTC (0 + off) : 00 : 00 . 000
    return new Date(Date.UTC(y, m - 1, day, off, 0, 0, 0));
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
   *  future analytics.
   *
   *  `attribution_failed` is distinct from `auto_no_match`: it means
   *  the trips query itself threw (network blip, offline, permission
   *  hiccup), so we CAN'T tell whether the game belongs to a trip.
   *  Callers should surface this to the coach via
   *  displayTripAttributionError so they know the season vs trip
   *  bucketing may be wrong and can retry the finalize.
   *  `error` is a legacy alias retained so old build snapshots don't
   *  crash — new code should treat it the same as attribution_failed. */
  reason: 'override_none' | 'override_season' | 'override_trip'
    | 'auto_match' | 'auto_no_match' | 'no_active_trips'
    | 'attribution_failed' | 'error';
  /** Underlying error message when reason === 'attribution_failed'.
   *  Passed to displayTripAttributionError for optional detail
   *  surfacing. Never contains PII (Firestore errors are opaque
   *  transport codes). */
  errorMessage?: string;
}

/** Typed error thrown by callers that want to convert a
 *  reason='attribution_failed' result into an exception (e.g. a
 *  wrapper in GameDay that lifts the resolver's soft failure into
 *  the finalize try/catch chain). Consumers can `instanceof` this
 *  to branch on trip-attribution vs any other failure. */
export class TripAttributionError extends Error {
  reason: ResolveTripResult['reason'];
  constructor(reason: ResolveTripResult['reason'], message?: string) {
    super(message || 'trip attribution failed');
    this.name = 'TripAttributionError';
    this.reason = reason;
  }
}

/**
 * Resolve the tripId for a stat write. THROWS TripAttributionError on
 * hard failures (network / permission blip) so callers can catch and
 * surface a retry — silent fallback to the season bucket was the exact
 * bug Trip v1.1 was meant to fix. Success reasons (including
 * `auto_no_match`, `no_active_trips`, and coach overrides) still return
 * the ResolveTripResult object as before.
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
    throw new TripAttributionError(
      'attribution_failed',
      err instanceof Error ? err.message : String(err),
    );
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
    // Let the inner resolveTripIdForGame throw propagate as-is (already
    // a TripAttributionError). Only wrap NEW errors from the event-doc
    // read step so callers get a uniform typed exception either way.
    if (err instanceof TripAttributionError) throw err;
    console.warn('[tripAttribution] resolveTripIdByEventId failed', err);
    throw new TripAttributionError(
      'attribution_failed',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Toast payload for a failed trip-attribution result. Callers pass
 *  the ResolveTripResult (or just the reason) and get back a
 *  coach-native title + message plus an optional retry action. Returns
 *  `null` when the result is a normal outcome (matched, no window, or
 *  a coach override) so the caller can short-circuit without a branch
 *  on their side.
 *
 *  Copy is deliberately reassuring: the season write STILL landed;
 *  the only thing that failed is the trip vs season bucketing on this
 *  one game. Retrying re-runs the read and, if it succeeds, stamps
 *  tripId on the mirrored event. */
export function displayTripAttributionError(
  result: ResolveTripResult | ResolveTripResult['reason'],
  onRetry?: () => void | Promise<void>,
): { title: string; message: string; actionLabel?: string; onAction?: () => void | Promise<void> } | null {
  const reason = typeof result === 'string' ? result : result.reason;
  if (reason !== 'attribution_failed' && reason !== 'error') return null;
  const message =
    'Stats saved to season totals. The trip check hit a snag, so this game may not appear in the trip totals until you retry.';
  const payload: { title: string; message: string; actionLabel?: string; onAction?: () => void | Promise<void> } = {
    title: 'Trip check did not run',
    message,
  };
  if (onRetry) {
    payload.actionLabel = 'Retry';
    payload.onAction = onRetry;
  }
  return payload;
}

/** Utility used by read-side filters. Returns true when the stat row
 *  should be included in the SEASON bucket (i.e. NO tripId set). Keeps
 *  the call sites terse. */
export function isSeasonStat(row: { tripId?: string | null } | undefined | null): boolean {
  if (!row) return true;
  return !row.tripId;
}

/** Detect trips whose Denver-tz windows overlap another active trip in
 *  the same list. Returns the set of tripIds that participate in ANY
 *  overlap (both / all sides are flagged). Used by CoachTrips to
 *  surface a banner so the coach can archive the stale one before it
 *  starts silently swallowing new stats. */
export function findOverlappingTripIds(trips: Trip[]): Set<string> {
  const flagged = new Set<string>();
  const norm = trips.map(t => ({
    id: t.id,
    start: startOfDayDenver(t.startDate).getTime(),
    end: endOfDayDenver(t.endDate).getTime(),
  }));
  for (let i = 0; i < norm.length; i++) {
    for (let j = i + 1; j < norm.length; j++) {
      const a = norm[i];
      const b = norm[j];
      if (a.start <= b.end && b.start <= a.end) {
        flagged.add(a.id);
        flagged.add(b.id);
      }
    }
  }
  return flagged;
}
