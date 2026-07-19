/**
 * Trip primitive — coach-owned stat-scoping container for tournaments
 * / weekend trips. See src/utils/tripAttribution.ts for the client
 * companion and the audit + design contract for the full shape.
 *
 * All writes go through this module so:
 *   - Only coach-of-team can create / update / archive / edit roster
 *   - clubId is snapshotted at create time
 *   - shareToken is minted server-side (unguessable) and never rotated
 *     without an explicit /trips/update payload — v1.1 will add a
 *     dedicated rotate endpoint.
 */

import { requireCoachOfTeam, AuthError } from './auth';
import { parseServiceAccount, ServiceAccount } from './fcm';
import {
  getDocument,
  patchDocument,
  createDocument,
  commitDocumentTransforms,
} from './firestore';

interface Env {
  FIREBASE_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT?: string;
  APP_ORIGIN?: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

function projectAndSA(env: Env): { pid: string; sa: ServiceAccount } {
  const pid = env.FIREBASE_PROJECT_ID;
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!pid || !raw) throw new AuthError('server_not_configured', 500);
  return { pid, sa: parseServiceAccount(raw) };
}

// Unguessable share token — 24 bytes → 32 base64url chars. Enough
// entropy that anyone trying to enumerate is effectively brute-forcing
// a 192-bit key.
function mintShareToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function coerceDate(v: any): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return d;
}

function sanitizeAttendees(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 200) break;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// POST /trips/create
// Body: { teamId, name, startDate, endDate, description?, attendingPlayerIds[] }
// Returns { ok: true, id, shareToken }
// ────────────────────────────────────────────────────────────────
export async function handleCreateTrip(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '').trim();
  if (!teamId) return json({ ok: false, error: 'team_id_required' }, 400);
  const name = String(payload?.name || '').trim().slice(0, 120);
  if (!name) return json({ ok: false, error: 'name_required' }, 400);
  const startDate = coerceDate(payload?.startDate);
  const endDate = coerceDate(payload?.endDate);
  if (!startDate) return json({ ok: false, error: 'start_date_required' }, 400);
  if (!endDate) return json({ ok: false, error: 'end_date_required' }, 400);
  if (endDate.getTime() < startDate.getTime()) {
    return json({ ok: false, error: 'end_before_start', hint: 'End date has to be on or after the start date.' }, 400);
  }

  const claims = await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);

  const team = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  if (!team?.data) return json({ ok: false, error: 'team_not_found' }, 404);
  const clubId = team.data.clubId ? String(team.data.clubId) : undefined;

  const user = await getDocument(pid, `users/${claims.uid}`, sa).catch(() => null);
  const createdByName = String(user?.data?.name || claims.email?.split('@')[0] || 'Coach').slice(0, 80);

  const attendingPlayerIds = sanitizeAttendees(payload?.attendingPlayerIds);
  const description = payload?.description
    ? String(payload.description).slice(0, 2000)
    : undefined;

  const base: Record<string, any> = {
    teamId,
    createdBy: claims.uid,
    createdByName,
    createdAt: new Date(),
    updatedAt: new Date(),
    isActive: true,
    name,
    startDate,
    endDate,
    attendingPlayerIds,
    status: 'active',
    shareToken: mintShareToken(),
  };
  if (clubId) base.clubId = clubId;
  if (description) base.description = description;

  const id = await createDocument(pid, 'trips', base, sa);
  return json({ ok: true, id, shareToken: base.shareToken });
}

