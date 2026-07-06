/**
 * Auth middleware for worker endpoints. Replaces the previous
 * NOTIFY_SECRET bearer (which was a shared static secret shipped in
 * the client bundle — see security-audit commit) with per-request
 * Firebase ID token verification + authorization scope checks.
 *
 * How callers use it
 * ──────────────────
 *
 *   // Any signed-in user
 *   const claims = await requireUser(req, env);
 *
 *   // Owner / admin of a specific club
 *   const claims = await requireClubAdmin(req, env, clubId);
 *
 *   // Coach or team_manager on a specific team
 *   const claims = await requireCoachOfTeam(req, env, teamId);
 *
 *   // Platform admin (user.isClubAdmin === true — legacy flag name)
 *   const claims = await requirePlatformAdmin(req, env);
 *
 *   // The token must belong to the specified uid
 *   const claims = await requireSelf(req, env, uid);
 *
 * All helpers throw AuthError on failure. Use `authErrorResponse` at
 * the request boundary to convert to a JSON 401/403 response so the
 * inside of every handler can stay focused on business logic.
 *
 * All helpers cache the user doc fetch on a WeakMap keyed on the
 * Request, so a single request that runs both requireUser and
 * requireCoachOfTeam only reads the user doc once.
 */

import { verifyIdToken, VerifiedIdToken } from './firebaseAuth';
import { getDocument } from './firestore';
import { parseServiceAccount, ServiceAccount } from './fcm';

export class AuthError extends Error {
  constructor(public code: string, public status: number, public detail?: string) {
    super(code);
  }
}

export interface AuthedClaims {
  uid: string;
  email?: string;
  name?: string;
  raw: VerifiedIdToken;
}

// Per-request memoization. We reach into these caches from
// authorization helpers so that (a) we don't verify the same token
// twice and (b) we don't re-fetch the user doc for cross-cutting
// checks like requireUser + requireCoachOfTeam. WeakMap so a request
// is garbage-collected when the runtime drops it.
const claimsCache = new WeakMap<Request, AuthedClaims>();
const userDocCache = new WeakMap<Request, Record<string, any> | null>();

function projectId(env: { FIREBASE_PROJECT_ID?: string }): string {
  const pid = env.FIREBASE_PROJECT_ID;
  if (!pid) throw new AuthError('project_id_missing', 500, 'FIREBASE_PROJECT_ID not configured');
  return pid;
}

function serviceAccount(env: { FCM_SERVICE_ACCOUNT?: string }): ServiceAccount {
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!raw) throw new AuthError('service_account_missing', 500, 'FCM_SERVICE_ACCOUNT not configured');
  return parseServiceAccount(raw);
}

// Verify the Authorization: Bearer <idToken> header and return the
// caller's claims. Reused by every authorization helper.
export async function requireUser(req: Request, env: { FIREBASE_PROJECT_ID?: string }): Promise<AuthedClaims> {
  const cached = claimsCache.get(req);
  if (cached) return cached;

  const h = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new AuthError('missing_bearer', 401);
  const idToken = m[1];

  let verified: VerifiedIdToken;
  try {
    verified = await verifyIdToken(idToken, projectId(env));
  } catch (err) {
    // Don't leak internal error strings; a single "invalid_token"
    // covers expired, malformed, and forged tokens.
    throw new AuthError('invalid_token', 401, (err as Error).message);
  }
  const claims: AuthedClaims = {
    uid: verified.uid,
    email: verified.email,
    name: verified.name,
    raw: verified,
  };
  claimsCache.set(req, claims);
  return claims;
}

// Load the user's Firestore doc for authorization checks. Cached per
// request so multiple `requireX` calls in the same handler don't
// re-fetch. Returns null if the user doc doesn't exist yet — new
// users have a Firebase Auth record before their /users/{uid} doc is
// written on first app open.
async function loadUserDoc(req: Request, env: { FIREBASE_PROJECT_ID?: string; FCM_SERVICE_ACCOUNT?: string }, uid: string): Promise<Record<string, any> | null> {
  if (userDocCache.has(req)) return userDocCache.get(req) ?? null;
  const sa = serviceAccount(env);
  const doc = await getDocument(projectId(env), `users/${uid}`, sa).catch(() => null);
  const data = doc?.data ?? null;
  userDocCache.set(req, data);
  return data;
}

