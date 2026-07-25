import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from './firebase';
import { eventEndMs } from './eventTiming';

export interface AttendanceCounts {
  attended: number;
  total: number;
  percent: number | null;
}

// Batched variant: pulls team events ONCE and computes attendance for
// every player in the roster from that shared list. Callers with N
// players save N-1 identical events fetches vs. calling
// computePlayerAttendance in a loop. Used by PlayerList to hydrate
// the Squad grid's attendance strip, and by AttendanceTracker for
// perfect_attendance badge granting.
export async function computeTeamAttendanceCounts(
  playerIds: string[],
  teamIds: string[],
  opts: { lookback?: number; eventTypes?: Array<'game' | 'practice' | 'event'> } = {}
): Promise<Record<string, AttendanceCounts>> {
  const lookback = opts.lookback ?? 10;
  const allowed = new Set(opts.eventTypes ?? ['practice', 'game']);
  const empty: Record<string, AttendanceCounts> = {};
  for (const id of playerIds) empty[id] = { attended: 0, total: 0, percent: null };
  if (playerIds.length === 0 || teamIds.length === 0) return empty;
  try {
    const allEvents: any[] = [];
    for (let i = 0; i < teamIds.length; i += 30) {
      const chunk = teamIds.slice(i, i + 30);
      const snap = await getDocs(query(
        collection(db, 'events'),
        where('teamId', 'in', chunk),
      ));
      snap.forEach(d => allEvents.push({ id: d.id, ...(d.data() as any) }));
    }
    const now = Date.now();
    const past = allEvents
      .filter(e => allowed.has(e.type))
      .filter(e => !e.isCancelled)
      .filter(e => e.isActive !== false)
      .map(e => ({
        ...e,
        dateMs: (e.date?.toDate?.() ?? new Date(e.date || 0)).getTime?.() || 0,
      }))
      // Only count events that are actually FINISHED — otherwise a
      // mid-second-half game gets pulled into the denominator before
      // anyone RSVPs "going," dragging the percent down.
      .filter(e => e.dateMs > 0 && eventEndMs(e) <= now)
      .sort((a, b) => b.dateMs - a.dateMs)
      .slice(0, lookback);
    if (past.length === 0) return empty;
    const out: Record<string, AttendanceCounts> = {};
    for (const pid of playerIds) {
      let attended = 0;
      for (const e of past) {
        if (e.playerRsvps?.[pid]?.status === 'going') attended++;
      }
      out[pid] = {
        attended,
        total: past.length,
        percent: Math.round((attended / past.length) * 100),
      };
    }
    return out;
  } catch (err) {
    console.warn('computeTeamAttendanceCounts failed', err);
    return empty;
  }
}

// Legacy shape wrapper — retained for the many callers that only need
// the percent map. Uses computeTeamAttendanceCounts under the hood.
export async function computeTeamAttendancePercents(
  playerIds: string[],
  teamIds: string[],
  opts: { lookback?: number; eventTypes?: Array<'game' | 'practice' | 'event'> } = {}
): Promise<Record<string, number | null>> {
  const lookback = opts.lookback ?? 10;
  const allowed = new Set(opts.eventTypes ?? ['practice', 'game']);
  const empty: Record<string, number | null> = {};
  for (const id of playerIds) empty[id] = null;
  if (playerIds.length === 0 || teamIds.length === 0) return empty;

  try {
    const allEvents: any[] = [];
    for (let i = 0; i < teamIds.length; i += 30) {
      const chunk = teamIds.slice(i, i + 30);
      const snap = await getDocs(query(
        collection(db, 'events'),
        where('teamId', 'in', chunk),
      ));
      snap.forEach(d => allEvents.push({ id: d.id, ...(d.data() as any) }));
    }

    const now = Date.now();
    const past = allEvents
      .filter(e => allowed.has(e.type))
      .filter(e => !e.isCancelled)
      .filter(e => e.isActive !== false)
      .map(e => ({
        ...e,
        dateMs: (e.date?.toDate?.() ?? new Date(e.date || 0)).getTime?.() || 0,
      }))
      // Only include events that have finished per the shared
      // boundary (endDate / start + type default / end-of-Denver-day).
      .filter(e => e.dateMs > 0 && eventEndMs(e) <= now)
      .sort((a, b) => b.dateMs - a.dateMs)
      .slice(0, lookback);

    if (past.length === 0) return empty;

    const out: Record<string, number | null> = {};
    for (const pid of playerIds) {
      let attended = 0;
      for (const e of past) {
        if (e.playerRsvps?.[pid]?.status === 'going') attended++;
      }
      out[pid] = Math.round((attended / past.length) * 100);
    }
    return out;
  } catch (err) {
    console.warn('computeTeamAttendancePercents failed', err);
    return empty;
  }
}

// Compute a player's practice attendance percentage over the most
// recent N completed events on their team(s). Reads playerRsvps off
// the event docs — the per-kid RSVPs that parents tap on the event
// page. Counts as "attended" when the RSVP is 'going' (the simplest
// signal we have; we can swap for a real attendance log later).

export interface AttendanceResult {
  /** 0-100 rounded percentage of completed events the kid attended. */
  percent: number | null;
  /** Count of completed events we found in the window. */
  totalEvents: number;
  /** Count of those where the kid RSVPed 'going'. */
  attendedEvents: number;
}

export async function computePlayerAttendance(
  playerId: string,
  teamIds: string[],
  opts: { lookback?: number; eventTypes?: Array<'game' | 'practice' | 'event'> } = {}
): Promise<AttendanceResult> {
  const lookback = opts.lookback ?? 10;
  const allowed = new Set(opts.eventTypes ?? ['practice', 'game']);
  if (!playerId || teamIds.length === 0) {
    return { percent: null, totalEvents: 0, attendedEvents: 0 };
  }

  try {
    // Pull events for the team(s). Firestore caps `in` queries at 30,
    // and Fire FC scale never approaches that. We filter completed
    // events client-side because there's no `<= now` + `teamId in`
    // composite index we want to require for a small list.
    const allEvents: any[] = [];
    for (let i = 0; i < teamIds.length; i += 30) {
      const chunk = teamIds.slice(i, i + 30);
      const snap = await getDocs(query(
        collection(db, 'events'),
        where('teamId', 'in', chunk),
      ));
      snap.forEach(d => allEvents.push({ id: d.id, ...(d.data() as any) }));
    }

    const now = Date.now();
    // Filter to past events of the allowed types, sort by date desc,
    // take the most recent `lookback` items. "Past" is measured
    // against the shared eventEndMs boundary so an in-progress game
    // doesn't dilute the kid's percent.
    const past = allEvents
      .filter(e => allowed.has(e.type))
      .filter(e => !e.isCancelled)
      .filter(e => e.isActive !== false)
      .map(e => ({
        ...e,
        dateMs: (e.date?.toDate?.() ?? new Date(e.date || 0)).getTime?.() || 0,
      }))
      .filter(e => e.dateMs > 0 && eventEndMs(e) <= now)
      .sort((a, b) => b.dateMs - a.dateMs)
      .slice(0, lookback);

    if (past.length === 0) {
      return { percent: null, totalEvents: 0, attendedEvents: 0 };
    }

    let attended = 0;
    for (const e of past) {
      const rsvp = e.playerRsvps?.[playerId];
      if (rsvp?.status === 'going') attended++;
    }
    return {
      percent: Math.round((attended / past.length) * 100),
      totalEvents: past.length,
      attendedEvents: attended,
    };
  } catch (err) {
    console.warn('computePlayerAttendance failed', err);
    return { percent: null, totalEvents: 0, attendedEvents: 0 };
  }
}