// ────────────────────────────────────────────────────────────────
// POST /trips/update
// Body: { tripId, patch: { name?, startDate?, endDate?, description?, attendingPlayerIds? } }
// Coach-only. Returns { ok: true }.
// ────────────────────────────────────────────────────────────────
export async function handleUpdateTrip(req: Request, env: Env, payload: any): Promise<Response> {
  const id = String(payload?.tripId || '').trim();
  if (!id) return json({ ok: false, error: 'trip_id_required' }, 400);
  const { pid, sa } = projectAndSA(env);
  const trip = await getDocument(pid, `trips/${id}`, sa).catch(() => null);
  if (!trip?.data) return json({ ok: false, error: 'not_found' }, 404);
  await requireCoachOfTeam(req, env, String(trip.data.teamId || ''));

  const rawPatch = payload?.patch || payload || {};
  const patch: Record<string, any> = { updatedAt: new Date() };

  if (rawPatch.name !== undefined) {
    const t = String(rawPatch.name || '').trim().slice(0, 120);
    if (!t) return json({ ok: false, error: 'name_required' }, 400);
    patch.name = t;
  }
  if (rawPatch.description !== undefined) {
    patch.description = rawPatch.description
      ? String(rawPatch.description).slice(0, 2000)
      : null;
  }

  const nextStart = rawPatch.startDate !== undefined
    ? coerceDate(rawPatch.startDate)
    : coerceDate(trip.data.startDate);
  const nextEnd = rawPatch.endDate !== undefined
    ? coerceDate(rawPatch.endDate)
    : coerceDate(trip.data.endDate);
  if (rawPatch.startDate !== undefined) {
    if (!nextStart) return json({ ok: false, error: 'start_date_required' }, 400);
    patch.startDate = nextStart;
  }
  if (rawPatch.endDate !== undefined) {
    if (!nextEnd) return json({ ok: false, error: 'end_date_required' }, 400);
    patch.endDate = nextEnd;
  }
  if (nextStart && nextEnd && nextEnd.getTime() < nextStart.getTime()) {
    return json({ ok: false, error: 'end_before_start', hint: 'End date has to be on or after the start date.' }, 400);
  }

  if (rawPatch.attendingPlayerIds !== undefined) {
    patch.attendingPlayerIds = sanitizeAttendees(rawPatch.attendingPlayerIds);
  }

  await patchDocument(pid, `trips/${id}`, patch, sa);
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// POST /trips/archive
// Body: { tripId, restore?: boolean }
// Flips status only. Existing stat rows keep tripId so they still
// bucket into the "Tournaments" surface.
// ────────────────────────────────────────────────────────────────
export async function handleArchiveTrip(req: Request, env: Env, payload: any): Promise<Response> {
  const id = String(payload?.tripId || '').trim();
  if (!id) return json({ ok: false, error: 'trip_id_required' }, 400);
  const restore = payload?.restore === true;
  const { pid, sa } = projectAndSA(env);
  const trip = await getDocument(pid, `trips/${id}`, sa).catch(() => null);
  if (!trip?.data) return json({ ok: false, error: 'not_found' }, 404);
  await requireCoachOfTeam(req, env, String(trip.data.teamId || ''));
  await patchDocument(pid, `trips/${id}`, {
    status: restore ? 'active' : 'archived',
    updatedAt: new Date(),
  }, sa);
  return json({ ok: true, status: restore ? 'active' : 'archived' });
}

// ────────────────────────────────────────────────────────────────
// POST /trips/attend
// Body: { tripId, playerId, going: boolean }
// Add / remove a single playerId from attendingPlayerIds. Uses
// arrayUnion/arrayRemove transform so races don't clobber other
// concurrent edits.
// ────────────────────────────────────────────────────────────────
export async function handleTripAttend(req: Request, env: Env, payload: any): Promise<Response> {
  const id = String(payload?.tripId || '').trim();
  const playerId = String(payload?.playerId || '').trim();
  const going = payload?.going !== false;
  if (!id) return json({ ok: false, error: 'trip_id_required' }, 400);
  if (!playerId) return json({ ok: false, error: 'player_id_required' }, 400);
  const { pid, sa } = projectAndSA(env);
  const trip = await getDocument(pid, `trips/${id}`, sa).catch(() => null);
  if (!trip?.data) return json({ ok: false, error: 'not_found' }, 404);
  await requireCoachOfTeam(req, env, String(trip.data.teamId || ''));

  await commitDocumentTransforms(
    pid,
    `trips/${id}`,
    [{
      fieldPath: 'attendingPlayerIds',
      kind: going ? 'arrayUnion' : 'arrayRemove',
      value: playerId,
    }],
    { updatedAt: new Date() },
    sa,
  );
  return json({ ok: true, going });
}

// ────────────────────────────────────────────────────────────────
// POST /trips/public-info
// Body: { tripId, shareToken }
// Anon-friendly projection for the /trip/:id?token=... recap URL.
// Returns { ok, trip: { id, name, startDate, endDate, description,
// teamName, attendingPlayerIds } } if the token matches. Never
// authenticated — safe to call anonymously.
// ────────────────────────────────────────────────────────────────
export async function handleTripPublicInfo(_req: Request, env: Env, payload: any): Promise<Response> {
  const id = String(payload?.tripId || '').trim();
  const token = String(payload?.shareToken || '').trim();
  if (!id || !token) return json({ ok: false, error: 'trip_and_token_required' }, 400);
  const { pid, sa } = projectAndSA(env);
  const trip = await getDocument(pid, `trips/${id}`, sa).catch(() => null);
  if (!trip?.data) return json({ ok: false, error: 'not_found' }, 404);
  if (String(trip.data.shareToken || '') !== token) {
    return json({ ok: false, error: 'invalid_token' }, 403);
  }
  const teamDoc = await getDocument(pid, `teams/${String(trip.data.teamId || '')}`, sa).catch(() => null);
  const teamName = String(teamDoc?.data?.name || '').slice(0, 120);
  return json({
    ok: true,
    trip: {
      id,
      name: String(trip.data.name || ''),
      startDate: trip.data.startDate,
      endDate: trip.data.endDate,
      description: trip.data.description || null,
      status: trip.data.status || 'active',
      attendingPlayerIds: Array.isArray(trip.data.attendingPlayerIds) ? trip.data.attendingPlayerIds : [],
      teamName,
    },
  });
}
