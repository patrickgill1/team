// Vercel serverless function — returns an iCalendar (.ics) feed for a
// team's upcoming events. Parents subscribe in Apple/Google Calendar
// via:  webcals://app.goalkickr.com/api/calendar/<teamId>
// (webcals with the s = TLS; plain webcal:// makes iOS Calendar
// throw an "Insecure Connection" prompt on subscribe.)
//
// Reads through Firestore's REST API. Events are publicly readable
// per the firestore.rules ("allow read: if true" on /events), so we
// don't need an authenticated client here — keeps the function tiny
// and fast.
//
// Env vars required:
//   FIREBASE_PROJECT_ID — the project's Firebase ID (same value used
//     by client-side firebase init).

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

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

// Convert a Firestore REST API document into a flat JS object.
function flatten(doc) {
  const out = { id: (doc.name || '').split('/').pop() };
  const fields = doc.fields || {};
  for (const [k, v] of Object.entries(fields)) {
    if ('stringValue' in v) out[k] = v.stringValue;
    else if ('integerValue' in v) out[k] = parseInt(v.integerValue, 10);
    else if ('doubleValue' in v) out[k] = v.doubleValue;
    else if ('booleanValue' in v) out[k] = v.booleanValue;
    else if ('timestampValue' in v) out[k] = new Date(v.timestampValue);
    else if ('mapValue' in v) out[k] = v.mapValue;
    else if ('arrayValue' in v) out[k] = (v.arrayValue.values || []).map((x) =>
      'stringValue' in x ? x.stringValue : x);
    else out[k] = v;
  }
  return out;
}

export default async function handler(req, res) {
  if (!PROJECT_ID) {
    res.status(500).send('Server misconfigured: FIREBASE_PROJECT_ID missing');
    return;
  }

  // Vercel encodes the dynamic segment ("team") as req.query.team. We
  // accept either /<teamId>.ics or /<teamId> for friendlier URLs.
  let teamId = (req.query.team || '').toString();
  if (teamId.endsWith('.ics')) teamId = teamId.slice(0, -4);
  if (!teamId) {
    res.status(400).send('Missing team id');
    return;
  }

  try {
    // Query Firestore REST API for events where teamId == teamId.
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
    const body = {
      structuredQuery: {
        from: [{ collectionId: 'events' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'teamId' },
            op: 'EQUAL',
            value: { stringValue: teamId },
          },
        },
        limit: 500,
      },
    };
    const fsRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!fsRes.ok) {
      const errText = await fsRes.text();
      res.status(502).send(`Firestore error ${fsRes.status}: ${errText}`);
      return;
    }
    const data = await fsRes.json();
    const docs = Array.isArray(data) ? data.map((r) => r.document).filter(Boolean) : [];
    const events = docs.map(flatten);

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
      const start = ev.date instanceof Date ? ev.date : (ev.date ? new Date(ev.date) : null);
      if (!start || isNaN(start.getTime())) continue;
      // Default duration 90 min if no endDate provided.
      const end = ev.endDate instanceof Date ? ev.endDate : new Date(start.getTime() + 90 * 60 * 1000);
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
