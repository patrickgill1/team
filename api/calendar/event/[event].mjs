// Vercel serverless function — returns a single-event iCalendar (.ics)
// download for one event by id. Powers the per-event "Add to Calendar"
// button on EventDetail + the event list card. Unlike the team feed
// (../[team].mjs), this endpoint returns exactly one VEVENT and sets
// Content-Disposition: attachment so mobile share sheets treat the
// response as a downloadable calendar file rather than a subscription
// URL to paste into Calendar.
//
// URL shapes accepted:
//   /api/calendar/event/<eventId>.ics   (preferred — mobile share sheets
//                                       key off the file extension)
//   /api/calendar/event/<eventId>       (bare — for direct fetches)
//
// Anonymous read, same as the team feed. Uses the Firebase Admin SDK so
// tightened Firestore rules (Phase 2 authed-only reads) don't 403 the
// unauthenticated calendar client. isActive === false and any event that
// doesn't exist both return 404 so we don't leak the difference between
// "never existed" and "coach quietly deleted this."
//
// Env vars required (Vercel):
//   FIREBASE_PROJECT_ID   — Firebase project id
//   FIREBASE_CLIENT_EMAIL — service account email
//   FIREBASE_PRIVATE_KEY  — service account PEM key
//                           (Vercel stores it with literal \n; we
//                            convert those back to real newlines.)

import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function adminApp() {
  const existing = getApps();
  if (existing.length > 0) return existing[0];

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Missing Firebase Admin env vars (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).');
  }
  return initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    projectId,
  });
}

function escapeIcs(text = '') {
  return String(text)
    // Normalize CRLF and bare CR to LF FIRST so a Windows-copied blob
    // (Notepad, Word, Outlook) doesn't leave a literal CR byte inside
    // the property value. Strict RFC 5545 parsers treat CR as the end
    // of a content line, so a CR in the middle truncates the value or
    // rejects the whole VEVENT.
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function fmt(date) {
  // 20260601T180000Z — floating UTC. Same approach as the team feed
  // ../[team].mjs. Calendar clients render the Z-suffixed absolute time
  // in the viewer's local zone, which is what parents on the road want.
  // VTIMEZONE would only matter for repeating events anchored to a
  // named zone, which we don't do here.
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getUTCFullYear().toString() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    'T' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  );
}

// Coerce a Firestore field value to a Date. Admin SDK returns
// Timestamps for timestamp fields; strings sometimes sneak in from
// legacy imports. Return null if unrecognized.
function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === 'function') return v.toDate();
  if (typeof v === 'string') {
    // Legacy string-date guard 2026-07-24. A naive local string like
    // '2026-08-15T18:00' with no zone marker gets parsed by Node in the
    // process TZ, which on Vercel is UTC. That drifts the event by 6-7h
    // for a Denver coach who meant 6 PM local. When the string has no
    // Z or +/- offset, interpret as America/Denver by appending -06:00
    // (MDT) as a stable coarse offset. Fine for one-off legacy imports;
    // Firestore Timestamp values (the normal path) are unaffected.
    const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(v);
    const s = hasZone ? v : `${v}-06:00`;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Downcase + collapse to hyphen-safe slug for the filename. Titles like
// "U10 vs Coyotes @ Little Valley" become "u10-vs-coyotes-little-valley"
// so a saved .ics is legible in a Downloads folder without breaking on
// mobile share sheets that reject spaces or punctuation.
function slugify(text) {
  return String(text || 'event')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'event';
}

// Prettify a bare event.type ('practice' / 'game' / 'event') into a
// title-cased fallback when the event has no explicit title.
function titleFallback(type) {
  if (type === 'practice') return 'Practice';
  if (type === 'game') return 'Game';
  return 'Event';
}

export default async function handler(req, res) {
  // Vercel encodes the dynamic segment as req.query.event. Accept the
  // trailing .ics extension for share-sheet friendliness or bare id
  // for a direct fetch.
  let eventId = (req.query.event || '').toString();
  if (eventId.endsWith('.ics')) eventId = eventId.slice(0, -4);
  if (!eventId) {
    res.status(400).send('Missing event id');
    return;
  }

  try {
    const db = getFirestore(adminApp());
    const snap = await db.collection('events').doc(eventId).get();
    if (!snap.exists) {
      res.status(404).send('Event not found');
      return;
    }
    const ev = { id: snap.id, ...(snap.data() || {}) };

    // Soft-deleted events masquerade as not-found. A parent tapping an
    // old link on a coach-deleted event shouldn't get the event details
    // through the calendar file.
    if (ev.isActive === false) {
      res.status(404).send('Event not found');
      return;
    }

    const start = toDate(ev.date);
    if (!start) {
      res.status(500).send('Event has no start date');
      return;
    }
    // Default duration 90 min if no endDate provided — matches the team
    // feed builder and the client-side inline downloadEventIcs.
    const end = toDate(ev.endDate) || new Date(start.getTime() + 90 * 60 * 1000);

    const title = ev.title || titleFallback(ev.type);
    const locationStr = ev.location || '';
    const descParts = [];
    if (ev.opponent) descParts.push(`Opponent: ${ev.opponent}`);
    if (ev.homeAway) descParts.push(`Home/Away: ${ev.homeAway}`);
    if (ev.fieldNumber) descParts.push(`Field: ${ev.fieldNumber}`);
    if (ev.description) descParts.push(ev.description);
    // CANCELLED reason shows up in the DESCRIPTION so the calendar row
    // still explains itself when the coach reads the entry days later.
    // STATUS:CANCELLED (below) makes iOS Calendar strike-through the
    // event as well.
    if (ev.isCancelled && ev.cancelReason) descParts.push(`Cancelled: ${ev.cancelReason}`);

    const now = new Date();
    const status = ev.isCancelled ? 'CANCELLED' : 'CONFIRMED';
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//GoalKickr//Event Invite//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${escapeIcs(title)}`,
      // Denver-anchored so importers that fall back to X-WR-TIMEZONE
      // (Google Calendar in particular) render the calendar's default
      // in the coach's real zone, not UTC. DTSTART/DTEND themselves
      // still emit Z-suffixed absolutes so single-event display is
      // zone-correct on every client regardless.
      'X-WR-TIMEZONE:America/Denver',
      'BEGIN:VEVENT',
      `UID:${ev.id}@app.goalkickr.com`,
      `DTSTAMP:${fmt(now)}`,
      `DTSTART:${fmt(start)}`,
      `DTEND:${fmt(end)}`,
      `SUMMARY:${escapeIcs(title)}`,
      `STATUS:${status}`,
    ];
    if (locationStr) lines.push(`LOCATION:${escapeIcs(locationStr)}`);
    if (descParts.length) lines.push(`DESCRIPTION:${escapeIcs(descParts.join('\n'))}`);
    lines.push('END:VEVENT');
    lines.push('END:VCALENDAR');

    const filename = `${slugify(title)}.ics`;
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    // attachment; filename= makes the browser download the file rather
    // than trying to render it inline; on iOS Safari + Android Chrome
    // the .ics is handed to the Calendar app on open.
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Short cache — an edited event should reflect in <5 min on any
    // subsequent share.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).send(lines.join('\r\n'));
  } catch (err) {
    console.error('[calendar event] failed', err);
    res.status(500).send(`Event calendar generation failed: ${err?.message || err}`);
  }
}
