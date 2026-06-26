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
  streakDays: number;
  nextEventTitle?: string | null;
  nextEventDateMs?: number | null;
  nextEventLocation?: string | null;
  potmCount?: number;
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

async function findFirstChildPlayerId(
  pid: string,
  sa: ServiceAccount,
  uid: string,
): Promise<string | null> {
  const rows = await runQuery(
    pid,
    'players',
    [{ field: 'parentIds', op: 'ARRAY_CONTAINS', value: uid }],
    sa,
    1,
  ).catch(() => [] as any[]);
  if (!rows || rows.length === 0) return null;
  return rows[0].id || null;
}

async function buildSnapshot(
  pid: string,
  sa: ServiceAccount,
  uid: string,
  user: any,
): Promise<WidgetSnapshot | null> {
  // Resolve which player to show. Priority:
  //   1. user.selfPlayerId — adult player path (they ARE the player)
  //   2. user.widgetPlayerId — user explicitly picked which kid
  //   3. first player linked via player.parentIds
  let playerId: string | null = user?.selfPlayerId || user?.widgetPlayerId || null;
  if (!playerId) playerId = await findFirstChildPlayerId(pid, sa, uid);
  if (!playerId) return null;

  const doc = await getDocument(pid, `players/${playerId}`, sa).catch(() => null);
  if (!doc) return null;
  const p: any = doc.data || {};

  // Next event: query events for any of the player's teams with
  // date >= now, asc. runQuery() only takes simple AND filters, so
  // we do one query per team (usually 1-2) and pick the soonest.
  const tIds: string[] = Array.isArray(p.teamIds) && p.teamIds.length
    ? p.teamIds
    : (p.teamId ? [p.teamId] : []);
  let nextEvent: any = null;
  let nextMs = Number.POSITIVE_INFINITY;
  const nowMs = Date.now();
  for (const tid of tIds.slice(0, 3)) {
    try {
      const rows = await runQuery(
        pid,
        'events',
        [
          { field: 'teamId', op: 'EQUAL', value: tid },
          { field: 'date', op: 'GREATER_THAN_OR_EQUAL', value: new Date(nowMs) },
        ],
        sa,
        5,
      ).catch(() => [] as any[]);
      for (const r of rows) {
        const d: any = r.data || {};
        const ms = d.date instanceof Date ? d.date.getTime() : (typeof d.date === 'string' ? Date.parse(d.date) : NaN);
        if (Number.isFinite(ms) && ms < nextMs) {
          nextMs = ms;
          nextEvent = d;
        }
      }
    } catch { /* ignore */ }
  }

  return {
    playerId,
    playerName: p.name || 'Player',
    jerseyNumber: typeof p.jerseyNumber === 'number' ? p.jerseyNumber : null,
    photoUrl: p.profilePhotoUrl || null,
    streakDays: typeof p.currentStreakDays === 'number' ? p.currentStreakDays : 0,
    nextEventTitle: nextEvent?.title || null,
    nextEventDateMs: Number.isFinite(nextMs) ? nextMs : null,
    nextEventLocation: nextEvent?.location || null,
    potmCount: typeof p.potmCount === 'number' ? p.potmCount : 0,
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
