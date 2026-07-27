/**
 * 2-hour-before event reminders.
 *
 * Every 5 minutes (piggybacking on the campaign cron), find events
 * starting in the window (now+110min, now+130min] that haven't been
 * reminded yet, gather the uids of everyone who said 'going' or
 * 'maybe' (either personally via rsvps or on behalf of a kid via
 * playerRsvps.byUid), and send one push per user with a deep-link to
 * the event.
 *
 * Idempotency: we stamp `reminderSentAt` on the event doc. The query
 * doesn't filter on it (missing-field composite indexes are annoying);
 * instead we skip events where the field is already present. That
 * also protects against the edge case where /5 cron ticks overlap a
 * fresh event during a 15-min slop.
 *
 * We deliberately do NOT include publicRsvps (anonymous guest RSVPs
 * from share links) — no uid, so nothing to push to. And we filter
 * users by pushPreferences.events !== false so someone who turned
 * event pushes off in Notification Preferences stays quiet.
 */

import { ServiceAccount } from './fcm';
import { getDocument, patchDocument, runQuery } from './firestore';
import { sendPush } from './fcm';

interface ReminderEnv {
  FCM_SERVICE_ACCOUNT?: string;
  FIREBASE_PROJECT_ID?: string;
  APP_ORIGIN?: string;
}

type EventDoc = {
  id: string;
  data: any;
};

