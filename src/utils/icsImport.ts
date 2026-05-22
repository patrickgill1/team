/**
 * Minimal iCalendar (.ics) parser tailored to youth-soccer schedule
 * imports. Handles the subset of RFC 5545 that GotSoccer, Demosphere,
 * TeamSnap, Google Calendar, and Apple Calendar exports actually use:
 *
 *   BEGIN:VEVENT
 *   SUMMARY:Game vs Lightning U12
 *   DTSTART:20260601T180000Z       ← UTC
 *   DTSTART;TZID=America/New_York:20260601T140000   ← local w/ tz
 *   DTSTART;VALUE=DATE:20260601    ← all-day
 *   LOCATION:River Park Field 3
 *   DESCRIPTION:Bring white jerseys
 *   END:VEVENT
 *
 * We do NOT try to be a full ICS implementation (no recurrence
 * expansion, no VALARM, no per-component timezone math). Anything we
 * can't parse cleanly is just skipped and surfaced as a warning.
 */

import type { CalendarEvent } from '../types';

export interface ParsedIcsEvent {
  /** RFC 5545 UID — used to dedupe re-imports of the same calendar. */
  uid?: string;
  title: string;
  description?: string;
  location?: string;
  /** Start time as a local-clock Date (no tz translation). */
  date: Date;
  /** End time, if the source provided one. */
  endDate?: Date;
  allDay: boolean;
}

/** Unfold RFC 5545 line continuations (lines that start with space/tab). */
function unfoldLines(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

/** Decode the escaped characters used in TEXT-type values. */
function decodeText(v: string): string {
  return v
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** Parse a DTSTART/DTEND value of any common shape into a Date. */
function parseDate(value: string): { date: Date; allDay: boolean } | null {
  // Date-only: 20260601
  if (/^\d{8}$/.test(value)) {
    const y = +value.slice(0, 4);
    const m = +value.slice(4, 6) - 1;
    const d = +value.slice(6, 8);
    return { date: new Date(y, m, d, 0, 0, 0), allDay: true };
  }
  // DateTime: 20260601T180000 (floating local) or 20260601T180000Z (UTC).
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, ys, mos, ds, hs, mins, ss, z] = m;
  const y = +ys, mo = +mos - 1, d = +ds, h = +hs, mi = +mins, s = +ss;
  if (z === 'Z') {
    return { date: new Date(Date.UTC(y, mo, d, h, mi, s)), allDay: false };
  }
  // Floating local or TZID-stamped local — treat as the local clock time.
  // For soccer schedules the league timezone always equals the user's
  // timezone, so this is correct in practice.
  return { date: new Date(y, mo, d, h, mi, s), allDay: false };
}

/** Strip the parameter part of a property line. `DTSTART;TZID=X` → `DTSTART`. */
function splitProperty(line: string): { name: string; value: string } | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const semi = left.indexOf(';');
  const name = semi === -1 ? left : left.slice(0, semi);
  return { name: name.toUpperCase(), value };
}

export function parseIcs(text: string): { events: ParsedIcsEvent[]; warnings: string[] } {
  const lines = unfoldLines(text);
  const events: ParsedIcsEvent[] = [];
  const warnings: string[] = [];
  let inEvent = false;
  let current: Partial<ParsedIcsEvent> = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      inEvent = false;
      if (current.title && current.date) {
        events.push({
          uid: current.uid,
          title: current.title,
          description: current.description,
          location: current.location,
          date: current.date,
          endDate: current.endDate,
          allDay: current.allDay === true,
        });
      } else {
        warnings.push('Skipped an event missing a title or start time.');
      }
      current = {};
      continue;
    }
    if (!inEvent) continue;
    const prop = splitProperty(line);
    if (!prop) continue;
    switch (prop.name) {
      case 'SUMMARY':
        current.title = decodeText(prop.value);
        break;
      case 'DESCRIPTION':
        current.description = decodeText(prop.value);
        break;
      case 'LOCATION':
        current.location = decodeText(prop.value);
        break;
      case 'UID':
        current.uid = prop.value;
        break;
      case 'DTSTART': {
        const parsed = parseDate(prop.value);
        if (parsed) {
          current.date = parsed.date;
          current.allDay = parsed.allDay;
        }
        break;
      }
      case 'DTEND': {
        const parsed = parseDate(prop.value);
        if (parsed) current.endDate = parsed.date;
        break;
      }
    }
  }
  return { events, warnings };
}

/**
 * Guess the event type + opponent + home/away from the title.
 * Soccer-league exports typically format titles as:
 *   "Fire FC PG vs Lightning U12"
 *   "Lightning U12 @ Fire FC PG"
 *   "Practice - Fire FC PG"
 *   "Spring Tournament"
 */
export function classifyEvent(
  title: string,
  teamName: string,
): Pick<CalendarEvent, 'type' | 'opponent' | 'homeAway'> {
  const lower = title.toLowerCase();
  const teamLower = (teamName || '').toLowerCase();

  if (/practice|training|skills/.test(lower)) {
    return { type: 'practice' };
  }

  // "X vs Y" — home if our team is on the left
  const vsMatch = title.match(/(.+?)\s+vs\.?\s+(.+)/i);
  if (vsMatch) {
    const [, left, right] = vsMatch;
    const leftIsUs = teamLower && left.toLowerCase().includes(teamLower);
    return {
      type: 'game',
      opponent: (leftIsUs ? right : left).trim(),
      homeAway: leftIsUs ? 'home' : 'away',
    };
  }

  // "X @ Y" — away if our team is on the left
  const atMatch = title.match(/(.+?)\s+@\s+(.+)/);
  if (atMatch) {
    const [, left, right] = atMatch;
    const leftIsUs = teamLower && left.toLowerCase().includes(teamLower);
    return {
      type: 'game',
      opponent: (leftIsUs ? right : left).trim(),
      homeAway: leftIsUs ? 'away' : 'home',
    };
  }

  if (/game|match|tournament|cup|league/.test(lower)) {
    return { type: 'game' };
  }

  return { type: 'event' };
}

/** Two events are duplicates if they share a title and start within an hour. */
export function isDuplicate(a: ParsedIcsEvent, b: { title: string; date: Date }): boolean {
  if (a.title.trim().toLowerCase() !== b.title.trim().toLowerCase()) return false;
  const dt = Math.abs(a.date.getTime() - new Date(b.date).getTime());
  return dt < 60 * 60 * 1000;
}
