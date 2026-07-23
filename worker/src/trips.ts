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
  runQuery,
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
// Returns the trip envelope + (best-effort) enriched games/stats
// summary for a grandparent-friendly recap. If either enrichment
// query fails or times out, the base envelope still returns and
// `richDataAvailable: false` flags the client to hide the enriched
// sections. Never authenticated — the shareToken IS the auth.
//
// Shape:
//   { ok: true, trip: { … base fields, teamName, games[], stats,
//                       richDataAvailable } }
//
// games[] is capped at MAX_TRIP_GAMES. stats aggregate is capped
// at MAX_TRIP_STATS_ROWS. Both caps are intentionally generous
// (a busy weekend cup can hit 6+ matches / 100+ stat rows) but
// bounded so a shared link never fans out into an unbounded scan.
// ────────────────────────────────────────────────────────────────
const MAX_TRIP_GAMES = 20;
const MAX_TRIP_STATS_ROWS = 500;

function isoOrRaw(v: any): any {
  if (!v) return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v?.toDate === 'function') {
    try { return v.toDate().toISOString(); } catch { return v; }
  }
  if (typeof v?.seconds === 'number') {
    try { return new Date(v.seconds * 1000).toISOString(); } catch { return v; }
  }
  return v;
}

function toNumOrNull(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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
  const teamId = String(trip.data.teamId || '');
  const teamDoc = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  const teamName = String(teamDoc?.data?.name || '').slice(0, 120);

  // Best-effort enrichment. Either half can fail independently
  // (missing composite index, transient 5xx, etc.) — we still
  // return the base envelope so the shared URL never dead-ends.
  let games: any[] = [];
  let statsSummary: any = null;
  let richDataAvailable = true;

  // Games list. Filter events on teamId + tripId, then join
  // per-event live_games doc for the final score. We deliberately
  // cap the events query and only join scores for the first
  // MAX_TRIP_GAMES rows so a stray tournament with 40 friendlies
  // doesn't fan out into 40 live_games gets.
  try {
    const rows = await runQuery(pid, 'events', [
      { field: 'teamId', op: 'EQUAL', value: teamId },
      { field: 'tripId', op: 'EQUAL', value: id },
    ], sa, 100);
    const gameEvents = rows
      .map(r => ({ id: r.id, data: r.data || {} }))
      .filter(r => (r.data as any).isActive !== false)
      .filter(r => String((r.data as any).type || 'game') === 'game')
      .sort((a, b) => {
        const da = new Date(isoOrRaw((a.data as any).date) || 0).getTime();
        const db = new Date(isoOrRaw((b.data as any).date) || 0).getTime();
        return da - db;
      })
      .slice(0, MAX_TRIP_GAMES);

    const scores = await Promise.all(gameEvents.map(async (g) => {
      try {
        const live = await getDocument(pid, `live_games/${g.id}`, sa);
        return live?.data || null;
      } catch {
        return null;
      }
    }));

    games = gameEvents.map((g, i) => {
      const ev: any = g.data || {};
      const live: any = scores[i] || {};
      const homeAway: 'home' | 'away' | null =
        ev.homeAway === 'home' || ev.homeAway === 'away' ? ev.homeAway : null;
      const ourScoreRaw = toNumOrNull(live.ourScore);
      const oppScoreRaw = toNumOrNull(live.oppScore);
      const isFinal = String(live.status || '') === 'final';
      // Map our-team-relative scores to true home/away scores. When
      // homeAway is unknown, fall back to "we were home" so the
      // rendered scoreboard still makes sense for the coach's team.
      const weWereAway = homeAway === 'away';
      const homeScore = ourScoreRaw == null && oppScoreRaw == null
        ? null
        : (weWereAway ? oppScoreRaw : ourScoreRaw);
      const awayScore = ourScoreRaw == null && oppScoreRaw == null
        ? null
        : (weWereAway ? ourScoreRaw : oppScoreRaw);
      let result: 'win' | 'loss' | 'tie' | null = null;
      if (isFinal && ourScoreRaw != null && oppScoreRaw != null) {
        result = ourScoreRaw > oppScoreRaw ? 'win'
          : ourScoreRaw < oppScoreRaw ? 'loss'
          : 'tie';
      }
      return {
        id: g.id,
        date: isoOrRaw(ev.date) || null,
        opponent: String(ev.opponent || 'Opponent').slice(0, 80),
        homeAway,
        homeScore,
        awayScore,
        result,
      };
    });
  } catch (err) {
    console.warn('[trips public-info] games enrichment failed', (err as any)?.message || err);
    richDataAvailable = false;
    games = [];
  }

  // Stats summary. Sum goals/assists/saves across all trip-scoped
  // stat rows and derive top scorer server-side so we don't ship
  // per-player rows to the public page. Cap at MAX_TRIP_STATS_ROWS.
  //
  // Filter to attendingPlayerIds only. A call-up whose stats got
  // tagged to this trip (e.g. guest playing under our banner) shouldn't
  // surface as "top scorer" on the public share — they aren't on the
  // traveling roster grandparents are here to celebrate. Totals also
  // exclude non-attending rows so goals/assists/saves match the coach's
  // roster-scoped view in CoachTripDetail.
  try {
    const rows = await runQuery(pid, 'stats', [
      { field: 'teamId', op: 'EQUAL', value: teamId },
      { field: 'tripId', op: 'EQUAL', value: id },
    ], sa, MAX_TRIP_STATS_ROWS);
    const attendingSet = new Set<string>(
      (Array.isArray(trip.data.attendingPlayerIds) ? trip.data.attendingPlayerIds : [])
        .map((x: any) => String(x || ''))
        .filter(Boolean),
    );
    let totalGoals = 0;
    let totalAssists = 0;
    let totalSaves = 0;
    const goalsByPlayer = new Map<string, { name: string; goals: number }>();
    for (const r of rows) {
      const d: any = r.data || {};
      const pid2 = String(d.playerId || '');
      if (!pid2 || !attendingSet.has(pid2)) continue;
      const goals = Number(d.goals || 0);
      const assists = Number(d.assists || 0);
      const saves = Number(d.saves || 0);
      totalGoals += Number.isFinite(goals) ? goals : 0;
      totalAssists += Number.isFinite(assists) ? assists : 0;
      totalSaves += Number.isFinite(saves) ? saves : 0;
      if (goals > 0) {
        const cur = goalsByPlayer.get(pid2) || { name: String(d.playerName || 'Player'), goals: 0 };
        cur.goals += goals;
        // Prefer the freshest non-empty name in case an older row
        // had a stale nickname.
        if (d.playerName) cur.name = String(d.playerName);
        goalsByPlayer.set(pid2, cur);
      }
    }
    let topScorerName: string | null = null;
    let topScorerGoals = 0;
    for (const v of goalsByPlayer.values()) {
      if (v.goals > topScorerGoals) {
        topScorerGoals = v.goals;
        topScorerName = v.name;
      }
    }
    statsSummary = {
      totalGoals,
      totalAssists,
      totalSaves,
      topScorerName,
      topScorerGoals,
    };
  } catch (err) {
    console.warn('[trips public-info] stats enrichment failed', (err as any)?.message || err);
    richDataAvailable = false;
    statsSummary = null;
  }

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
      games,
      stats: statsSummary,
      richDataAvailable,
    },
  });
}