export async function runEventReminders(env: ReminderEnv): Promise<{
  ok: boolean;
  scanned: number;
  sentEvents: number;
  sentPushes: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let sentEvents = 0;
  let sentPushes = 0;

  if (!env.FCM_SERVICE_ACCOUNT) return { ok: false, scanned: 0, sentEvents, sentPushes, errors: ['no-service-account'] };
  const { parseServiceAccount } = await import('./fcm');
  let sa: ServiceAccount;
  try { sa = parseServiceAccount(env.FCM_SERVICE_ACCOUNT); }
  catch { return { ok: false, scanned: 0, sentEvents, sentPushes, errors: ['bad-service-account'] }; }
  const projectId = env.FIREBASE_PROJECT_ID || sa.project_id;
  if (!projectId) return { ok: false, scanned: 0, sentEvents, sentPushes, errors: ['no-project-id'] };

  const now = new Date();
  const windowStart = new Date(now.getTime() + 110 * 60 * 1000);
  const windowEnd   = new Date(now.getTime() + 130 * 60 * 1000);

  // Query events within the 2h window. Bounded to 200 events per
  // tick — if a real team hits that on a single 20-min slice we've
  // got a much bigger problem than dropped pushes.
  const events = await runQuery(projectId, 'events', [
    { field: 'date', op: 'GREATER_THAN_OR_EQUAL', value: windowStart },
    { field: 'date', op: 'LESS_THAN', value: windowEnd },
  ], sa, 200).catch((err: any) => {
    errors.push(`query-failed: ${String(err?.message || err).slice(0, 200)}`);
    return [] as EventDoc[];
  });

  for (const ev of events) {
    const eid = ev.id;
    const data: any = ev.data || {};

    // Skip soft-deleted (tombstoned) events — coach silently
    // deleted them via handleDelete in EventDetail.tsx, so no
    // push reminders should fire. Missing field is treated as
    // active, so legacy events keep working.
    if (data.isActive === false) continue;

    // Skip if we've already sent a reminder for this event.
    if (data.reminderSentAt) continue;

    // Gather target uids. Both the adult rsvps map AND the parent-on-
    // behalf-of-kid playerRsvps map. Anyone who said 'no' (either
    // path) is excluded.
    const uidSet = new Set<string>();
    if (data.rsvps && typeof data.rsvps === 'object') {
      for (const [uid, entry] of Object.entries(data.rsvps as any)) {
        const status = (entry as any)?.status;
        if (uid && (status === 'going' || status === 'maybe')) uidSet.add(uid);
      }
    }
    if (data.playerRsvps && typeof data.playerRsvps === 'object') {
      for (const entry of Object.values(data.playerRsvps as any)) {
        const status = (entry as any)?.status;
        const byUid = (entry as any)?.byUid;
        if (byUid && (status === 'going' || status === 'maybe')) uidSet.add(byUid);
      }
    }

    if (uidSet.size === 0) {
      // Nobody to remind. Still stamp so we don't rescan.
      try {
        await patchDocument(projectId, `events/${eid}`, { reminderSentAt: now, reminderRecipientCount: 0 }, sa);
      } catch (err: any) {
        errors.push(`stamp-empty ${eid}: ${String(err?.message || err).slice(0, 200)}`);
      }
      continue;
    }

    // Resolve tokens per user. Two filters:
    //   1. user doc must exist and not be isActive === false
    //   2. pushPreferences.events must not be explicitly false
    // Same token collection pattern as notify.ts on the client so
    // token→uid attribution stays consistent if we ever need to
    // prune dead tokens from here.
    const tokens: string[] = [];
    for (const uid of uidSet) {
      try {
        const uDoc = await getDocument(projectId, `users/${uid}`, sa).catch(() => null);
        if (!uDoc?.data) continue;
        const u: any = uDoc.data;
        if (u.isActive === false) continue;
        // Respect the events push pref. Undefined defaults to ON —
        // matches DEFAULT_PUSH_PREFS on the client.
        if (u.pushPreferences && u.pushPreferences.events === false) continue;
        const arr: string[] = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
        for (const t of arr) {
          if (typeof t === 'string' && t.length > 10) tokens.push(t);
        }
      } catch { /* ignore per-user lookup failures */ }
    }

    // Dedupe tokens — a user with multiple devices could contribute
    // several, but the same physical token shouldn't get pinged
    // twice for the same event.
    const uniqueTokens = Array.from(new Set(tokens));

    // Build the push copy. The event's date is a Firestore Timestamp
    // over the wire; format in America/Denver by default (worker's
    // timezone memory).
    const startAt = data.date?.toDate?.() || new Date(data.date || Date.now());
    const time = formatTime(startAt);
    const kind = String(data.type || 'event');
    const rawTitle = String(data.title || '').trim();
    const location = String(data.location || '').trim();
    const title = rawTitle
      ? `In 2 hours: ${rawTitle}`
      : `In 2 hours: ${capitalize(kind)}`;
    const body = location
      ? `${capitalize(kind)} at ${location} — ${time}`
      : `${capitalize(kind)} starts at ${time}`;
    const appOrigin = env.APP_ORIGIN || 'https://app.goalkickr.com';
    const url = `${appOrigin}/event/${eid}`;

    if (uniqueTokens.length === 0) {
      // Every recipient has push off / no tokens. Still stamp.
      try {
        await patchDocument(projectId, `events/${eid}`, {
          reminderSentAt: now,
          reminderRecipientCount: uidSet.size,
          reminderTokenCount: 0,
        }, sa);
      } catch { /* ignore */ }
      continue;
    }

    try {
      const result = await sendPush(uniqueTokens, {
        title,
        body,
        url,
      }, env.FCM_SERVICE_ACCOUNT);
      sentPushes += result.sent;
      await patchDocument(projectId, `events/${eid}`, {
        reminderSentAt: now,
        reminderRecipientCount: uidSet.size,
        reminderTokenCount: uniqueTokens.length,
        reminderSentCount: result.sent,
      }, sa);
      sentEvents++;
    } catch (err: any) {
      errors.push(`send ${eid}: ${String(err?.message || err).slice(0, 200)}`);
    }
  }

  return { ok: errors.length === 0, scanned: events.length, sentEvents, sentPushes, errors };
}

function formatTime(d: Date): string {
  try {
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Denver',
    });
  } catch {
    return d.toISOString();
  }
}

function capitalize(s: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
