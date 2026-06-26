// Player widget snapshot endpoint. iOS PlayerWidget hits
// GET /widget/snapshot every hour and renders the returned JSON.
// Same shape will serve the Android widget when that ships.
//
// Auth: long-lived widgetToken on users/{uid}.widgetToken. User
// reads it from Settings → Widget in the app and pastes it into
// the widget's edit screen. No App Group / native plugin needed.
//
// Why a long-lived token vs Firebase ID token:
//   - The widget extension can't run Firebase Auth.
//   - ID tokens expire hourly and need refresh; widgets refresh on
//     an unpredictable schedule.
//   - A bearer token the user pastes once is the cleanest UX, and
//     leaks only one player's already-shared-with-the-team data.

import { runQuery, getDocument } from './firestore';
import { ServiceAccount, parseServiceAccount } from './fcm';

export interface WidgetEnv {
  FIREBASE_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT?: string;
}

interface WidgetSnapshot {
  playerId: string;
  playerName: string;
  jerseyNumber?: number | null;
  photoUrl?: string | null;
  teamName?: string | null;
  streakDays: number;
  potmCount?: number;
  // Next non-cancelled event on the player's schedule. Cancelled
  // events are explicitly filtered upstream so the widget never
  // shows a CANCELLED row as 'Next up'.
  nextEventTitle?: string | null;
  nextEventType?: string | null;
  nextEventDateMs?: number | null;
  nextEventLocation?: string | null;
  // Player's RSVP for the next event ('going' | 'maybe' | 'no' |
  // null if no response). Read from event.playerRsvps[playerId].
  nextEventRsvp?: 'going' | 'maybe' | 'no' | null;
  // Fallback when the schedule is empty — shows the most recent
  // game result so the widget always has something to show.
  lastResultTitle?: string | null;
  lastResultScore?: string | null;    // 'W 3-1' / 'L 0-2'
  lastResultDateMs?: number | null;
  generatedAt: number;
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Widget extensions don't honor CORS, but be permissive for
      // any web preview / debug use. Token is the actual gate.
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

function getSa(env: WidgetEnv): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try { return parseServiceAccount(env.FCM_SERVICE_ACCOUNT); } catch { return null; }
}

function projectId(env: WidgetEnv): string | null {
  if (env.FIREBASE_PROJECT_ID) return env.FIREBASE_PROJECT_ID;
  return getSa(env)?.project_id || null;
}

// Constant-time compare so token verification isn't timing-
// distinguishable. Tokens are short, discipline is cheap.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function findUserByWidgetToken(
  pid: string,
  sa: ServiceAccount,
  token: string,
): Promise<{ uid: string; user: any } | null> {
  const rows = await runQuery(
    pid,
    'users',
    [{ field: 'widgetToken', op: 'EQUAL', value: token }],
    sa,
    1,
  ).catch(() => [] as any[]);
  if (!rows || rows.length === 0) return null;
  const row: any = rows[0];
  return { uid: row.id, user: row.data || {} };
}

// Pull every player linked to this user. Multi-team kids show up
// as multiple player documents (one per team — common when a kid
// is on a club team AND a skills-academy team, since each team is
// often managed by a different coach who creates their own roster
// entry). Returns the raw rows; caller picks the display identity
// and aggregates teamIds across the whole set.
async function findLinkedPlayers(
  pid: string,
  sa: ServiceAccount,
  uid: string,
): Promise<Array<{ id: string; data: any }>> {
  const rows = await runQuery(
    pid,
    'players',
    [{ field: 'parentIds', op: 'ARRAY_CONTAINS', value: uid }],
    sa,
    10,
  ).catch(() => [] as any[]);
  return (rows || [])
    .map((r: any) => ({ id: r.id as string, data: r.data || {} }))
    .filter(r => r.data.isActive !== false);
}

