// SnackAssignmentBanner — slim amber banner shown when the current
// user's linked player(s) are on snack duty for an upcoming event.
// Dismissible; dismissal is persisted per-event in localStorage so
// the same assignment doesn't re-nag on every dashboard visit.
//
// Data source: caller passes upcomingEvents + a set of "my player
// ids" (typically the coach or parent's linked kids on this team).
// The first event where snackAssignment.playerId is in the set
// wins — coaches on snack for multiple upcoming events see the
// nearest one; the others show up when the coach opens the calendar.
//
// Design brief: Patrick 2026-07-13 dashboard audit. Banner when
// unconfirmed, dismisses to nothing once acknowledged. If the
// event has a new assignment later, the banner returns because the
// dismissed key includes the assignment timestamp.

import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEvent } from '../../types';

interface Props {
  events: CalendarEvent[];
  /** Player ids the current user is linked to (their kids OR — for
   *  the adult-player path — themselves). We surface a snack banner
   *  when snackAssignment.playerId matches any of these. */
  myPlayerIds: string[];
}

function dismissedKey(eventId: string, assignedAtMs: number | null): string {
  return `firefc.snackBannerDismissedAt:${eventId}:${assignedAtMs || 'noTs'}`;
}

function toMs(v: any): number | null {
  if (!v) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v?.toDate === 'function') { try { return v.toDate().getTime(); } catch { return null; } }
  if (typeof v?.seconds === 'number') return v.seconds * 1000;
  if (typeof v === 'number') return v;
  return null;
}

const SnackAssignmentBanner: React.FC<Props> = ({ events, myPlayerIds }) => {
  const [dismissedTick, setDismissedTick] = useState(0);

  const nextAssignment = useMemo(() => {
    if (!Array.isArray(myPlayerIds) || myPlayerIds.length === 0) return null;
    const myIds = new Set(myPlayerIds);
    const now = Date.now();
    // Prefer nearest upcoming event where snackAssignment.playerId
    // is one of my player ids. Events are typically already
    // sorted ascending by date on the Dashboard.
    const sorted = [...events]
      .filter((e) => e.date instanceof Date && e.date.getTime() >= now - 3 * 60 * 60 * 1000)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    for (const e of sorted) {
      const a = (e as any).snackAssignment;
      if (!a || !myIds.has(String(a.playerId || ''))) continue;
      const assignedAtMs = toMs(a.assignedAt);
      // Dismissal is timestamp-scoped: if the coach re-assigns you
      // (new assignedAt), the banner returns.
      const key = dismissedKey(e.id, assignedAtMs);
      try {
        if (typeof window !== 'undefined' && window.localStorage.getItem(key)) continue;
      } catch { /* localStorage unavailable — always show */ }
      return { event: e, assignment: a, assignedAtMs };
    }
    return null;
  }, [events, myPlayerIds, dismissedTick]);

  if (!nextAssignment) return null;
  const { event, assignment, assignedAtMs } = nextAssignment;

  const dateText = event.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const timeText = event.date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
  const firstName = String(assignment.playerName || '').trim().split(/\s+/)[0] || 'your player';

  const dismiss = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      window.localStorage.setItem(dismissedKey(event.id, assignedAtMs), String(Date.now()));
    } catch { /* ignore */ }
    setDismissedTick((t) => t + 1);
  };

  return (
    <Link
      to={`/event/${event.id}`}
      className="relative flex items-center gap-3 rounded-xl bg-amber-500/[0.10] ring-1 ring-amber-400/30 px-3 py-2.5 hover:bg-amber-500/[0.15] transition shadow-sm shadow-black/5"
    >
      <span
        className="flex-shrink-0 w-8 h-8 rounded-full bg-amber-500/20 ring-1 ring-amber-400/40 flex items-center justify-center text-amber-200"
        aria-hidden
      >
        {/* Snack-adjacent glyph — apple silhouette. Monoline, on-brand. */}
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <path d="M12 7c-1-2-3-3-5-2-2 1-3 4-2 7 1 4 3 7 6 10 3-3 5-6 6-10 1-3 0-6-2-7-2-1-4 0-5 2z" />
          <path d="M12 7c0-2 1-3 3-4" />
        </svg>
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] font-black tracking-widest uppercase text-amber-300/85">
          Snack duty
        </p>
        <p className="text-sm text-ink-primary leading-snug mt-0.5">
          <span className="font-bold">{firstName}</span> is on snack for {dateText} at {timeText}.
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Got it, hide"
        className="flex-shrink-0 -mr-1 p-1.5 rounded-md text-amber-200/60 hover:text-amber-100 hover:bg-amber-500/20 transition"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <path d="M6 6l12 12M6 18L18 6" />
        </svg>
      </button>
    </Link>
  );
};

export default SnackAssignmentBanner;
