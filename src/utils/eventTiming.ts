// Shared "when is an event over?" boundary. Every user-facing surface
// that filters upcoming vs. past events must go through this helper so
// the same event doesn't flip to Past mid-kickoff on the Dashboard
// while still reading as Live on the Calendar (Patrick 2026-07-25:
// coach's complaint that events dropped to Past the second the clock
// hit start time).
//
// Priority for "when does this event end?":
//   1. event.endDate (coach explicitly set one)
//   2. event.date + defaultDurationMinutes(type) (type-aware default)
//   3. max of (2) and end-of-startDate-day in America/Denver
//      — so an event that happened today keeps feeling like "today"
//      through the rest of that calendar day, matching the coach's
//      "not go to past until AFTER the event is over" ask.
//
// The Denver end-of-day floor uses the actual DST-aware offset for
// the specific calendar day (reuses the same shape as
// tripAttribution.endOfDayDenver so a spring-forward day still lands
// at 23:59:59 local, not 22:59:59 or 00:59:59 the next day).

import type { CalendarEvent } from '../types';

/** Type-aware duration used when `event.endDate` is missing. Chosen
 *  so a game or tournament gets a healthy grace window (regulation +
 *  warmups + walk-off) and a practice / team dinner doesn't linger
 *  in "Upcoming" all evening. */
export function defaultDurationMinutes(type?: string | null): number {
  switch (String(type || '').toLowerCase()) {
    case 'game':
      // 90m regulation + warmups + a little post-game buffer so an
      // event mid-second-half isn't classed as ended.
      return 180;
    case 'tournament':
      // Full-day bracket. Rarely used as a `type` today (CalendarEvent
      // only permits game/practice/event), kept for future-proofing
      // and for SmartDiscoveryPrompts which already recognizes it.
      return 480;
    case 'practice':
      return 120;
    default:
      return 120;
  }
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === 'function') {
    try {
      return value.toDate();
    } catch {
      return null;
    }
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** UTC-ms of Denver's 23:59:59.999 for the calendar day that `d`
 *  falls into. Mirrors tripAttribution.endOfDayDenver so DST edges
 *  are respected. Falls back to local midnight if Intl misbehaves. */
function endOfDenverDayMs(d: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const y = Number(parts.find(p => p.type === 'year')?.value || 0);
    const m = Number(parts.find(p => p.type === 'month')?.value || 0);
    const day = Number(parts.find(p => p.type === 'day')?.value || 0);
    if (!y || !m || !day) throw new Error('bad Denver date parts');

    // Ask Intl for the Denver clock hour at 12:00 UTC that day; the
    // difference from 12 is Denver's UTC offset in hours (6 for MDT,
    // 7 for MST). 12:00 UTC is safely inside the DST regime on both
    // transition days, avoiding the 2am flip.
    const probe = new Date(Date.UTC(y, m - 1, day, 12, 0, 0));
    const hourParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      hour: '2-digit', hour12: false,
    }).formatToParts(probe);
    const raw = hourParts.find(p => p.type === 'hour')?.value || '05';
    // en-US with hour12:false emits "24" for midnight — normalise.
    const denverHour = Number(raw) % 24;
    const offsetHours = 12 - denverHour;

    // Denver 23:59:59.999 -> UTC (23 + offset) : 59 : 59 . 999.
    return Date.UTC(y, m - 1, day, 23 + offsetHours, 59, 59, 999);
  } catch {
    const c = new Date(d);
    c.setHours(23, 59, 59, 999);
    return c.getTime();
  }
}

/** Ms since epoch when the event should be considered OVER. See file
 *  header for the priority order. Accepts any object that shape-
 *  matches `{ date, endDate?, type? }`, tolerating Firestore
 *  Timestamps, Dates, and ISO strings. */
export function eventEndMs(
  event: Pick<CalendarEvent, 'date' | 'endDate' | 'type'> | any
): number {
  const start = toDate(event?.date);
  if (!start) return 0;
  const startMs = start.getTime();

  const explicit = toDate(event?.endDate);
  if (explicit) {
    const endMs = explicit.getTime();
    if (endMs > startMs) return endMs;
  }

  const durMs = defaultDurationMinutes(event?.type) * 60_000;
  const bodyEnd = startMs + durMs;
  const dayEnd = endOfDenverDayMs(start);
  return Math.max(bodyEnd, dayEnd);
}

/** True when the event has finished per `eventEndMs`. Callers should
 *  use this instead of `new Date(event.date) < new Date()` anywhere
 *  they're categorizing an event as upcoming/past. */
export function isEventPast(event: any, now: Date = new Date()): boolean {
  const end = eventEndMs(event);
  if (!end) return false;
  return end < now.getTime();
}

/** True when we're between kickoff and eventEndMs. Useful for
 *  "LIVE" badges and "auto-select the event currently happening"
 *  paths. */
export function isEventLive(event: any, now: Date = new Date()): boolean {
  const start = toDate(event?.date);
  if (!start) return false;
  const nowMs = now.getTime();
  return nowMs >= start.getTime() && nowMs < eventEndMs(event);
}