async function buildSnapshot(
  pid: string,
  sa: ServiceAccount,
  uid: string,
  user: any,
): Promise<WidgetSnapshot | null> {
  // Resolve which player(s) we're working with.
  //   1. user.selfPlayerId — adult player path (they ARE the player)
  //   2. user.widgetPlayerId — user explicitly picked which kid
  //   3. otherwise: every player linked via player.parentIds
  //
  // For #3 we intentionally pull the whole set (not just the first)
  // because a kid can have multiple player documents — one per
  // team. Without aggregating, the widget would only ever see
  // events from whichever team Firestore returned first. Patrick
  // caught this when his widget only showed Sat Skills events and
  // missed his main team entirely.
  let primaryId: string | null = user?.selfPlayerId || user?.widgetPlayerId || null;
  let linked: Array<{ id: string; data: any }> = [];

  if (primaryId) {
    const single = await getDocument(pid, `players/${primaryId}`, sa).catch(() => null);
    if (single) linked = [{ id: primaryId, data: single.data || {} }];
  } else {
    linked = await findLinkedPlayers(pid, sa, uid);
    if (linked.length > 0) primaryId = linked[0].id;
  }
  if (!primaryId || linked.length === 0) return null;

  // Display identity: prefer the linked player record with the
  // most photo / jersey detail (a kid's "main team" record usually
  // has the full profile; the academy record is sparser).
  const ranked = [...linked].sort((a, b) => {
    const score = (r: { data: any }) =>
      (r.data?.profilePhotoUrl ? 4 : 0) +
      (typeof r.data?.jerseyNumber === 'number' ? 2 : 0) +
      (Array.isArray(r.data?.teamIds) ? r.data.teamIds.length : (r.data?.teamId ? 1 : 0));
    return score(b) - score(a);
  });
  const p: any = ranked[0].data || {};
  const playerId = ranked[0].id;

  // Aggregate teams across EVERY linked player record so events
  // from any of the kid's teams can surface. Capped to keep the
  // event-query fanout bounded.
  const teamSet = new Set<string>();
  for (const r of linked) {
    const d = r.data || {};
    if (Array.isArray(d.teamIds)) d.teamIds.forEach((t: string) => t && teamSet.add(t));
    if (d.teamId) teamSet.add(d.teamId);
  }
  const tIds: string[] = Array.from(teamSet);
  let nextEvent: any = null;
  let nextMs = Number.POSITIVE_INFINITY;
  let lastGame: any = null;
  let lastGameMs = Number.NEGATIVE_INFINITY;
  const nowMs = Date.now();
  const lookbackDays = 21;
  const lookbackDate = new Date(nowMs - lookbackDays * 24 * 60 * 60 * 1000);

  for (const tid of tIds.slice(0, 5)) {
    try {
      const rows = await runQuery(
        pid,
        'events',
        [
          { field: 'teamId', op: 'EQUAL', value: tid },
          { field: 'date', op: 'GREATER_THAN_OR_EQUAL', value: lookbackDate },
        ],
        sa,
        40,
      ).catch(() => [] as any[]);

      for (const r of rows) {
        const d: any = r.data || {};
        // Soft-delete pattern: cancelled events stay in the
        // collection with isCancelled=true so attendees can see
        // why nothing's happening. Never surface them on the
        // widget — Patrick caught this on the first screenshot.
        if (d.isCancelled === true) continue;
        const ms = d.date instanceof Date
          ? d.date.getTime()
          : (typeof d.date === 'string' ? Date.parse(d.date) : NaN);
        if (!Number.isFinite(ms)) continue;
        if (ms >= nowMs) {
          if (ms < nextMs) { nextMs = ms; nextEvent = d; }
        } else {
          // Past event — only games with a completed result are
          // useful as a fallback display.
          const res: any = d.result;
          const isCompleted = res && typeof res === 'object' && res.status === 'completed'
            && typeof res.teamScore === 'number' && typeof res.opponentScore === 'number';
          if (isCompleted && ms > lastGameMs) { lastGameMs = ms; lastGame = d; }
        }
      }
    } catch { /* ignore */ }
  }

  let lastResultScore: string | null = null;
  let lastResultTitle: string | null = null;
  if (lastGame && lastGame.result) {
    const ts = lastGame.result.teamScore;
    const os = lastGame.result.opponentScore;
    const tag = ts > os ? 'W' : ts < os ? 'L' : 'T';
    lastResultScore = `${tag} ${ts}-${os}`;
    lastResultTitle = lastGame.opponent
      ? `vs ${lastGame.opponent}`
      : (lastGame.title || 'Game');
  }

  let teamName: string | null = null;
  if (tIds.length > 0) {
    try {
      const tDoc = await getDocument(pid, `teams/${tIds[0]}`, sa).catch(() => null);
      teamName = (tDoc?.data as any)?.name || null;
    } catch { /* ignore */ }
  }

  return {
    playerId,
    playerName: p.name || 'Player',
    jerseyNumber: typeof p.jerseyNumber === 'number' ? p.jerseyNumber : null,
    photoUrl: p.profilePhotoUrl || null,
    teamName,
    streakDays: typeof p.currentStreakDays === 'number' ? p.currentStreakDays : 0,
    potmCount: typeof p.potmCount === 'number' ? p.potmCount : 0,
    nextEventTitle: nextEvent?.title || null,
    nextEventType: nextEvent?.type || null,
    nextEventDateMs: Number.isFinite(nextMs) ? nextMs : null,
    nextEventLocation: nextEvent?.location || null,
    nextEventRsvp: ((): 'going' | 'maybe' | 'no' | null => {
      const m = nextEvent?.playerRsvps;
      if (!m || typeof m !== 'object') return null;
      // Check every linked player id — the kid's main-team record
      // and academy-team record have different player ids, and the
      // RSVP is keyed by whichever id matches the event's team.
      for (const r of linked) {
        const row = (m as any)[r.id];
        const s = row?.status;
        if (s === 'going' || s === 'maybe' || s === 'no') return s;
      }
      return null;
    })(),
    lastResultTitle,
    lastResultScore,
    lastResultDateMs: Number.isFinite(lastGameMs) ? lastGameMs : null,
    generatedAt: Date.now(),
  };
}

export async function handleWidgetRequest(request: Request, env: WidgetEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/widget/snapshot') return json({ ok: false, error: 'not-found' }, 404);

  // Token from Authorization: Bearer <token> or ?token=
  let token = '';
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) token = auth.slice(7).trim();
  if (!token) token = url.searchParams.get('token') || '';
  if (!token || token.length < 16) return json({ ok: false, error: 'missing-token' }, 401);

  const pid = projectId(env);
  const sa = getSa(env);
  if (!pid || !sa) return json({ ok: false, error: 'firestore-not-configured' }, 503);

  const hit = await findUserByWidgetToken(pid, sa, token);
  if (!hit) return json({ ok: false, error: 'invalid-token' }, 401);
  const stored = String(hit.user?.widgetToken || '');
  if (!safeEqual(stored, token)) return json({ ok: false, error: 'invalid-token' }, 401);

  const snapshot = await buildSnapshot(pid, sa, hit.uid, hit.user);
  if (!snapshot) return json({ ok: false, error: 'no-player' }, 404);
  return json({ ok: true, snapshot });
}
