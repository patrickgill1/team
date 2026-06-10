import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from './firebase';

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
    // take the most recent `lookback` items.
    const past = allEvents
      .filter(e => allowed.has(e.type))
      .filter(e => !e.isCancelled)
      .map(e => ({
        ...e,
        dateMs: (e.date?.toDate?.() ?? new Date(e.date || 0)).getTime?.() || 0,
      }))
      .filter(e => e.dateMs > 0 && e.dateMs <= now)
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