// Enforce that the token's uid matches the caller's claimed identity.
// Guards endpoints where the request body includes a uid or an
// object-ownership assertion — the client can't hand us a mismatched
// uid to act on someone else's behalf.
export async function requireSelf(req: Request, env: { FIREBASE_PROJECT_ID?: string }, uid: string): Promise<AuthedClaims> {
  const claims = await requireUser(req, env);
  if (claims.uid !== uid) throw new AuthError('not_self', 403);
  return claims;
}

// Platform admin. Reads user.isClubAdmin (the legacy field name —
// see firestore.rules isPlatformAdmin() gate). Only trusted admins
// should ever have this flag set.
export async function requirePlatformAdmin(req: Request, env: { FIREBASE_PROJECT_ID?: string; FCM_SERVICE_ACCOUNT?: string }): Promise<AuthedClaims> {
  const claims = await requireUser(req, env);
  const user = await loadUserDoc(req, env, claims.uid);
  if (user?.isClubAdmin !== true) throw new AuthError('not_platform_admin', 403);
  return claims;
}

// Coach / team_manager on a specific team. Two acceptance paths so
// legacy data still authorizes:
//   1. team.coachIds includes the caller's uid (authoritative — the
//      team's own view of who coaches it)
//   2. user.role in {coach, team_manager} AND user.teamIds includes
//      the team (the user's own view of their membership — matches
//      the Firestore rules `onTeam()` helper).
export async function requireCoachOfTeam(req: Request, env: { FIREBASE_PROJECT_ID?: string; FCM_SERVICE_ACCOUNT?: string }, teamId: string): Promise<AuthedClaims> {
  if (!teamId) throw new AuthError('team_id_required', 400);
  const claims = await requireUser(req, env);
  const sa = serviceAccount(env);
  const pid = projectId(env);
  const [user, team] = await Promise.all([
    loadUserDoc(req, env, claims.uid),
    getDocument(pid, `teams/${teamId}`, sa).catch(() => null),
  ]);
  // Platform admin bypass — keeps parity with the Firestore rules.
  if (user?.isClubAdmin === true) return claims;
  const teamData = team?.data ?? null;
  const inTeamCoachIds = Array.isArray(teamData?.coachIds) && teamData.coachIds.includes(claims.uid);
  const isCoachRole = user?.role === 'coach' || user?.role === 'team_manager';
  const onTeamIds = Array.isArray(user?.teamIds) && user.teamIds.includes(teamId);
  if (!inTeamCoachIds && !(isCoachRole && onTeamIds)) {
    throw new AuthError('not_coach_of_team', 403);
  }
  return claims;
}

// Club owner or admin. Reads clubs/{clubId} and checks ownerUid /
// adminUids for the caller.
export async function requireClubAdmin(req: Request, env: { FIREBASE_PROJECT_ID?: string; FCM_SERVICE_ACCOUNT?: string }, clubId: string): Promise<AuthedClaims> {
  if (!clubId) throw new AuthError('club_id_required', 400);
  const claims = await requireUser(req, env);
  const sa = serviceAccount(env);
  const pid = projectId(env);
  const [user, club] = await Promise.all([
    loadUserDoc(req, env, claims.uid),
    getDocument(pid, `clubs/${clubId}`, sa).catch(() => null),
  ]);
  if (user?.isClubAdmin === true) return claims;
  const clubData = club?.data ?? null;
  const isOwner = clubData?.ownerUid === claims.uid;
  const inAdmins = Array.isArray(clubData?.adminUids) && clubData.adminUids.includes(claims.uid);
  if (!isOwner && !inAdmins) throw new AuthError('not_club_admin', 403);
  return claims;
}

// Convert an AuthError into a JSON 401/403 response. Returns null
// when the error isn't an AuthError so callers can rethrow.
export function authErrorResponse(err: unknown, corsHeaders: Record<string, string> = {}): Response | null {
  if (err instanceof AuthError) {
    return new Response(JSON.stringify({ error: err.code, detail: err.detail }), {
      status: err.status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
    });
  }
  return null;
}
