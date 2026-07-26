import React, { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';

// Adult-league attendance nudge. Two positive signals, one card:
//   1. Social proof: "N of X teammates going" — pulls from the current
//      event's roster + going bucket. Positive framing only; we never
//      surface a "team is thin" or shame count.
//   2. Personal habit: "You: N of last M events" — counts how many of
//      the user's last M completed events (any type on this team) they
//      marked 'going' for at least one of their linked player IDs.
//
// Only renders for adult teams (audienceType === 'adult'). Youth teams
// route RSVPs through parents; the "you attended" framing doesn't fit
// when it's the parent's tap on behalf of the kid.
//
// Cheap enough to inline: one Firestore query on mount, then in-memory
// count. If the user has no linked player on this team we skip the
// personal-stat line but still show the social-proof number.

interface Props {
  teamId: string | null | undefined;
  /** Player IDs the current user represents on this team (usually 1
   *  entry — the user's own selfPlayer for adult leagues). Empty
   *  array skips the personal-stat line. */
  myPlayerIds: string[];
  /** How many teammates on the roster have RSVP'd 'going' for THIS
   *  event. Counted upstream where the buckets already exist. */
  goingCount: number;
  /** Total active-roster size on the team (denominator for the "N of
   *  X teammates going" line). */
  rosterSize: number;
  /** ISO ms of the current event. Used to scope the personal history
   *  lookback so we only count events that ALREADY happened, not
   *  future events the user hasn't had a chance to RSVP for yet. */
  currentEventStartMs: number;
  /** How many recent past events to sample when computing the
   *  personal attendance ratio. Default 6 (roughly one season month
   *  for a Tuesday/Thursday adult league). */
  lookbackCount?: number;
}

interface RsvpLookup {
  wentCount: number;
  sampleCount: number;
}

const AttendanceMotivationCard: React.FC<Props> = ({
  teamId,
  myPlayerIds,
  goingCount,
  rosterSize,
  currentEventStartMs,
  lookbackCount = 6,
}) => {
  const [personal, setPersonal] = useState<RsvpLookup | null>(null);

  // Stable key for the effect's dependency — the array identity of
  // myPlayerIds changes on every render up the tree, so we memoize on
  // its joined string. Rare to have >1 entry (adult self-player), so
  // the join stays cheap.
  const pidKey = useMemo(() => myPlayerIds.slice().sort().join(','), [myPlayerIds]);

  useEffect(() => {
    // Zero linked players → no personal history to compute. Skip the
    // query entirely; render will fall back to social-proof-only.
    if (!teamId || myPlayerIds.length === 0) { setPersonal(null); return; }
    let cancelled = false;
    (async () => {
      try {
        // Fetch all past events for this team. We can't range-query on
        // the date field AND filter isActive in one composite index
        // without adding one, so we pull team events and filter in
        // memory. Adult teams rarely have >100 events per season, so
        // this stays cheap. Kids-facing teams don't render this card
        // (audienceType gate lives at the caller).
        const snap = await getDocs(query(
          collection(db, 'events'),
          where('teamId', '==', teamId),
        ));
        if (cancelled) return;

        // Filter to events that ended before the current one and were
        // active. Sort descending by date; take the newest N.
        const past = snap.docs
          .map(d => {
            const data: any = d.data();
            const dateMs = (() => {
              const raw = data.date;
              if (!raw) return 0;
              const dt = raw?.toDate ? raw.toDate() : new Date(raw);
              return dt instanceof Date && !isNaN(dt.getTime()) ? dt.getTime() : 0;
            })();
            return { id: d.id, dateMs, playerRsvps: data.playerRsvps || {}, isActive: data.isActive !== false };
          })
          .filter(e => e.isActive && e.dateMs > 0 && e.dateMs < currentEventStartMs)
          .sort((a, b) => b.dateMs - a.dateMs)
          .slice(0, lookbackCount);

        // Count events where at least one of the user's linked
        // players marked 'going'. Using 'at least one' so a coach who
        // rostered ONE self-player still gets a full count if they
        // showed up — no penalty for a linked-player list that's just
        // themselves.
        let went = 0;
        for (const ev of past) {
          const rsvps = ev.playerRsvps as Record<string, { status?: string }>;
          const anyGoing = myPlayerIds.some(pid => rsvps[pid]?.status === 'going');
          if (anyGoing) went++;
        }
        setPersonal({ wentCount: went, sampleCount: past.length });
      } catch (err) {
        console.warn('[attendance-motivation] history load failed', err);
        setPersonal(null);
      }
    })();
    return () => { cancelled = true; };
  }, [teamId, pidKey, currentEventStartMs, lookbackCount, myPlayerIds]);

  // Nothing meaningful to show when both signals are empty. Zero
  // roster + zero going = don't render (keeps a brand-new team's
  // event page from having a "0 of 0 going" ghost stat).
  const hasSocial = rosterSize > 0;
  const hasPersonal = personal && personal.sampleCount > 0;
  if (!hasSocial && !hasPersonal) return null;

  return (
    <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/10 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
      <div className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/70 mb-3 flex items-center gap-1.5">
        <svg className="w-3 h-3 text-brand-primary" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        Attendance
      </div>

      {hasSocial && (
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-black text-ink-primary tabular-nums">{goingCount}</span>
          <span className="text-sm text-ink-primary/60">
            of {rosterSize} teammate{rosterSize === 1 ? '' : 's'} going
          </span>
        </div>
      )}

      {hasPersonal && (
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/50">You</span>
          <span className="text-sm text-ink-primary/75 tabular-nums">
            {personal!.wentCount} of your last {personal!.sampleCount} event{personal!.sampleCount === 1 ? '' : 's'}
          </span>
        </div>
      )}
    </section>
  );
};

export default AttendanceMotivationCard;
