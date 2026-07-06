// Vercel serverless function — returns an iCalendar (.ics) feed for a
// team's upcoming events. Parents subscribe in Apple/Google Calendar
// via: pasting https://app.goalkickr.com/api/calendar/<teamId>.ics
// into Calendar's "Add Subscription Calendar" flow.
// (webcal:// works but iOS Calendar mislabels it "Insecure
//  Connection" over TLS. webcals:// is not a recognized scheme.)
//
// Uses Firebase Admin SDK to bypass Firestore rules — events are no
// longer world-readable (Phase 2 security tightened them to
// authed-only), so the unauthenticated REST path returns 403 and
// iOS then labels the whole endpoint as "insecure" because it got
// an HTML error page instead of iCal content.
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
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function fmt(date) {
  // 20260601T180000Z (UTC, no separators)
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
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export default async function handler(req, res) {
  // Vercel encodes the dynamic segment ("team") as req.query.team. We
  // accept either /<teamId>.ics or /<teamId> for friendlier URLs.
  let teamId = (req.query.team || '').toString();
  if (teamId.endsWith('.ics')) teamId = teamId.slice(0, -4);
  if (!teamId) {
    res.status(400).send('Missing team id');
    return;
  }

  try {
    const db = getFirestore(adminApp());
    const snap = await db.collection('events')
      .where('teamId', '==', teamId)
      .limit(500)
      .get();

    const events = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));

    // Build the .ics
    const now = new Date();
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//GoalKickr//Team Calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:GoalKickr team schedule`,
      `X-WR-TIMEZONE:UTC`,
    ];
    for (const ev of events) {
      const start = toDate(ev.date);
      if (!start) continue;
      // Default duration 90 min if no endDate provided.
      const end = toDate(ev.endDate) || new Date(start.getTime() + 90 * 60 * 1000);
      const title = ev.title || (ev.type === 'practice' ? 'Practice' : ev.type === 'game' ? 'Game' : 'Event');
      const locationStr = ev.location || '';
      const descParts = [];
      if (ev.opponent) descParts.push(`Opponent: ${ev.opponent}`);
      if (ev.homeAway) descParts.push(`Home/Away: ${ev.homeAway}`);
      if (ev.description) descParts.push(ev.description);
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${ev.id}@app.goalkickr.com`);
      lines.push(`DTSTAMP:${fmt(now)}`);
      lines.push(`DTSTART:${fmt(start)}`);
      lines.push(`DTEND:${fmt(end)}`);
      lines.push(`SUMMARY:${escapeIcs(title)}`);
      if (locationStr) lines.push(`LOCATION:${escapeIcs(locationStr)}`);
      if (descParts.length) lines.push(`DESCRIPTION:${escapeIcs(descParts.join('\n'))}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    // Cache for 5 min — phones poll every ~15 min anyway.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).send(lines.join('\r\n'));
  } catch (err) {
    console.error('[calendar feed] failed', err);
    res.status(500).send(`Feed generation failed: ${err?.message || err}`);
  }
}
