/**
 * Server-side guarded writes for sensitive Firestore fields.
 *
 * WHY
 * ═══
 * Before this file existed, the client wrote directly to:
 *   users/{uid}.{teamIds, role, coverageSource, selfPlayerId, widgetPlayerId}
 *   players/{playerId}.parentIds
 *   teams/{teamId}.coachIds
 *   invites/{id}.usedCount, .usedBy
 *   offers/{id}.status
 *
 * That's convenient but insecure — Firestore rules can't verify "did
 * you actually have a valid invite token?" without server logic, so
 * the audit found any signed-in user could self-add themselves to
 * teams / claim other players / mint their own admin role.
 *
 * These endpoints replace the client-side writes. Each verifies the
 * caller has legitimate business making the change (invite token
 * matches, coach-of-team, self-only, etc.) and performs the write
 * with the worker service account. Once the client has migrated,
 * Firestore rules deny direct writes to these fields entirely.
 *
 * All endpoints share the `route(pathname, req, env, payload)` entry
 * point below so index.ts can dispatch a whole family with one line.
 */

import {
  requireUser,
  requireCoachOfTeam,
  requireClubAdmin,
  requirePlatformAdmin,
  requireSelf,
  AuthError,
} from './auth';
import { parseServiceAccount, ServiceAccount, getAccessToken } from './fcm';
import {
  getDocument,
  patchDocument,
  createDocument,
  runQuery,
  commitDocumentTransforms,
  FirestoreDoc,
  PreconditionFailedError,
  AlreadyExistsError,
} from './firestore';
import { computeBackfillPlan, backfillEventId, type BackfillPlan, type ComputedBadge } from './xpBackfill';
import { setCustomClaims } from './identityToolkit';
import { createLeague, createFixture, reportFixtureScore, recomputeStandings } from './leagues';
import { handleAdminSendPlayerInvite } from './adminPlayerInvite';

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

// Normalize an email for the parent-match lookup. Callers compare
// against player.parentEmails which is stored lowercased.
const normEmail = (v: unknown): string =>
  typeof v === 'string' ? v.trim().toLowerCase() : '';

// ────────────────────────────────────────────────────────────────
// Background-work registry.
//
// Cloudflare Workers kill any pending fetch/setTimeout the moment a
// Response is returned unless `ctx.waitUntil()` is holding it. Handlers
// that want to fire fire-and-forget work (custom claims mint, cleanup
// tasks, log fanouts) push their promise here; the top-level fetch
// handler drains this array after routing and hands it to
// ctx.waitUntil so the promises survive to completion.
//
// Module scope in Cloudflare Workers is shared across concurrent
// requests within the same isolate — the drain-after-route pattern
// works because whichever request finishes first collects any
// straggler promises and waits on them. Slight over-attribution is
// acceptable (it's just "how long the worker instance stays alive").
// ────────────────────────────────────────────────────────────────
const pendingBackground: Array<Promise<unknown>> = [];

/** Register a fire-and-forget promise for `ctx.waitUntil`. Handlers
 *  call this instead of awaiting so the response goes out fast. */
export function trackBackground(p: Promise<unknown>): void {
  pendingBackground.push(p.catch(() => { /* logged inside — don't crash the drain */ }));
}

/** Called by the top-level fetch handler after routing. Drains and
 *  returns the currently-pending promises so the fetch handler can
 *  wrap them in ctx.waitUntil. */
export function drainPendingBackground(): Promise<unknown>[] {
  return pendingBackground.splice(0);
}

// ────────────────────────────────────────────────────────────────
// Refresh Firebase Auth custom claims for a user so LIST rules can
// verify `request.auth.token.clubIds` / `.teamIds` statically against
// query where() constraints. Call this at the END of every handler
// that mutates the target uid's user.clubIds or user.teamIds so the
// claim payload matches the Firestore state.
//
// Non-fatal on failure: if the Identity Toolkit round-trip errors,
// the mutation stays committed and the user's next sign-in / next
// refresh cycle picks up the new claims. Rules still fall back to
// the userDoc()-based branches during the transition.
//
// Callers who mutate their OWN membership then force-refresh their
// ID token client-side (auth.currentUser.getIdToken(true)) to see
// the new claim immediately. Callers who mutate SOMEONE ELSE's uid
// (add-coach, set-admin) — the target's token in-flight stays
// valid for up to 1hr; we accept that lag rather than pushing an
// invalidation.
// ────────────────────────────────────────────────────────────────
function refreshClaimsForUid(
  uid: string,
  pid: string,
  sa: ServiceAccount,
): void {
  if (!uid) return;
  // Fire-and-forget via the background registry. Prior shape awaited
  // and blocked every mutation response by the Identity Toolkit round-
  // trip (~150-500ms) AND swallowed failures returning ok:true — the
  // client then force-refreshed to a stale token. Now the response
  // returns fast; the refresh completes under ctx.waitUntil's watch.
  // On failure the client's subsequent /users/refresh-claims call or
  // the next background heal-team-membership tick catches up.
  trackBackground((async () => {
    try {
      const userDoc = await getDocument(pid, `users/${uid}`, sa).catch(() => null);
      const data: any = userDoc?.data || {};
      const isPlatformAdmin = data.isClubAdmin === true;
      const clubIds = Array.isArray(data.clubIds) ? data.clubIds.filter((s: unknown) => typeof s === 'string') : [];
      const teamIds = Array.isArray(data.teamIds) ? data.teamIds.filter((s: unknown) => typeof s === 'string') : [];
      const claims = {
        clubIds,
        teamIds,
        ...(isPlatformAdmin ? { admin: true } : {}),
      };
      const res = await setCustomClaims(sa, uid, claims);
      if (!res.ok) {
        console.warn('[claims] refresh failed', uid, res.error);
      }
    } catch (err) {
      console.warn('[claims] refresh threw', uid, err);
    }
  })());
}

// ────────────────────────────────────────────────────────────────
// /users/bootstrap — first-time user-doc creation.
//
// Replaces the client-side `createUser(userDataWithId)` + email
// auto-link in AuthContext.signUp. Signed-in caller (Firebase Auth
// account already exists) posts their intended profile fields; the
// worker:
//   1. Refuses if users/{uid} already exists (idempotent create)
//   2. Writes users/{uid} with a server-controlled allowlist of
//      fields (uid, email, name, phone, role, isActive, createdAt,
//      approved, approvalStatus, teamIds)
//   3. Runs the email → player.parentEmails auto-link: for every
//      matching player, arrayUnion the uid onto parentIds AND
//      arrayUnion the player's teamIds onto the new user's teamIds
//   4. Sets approved=true if any auto-link happened
// ────────────────────────────────────────────────────────────────
async function handleUsersBootstrap(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);

  const existing = await getDocument(pid, `users/${claims.uid}`, sa).catch(() => null);
  if (existing?.data) {
    return json({ ok: false, error: 'user_already_exists' }, 409);
  }

  // Allowlist. Everything not on this list is dropped — a malicious
  // client can't sneak in isClubAdmin, coachLevel, or a fake teamIds
  // array via this endpoint.
  //
  // Role is REQUIRED and must be exactly "coach" or "parent". Prior
  // code silently defaulted to "parent" for missing / invalid inputs,
  // which meant any client bug (forgotten field, race condition,
  // Google popup that lost the wantRole hint) would create a parent
  // account without anyone asking for it. Patrick 2026-07-14: "i had
  // another user sign up that put them in as a parent... please please
  // please stop that from happening." Every legit signup flow now sets
  // role explicitly (SimpleAuth email defaults to coach; SimpleAuth
  // Google/Apple passes joinFlow-derived role; RegisterAuthGate sends
  // parent for the /register season path). Missing role at this
  // endpoint is a client bug and 400 makes it visible instead of
  // silently miscategorizing the user.
  if (payload?.role !== 'coach' && payload?.role !== 'parent') {
    return json({
      ok: false,
      error: 'invalid_role',
      hint: 'role must be exactly "coach" or "parent"; got ' + JSON.stringify(payload?.role),
    }, 400);
  }
  const wantRole: 'coach' | 'parent' = payload.role;
  const name = String(payload?.name || claims.name || '').slice(0, 100);
  const email = normEmail(payload?.email || claims.email);
  const phone = typeof payload?.phone === 'string' ? payload.phone.slice(0, 40) : '';

  const nowMs = Date.now();
  const initialFields: Record<string, any> = {
    uid: claims.uid,
    email,
    name,
    phone,
    role: wantRole,
    isActive: true,
    approved: false,
    approvalStatus: 'pending',
    authProvider: payload?.authProvider === 'google' ? 'google'
                : payload?.authProvider === 'apple' ? 'apple'
                : 'email',
    createdAt: new Date(nowMs),
    teamIds: [],
    // Privacy defaults OFF — new users' contact info stays hidden
    // in the parent directory unless they opt in via Settings.
    // Coaches see everyone regardless (gated at the render layer).
    privacy: {
      showEmail: false,
      showPhone: false,
      showAddress: false,
    },
  };
  await patchDocument(pid, `users/${claims.uid}`, initialFields, sa);

  // Email-match auto-link. Runs UNCONDITIONALLY on wantRole.
  //
  // Before 2026-07-07 this was gated on `wantRole !== 'coach'`,
  // which silently broke every parent who Google-authed into the
  // app without an invite link: AuthContext defaults Google signups
  // to role='coach', the auto-link skipped, and even though their
  // email was on parentEmails, they never got linked to their kid.
  // Support triage kept finding "2 parent emails on the player, 0
  // accounts linked" (Ruston, others).
  //
  // Correct rule: if the caller's email matches ANY player's
  // parentEmails, they are a parent — regardless of what the
  // client-side default said. Link them and flip role to 'parent'
  // in the same commit so they get parent-shaped access
  // (dashboard InThePoolHero, RSVPs, chat, media view).
  //
  // Idempotent — arrayUnion won't duplicate.
  const linked: { playerId: string; teamIds: string[] }[] = [];
  if (email) {
    try {
      const players = await runQuery(
        pid,
        'players',
        [{ field: 'parentEmails', op: 'ARRAY_CONTAINS', value: email }],
        sa,
        50,
      );
      for (const p of players) {
        const data: any = p.data || {};
        const teamIds: string[] = Array.isArray(data.teamIds) && data.teamIds.length > 0
          ? data.teamIds
          : (data.teamId ? [data.teamId] : []);
        await commitDocumentTransforms(
          pid,
          `players/${p.id}`,
          [{ fieldPath: 'parentIds', kind: 'arrayUnion', value: claims.uid }],
          null,
          sa,
        );
        linked.push({ playerId: p.id, teamIds });
      }
    } catch (err) {
      console.warn('[bootstrap] auto-link failed:', (err as Error).message);
    }
  }

  if (linked.length > 0) {
    const teamsToAdd = Array.from(new Set(linked.flatMap(l => l.teamIds).filter(Boolean)));
    // 3.9.156: NO LONGER force-flip role to parent on email match.
    // The user's explicit choice on the landing screen ("Set up a
    // new team" vs "Join a team with a code") is now the source of
    // truth for role. Auto-link still runs — parentIds stamped on
    // every matching player + the player's teamIds fanned onto the
    // user — so a coach whose email happens to be on their own
    // kid's parentEmails still sees the kid in the app and gets
    // events/media pushes for them. But the global role stays
    // whatever they picked, so a genuine new coach whose email was
    // already on some player's parentEmails (test data, leftover
    // from another club, spouse added them) doesn't silently get
    // demoted to parent.
    //
    // approved:true still applies — email match IS a good signal
    // they're a real user of the club, so we skip the pending gate.
    const patch: Record<string, any> = {
      approved: true,
      approvalStatus: 'auto-email-match',
    };
    if (teamsToAdd.length > 0) {
      await commitDocumentTransforms(
        pid,
        `users/${claims.uid}`,
        [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: teamsToAdd }],
        patch,
        sa,
      );
    } else {
      // Match with no teamIds on the player (unusual — orphaned
      // player, or team just deleted). Still patch approved so at
      // least the pending gate doesn't strand them.
      await patchDocument(pid, `users/${claims.uid}`, patch, sa);
    }
  }

  // Spine refactor Phase A: stamp onboardingStage on the fresh user
  // doc so App.tsx doesn't have to recompute it client-side. Runs
  // AFTER any auto-link writes so `active` correctly reflects a
  // just-linked parent instead of showing needs_player for one tick.
  await stampStage(claims.uid, pid, sa);

  // Custom claims: fresh user doc now has final teamIds + clubIds.
  // Stamp them onto the JWT so first-session LIST rules can verify
  // scope without the userDoc() runtime lookup.
  refreshClaimsForUid(claims.uid, pid, sa);

  return json({
    ok: true,
    uid: claims.uid,
    linkedCount: linked.length,
    // Return the ACTUAL stored role (wantRole) so the client's cached
    // userData matches Firestore. The prior expression returned
    // 'parent' when a coach signed up whose email happened to match a
    // player's parentEmails — but the DB was still stamped 'coach' at
    // line 108. Client rendered parent UI briefly, then flipped to
    // coach on hard refresh. Exact 3.9.156 regression class this
    // endpoint was supposed to fix. Audited 2026-07-10.
    role: wantRole,
  });
}

// ────────────────────────────────────────────────────────────────
// /parent/pool-status — read-only endpoint for the unrostered
// parent's dashboard "InThePoolHero." Reads /registrations
// server-side via admin SDK, filtering by the caller's verified
// auth.token.email, and returns a sanitized list of the parent's
// own kids + statuses.
//
// Why not a direct client Firestore query: the /registrations LIST
// rule was tightened 2026-07-14 to require clubId scope, but
// parents on this hero have NO clubIds on their user doc (they
// haven't been rostered yet). Rules can't scope a parent's
// pool-status query. Worker owns it.
// ────────────────────────────────────────────────────────────────
async function handleParentPoolStatus(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);

  // Trust the JWT's email, not the payload — prevents a caller
  // from asking for someone else's registrations.
  const email = normEmail(claims.email);
  if (!email) {
    return json({ ok: false, error: 'no_verified_email' }, 400);
  }

  // parents field is a list-of-maps in Firestore; parentEmails is
  // a denormalized flat list-of-strings on the same doc (populated
  // by /register/submit). Query the flat list — no ARRAY_CONTAINS
  // on nested-map field. See writeGuards.ts:2273 for the write.
  let regs: any[] = [];
  try {
    regs = await runQuery(
      pid,
      'registrations',
      [{ field: 'parentEmails', op: 'ARRAY_CONTAINS', value: email }],
      sa,
      100,
    );
  } catch (err) {
    console.warn('[pool-status] query failed:', (err as Error).message);
    return json({ ok: false, error: 'query_failed' }, 500);
  }

  const kids = regs.map((r) => {
    const data: any = r.data || {};
    const first = String(data.player?.firstName || '').trim();
    const last = String(data.player?.lastName || '').trim();
    return {
      registrationId: r.id,
      playerName: (first || last) ? `${first} ${last}`.trim() : 'Your kid',
      ageGroup: data.player?.ageGroup || null,
      status: data.status || 'pending_payment',
    };
  });

  return json({ ok: true, kids });
}

// ════════════════════════════════════════════════════════════════
// Phase B — applyMembership() unified core
// ════════════════════════════════════════════════════════════════
//
// Thin core that grants team/player membership to a targetUid. All
// four membership-attach endpoints (/claim/invite,
// /claim/coach-invite, /claim/player-link, /teams/add-coach) call
// this after their own invite reservation + authorization phase.
//
// Consolidating the write phase closes drift that had accumulated
// across the four handlers:
//   1. team.coachIds arrayUnion when role='coach' with an attach
//      team (was silently MISSING in /claim/invite type='coach' —
//      coach could claim a legacy invite doc, get role=coach and
//      teamIds+=teamId, but team.coachIds stayed empty so
//      requireCoachOfTeam still refused them the writes they'd
//      just been granted by role).
//   2. onboardingStage stamped exactly once on the success path —
//      including idempotent re-runs of /teams/add-coach where a
//      previous stamp may have gone stale via another mutation.
//   3. Uniform approvalStatus + approvedAt stamp. /teams/add-coach
//      previously wrote neither, leaving admin-granted coaches with
//      a schema-shape that diverged from invite-consumed coaches.
//   4. Consume-first ordering (reserve the invite BEFORE granting
//      access) is enforced by every shim: if applyMembership throws
//      mid-flight, the invite is already burned. A retry hits the
//      idempotent short-circuit (usedBy includes uid / claimedBy ==
//      uid) and heals without double-consuming.
//
// The invite-consume phase itself stays in each shim because the
// shape differs too much (`invites` vs `coach_invites` vs no-invite
// path) to squeeze into a single argument type. The core is
// intentionally invite-agnostic.
// ────────────────────────────────────────────────────────────────

type MembershipRole = 'parent' | 'coach' | 'team_manager';
type MembershipOperationSource =
  | 'claim_invite'
  | 'claim_coach_invite'
  | 'claim_player_link'
  | 'claim_offer_accept'
  | 'teams_add_coach';
type MembershipApprovalStatus =
  | 'auto'
  | 'invite-consumed'
  | 'player-link'
  | 'admin-grant';

interface MembershipOp {
  operationSource: MembershipOperationSource;
  targetUid: string;
  role?: MembershipRole;
  // Team ids arrayUnion'd onto users.teamIds. Duplicates are fine —
  // arrayUnion dedupes server-side.
  teamIds: string[];
  // If set AND role==='coach', also arrayUnion targetUid onto
  // teams/{attachToTeamCoachIds}.coachIds. Uniform closure of the
  // /claim/invite type='coach' drift bug.
  attachToTeamCoachIds?: string;
  // Legacy single-team pointer. Stamped as users.teamId so anything
  // still reading that scalar keeps working.
  legacyTeamId?: string;
  coachLevel?: string;                                  // role='coach' only
  relationship?: string;                                // role='parent' only
  approvalStatus: MembershipApprovalStatus;
  invitedBy?: string | null;
  invitedVia?: string;
  playerLink?: { playerId: string; isAdultPlayer?: boolean };
  coverage?: { source: 'club'; clubId: string };
  // Escape hatch for one-off fields (e.g. selfPlayerId when the
  // player-link path lands an adult self-claim). Merged into the
  // user patch verbatim.
  extraUserPatch?: Record<string, any>;
}

/**
 * Parse an invite expiresAt value that can be either an ISO string
 * or a Firestore Timestamp-shaped `{ seconds }` object. Returns
 * true if the invite has expired. Uniform across all four
 * endpoints — closes the /claim/coach-invite drift where only ISO
 * was handled and real Timestamp expiries silently passed.
 */
function isInviteExpired(expiresAt: any): boolean {
  if (!expiresAt) return false;
  const ms = typeof expiresAt === 'string'
    ? new Date(expiresAt).getTime()
    : (typeof expiresAt?.seconds === 'number' ? expiresAt.seconds * 1000 : 0);
  return ms > 0 && ms < Date.now();
}

async function applyMembership(
  op: MembershipOp,
  pid: string,
  sa: ServiceAccount,
): Promise<void> {
  const now = new Date();

  // Step 1 — team.coachIds fanout for coach/team_manager roles with
  // an attach team. Guard-drift closure #1. Runs BEFORE the user
  // grant so that requireCoachOfTeam sees the coach on
  // team.coachIds by the time the user grant lands.
  //
  // Historically we only mirrored to team.coachIds, but the Staff
  // page (src/pages/StaffManagement.tsx) reads ONLY headCoachId /
  // assistantCoachIds / managerIds — never coachIds. That produced
  // "ghost coaches": real for security-rule purposes (they're on
  // coachIds) but invisible on the Staff page for the head coach to
  // adjust permissions or remove. Every /claim/invite +
  // /claim/coach-invite promotion silently landed one.
  //
  // Fix: mirror into the role-specific list the Staff page reads,
  // so the moment the invite is consumed the new coach shows up in
  // the head coach's staff panel. arrayUnion is idempotent, so
  // re-runs against an already-promoted uid are safe.
  //   - role='coach' + coachLevel='head_coach' → set headCoachId
  //   - role='coach' (assistant / unset)      → arrayUnion into assistantCoachIds
  //   - role='team_manager'                    → arrayUnion into managerIds
  if (op.attachToTeamCoachIds && (op.role === 'coach' || op.role === 'team_manager')) {
    const teamPath = `teams/${op.attachToTeamCoachIds}`;
    const teamTransforms: any[] = [];
    let teamPatch: Record<string, any> | null = null;
    let effectiveCoachLevel = op.coachLevel;

    if (op.role === 'coach') {
      teamTransforms.push({ fieldPath: 'coachIds', kind: 'arrayUnion', value: op.targetUid });
      if (op.coachLevel === 'head_coach') {
        // Head coach is a scalar pointer, not an array. Only crown
        // when the seat is vacant or already held by this uid — a
        // legacy invite doc with a stale head_coach shape must never
        // silently displace the current head. Head transfers must go
        // through /teams/transfer-head. If a head is already seated,
        // downgrade this promotion to assistant so the coach still
        // lands on the team, just not as head.
        const teamSnap = await getDocument(pid, teamPath, sa).catch(() => null);
        const currentHead = String(teamSnap?.data?.headCoachId || '');
        if (!currentHead || currentHead === op.targetUid) {
          teamPatch = { headCoachId: op.targetUid };
        } else {
          effectiveCoachLevel = 'assistant';
          teamTransforms.push({ fieldPath: 'assistantCoachIds', kind: 'arrayUnion', value: op.targetUid });
        }
      } else {
        teamTransforms.push({ fieldPath: 'assistantCoachIds', kind: 'arrayUnion', value: op.targetUid });
      }
    } else if (op.role === 'team_manager') {
      // Team managers don't live on coachIds (they're not coaches
      // for security rules), only on managerIds.
      teamTransforms.push({ fieldPath: 'managerIds', kind: 'arrayUnion', value: op.targetUid });
    }

    await commitDocumentTransforms(
      pid,
      teamPath,
      teamTransforms,
      teamPatch,
      sa,
    );

    // Reflect the downgrade into the user grant below so
    // users/{uid}.coachLevel matches team.assistantCoachIds. Otherwise
    // team.coachIds sees the uid as assistant but the user doc claims
    // head_coach — the exact drift class this whole section closes.
    if (effectiveCoachLevel !== op.coachLevel) {
      op.coachLevel = effectiveCoachLevel;
    }
  }

  // Step 2 — player link. Adds targetUid to players.parentIds and
  // optionally flips isAdultPlayer. Only when playerLink is set.
  if (op.playerLink) {
    const playerPatch: Record<string, any> = {};
    if (op.playerLink.isAdultPlayer) playerPatch.isAdultPlayer = true;
    await commitDocumentTransforms(
      pid,
      `players/${op.playerLink.playerId}`,
      [{ fieldPath: 'parentIds', kind: 'arrayUnion', value: op.targetUid }],
      Object.keys(playerPatch).length ? playerPatch : null,
      sa,
    );
  }

  // Step 3 — user grant. teamIds arrayUnion + role/approval/coverage
  // stamp. approved=true + approvalStatus + approvedAt uniformly
  // applied (guard-drift closure #3).
  const userTransforms: any[] = [];
  const uniqueTeamIds = Array.from(new Set(op.teamIds.filter(Boolean)));
  if (uniqueTeamIds.length > 0) {
    userTransforms.push({ fieldPath: 'teamIds', kind: 'arrayUnion', value: uniqueTeamIds });
  }
  if (op.playerLink) {
    userTransforms.push({ fieldPath: 'children', kind: 'arrayUnion', value: op.playerLink.playerId });
  }
  const userPatch: Record<string, any> = {
    approved: true,
    approvalStatus: op.approvalStatus,
    approvedAt: now,
  };
  if (op.role) userPatch.role = op.role;
  if (op.role === 'coach' && op.coachLevel) userPatch.coachLevel = op.coachLevel;
  if (op.role === 'parent' && op.relationship) userPatch.relationship = op.relationship;
  if (op.legacyTeamId) userPatch.teamId = op.legacyTeamId;
  if (op.invitedBy !== undefined) userPatch.invitedBy = op.invitedBy;
  if (op.invitedVia) userPatch.invitedVia = op.invitedVia;
  if (op.coverage) {
    userPatch.coverageSource = op.coverage.source;
    userPatch.coverageClubId = op.coverage.clubId;
  }
  if (op.playerLink?.isAdultPlayer) userPatch.selfPlayerId = op.playerLink.playerId;
  if (op.extraUserPatch) Object.assign(userPatch, op.extraUserPatch);

  if (userTransforms.length > 0 || Object.keys(userPatch).length > 0) {
    await commitDocumentTransforms(
      pid,
      `users/${op.targetUid}`,
      userTransforms,
      userPatch,
      sa,
    );
  }

  // Step 4 — stage stamp. Guard-drift closure #2: always fires on
  // the success path (idempotent shortcircuits in the shims call
  // stampStageFor() themselves so this doesn't need a special case).
  await stampStageFor(op.targetUid, pid, sa);

  // Step 5 — reconcile custom claims with post-write teamIds/clubIds
  // so LIST rules see the fresh scope on the target's next token
  // refresh. Covers /claim/invite, /claim/coach-invite,
  // /claim/player-link, /claim/offer-accept — every applyMembership
  // caller in one line.
  refreshClaimsForUid(op.targetUid, pid, sa);
}

// ────────────────────────────────────────────────────────────────
// /claim/invite — signed-in user consumes an invites/{id}. Replaces
// src/utils/invites.ts consumeInvite. Handles all three invite
// types (player, coach, team_manager) in a single endpoint since
// they share the same collection.
//
// Body: { inviteId }
//
// Side-effects:
//   player invite      → players/{playerId}.parentIds arrayUnion(uid),
//                        players.isAdultPlayer=true (if adult flag),
//                        users.role=parent, users.teamIds+=teamId,
//                        users.selfPlayerId (if adult)
//   coach invite       → users.role=coach, users.coachLevel,
//                        users.teamIds+=teamId
//   team_manager       → users.role=team_manager, teamIds+=teamId
//
// After the primary write, coach + team_manager invites also stamp
// users.coverageSource='club' when the team belongs to a non-solo
// club — matches the pre-worker post-transaction fixup.
// ────────────────────────────────────────────────────────────────
async function handleClaimInvite(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  const inviteId = String(payload?.inviteId || '');
  if (!inviteId) return json({ ok: false, error: 'invite_id_required' }, 400);

  const inviteDoc = await getDocument(pid, `invites/${inviteId}`, sa).catch(() => null);
  if (!inviteDoc?.data) return json({ ok: false, error: 'invite_not_found' }, 404);
  const invite: any = inviteDoc.data;
  if (invite.revokedAt) return json({ ok: false, error: 'invite_revoked' }, 410);
  if (isInviteExpired(invite.expiresAt)) return json({ ok: false, error: 'invite_expired' }, 410);
  const usedCount = typeof invite.usedCount === 'number' ? invite.usedCount : 0;
  const maxUses = typeof invite.maxUses === 'number' ? invite.maxUses : 1;
  if (usedCount >= maxUses) return json({ ok: false, error: 'invite_exhausted' }, 410);
  const teamId = String(invite.teamId || '');
  if (!teamId) return json({ ok: false, error: 'invite_missing_team' }, 400);
  const inviteType = String(invite.type || '');
  if (inviteType !== 'player' && inviteType !== 'coach' && inviteType !== 'team_manager') {
    return json({ ok: false, error: 'unknown_invite_type' }, 400);
  }
  // Player-type invite must carry playerId. Check here rather than
  // after the reservation so we don't consume a malformed invite.
  let playerId = '';
  if (inviteType === 'player') {
    playerId = String(invite.playerId || '');
    if (!playerId) return json({ ok: false, error: 'invite_missing_player' }, 400);
  }

  const usedBy: string[] = Array.isArray(invite.usedBy) ? invite.usedBy : [];
  if (usedBy.includes(claims.uid)) {
    // Idempotent replay — user already consumed this. Restamp stage
    // in case it drifted via another mutation and return the same
    // shape as before. Bug-for-bug preservation: this branch OMITS
    // the 'type' field that the fresh-consume branch returns, so
    // mobile 3.9.160 clients that never expected it here don't
    // suddenly see a schema change.
    await stampStage(claims.uid, pid, sa);
    return json({ ok: true, teamId: invite.teamId, playerId: invite.playerId, idempotent: true });
  }

  // Consume-first ordering: reserve the invite BEFORE the grant. If
  // applyMembership() throws mid-flight the invite is already burned;
  // a retry hits the idempotent short-circuit above and heals. For
  // maxUses>1 invites both arrayUnion and increment are commutative,
  // so two concurrent callers both succeed correctly.
  //
  // For maxUses=1 there's a real TOCTOU: both callers pass the
  // usedCount<maxUses check, both commit, invite ends up with
  // usedCount=2 and both get the grant. When the invite is
  // single-use, pass an updateTime precondition so only one commit
  // wins. Multi-use invites keep commutative semantics (no
  // precondition) since both callers should succeed.
  const preconditionOnSingleUse = maxUses <= 1 && inviteDoc.updateTime
    ? { updateTime: inviteDoc.updateTime }
    : undefined;
  try {
    await commitDocumentTransforms(
      pid,
      `invites/${inviteId}`,
      [
        { fieldPath: 'usedCount', kind: 'increment', value: 1 },
        { fieldPath: 'usedBy', kind: 'arrayUnion', value: claims.uid },
      ],
      null,
      sa,
      preconditionOnSingleUse,
    );
  } catch (err) {
    if (err instanceof PreconditionFailedError) {
      return json({ ok: false, error: 'invite_exhausted' }, 410);
    }
    throw err;
  }

  // Club coverage lookup — coach + team_manager joining a NON-solo
  // club inherit coverage. Non-fatal: a bad lookup logs and skips
  // rather than blocking the whole flow.
  let coverage: MembershipOp['coverage'];
  if (inviteType === 'coach' || inviteType === 'team_manager') {
    try {
      const teamDoc = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
      const clubId = teamDoc?.data?.clubId ? String(teamDoc.data.clubId) : '';
      if (clubId) {
        const clubDoc = await getDocument(pid, `clubs/${clubId}`, sa).catch(() => null);
        if (clubDoc?.data?.isDefaultSoloClub !== true) {
          coverage = { source: 'club', clubId };
        }
      }
    } catch (err) {
      console.warn('[claim-invite] club coverage lookup failed:', (err as Error).message);
    }
  }

  const op: MembershipOp = {
    operationSource: 'claim_invite',
    targetUid: claims.uid,
    teamIds: [teamId],
    legacyTeamId: teamId,
    invitedBy: invite.createdBy || null,
    invitedVia: inviteId,
    approvalStatus: 'auto',
    coverage,
  };
  if (inviteType === 'player') {
    op.role = 'parent';
    // 2026-07-19: previously only stamped when inviteRel was non-empty
    // AND non-'parent' (treated 'parent' as a legacy no-info fallback).
    // That left mom/dad accepters with relationship=undefined, which
    // downstream self-Kudos + directory gates couldn't distinguish
    // from a grandma-with-undefined. Now that the PlayerCircle picker
    // forces the inviter to declare a real relationship (including
    // 'parent'/'guardian') before generating the invite, we stamp
    // whatever the invite carried. Legacy invites with no relationship
    // still leave the field undefined — those users need a Settings
    // prompt to self-declare (follow-up, not shipped here).
    const inviteRel = invite.relationship ? String(invite.relationship) : '';
    if (inviteRel) {
      op.relationship = inviteRel;
    }
    op.playerLink = { playerId, isAdultPlayer: invite.isAdultPlayer === true };
  } else if (inviteType === 'coach') {
    op.role = 'coach';
    // Generic /claim/invite never crowns a head coach. Head-coach
    // promotion goes through /claim/coach-invite (which itself gates
    // an existing head via applyMembership). Any legacy invites doc
    // shaped with role='head_coach' would otherwise silently displace
    // the current head via the scalar headCoachId overwrite.
    op.coachLevel = 'assistant';
    // Guard-drift closure #1: previously omitted. Coach claiming a
    // legacy invite must also land on team.coachIds so
    // requireCoachOfTeam works after the grant.
    op.attachToTeamCoachIds = teamId;
  } else {
    op.role = 'team_manager';
    // Guard-drift closure: team_manager promotions must land on
    // team.managerIds so the Staff page (which reads managerIds, not
    // any generic membership list) shows them to the head coach.
    // applyMembership routes attachToTeamCoachIds through the
    // managerIds branch when role === 'team_manager'.
    op.attachToTeamCoachIds = teamId;
  }

  await applyMembership(op, pid, sa);

  return json({ ok: true, type: inviteType, teamId, playerId: invite.playerId || null });
}

// ────────────────────────────────────────────────────────────────
// /claim/coach-invite — coach claims a coach_invite. Same pattern
// as parent-invite but writes teams/{teamId}.coachIds AND
// users/{uid}.{role, coachLevel, teamIds}.
// ────────────────────────────────────────────────────────────────
async function handleClaimCoachInvite(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  const inviteId = String(payload?.inviteId || '');
  if (!inviteId) return json({ ok: false, error: 'invite_id_required' }, 400);

  const inviteDoc = await getDocument(pid, `coach_invites/${inviteId}`, sa).catch(() => null);
  if (!inviteDoc?.data) return json({ ok: false, error: 'invite_not_found' }, 404);
  const invite: any = inviteDoc.data;
  if (invite.revokedAt || invite.status === 'revoked') return json({ ok: false, error: 'invite_revoked' }, 410);
  // Timestamp/ISO uniform via isInviteExpired — closes drift where
  // {seconds} Timestamps silently passed through as unexpired.
  if (isInviteExpired(invite.expiresAt)) return json({ ok: false, error: 'invite_expired' }, 410);

  const teamId = String(invite.teamId || '');
  if (!teamId) return json({ ok: false, error: 'invite_missing_team' }, 400);
  // Default to assistant unless the invite explicitly says head_coach.
  // Legacy invites with missing / non-canonical coachLevel (e.g.
  // 'assistant_coach', null, absent) previously fell through to
  // head_coach, which combined with applyMembership's scalar
  // headCoachId write would silently displace the current head. Safe
  // default is assistant; applyMembership additionally guards the
  // headCoachId scalar so an existing head is never overwritten.
  const coachLevel = invite.coachLevel === 'head_coach' ? 'head_coach' : 'assistant';

  // Idempotent retry by the same uid: they already claimed this
  // invite and are hitting the endpoint again (double-tap, retry
  // after network blip). Return 200 rather than the historical 409
  // so mobile clients treat it as success. Different-uid retries
  // still 409 below.
  if (invite.status === 'claimed' && invite.claimedBy === claims.uid) {
    await stampStage(claims.uid, pid, sa);
    return json({ ok: true, teamId, idempotent: true });
  }
  if (invite.status === 'claimed') return json({ ok: false, error: 'already_used' }, 409);

  // TOCTOU-safe reservation: flip status to 'claimed' with a
  // currentDocument.updateTime precondition. If another caller wins
  // the race between our getDocument above and this commit, Firestore
  // returns FAILED_PRECONDITION → PreconditionFailedError → 409. This
  // is the single-use invite mutex; without it two coaches sharing
  // a link could both attach.
  try {
    await commitDocumentTransforms(
      pid,
      `coach_invites/${inviteId}`,
      [],
      { status: 'claimed', claimedBy: claims.uid, claimedAt: new Date() },
      sa,
      inviteDoc.updateTime ? { updateTime: inviteDoc.updateTime } : undefined,
    );
  } catch (err) {
    if (err instanceof PreconditionFailedError) {
      return json({ ok: false, error: 'already_used' }, 409);
    }
    throw err;
  }

  await applyMembership({
    operationSource: 'claim_coach_invite',
    targetUid: claims.uid,
    teamIds: [teamId],
    attachToTeamCoachIds: teamId,
    role: 'coach',
    coachLevel,
    approvalStatus: 'invite-consumed',
    invitedVia: inviteId,
    coverage: invite.clubId ? { source: 'club', clubId: String(invite.clubId) } : undefined,
  }, pid, sa);

  return json({ ok: true, teamId });
}

// ────────────────────────────────────────────────────────────────
// /claim/player-link — parent (or adult) auto-links via a shared
// /p/{playerId} link. Only allowed if the caller's email matches
// the player's parentEmails, OR the player has no parents yet AND
// the caller is claiming as the adult player themselves.
// ────────────────────────────────────────────────────────────────
async function handleClaimPlayerLink(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  const playerId = String(payload?.playerId || '');
  const asAdultPlayer = payload?.asAdultPlayer === true;
  if (!playerId) return json({ ok: false, error: 'player_id_required' }, 400);

  const playerDoc = await getDocument(pid, `players/${playerId}`, sa).catch(() => null);
  if (!playerDoc?.data) return json({ ok: false, error: 'player_not_found' }, 404);
  const player: any = playerDoc.data;

  const parentEmails: string[] = Array.isArray(player.parentEmails) ? player.parentEmails.map(normEmail) : [];
  const emailMatches = !!claims.email && parentEmails.includes(normEmail(claims.email));
  const noParents = !Array.isArray(player.parentIds) || player.parentIds.length === 0;
  const isAdultClaim = asAdultPlayer && noParents;
  if (!emailMatches && !isAdultClaim) {
    return json({ ok: false, error: 'not_authorized' }, 403);
  }

  const teamIds: string[] = Array.isArray(player.teamIds) && player.teamIds.length > 0
    ? player.teamIds
    : (player.teamId ? [player.teamId] : []);

  // Adult self-claim TOCTOU: two callers of an unclaimed adult
  // player both pass the noParents check, both call applyMembership,
  // both end up on parentIds (arrayUnion is commutative), and both
  // get isAdultPlayer=true stamped. The intent of the flow is
  // "first tap wins the identity" — the second tap should get
  // 409 already_claimed instead of silently piggybacking.
  //
  // Enforced via a currentDocument.updateTime precondition on the
  // parentIds arrayUnion write. Only wraps the adult-self path
  // (email-match path is idempotent and safe to concurrent-tap).
  if (isAdultClaim) {
    const playerPatch: Record<string, any> = { isAdultPlayer: true };
    try {
      await commitDocumentTransforms(
        pid,
        `players/${playerId}`,
        [{ fieldPath: 'parentIds', kind: 'arrayUnion', value: claims.uid }],
        playerPatch,
        sa,
        playerDoc.updateTime ? { updateTime: playerDoc.updateTime } : undefined,
      );
    } catch (err) {
      if (err instanceof PreconditionFailedError) {
        return json({ ok: false, error: 'already_claimed' }, 409);
      }
      throw err;
    }
    // applyMembership below re-arrayUnions parentIds (idempotent) +
    // does the user-doc grant. Safe because we've already won the
    // race on the player doc.
  }

  await applyMembership({
    operationSource: 'claim_player_link',
    targetUid: claims.uid,
    teamIds,
    approvalStatus: 'player-link',
    playerLink: { playerId, isAdultPlayer: isAdultClaim },
  }, pid, sa);

  return json({ ok: true, playerId, linkedTeams: teamIds.length });
}

// ────────────────────────────────────────────────────────────────
// /claim/offer-accept — parent accepts an offer link (tryout).
// Currently offers are gettable by id (no list). The endpoint
// verifies the offer + that the caller's email matches the offer's
// parent email, then flips status and stamps player.teamIds.
// ────────────────────────────────────────────────────────────────
async function handleClaimOfferAccept(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  const offerId = String(payload?.offerId || '');
  if (!offerId) return json({ ok: false, error: 'offer_id_required' }, 400);

  const offerDoc = await getDocument(pid, `offers/${offerId}`, sa).catch(() => null);
  if (!offerDoc?.data) return json({ ok: false, error: 'offer_not_found' }, 404);
  const offer: any = offerDoc.data;
  if (offer.status && offer.status !== 'sent' && offer.status !== 'viewed') {
    return json({ ok: false, error: 'offer_not_open' }, 409);
  }
  if (offer.parentEmail && normEmail(offer.parentEmail) !== normEmail(claims.email)) {
    return json({ ok: false, error: 'wrong_recipient' }, 403);
  }

  const teamId = String(offer.teamId || '');
  let playerId = String(offer.playerId || '');
  // Fallback for offers created before SendOfferModal started stamping
  // playerId on the offer doc (audit 2026-07-10). Look at the linked
  // registration and take its playerId / promotedToPlayerId. Without
  // this the whole applyMembership grant below silently no-ops for
  // legacy offers — parent taps Accept, sees green, but stays outside
  // the team.
  if (!playerId && offer.registrationId) {
    const regDoc = await getDocument(pid, `registrations/${String(offer.registrationId)}`, sa).catch(() => null);
    const regData: any = regDoc?.data;
    if (regData) {
      const fromReg = String(regData.playerId || regData.promotedToPlayerId || '');
      if (fromReg) playerId = fromReg;
    }
  }
  // Last-resort override from client payload — Offer.tsx accept flow
  // has the playerId in memory and can pass it explicitly.
  if (!playerId && payload?.playerId) {
    playerId = String(payload.playerId);
  }
  const now = new Date();

  // 1. Flip the offer to accepted (audit trail).
  await patchDocument(
    pid,
    `offers/${offerId}`,
    {
      status: 'accepted',
      acceptedAt: now,
      acceptedBy: claims.uid,
      updatedAt: now,
    },
    sa,
  );

  // 2. Player patch — accepts optional position/jersey/roster fields
  //    from the client so the coach's roster picks them up on the
  //    same commit. Previously the client attempted this write and
  //    hit permission-denied (players.update blocks teamId edits
  //    from the parent branch). Consolidated here so the whole
  //    accept flow lands atomically via the service account.
  if (playerId && teamId) {
    const playerPatch: Record<string, any> = {
      teamId,
      rosteredFromOfferId: offerId,
      rosteredAt: now,
    };
    const p: any = payload?.player || {};
    if (p.position) playerPatch.position = String(p.position).slice(0, 40);
    if (typeof p.jerseyNumber === 'number') playerPatch.jerseyNumber = p.jerseyNumber;
    await commitDocumentTransforms(
      pid,
      `players/${playerId}`,
      [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: teamId }],
      playerPatch,
      sa,
    );
  }

  // 3. Grant the accepting Circle member team + player-link membership.
  //    Uses applyMembership so parentIds arrayUnion, user.teamIds
  //    arrayUnion, user.children arrayUnion, role='parent',
  //    approvalStatus='auto', stampStageFor all fire in one shot.
  //    Previously omitted — parent accepted the offer but never got
  //    the team in their switcher, chat, RSVPs, etc. Silent breakage
  //    of the tryout happy path for every family who accepted.
  //
  //    2026-07-19: was dropping offerRel==='parent' as a legacy
  //    no-info fallback. Now we stamp whatever the offer carried
  //    (including 'parent'/'guardian') so the self-Kudos gate can
  //    tell mom/dad apart from grandma-with-undefined. Matches the
  //    invite-path change at handleClaimInvite.
  if (playerId && teamId) {
    const offerRel = offer.relationship ? String(offer.relationship) : '';
    const membershipOp: any = {
      operationSource: 'claim_offer_accept',
      targetUid: claims.uid,
      teamIds: [teamId],
      legacyTeamId: teamId,
      role: 'parent',
      approvalStatus: 'auto',
      invitedVia: `offer:${offerId}`,
      playerLink: { playerId },
    };
    if (offerRel) {
      membershipOp.relationship = offerRel;
    }
    await applyMembership(membershipOp, pid, sa);
  } else {
    // Offer without a linked player+team can still fire stage
    // recompute (edge case: pre-Phase-1 offers).
    await stampStage(claims.uid, pid, sa);
  }

  return json({ ok: true, teamId, playerId });
}

async function handleClaimOfferDecline(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  const offerId = String(payload?.offerId || '');
  if (!offerId) return json({ ok: false, error: 'offer_id_required' }, 400);
  const offerDoc = await getDocument(pid, `offers/${offerId}`, sa).catch(() => null);
  if (!offerDoc?.data) return json({ ok: false, error: 'offer_not_found' }, 404);
  const offer: any = offerDoc.data;
  // Recipient guard: refuse decline unless offer.parentEmail is set
  // AND matches the caller's email. Previous check let a decline
  // through when parentEmail was empty because the leading truthy
  // check short-circuited — any authed user could DoS an unclaimed
  // offer by force-declining it. Audit 2026-07-10.
  if (!offer.parentEmail || !claims.email) {
    return json({ ok: false, error: 'wrong_recipient' }, 403);
  }
  if (normEmail(offer.parentEmail) !== normEmail(claims.email)) {
    return json({ ok: false, error: 'wrong_recipient' }, 403);
  }
  const now = new Date();
  const reason = String(payload?.reason || '').slice(0, 500);
  await patchDocument(
    pid,
    `offers/${offerId}`,
    { status: 'declined', declinedAt: now, declinedBy: claims.uid, declineReason: reason },
    sa,
  );

  // Also flip the linked registration back to declined + stamp the
  // decline reason in notes. Previously the client tried this itself
  // and 403'd on the registrations.update rule (parent-branch hasOnly
  // allowlist doesn't include 'notes'). Consolidated here so the
  // caller only makes one round-trip and the audit trail is coherent.
  const linkedRegId = String(offer?.registrationId || '');
  if (linkedRegId) {
    const notes = reason ? `Offer declined: ${reason}` : undefined;
    const regPatch: Record<string, any> = { status: 'declined', updatedAt: now };
    if (notes) regPatch.notes = notes;
    await patchDocument(pid, `registrations/${linkedRegId}`, regPatch, sa).catch(err => {
      console.warn('registration decline patch failed', linkedRegId, err);
    });
  }
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /teams/create — signed-in user creates a team + becomes its coach.
// Body: { name, ageGroup?, season?, clubId?, format?,
//         withDefaultClub? }
//
// Two modes:
//  1. `clubId` provided (team joins an existing club — future flow
//     for club admins adding a team to their org)
//  2. `withDefaultClub: true` (the current onboarding "solo coach"
//     path): worker creates a wrapper club with isDefaultSoloClub:
//     true, stamps its id on the team + user, so "becoming a club
//     later" is still a no-op — same posture as the pre-worker flow.
//  3. Neither: team gets created without a clubId. Rare — mostly a
//     safety fall-through.
//
// All writes happen server-side so the client only makes ONE call.
// ────────────────────────────────────────────────────────────────
async function handleTeamsCreate(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  const name = String(payload?.name || '').slice(0, 100).trim();
  if (!name) return json({ ok: false, error: 'name_required' }, 400);
  const ageGroup = String(payload?.ageGroup || '').slice(0, 40);
  const season = String(payload?.season || '').slice(0, 40);
  const requestedClubId = payload?.clubId ? String(payload.clubId) : '';
  const withDefaultClub = payload?.withDefaultClub === true;
  const format = ['7v7', '9v9', '11v11'].includes(String(payload?.format)) ? String(payload.format) : '7v7';
  const audienceType = payload?.audienceType === 'adult' ? 'adult' : undefined;
  // rosterMode is a sibling to audienceType, not a third value on it.
  // Only accept 'pickup' explicitly; anything else (undefined, 'roster',
  // garbage) leaves the field unset so read sites fall back to 'roster'
  // via rosterModeOf(). Enforced adult-only to keep youth teams clean —
  // a youth team with rosterMode='pickup' would be nonsense.
  const rosterMode = (payload?.rosterMode === 'pickup' && audienceType === 'adult')
    ? 'pickup'
    : undefined;

  const teamFields: Record<string, any> = {
    name,
    ageGroup,
    season,
    format,
    coachIds: [claims.uid],
    headCoachId: claims.uid,
    playerIds: [],
    parentIds: [],
    isActive: true,
    createdAt: new Date(),
    createdBy: claims.uid,
    // XP + badges default ON for newly-created teams. Existing teams
    // (created before this field existed) show undefined which the
    // client reads as OFF — no surprise gamification for coaches
    // who never opted in. See onboarding-xp memo.
    xpConfig: { enabled: true, enabledAt: new Date() },
  };
  if (audienceType) teamFields.audienceType = audienceType;
  if (rosterMode) teamFields.rosterMode = rosterMode;
  if (requestedClubId) teamFields.clubId = requestedClubId;

  const teamId = payload?.desiredId ? String(payload.desiredId).slice(0, 60) : undefined;
  const newTeamId = await createDocument(pid, 'teams', teamFields, sa, teamId);

  // Spin up the wrapper club when the caller asked for one.
  let newClubId: string | null = null;
  if (!requestedClubId && withDefaultClub) {
    newClubId = await createDocument(
      pid,
      'clubs',
      {
        name,
        ownerUid: claims.uid,
        adminUids: [],
        initialTeamId: newTeamId,
        isDefaultSoloClub: true,
        createdAt: new Date(),
      },
      sa,
    );
    // Stamp the club id back onto the team so multi-tenant scoping
    // reads a coherent state.
    await patchDocument(pid, `teams/${newTeamId}`, { clubId: newClubId }, sa);
  }

  // Load current user first so we can preserve elevated roles
  // (club_admin, team_manager, isClubAdmin) that shouldn't be
  // clobbered by a team-create call. Prior shape unconditionally
  // stamped role='coach' which silently demoted club directors.
  const currentUser = await getDocument(pid, `users/${claims.uid}`, sa).catch(() => null);
  const existingRole = String(currentUser?.data?.role || '');
  const preserveRole = existingRole === 'club_admin' || existingRole === 'team_manager';
  const userPatch: Record<string, any> = {
    coachLevel: 'head_coach',
    approved: true,
    approvalStatus: 'self-created-team',
  };
  if (!preserveRole) userPatch.role = 'coach';
  // Auto-grant a 7-day trial to first-time team creators so they
  // don't hit the canCoachWrite() trial wall while dogfooding the
  // team they just made. Only stamps if they don't already have an
  // active subscription — avoids clobbering a paid user's
  // subscriptionExpiresAt when they create a second team. Patrick
  // 2026-07-09: "what about new users? am i going to have them do
  // the same thing?" — no; every new coach now gets 7 real days.
  const alreadyActive = !!currentUser?.data?.subscriptionActive;
  if (!alreadyActive) {
    const now = new Date();
    const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    userPatch.subscriptionActive = true;
    userPatch.subscriptionTier = 'trial';
    userPatch.subscriptionStatus = 'trialing';
    userPatch.subscriptionStartedAt = now;
    userPatch.subscriptionExpiresAt = in7;
    userPatch.subscriptionSource = 'auto-trial-team-create';
  }
  const userTransforms: any[] = [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: newTeamId }];
  const effectiveClubId = newClubId || requestedClubId;
  if (effectiveClubId) {
    userTransforms.push({ fieldPath: 'clubIds', kind: 'arrayUnion', value: effectiveClubId });
  }
  await commitDocumentTransforms(pid, `users/${claims.uid}`, userTransforms, userPatch, sa);

  // Phase A: caller just created a team + got teamIds arrayUnion'd →
  // active.
  await stampStage(claims.uid, pid, sa);

  // Reconcile custom claims — caller just got teamIds + clubIds
  // arrayUnion'd. LIST rules that read request.auth.token pick up
  // the new scope on the client's next getIdToken(true).
  refreshClaimsForUid(claims.uid, pid, sa);

  return json({ ok: true, teamId: newTeamId, clubId: effectiveClubId || null });
}

// ────────────────────────────────────────────────────────────────
// /clubs/create — club-first onboarding path (director/registrar).
// Body: { name, alsoCoach?: boolean, firstTeamName? }
// If alsoCoach, ALSO creates a first team and stamps user as coach.
// Otherwise user becomes club_admin with no team affiliation.
// ────────────────────────────────────────────────────────────────
async function handleClubsCreate(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  const name = String(payload?.name || '').slice(0, 100).trim();
  if (!name) return json({ ok: false, error: 'name_required' }, 400);
  const alsoCoach = payload?.alsoCoach === true;
  const firstTeamName = String(payload?.firstTeamName || '').slice(0, 100).trim();
  if (alsoCoach && !firstTeamName) {
    return json({ ok: false, error: 'first_team_name_required' }, 400);
  }

  let teamId: string | null = null;
  if (alsoCoach) {
    teamId = await createDocument(
      pid,
      'teams',
      {
        name: firstTeamName,
        coachIds: [claims.uid],
        headCoachId: claims.uid,
        assistantCoachIds: [],
        playerIds: [],
        parentIds: [],
        season: String(new Date().getFullYear()),
        ageGroup: '',
        format: '7v7',
        isActive: true,
        createdAt: new Date(),
        createdBy: claims.uid,
      },
      sa,
    );
  }
  const clubId = await createDocument(
    pid,
    'clubs',
    {
      name,
      ownerUid: claims.uid,
      adminUids: [],
      isDefaultSoloClub: false,
      createdAt: new Date(),
      ...(teamId ? { initialTeamId: teamId } : {}),
    },
    sa,
  );
  if (teamId) {
    await patchDocument(pid, `teams/${teamId}`, { clubId }, sa);
  }

  // Preserve pre-existing elevated roles same as /teams/create. A
  // user who was already team_manager on another team shouldn't be
  // silently demoted to coach just because they created a club.
  const currentUserClub = await getDocument(pid, `users/${claims.uid}`, sa).catch(() => null);
  const existingRoleClub = String(currentUserClub?.data?.role || '');
  const preserveRoleClub = existingRoleClub === 'team_manager'
    || (existingRoleClub === 'club_admin' && !alsoCoach);
  const userPatch: Record<string, any> = {
    approved: true,
    approvalStatus: 'self-created-club',
    // NOT platform admin — that's a separate flag Patrick controls.
    // isClubAdmin here is only true for platform admins per legacy
    // naming; do not stamp it based on club ownership.
  };
  if (!preserveRoleClub) userPatch.role = alsoCoach ? 'coach' : 'club_admin';
  // Same 7-day auto-trial as /teams/create. Same rationale — a
  // freshly-onboarded club director should have a working app for
  // 7 days before the trial wall kicks in.
  const alreadyActiveClub = !!currentUserClub?.data?.subscriptionActive;
  if (!alreadyActiveClub) {
    const now = new Date();
    const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    userPatch.subscriptionActive = true;
    userPatch.subscriptionTier = 'trial';
    userPatch.subscriptionStatus = 'trialing';
    userPatch.subscriptionStartedAt = now;
    userPatch.subscriptionExpiresAt = in7;
    userPatch.subscriptionSource = 'auto-trial-club-create';
  }
  const userTransforms: any[] = [{ fieldPath: 'clubIds', kind: 'arrayUnion', value: clubId }];
  if (teamId) {
    userPatch.coachLevel = 'head_coach';
    userTransforms.push({ fieldPath: 'teamIds', kind: 'arrayUnion', value: teamId });
  }
  await commitDocumentTransforms(pid, `users/${claims.uid}`, userTransforms, userPatch, sa);

  // Phase A: club creator is active regardless of the alsoCoach path
  // (club_admin identity → active, coach with new team → active).
  await stampStage(claims.uid, pid, sa);

  // Reconcile custom claims — caller now has clubIds and (optionally)
  // teamIds updated.
  refreshClaimsForUid(claims.uid, pid, sa);

  return json({ ok: true, clubId, teamId });
}

// ────────────────────────────────────────────────────────────────
// /teams/add-coach — head coach adds another coach to their team.
// Body: { teamId, coachUid, coachLevel? ('head_coach' | 'assistant') }
// Verifies caller is a coach on the target team.
// ────────────────────────────────────────────────────────────────
async function handleTeamsAddCoach(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  const claims = await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const coachUid = String(payload?.coachUid || '');
  if (!coachUid) return json({ ok: false, error: 'coach_uid_required' }, 400);
  // Assistant coaches cannot promote themselves or an alt account to
  // head_coach via /teams/add-coach — head transfer has its own
  // endpoint (/teams/transfer-head). Assistant callers who pass
  // head_coach silently get downgraded to assistant. Head coach can
  // still pass any level; club/team_manager caller too. Closes the
  // 2026-07-10 audit vuln: assistant crowns their alt account, then
  // removes the real head via /teams/remove-coach.
  const teamDocForRole = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  const currentHeadId = String(teamDocForRole?.data?.headCoachId || '');
  const isHead = currentHeadId && currentHeadId === claims.uid;
  const requestedLevel = payload?.coachLevel === 'head_coach' ? 'head_coach' : 'assistant';
  const coachLevel = requestedLevel === 'head_coach' && !isHead ? 'assistant' : requestedLevel;

  await applyMembership({
    operationSource: 'teams_add_coach',
    targetUid: coachUid,
    teamIds: [teamId],
    attachToTeamCoachIds: teamId,
    role: 'coach',
    coachLevel,
    // Guard-drift closure #3: previously omitted approvalStatus. Now
    // uniformly stamped so admin-granted coaches have the same shape
    // as invite-consumed coaches.
    approvalStatus: 'admin-grant',
  }, pid, sa);

  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /teams/remove-coach — head coach removes a coach from their team.
// ────────────────────────────────────────────────────────────────
async function handleTeamsRemoveCoach(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  const claims = await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const coachUid = String(payload?.coachUid || '');
  if (!coachUid) return json({ ok: false, error: 'coach_uid_required' }, 400);
  // Protect the head coach: any coach can remove themselves or a
  // peer, but only the head (or platform admin) can remove the head.
  // Otherwise an assistant would be able to eject the head coach
  // and rearrange the roster. Self-removal is always allowed.
  const teamDocForHeadCheck = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  const currentHeadId = String(teamDocForHeadCheck?.data?.headCoachId || '');
  if (coachUid === currentHeadId && claims.uid !== currentHeadId) {
    return json({
      ok: false,
      error: 'cannot_remove_head_coach',
      message: 'Only the head coach can remove themselves. Use "Transfer head coach" first.',
    }, 403);
  }

  await commitDocumentTransforms(
    pid,
    `teams/${teamId}`,
    [{ fieldPath: 'coachIds', kind: 'arrayRemove', value: coachUid }],
    null,
    sa,
  );
  await commitDocumentTransforms(
    pid,
    `users/${coachUid}`,
    [{ fieldPath: 'teamIds', kind: 'arrayRemove', value: teamId }],
    null,
    sa,
  );

  // Phase A: TARGET user lost a team — recompute their stage. They
  // may still have other teams (active) or be back to needs_team.
  await stampStageFor(coachUid, pid, sa);

  // Reconcile the removed coach's custom claims — their teamIds
  // shrank. Their in-flight token is still valid until it expires
  // (up to 1hr); LIST rules tolerate that lag via the userDoc()
  // fallback branches.
  refreshClaimsForUid(coachUid, pid, sa);

  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /teams/share-player — coach adds a player onto another team they
// also coach (e.g. sharing across a club's dev team).
// Body: { fromTeamId, toTeamId, playerId }
// ────────────────────────────────────────────────────────────────
async function handleTeamsSharePlayer(req: Request, env: Env, payload: any): Promise<Response> {
  const fromTeamId = String(payload?.fromTeamId || '');
  const toTeamId = String(payload?.toTeamId || '');
  if (!fromTeamId || !toTeamId) return json({ ok: false, error: 'team_ids_required' }, 400);
  // Must be a coach on BOTH teams.
  await requireCoachOfTeam(req, env, fromTeamId);
  await requireCoachOfTeam(req, env, toTeamId);
  const { pid, sa } = projectAndSA(env);
  const playerId = String(payload?.playerId || '');
  if (!playerId) return json({ ok: false, error: 'player_id_required' }, 400);

  await commitDocumentTransforms(
    pid,
    `players/${playerId}`,
    [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: toTeamId }],
    null,
    sa,
  );
  await commitDocumentTransforms(
    pid,
    `teams/${toTeamId}`,
    [{ fieldPath: 'playerIds', kind: 'arrayUnion', value: playerId }],
    null,
    sa,
  );
  // Fan out to each parent so their user.teamIds includes the new team.
  const playerDoc = await getDocument(pid, `players/${playerId}`, sa).catch(() => null);
  const parentIds: string[] = Array.isArray(playerDoc?.data?.parentIds) ? playerDoc?.data?.parentIds : [];
  for (const parentUid of parentIds) {
    await commitDocumentTransforms(
      pid,
      `users/${parentUid}`,
      [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: toTeamId }],
      null,
      sa,
    ).catch(() => undefined);
    // Reconcile the parent's custom claims so LIST rules pick up the
    // new team scope without waiting for a full re-sign-in.
    refreshClaimsForUid(parentUid, pid, sa);
  }
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /teams/unshare-player — coach removes a player from a team they
// were previously shared into. Trims the team from player.teamIds
// AND from each parent's user.teamIds — UNLESS the parent has
// another player still on that team.
// Body: { teamId, playerId }
// ────────────────────────────────────────────────────────────────
async function handleTeamsUnsharePlayer(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const playerId = String(payload?.playerId || '');
  if (!playerId) return json({ ok: false, error: 'player_id_required' }, 400);

  const playerDoc = await getDocument(pid, `players/${playerId}`, sa).catch(() => null);
  if (!playerDoc?.data) return json({ ok: false, error: 'player_not_found' }, 404);
  const player: any = playerDoc.data;
  const playerTeamIds: string[] = Array.isArray(player.teamIds)
    ? player.teamIds
    : (player.teamId ? [player.teamId] : []);
  if (!playerTeamIds.includes(teamId)) {
    return json({ ok: false, error: 'player_not_on_team' }, 400);
  }
  if (playerTeamIds.length <= 1) {
    return json({ ok: false, error: 'last_team_cannot_unshare' }, 400);
  }
  const parentIds: string[] = Array.isArray(player.parentIds) ? player.parentIds : [];

  await commitDocumentTransforms(
    pid,
    `players/${playerId}`,
    [{ fieldPath: 'teamIds', kind: 'arrayRemove', value: teamId }],
    player.teamId === teamId ? { teamId: playerTeamIds.find(t => t !== teamId) || '' } : null,
    sa,
  );
  await commitDocumentTransforms(
    pid,
    `teams/${teamId}`,
    [{ fieldPath: 'playerIds', kind: 'arrayRemove', value: playerId }],
    null,
    sa,
  );

  // For each parent: does another player of theirs still tie them
  // to this team? If yes, leave user.teamIds alone. If no, remove.
  for (const parentUid of parentIds) {
    try {
      const otherPlayers = await runQuery(
        pid,
        'players',
        [{ field: 'parentIds', op: 'ARRAY_CONTAINS', value: parentUid }],
        sa,
        50,
      );
      const stillTied = otherPlayers.some((p: any) => {
        if (p.id === playerId) return false;
        const otherTeams: string[] = Array.isArray(p.data?.teamIds)
          ? p.data.teamIds
          : (p.data?.teamId ? [p.data.teamId] : []);
        return otherTeams.includes(teamId);
      });
      if (!stillTied) {
        await commitDocumentTransforms(
          pid,
          `users/${parentUid}`,
          [{ fieldPath: 'teamIds', kind: 'arrayRemove', value: teamId }],
          null,
          sa,
        );
        // Reconcile parent's claims after teamIds arrayRemove so a
        // subsequent LIST doesn't overreport the removed team.
        refreshClaimsForUid(parentUid, pid, sa);
      }
    } catch (err) {
      console.warn('[unshare-player] parent trim failed:', (err as Error).message);
    }
  }
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /users/set-widget-player — user picks the kid the widget shows.
// Caller must be a parent of the target player, or the player IS the
// caller (adult self-claim).
// ────────────────────────────────────────────────────────────────
async function handleUsersSetWidgetPlayer(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  const playerId = String(payload?.playerId || '');
  if (!playerId) return json({ ok: false, error: 'player_id_required' }, 400);
  const playerDoc = await getDocument(pid, `players/${playerId}`, sa).catch(() => null);
  if (!playerDoc?.data) return json({ ok: false, error: 'player_not_found' }, 404);
  const parentIds: string[] = Array.isArray(playerDoc.data.parentIds) ? playerDoc.data.parentIds : [];
  const userDoc = await getDocument(pid, `users/${claims.uid}`, sa).catch(() => null);
  const isSelf = userDoc?.data?.selfPlayerId === playerId;
  if (!parentIds.includes(claims.uid) && !isSelf) {
    return json({ ok: false, error: 'not_authorized' }, 403);
  }
  await patchDocument(pid, `users/${claims.uid}`, { widgetPlayerId: playerId }, sa);
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /club/set-admin — club owner adds an admin uid to clubs/{id}.
// Also stamps user.isClubAdmin so Firestore rules unlock the
// per-club admin surfaces for them. Owner-only.
// ────────────────────────────────────────────────────────────────
async function handleClubSetAdmin(req: Request, env: Env, payload: any): Promise<Response> {
  const clubId = String(payload?.clubId || '');
  await requireClubAdmin(req, env, clubId);  // ownerUid + adminUids gate
  const { pid, sa } = projectAndSA(env);
  const targetUid = String(payload?.targetUid || '');
  if (!targetUid) return json({ ok: false, error: 'target_uid_required' }, 400);
  const scopes: string[] = Array.isArray(payload?.adminScopes) ? payload.adminScopes.slice(0, 20) : [];

  await commitDocumentTransforms(
    pid,
    `clubs/${clubId}`,
    [{ fieldPath: 'adminUids', kind: 'arrayUnion', value: targetUid }],
    scopes.length > 0 ? { [`adminScopes.${targetUid}`]: scopes } : null,
    sa,
  );
  // Stamp clubIds arrayUnion so the target's TeamContext picks up
  // the club scope. Explicitly do NOT set user.isClubAdmin here —
  // that field is the platform-admin bypass in firestore.rules
  // (line 26, "Platform admin bypasses everything") and is intended
  // to be granted manually to Patrick only. Setting it here was a
  // /clubs/create → /club/set-admin(self) privilege-escalation chain
  // that let any signed-up user become platform admin. Legitimate
  // club-admin scope is granted via role='club_admin' (from the
  // /clubs/create "not a coach" flow) plus clubs.adminUids
  // membership; both are checked by requireClubAdmin.
  await commitDocumentTransforms(
    pid,
    `users/${targetUid}`,
    [{ fieldPath: 'clubIds', kind: 'arrayUnion', value: clubId }],
    null,
    sa,
  );
  // Reconcile target's custom claims — clubIds grew.
  refreshClaimsForUid(targetUid, pid, sa);
  return json({ ok: true });
}

async function handleClubRemoveAdmin(req: Request, env: Env, payload: any): Promise<Response> {
  const clubId = String(payload?.clubId || '');
  await requireClubAdmin(req, env, clubId);
  const { pid, sa } = projectAndSA(env);
  const targetUid = String(payload?.targetUid || '');
  if (!targetUid) return json({ ok: false, error: 'target_uid_required' }, 400);
  await commitDocumentTransforms(
    pid,
    `clubs/${clubId}`,
    [{ fieldPath: 'adminUids', kind: 'arrayRemove', value: targetUid }],
    null,
    sa,
  );
  // Don't strip user.isClubAdmin — the user may still admin other
  // clubs. Client-side scope check gates each surface.
  await commitDocumentTransforms(
    pid,
    `users/${targetUid}`,
    [{ fieldPath: 'clubIds', kind: 'arrayRemove', value: clubId }],
    null,
    sa,
  );
  // Reconcile target's custom claims — clubIds shrank.
  refreshClaimsForUid(targetUid, pid, sa);
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /users/set-self-role — a signed-in user changes their OWN role
// between coach and parent. Safety net for anyone who got
// misassigned during signup (either through the pre-3.9.156
// email-match auto-flip, or a stray tap on the wrong landing
// button). Only touches the caller's own user doc; can only flip
// between the two user-selectable roles; never grants elevated
// scopes (isClubAdmin, team_manager, etc.).
//
// Body: { role: 'coach' | 'parent' }
// ────────────────────────────────────────────────────────────────
async function handleUsersSetSelfRole(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const nextRole = payload?.role === 'coach' ? 'coach' : payload?.role === 'parent' ? 'parent' : null;
  if (!nextRole) return json({ ok: false, error: 'role_must_be_coach_or_parent' }, 400);
  const { pid, sa } = projectAndSA(env);
  const current = await getDocument(pid, `users/${claims.uid}`, sa).catch(() => null);
  if (!current?.data) return json({ ok: false, error: 'user_not_found' }, 404);
  // SELF-PROMOTION GUARD: only allow role changes that DEMOTE — a
  // coach can flip themselves to parent, but a parent can NOT flip
  // themselves to coach through this path. Otherwise a parent on
  // any team could gain read access to parent_whispers +
  // form_submissions for every kid on that team via the
  // callerCanReadWhisper / callerCanReadFormSubmission rules that
  // trust isCoachRole() as a proxy for "coach on the team."
  // Parent → coach requires an admin action (or the user starting
  // a fresh team via /teams/create which stamps them on team.coachIds
  // properly).
  const currentRole = current.data.role || null;
  if (currentRole === 'parent' && nextRole === 'coach') {
    return json({
      ok: false,
      error: 'self_promotion_blocked',
      hint: 'A parent cannot promote themselves to coach. Ask an admin, or start a new team from the landing screen — that path is the correct one for taking on a coach role.',
    }, 403);
  }
  const patch: Record<string, any> = { role: nextRole, updatedAt: new Date() };
  if (nextRole === 'parent') {
    patch.coachLevel = null;
  }
  await patchDocument(pid, `users/${claims.uid}`, patch, sa);

  // Coach → parent demotion: clean up team.coachIds so the user no
  // longer appears in the roster of any team they coached. Without
  // this, requireCoachOfTeam continued to succeed for them despite
  // their public role='parent' — a stale-membership bug the audit
  // caught 2026-07-10. Only fires on demotion; parent→coach path
  // above is blocked entirely.
  if (currentRole === 'coach' && nextRole === 'parent') {
    const teamIds: string[] = Array.isArray(current.data.teamIds) ? current.data.teamIds : [];
    for (const tid of teamIds) {
      if (!tid) continue;
      try {
        const team = await getDocument(pid, `teams/${tid}`, sa).catch(() => null);
        if (!team?.data) continue;
        const coachIds: string[] = Array.isArray(team.data.coachIds) ? team.data.coachIds : [];
        const assistantIds: string[] = Array.isArray(team.data.assistantCoachIds) ? team.data.assistantCoachIds : [];
        const managerIds: string[] = Array.isArray(team.data.managerIds) ? team.data.managerIds : [];
        const teamTransforms: any[] = [];
        if (coachIds.includes(claims.uid)) {
          teamTransforms.push({ fieldPath: 'coachIds', kind: 'arrayRemove', value: claims.uid });
        }
        if (assistantIds.includes(claims.uid)) {
          teamTransforms.push({ fieldPath: 'assistantCoachIds', kind: 'arrayRemove', value: claims.uid });
        }
        if (managerIds.includes(claims.uid)) {
          teamTransforms.push({ fieldPath: 'managerIds', kind: 'arrayRemove', value: claims.uid });
        }
        // Also clear headCoachId if they were the head. Team is now
        // orphaned head-coach-wise; another coach must take over via
        // /teams/transfer-head-coach.
        const teamPatch: Record<string, any> = {};
        if (team.data.headCoachId === claims.uid) {
          teamPatch.headCoachId = null;
        }
        if (teamTransforms.length > 0 || Object.keys(teamPatch).length > 0) {
          await commitDocumentTransforms(
            pid,
            `teams/${tid}`,
            teamTransforms,
            Object.keys(teamPatch).length ? teamPatch : null,
            sa,
          );
        }
      } catch (err) {
        console.warn('[setSelfRole] team cleanup failed for', tid, (err as Error).message);
      }
    }
  }

  // Phase A: role changed → stage may need to move between
  // needs_team ↔ needs_player.
  await stampStage(claims.uid, pid, sa);

  return json({ ok: true, role: nextRole });
}

// ────────────────────────────────────────────────────────────────
// /users/set-role — coach changes another user's role in the
// Parent Directory (parent ↔ coach). Requires caller to be a coach
// on a team the target user shares.
// ────────────────────────────────────────────────────────────────
async function handleUsersSetRole(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  const claims = await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const targetUid = String(payload?.targetUid || '');
  const nextRole = payload?.role === 'coach' ? 'coach' : 'parent';
  if (!targetUid) return json({ ok: false, error: 'target_uid_required' }, 400);
  const target = await getDocument(pid, `users/${targetUid}`, sa).catch(() => null);
  if (!target?.data) return json({ ok: false, error: 'target_not_found' }, 404);
  const targetTeams: string[] = Array.isArray(target.data.teamIds) ? target.data.teamIds : [];
  if (!targetTeams.includes(teamId)) {
    return json({ ok: false, error: 'target_not_on_team' }, 403);
  }
  // Head-coach protection: refuse to change the head coach's role
  // unless the caller is the head themselves. Otherwise an assistant
  // could demote the head to parent. Also never auto-set approved
  // when target's global role is 'club_admin' (director path).
  const teamDoc = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  const currentHeadId = String(teamDoc?.data?.headCoachId || '');
  if (targetUid === currentHeadId && claims.uid !== currentHeadId) {
    return json({
      ok: false,
      error: 'cannot_change_head_role',
      message: 'Only the head coach can change their own role. Transfer head first.',
    }, 403);
  }
  if (target.data.role === 'club_admin') {
    return json({ ok: false, error: 'cannot_change_club_admin_role' }, 403);
  }
  const patch: Record<string, any> = { role: nextRole };
  if (nextRole === 'coach') patch.coachLevel = 'assistant';
  await patchDocument(pid, `users/${targetUid}`, patch, sa);
  // If promoting to coach, also add to team.coachIds.
  if (nextRole === 'coach') {
    await commitDocumentTransforms(
      pid,
      `teams/${teamId}`,
      [{ fieldPath: 'coachIds', kind: 'arrayUnion', value: targetUid }],
      null,
      sa,
    );
  } else {
    await commitDocumentTransforms(
      pid,
      `teams/${teamId}`,
      [{ fieldPath: 'coachIds', kind: 'arrayRemove', value: targetUid }],
      null,
      sa,
    );
  }

  // Phase A: TARGET user role changed → restamp their stage.
  await stampStageFor(targetUid, pid, sa);

  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /users/approve — coach approves a pending user (parent) on their
// team. Also flips approvalStatus.
// Body: { teamId, targetUid }
// ────────────────────────────────────────────────────────────────
async function handleUsersApprove(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const targetUid = String(payload?.targetUid || '');
  if (!targetUid) return json({ ok: false, error: 'target_uid_required' }, 400);
  const target = await getDocument(pid, `users/${targetUid}`, sa).catch(() => null);
  if (!target?.data) return json({ ok: false, error: 'target_not_found' }, 404);
  const targetTeams: string[] = Array.isArray(target.data.teamIds) ? target.data.teamIds : [];
  if (!targetTeams.includes(teamId)) {
    return json({ ok: false, error: 'target_not_on_team' }, 403);
  }
  await patchDocument(
    pid,
    `users/${targetUid}`,
    { approved: true, approvalStatus: 'coach-approved', approvedAt: new Date() },
    sa,
  );

  // Phase A: approved parent → stage moves from pending_parent to
  // either active (if any player links exist) or needs_player.
  await stampStageFor(targetUid, pid, sa);

  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /users/deactivate — coach removes / suspends a user on their team.
// Body: { teamId, targetUid, reject?: boolean }  reject=true also
// flips approved:false (post-reject state); default just deactivates.
// ────────────────────────────────────────────────────────────────
async function handleUsersDeactivate(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  const claims = await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const targetUid = String(payload?.targetUid || '');
  if (!targetUid) return json({ ok: false, error: 'target_uid_required' }, 400);
  const target = await getDocument(pid, `users/${targetUid}`, sa).catch(() => null);
  if (!target?.data) return json({ ok: false, error: 'target_not_found' }, 404);
  const targetTeams: string[] = Array.isArray(target.data.teamIds) ? target.data.teamIds : [];
  if (!targetTeams.includes(teamId)) {
    return json({ ok: false, error: 'target_not_on_team' }, 403);
  }
  // Head-coach protection: an assistant cannot deactivate the head
  // coach. The head must transfer first, then deactivate themselves
  // (which is a self-op and always allowed).
  const teamDoc = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  const currentHeadId = String(teamDoc?.data?.headCoachId || '');
  if (targetUid === currentHeadId && claims.uid !== currentHeadId) {
    return json({
      ok: false,
      error: 'cannot_deactivate_head',
      message: 'Only the head coach can deactivate themselves. Transfer head first.',
    }, 403);
  }
  const patch: Record<string, any> = { isActive: false };
  if (payload?.reject === true) patch.approved = false;
  await patchDocument(pid, `users/${targetUid}`, patch, sa);
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /teams/transfer-head-coach — head coach transfers to another
// coach already on the team. Updates team.headCoachId,
// team.assistantCoachIds (moves old head into assistants), and both
// users' coachLevel.
// Body: { teamId, newHeadCoachUid }
// ────────────────────────────────────────────────────────────────
async function handleTeamsTransferHead(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  const claims = await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const newHead = String(payload?.newHeadCoachUid || '');
  if (!newHead) return json({ ok: false, error: 'new_head_required' }, 400);
  const team = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  if (!team?.data) return json({ ok: false, error: 'team_not_found' }, 404);
  const teamData: any = team.data;
  const coachIds: string[] = Array.isArray(teamData.coachIds) ? teamData.coachIds : [];
  if (!coachIds.includes(newHead)) {
    return json({ ok: false, error: 'new_head_not_on_team' }, 400);
  }
  const oldHead = String(teamData.headCoachId || claims.uid);
  const assistants: string[] = Array.isArray(teamData.assistantCoachIds) ? teamData.assistantCoachIds : [];
  const nextAssistants = assistants.filter(u => u !== newHead);
  if (oldHead && oldHead !== newHead && !nextAssistants.includes(oldHead)) {
    nextAssistants.push(oldHead);
  }
  await patchDocument(
    pid,
    `teams/${teamId}`,
    { headCoachId: newHead, assistantCoachIds: nextAssistants, updatedAt: new Date() },
    sa,
  );
  await patchDocument(pid, `users/${newHead}`, { coachLevel: 'head_coach', updatedAt: new Date() }, sa);
  if (oldHead && oldHead !== newHead) {
    await patchDocument(pid, `users/${oldHead}`, { coachLevel: 'assistant_coach', updatedAt: new Date() }, sa);
  }
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /teams/set-staff-permissions — head coach adjusts per-staff
// permission map. Only the head coach on the team can call this;
// they can set arbitrary keys for any assistant / manager on the
// team. Absent uid = fall back to role defaults (client-side helper
// takes care of that).
//
// Body: { teamId, staffUid, permissions: { [key]: boolean } }
//
// Only the keys listed in the ALLOWED set are written; anything
// else is ignored (a rogue client can't invent new permission keys).
// ────────────────────────────────────────────────────────────────
const ALLOWED_STAFF_PERMISSION_KEYS = new Set<string>([
  'gameday', 'planPractice', 'manageRoster', 'uploadDrills', 'postMedia',
  'manageSchedule', 'chat', 'viewDues', 'deletePlayers',
]);

async function handleTeamsSetStaffPermissions(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  if (!teamId) return json({ ok: false, error: 'team_id_required' }, 400);
  const staffUid = String(payload?.staffUid || '');
  if (!staffUid) return json({ ok: false, error: 'staff_uid_required' }, 400);
  const permissions = payload?.permissions;
  if (!permissions || typeof permissions !== 'object') {
    return json({ ok: false, error: 'permissions_object_required' }, 400);
  }

  const claims = await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const team = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  if (!team?.data) return json({ ok: false, error: 'team_not_found' }, 404);

  // Only the head coach can rewrite staff permissions. Assistants
  // and managers can't grant themselves new capabilities.
  const headCoachId = String(team.data.headCoachId || '');
  if (headCoachId && headCoachId !== claims.uid) {
    return json({ ok: false, error: 'not_head_coach' }, 403);
  }

  // Filter to allowed keys with boolean values only.
  const filtered: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(permissions)) {
    if (!ALLOWED_STAFF_PERMISSION_KEYS.has(k)) continue;
    if (typeof v !== 'boolean') continue;
    filtered[k] = v;
  }
  if (Object.keys(filtered).length === 0) {
    return json({ ok: false, error: 'no_valid_permissions' }, 400);
  }

  // Merge with existing overrides so we don't clobber keys the
  // caller didn't send.
  const existing: Record<string, Record<string, boolean>> = (team.data.staffPermissions as any) || {};
  const nextForUid = { ...(existing[staffUid] || {}), ...filtered };
  const nextMap = { ...existing, [staffUid]: nextForUid };

  await patchDocument(
    pid,
    `teams/${teamId}`,
    { staffPermissions: nextMap, updatedAt: new Date() },
    sa,
  );
  return json({ ok: true, effective: nextForUid });
}

// ────────────────────────────────────────────────────────────────
// /teams/set-staff-role — head coach adds or moves a user between
// assistant coach and team manager, or removes them from staff.
// Body: { teamId, staffUid, role: 'assistant' | 'manager' | 'remove' }
//
// Manages assistantCoachIds + managerIds atomically. Won't touch
// headCoachId (that transfer is a separate flow).
// ────────────────────────────────────────────────────────────────
async function handleTeamsSetStaffRole(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  if (!teamId) return json({ ok: false, error: 'team_id_required' }, 400);
  const staffUid = String(payload?.staffUid || '');
  if (!staffUid) return json({ ok: false, error: 'staff_uid_required' }, 400);
  const role = String(payload?.role || '');
  if (!['assistant', 'manager', 'remove'].includes(role)) {
    return json({ ok: false, error: 'invalid_role', valid: ['assistant', 'manager', 'remove'] }, 400);
  }

  const claims = await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const team = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  if (!team?.data) return json({ ok: false, error: 'team_not_found' }, 404);
  const headCoachId = String(team.data.headCoachId || '');
  if (headCoachId && headCoachId !== claims.uid) {
    return json({ ok: false, error: 'not_head_coach' }, 403);
  }
  if (staffUid === headCoachId) {
    return json({ ok: false, error: 'cannot_move_head_coach', hint: 'Use the head-coach transfer flow.' }, 400);
  }

  const assistants: string[] = Array.isArray(team.data.assistantCoachIds) ? team.data.assistantCoachIds : [];
  const managers: string[] = Array.isArray(team.data.managerIds) ? team.data.managerIds : [];
  const coachIds: string[] = Array.isArray(team.data.coachIds) ? team.data.coachIds : [];

  const nextAssistants = new Set(assistants.filter(u => u !== staffUid));
  const nextManagers = new Set(managers.filter(u => u !== staffUid));
  const nextCoachIds = new Set(coachIds.filter(u => u !== staffUid));

  if (role === 'assistant') {
    nextAssistants.add(staffUid);
    nextCoachIds.add(staffUid);
  } else if (role === 'manager') {
    nextManagers.add(staffUid);
    // Managers don't sit in coachIds — coachIds is coach-only for
    // gate checks like "is this person a coach on the team" that
    // exclude managers by definition.
  }
  // 'remove' just leaves them out of all three sets.

  await patchDocument(
    pid,
    `teams/${teamId}`,
    {
      assistantCoachIds: [...nextAssistants],
      managerIds: [...nextManagers],
      coachIds: [...nextCoachIds],
      updatedAt: new Date(),
    },
    sa,
  );

  // Sync teamIds on the user side. Add when they join, remove when
  // they leave the whole team (i.e., role='remove' AND they weren't
  // already in headCoachId, which we already refused above).
  const userTeamsPath = `users/${staffUid}`;
  const userDoc = await getDocument(pid, userTeamsPath, sa).catch(() => null);
  const userTeamIds: string[] = Array.isArray(userDoc?.data?.teamIds) ? userDoc.data.teamIds : [];
  if (role === 'remove') {
    if (userTeamIds.includes(teamId)) {
      await commitDocumentTransforms(
        pid, userTeamsPath,
        [{ fieldPath: 'teamIds', kind: 'arrayRemove', value: teamId }],
        null, sa,
      );
      refreshClaimsForUid(staffUid, pid, sa);
    }
  } else {
    if (!userTeamIds.includes(teamId)) {
      await commitDocumentTransforms(
        pid, userTeamsPath,
        [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: teamId }],
        null, sa,
      );
      refreshClaimsForUid(staffUid, pid, sa);
    }
  }

  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /teams/archive + /teams/restore — soft-delete / undelete.
// Body: { teamId }
//
// Accepts EITHER a coach on the team OR a club admin whose club
// owns the team. The second path unblocks directors/registrars who
// aren't coaching but need to retire teams (e.g., end-of-season
// cleanup, coach left the platform).
// ────────────────────────────────────────────────────────────────
async function requireCoachOrClubAdminOfTeam(
  req: Request,
  env: Env,
  teamId: string,
): Promise<void> {
  try {
    await requireCoachOfTeam(req, env, teamId);
    return;
  } catch (err: any) {
    // Only fall through to the club-admin path on the specific
    // "not_coach_of_team" branch. Missing team, bad token, etc.
    // should keep their original error.
    if (err?.code !== 'not_coach_of_team' && err?.status !== 403) throw err;
  }
  const { pid, sa } = projectAndSA(env);
  const team = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  const clubId = team?.data?.clubId as string | undefined;
  if (!clubId) {
    // Team has no club → no club-admin fallback. Surface the same
    // AuthError shape the coach path would have produced so the
    // outer catch renders the correct 403 body.
    throw new AuthError('not_coach_of_team', 403);
  }
  await requireClubAdmin(req, env, clubId);
}

async function handleTeamsArchive(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  if (!teamId) return json({ ok: false, error: 'team_id_required' }, 400);
  await requireCoachOrClubAdminOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  await patchDocument(pid, `teams/${teamId}`, { isActive: false, archivedAt: new Date() }, sa);
  return json({ ok: true });
}
async function handleTeamsRestore(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  if (!teamId) return json({ ok: false, error: 'team_id_required' }, 400);
  await requireCoachOrClubAdminOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  await patchDocument(pid, `teams/${teamId}`, { isActive: true, archivedAt: null }, sa);
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /players/create — coach adds a new player to their team.
// Body: { teamId, name, dateOfBirth?, jerseyNumber?, positions?[],
//         parentEmails?[], isAdultPlayer?, ... }
// ────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────
// /events/batch-create — write N events in one call. Used by the
// onboarding wizard to materialize the auto-generated practice
// schedule. Client-side event creates are blocked for pre-trial
// coaches by the canCoachWrite() trial wall; this endpoint bypasses
// the wall via the service account, but still verifies the caller
// is a coach on the target team.
//
// Body: { teamId, events: Array<{ title, type, date, endDate, location }> }
// Response: { ok: true, created: number, ids: string[] }
// ────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────
// /events/rsvp — atomic RSVP with cap enforcement + waitlist auto-
// promotion. Enables the adult-pickup use case ("first 20 confirmed,
// rest waitlist"). Client for uncapped youth events still uses the
// cheap dotted-path client write; this handler is called only when
// event.rsvpCap is set.
//
// Race handling: uses commitDocumentTransforms with an updateTime
// precondition so simultaneous RSVPs at 60-adult scale don't lose
// updates. Retries up to 3× on PreconditionFailedError.
//
// Body: { eventId, status: 'going'|'maybe'|'no', name, role? }
//
// Response: { ok, waitlisted, waitlistPosition?, promoted? }
// ────────────────────────────────────────────────────────────────
async function handleEventsRsvp(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  const eventId = String(payload?.eventId || '');
  const status = String(payload?.status || '');
  const name = String(payload?.name || claims.email || 'Unknown').slice(0, 100);
  const role = payload?.role ? String(payload.role).slice(0, 20) : undefined;
  if (!eventId) return json({ ok: false, error: 'event_id_required' }, 400);
  if (!['going', 'maybe', 'no'].includes(status)) {
    return json({ ok: false, error: 'invalid_status' }, 400);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const ev = await getDocument(pid, `events/${eventId}`, sa).catch(() => null);
    if (!ev?.data) return json({ ok: false, error: 'event_not_found' }, 404);
    const data: any = ev.data;
    const rsvpCap: number | undefined = typeof data.rsvpCap === 'number' && data.rsvpCap > 0
      ? Math.floor(data.rsvpCap)
      : undefined;
    const rsvps: Record<string, any> = data.rsvps && typeof data.rsvps === 'object' ? { ...data.rsvps } : {};
    const waitlist: Array<any> = Array.isArray(data.waitlist) ? [...data.waitlist] : [];

    const prevStatus = rsvps[claims.uid]?.status;
    const now = new Date();

    // Remove self from waitlist first — any state change requires
    // re-inserting or promoting them.
    const filteredWaitlist = waitlist.filter((w: any) => w?.uid !== claims.uid);

    // Count going, excluding self so a re-tap on going doesn't
    // self-block against the cap.
    const goingCount = Object.entries(rsvps)
      .filter(([uid, r]: [string, any]) => uid !== claims.uid && r?.status === 'going')
      .length;

    let waitlistPosition: number | undefined;
    let promoted: { uid: string; name: string } | undefined;

    if (status === 'going' && rsvpCap && goingCount >= rsvpCap) {
      // Cap already reached — waitlist this user, clear any prior
      // rsvps entry so they don't double-count.
      delete rsvps[claims.uid];
      filteredWaitlist.push({ uid: claims.uid, name, role, addedAt: now });
      waitlistPosition = filteredWaitlist.length;
    } else {
      rsvps[claims.uid] = { status, name, ...(role ? { role } : {}), respondedAt: now };
      // If the caller was previously 'going' and just released the
      // slot, promote the first waitlisted person.
      if (prevStatus === 'going' && status !== 'going' && filteredWaitlist.length > 0) {
        const head = filteredWaitlist.shift();
        if (head?.uid) {
          rsvps[head.uid] = {
            status: 'going',
            name: head.name,
            ...(head.role ? { role: head.role } : {}),
            respondedAt: now,
            promotedFromWaitlist: true,
          };
          promoted = { uid: head.uid, name: head.name };
        }
      }
    }

    try {
      await commitDocumentTransforms(
        pid,
        `events/${eventId}`,
        [],
        { rsvps, waitlist: filteredWaitlist, updatedAt: now },
        sa,
        ev.updateTime ? { updateTime: ev.updateTime } : undefined,
      );
      return json({
        ok: true,
        waitlisted: waitlistPosition !== undefined,
        waitlistPosition,
        promoted,
      });
    } catch (err) {
      if (err instanceof PreconditionFailedError && attempt < 2) {
        continue; // read + retry
      }
      throw err;
    }
  }
  return json({ ok: false, error: 'contention', message: 'Too many concurrent RSVPs — please try again.' }, 409);
}

// ────────────────────────────────────────────────────────────────
// /events/mark-paid — coach toggles paid state for an attendee on an
// event with feeCents > 0. Two shapes:
//   { eventId, uid, paid }       → adult attendee, writes paidByCoach
//   { eventId, playerId, paid }  → roster kid, writes paidByCoachPlayerIds
// Coexists with paidUids (Stripe path); display truth is the union
// of paidUids ∪ paidByCoach ∪ paidByCoachPlayerIds. Idempotent:
// setting the same state is a no-op returning 200. Kids are marked
// by playerId so two siblings sharing a parent uid don't contaminate
// each other.
// ────────────────────────────────────────────────────────────────
async function handleEventsMarkPaid(req: Request, env: Env, payload: any): Promise<Response> {
  const eventId = String(payload?.eventId || '').trim();
  const targetUid = String(payload?.uid || '').trim();
  const targetPlayerId = String(payload?.playerId || '').trim();
  const paid = payload?.paid !== false; // default true so a bare call marks paid
  if (!eventId) return json({ ok: false, error: 'event_id_required' }, 400);
  if (!targetUid && !targetPlayerId) return json({ ok: false, error: 'uid_or_player_id_required' }, 400);

  const { pid, sa } = projectAndSA(env);
  const ev = await getDocument(pid, `events/${eventId}`, sa).catch(() => null);
  if (!ev?.data) return json({ ok: false, error: 'event_not_found' }, 404);
  const teamId = String(ev.data.teamId || '');
  if (!teamId) return json({ ok: false, error: 'event_missing_team' }, 400);

  // Coach-of-team check — reuses the standard scope helper so the
  // authorization surface matches every other coach-only write.
  const claims = await requireCoachOfTeam(req, env, teamId);

  const feeCents = Number(ev.data.feeCents || 0);
  if (feeCents <= 0) {
    return json({ ok: false, error: 'no_fee_set', hint: 'Set a drop-in fee on the event before marking anyone paid.' }, 400);
  }

  const existingUids: string[] = Array.isArray(ev.data.paidByCoach) ? ev.data.paidByCoach.filter((v: any) => typeof v === 'string') : [];
  const existingPids: string[] = Array.isArray(ev.data.paidByCoachPlayerIds) ? ev.data.paidByCoachPlayerIds.filter((v: any) => typeof v === 'string') : [];
  const uidSet = new Set(existingUids);
  const pidSet = new Set(existingPids);
  const beforeUid = uidSet.size;
  const beforePid = pidSet.size;

  if (targetPlayerId) {
    if (paid) pidSet.add(targetPlayerId);
    else pidSet.delete(targetPlayerId);
  } else {
    if (paid) uidSet.add(targetUid);
    else uidSet.delete(targetUid);
  }
  const nextUids = Array.from(uidSet);
  const nextPids = Array.from(pidSet);
  const changed = uidSet.size !== beforeUid || pidSet.size !== beforePid;

  // Idempotent — same state, no write.
  if (!changed) {
    return json({ ok: true, paidByCoach: nextUids, paidByCoachPlayerIds: nextPids, noop: true });
  }

  const patch: Record<string, any> = { updatedAt: new Date() };
  if (targetPlayerId) patch.paidByCoachPlayerIds = nextPids;
  else patch.paidByCoach = nextUids;
  await patchDocument(pid, `events/${eventId}`, patch, sa);

  // Best-effort audit trail — non-blocking on failure. Mirrors the
  // eventActivity shape used elsewhere in the app for coach actions.
  trackBackground((async () => {
    try {
      await createDocument(pid, `events/${eventId}/eventActivity`, {
        action: 'markPaid',
        by: claims.uid,
        target: targetPlayerId || targetUid,
        targetKind: targetPlayerId ? 'playerId' : 'uid',
        paid,
        at: new Date(),
      }, sa);
    } catch (e) {
      console.warn('events/mark-paid audit write failed', e);
    }
  })());

  return json({ ok: true, paidByCoach: nextUids, paidByCoachPlayerIds: nextPids });
}

// ────────────────────────────────────────────────────────────────
// /clubs/personal-create-if-missing — standalone-coach auto-club.
// The first time a coach without a clubId turns on feeCents on an
// event, the EventForm save path fires this to spin up a personal
// club shell at clubs/personal_{coachUid} and stamp it as
// team.clubId so downstream Stripe Connect + platform-fee reads
// have a doc to land on.
//
// Body: { teamId }
// Idempotent by construction: deterministic doc id + team.clubId
// patch is a set that converges. Concurrent double-fires safely
// no-op.
// ────────────────────────────────────────────────────────────────
async function handleClubsPersonalCreateIfMissing(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '').trim();
  if (!teamId) return json({ ok: false, error: 'team_id_required' }, 400);
  const claims = await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);

  const clubId = `personal_${claims.uid}`;
  const team = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  if (!team?.data) return json({ ok: false, error: 'team_not_found' }, 404);
  const existingClubId = String(team.data.clubId || '');
  if (existingClubId) {
    // Team is already club-attached — do nothing. This is the common
    // case for club-owned adult teams; the endpoint is safe to call
    // opportunistically without checking client-side.
    return json({ ok: true, clubId: existingClubId, created: false });
  }

  // Load coach name for the personal-club name. Fall back to a neutral
  // "My Team" if the user doc is missing — always writable later.
  const user = await getDocument(pid, `users/${claims.uid}`, sa).catch(() => null);
  const coachName = String(user?.data?.name || claims.email?.split('@')[0] || 'My').trim() || 'My';

  // Try to create the personal club at the deterministic id. If it
  // already exists (concurrent fire, prior aborted flow, whatever),
  // swallow AlreadyExistsError and move on to the team patch.
  try {
    await createDocument(pid, 'clubs', {
      name: `${coachName}'s Team`,
      ownerUid: claims.uid,
      adminUids: [],
      teamIds: [teamId],
      isActive: true,
      isDefaultSoloClub: true,
      createdAt: new Date(),
      createdBy: claims.uid,
    }, sa, clubId);
  } catch (err) {
    if (!(err instanceof AlreadyExistsError)) {
      throw err;
    }
    // Existing personal club — fine.
  }

  await patchDocument(pid, `teams/${teamId}`, { clubId }, sa);

  // Stamp the personal clubId onto the user so isClubAdmin() opens
  // /club for them and Stripe Connect setup is reachable. arrayUnion
  // is idempotent — safe to re-fire on subsequent teams.
  try {
    await commitDocumentTransforms(
      pid,
      `users/${claims.uid}`,
      [{ fieldPath: 'clubIds', kind: 'arrayUnion', value: clubId }],
      null,
      sa,
    );
  } catch (err) {
    console.warn('[personal-club] user.clubIds arrayUnion failed', err);
  }

  return json({ ok: true, clubId, created: true });
}

// ────────────────────────────────────────────────────────────────
// League endpoints — thin wrappers around worker/src/leagues.ts
// helpers. All league writes go through here so admin-scope
// (adminUids / ownerUid) is enforced server-side. Public reads of
// leagues + fixtures + standings are Firestore-rule-scoped (see
// firestore.rules).
// ────────────────────────────────────────────────────────────────
async function handleLeaguesCreate(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  try {
    const out = await createLeague(pid, sa, claims.uid, payload);
    return json({ ok: true, ...out });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err).slice(0, 100) }, 400);
  }
}

async function handleLeaguesFixtureCreate(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  try {
    const out = await createFixture(pid, sa, claims.uid, payload);
    return json({ ok: true, ...out });
  } catch (err: any) {
    const code = String(err?.message || 'error').slice(0, 100);
    const status = code === 'not_league_admin' ? 403 : code === 'league_not_found' ? 404 : 400;
    return json({ ok: false, error: code }, status);
  }
}

async function handleLeaguesReportScore(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  try {
    const out = await reportFixtureScore(pid, sa, claims.uid, payload);
    return json({ ok: true, standings: out.standings });
  } catch (err: any) {
    const code = String(err?.message || 'error').slice(0, 100);
    const status = code === 'not_league_admin' ? 403 : code === 'fixture_not_found' ? 404 : 400;
    return json({ ok: false, error: code }, status);
  }
}

async function handleLeaguesRecompute(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  const leagueId = String(payload?.leagueId || '');
  if (!leagueId) return json({ ok: false, error: 'league_id_required' }, 400);
  const league = await getDocument(pid, `leagues/${leagueId}`, sa).catch(() => null);
  if (!league?.data) return json({ ok: false, error: 'league_not_found' }, 404);
  const admins: string[] = Array.isArray(league.data.adminUids) ? league.data.adminUids : [];
  if (!admins.includes(claims.uid) && String(league.data.ownerUid || '') !== claims.uid) {
    return json({ ok: false, error: 'not_league_admin' }, 403);
  }
  const standings = await recomputeStandings(pid, leagueId, sa);
  return json({ ok: true, standings });
}

async function handleEventsBatchCreate(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  const claims = await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const events: any[] = Array.isArray(payload?.events) ? payload.events.slice(0, 100) : [];
  if (events.length === 0) return json({ ok: true, created: 0, ids: [] });
  const ids: string[] = [];
  for (const ev of events) {
    const dateMs = Number(ev?.dateMs);
    const endMs = Number(ev?.endMs);
    if (!isFinite(dateMs) || !isFinite(endMs)) continue;
    const fields: Record<string, any> = {
      title: String(ev?.title || 'Practice').slice(0, 120),
      type: ev?.type === 'game' ? 'game' : 'practice',
      date: new Date(dateMs),
      endDate: new Date(endMs),
      location: String(ev?.location || '').slice(0, 200),
      teamId,
      createdBy: claims.uid,
      createdByName: String(ev?.createdByName || '').slice(0, 80) || 'Coach',
      createdAt: new Date(),
      isActive: true,
    };
    // Geocoded location (from the Onboarding wizard's address
    // autocomplete or EventForm's location picker). Stamped so
    // iOS/Android calendar subscribers can open the practice in
    // Maps with the real pin, not just a field name.
    const locationAddress = String(ev?.locationAddress || '').slice(0, 300);
    if (locationAddress) fields.locationAddress = locationAddress;
    const coords: any = ev?.locationCoords;
    if (coords && typeof coords.lat === 'number' && typeof coords.lon === 'number') {
      fields.locationCoords = { lat: coords.lat, lon: coords.lon };
    }
    try {
      const id = await createDocument(pid, 'events', fields, sa);
      ids.push(id);
    } catch (err) {
      // Skip individual failures; a whole-batch abort would strand
      // the coach in the wizard with no way to retry cleanly.
      console.warn('batch event create failed', err);
    }
  }
  return json({ ok: true, created: ids.length, ids });
}

// ════════════════════════════════════════════════════════════════
// /register/submit — cold + returning family registration.
// ════════════════════════════════════════════════════════════════
//
// Owned server-side because the two writes it makes (Player create
// + Registration create) both target collections with strict
// per-doc rules that no cold-signup parent can satisfy from the
// client:
//   - players create rule: canCoachWrite() && onTeam(teamId)
//     A parent isn't on any team yet, so cold submits 403 every
//     time (Register.tsx:401 pre-refactor).
//   - registrations rule: post-2026-07-10 tightening will require
//     the caller's email be on the parentEmails denorm array;
//     that denorm didn't exist client-side.
//
// This endpoint atomically:
//   1. Creates or updates a Player doc (teamId:null, parentIds:[uid],
//      parentEmails from the parents[] payload, medical, clubId,
//      registrationSeasonId).
//   2. Creates a Registration doc with everything the admin timeline
//      needs, PLUS a parentEmails: string[] denorm for the tightened
//      rule.
//   3. Stamps player.funnelProgress.register so the FunnelStepper
//      visualizes the kid past the first hurdle from day one.
//
// Idempotency: if the client retries after a network drop, pass
// idempotencyKey (any stable string) and we look up an existing
// registration with that key on the same clubId; if found, we
// return its ids without re-creating.
// ────────────────────────────────────────────────────────────────
async function handleRegisterSubmit(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);

  const clubId = String(payload?.clubId || '');
  const seasonId = String(payload?.seasonId || '');
  if (!clubId) return json({ ok: false, error: 'club_id_required' }, 400);
  if (!seasonId) return json({ ok: false, error: 'season_id_required' }, 400);

  const season = await getDocument(pid, `seasons/${seasonId}`, sa).catch(() => null);
  if (!season?.data) return json({ ok: false, error: 'season_not_found' }, 404);
  if ((season.data as any).registrationOpen !== true) {
    return json({ ok: false, error: 'registration_closed' }, 409);
  }

  const p: any = payload?.player || {};
  const firstName = String(p.firstName || '').trim().slice(0, 60);
  const lastName = String(p.lastName || '').trim().slice(0, 60);
  const name = `${firstName} ${lastName}`.trim();
  if (!name) return json({ ok: false, error: 'player_name_required' }, 400);

  const parentsRaw = Array.isArray(payload?.parents) ? payload.parents : [];
  const parents = parentsRaw
    .filter((x: any) => x?.firstName && x?.email)
    .slice(0, 4)
    .map((x: any) => ({
      firstName: String(x.firstName).trim().slice(0, 60),
      lastName: String(x.lastName || '').trim().slice(0, 60),
      email: normEmail(x.email),
      phone: String(x.phone || '').trim().slice(0, 30) || undefined,
      relationship: String(x.relationship || 'parent').slice(0, 30),
    }));
  if (parents.length === 0) return json({ ok: false, error: 'parents_required' }, 400);

  const parentEmails: string[] = Array.from(new Set(
    parents.map((p: { email: string }) => p.email).filter(Boolean).concat(claims.email ? [normEmail(claims.email)] : [])
  ));

  // Idempotency guard: check for an existing registration keyed to
  // the same (clubId, uid, seasonId, idempotencyKey) tuple.
  const idempotencyKey = String(payload?.idempotencyKey || '').slice(0, 80);
  if (idempotencyKey) {
    try {
      const existing = await runQuery(
        pid,
        'registrations',
        [
          { field: 'clubId', op: 'EQUAL', value: clubId },
          { field: 'idempotencyKey', op: 'EQUAL', value: idempotencyKey },
          { field: 'createdByUid', op: 'EQUAL', value: claims.uid },
        ],
        sa,
        1,
      );
      if (existing.length > 0) {
        const doc: any = existing[0];
        return json({
          ok: true,
          idempotent: true,
          registrationId: doc.id,
          playerId: doc.data?.playerId || null,
        });
      }
    } catch (err) {
      console.warn('[register] idempotency lookup failed, proceeding:', (err as Error).message);
    }
  }

  const returnPlayerId = String(payload?.returnPlayerId || '');
  let playerId = returnPlayerId;
  const now = new Date();

  if (returnPlayerId) {
    // Returning family — attach the current parent's uid + email to
    // the existing player without clobbering the roster's teamIds or
    // other coach-side fields.
    const playerTransforms: any[] = [
      { fieldPath: 'parentIds', kind: 'arrayUnion', value: claims.uid },
    ];
    if (parentEmails.length > 0) {
      playerTransforms.push({ fieldPath: 'parentEmails', kind: 'arrayUnion', value: parentEmails });
    }
    await commitDocumentTransforms(pid, `players/${returnPlayerId}`, playerTransforms, {
      registrationSeasonId: seasonId,
      isActive: true,
    }, sa);
  } else {
    const playerFields: Record<string, any> = {
      name,
      firstName,
      lastName,
      teamId: null,
      teamIds: [],
      clubId,
      parentIds: [claims.uid],
      parentEmails,
      isActive: true,
      registrationSeasonId: seasonId,
      createdAt: now,
      createdBy: claims.uid,
    };
    if (p.dateOfBirth) playerFields.dateOfBirth = String(p.dateOfBirth);
    if (p.gender) playerFields.gender = String(p.gender).slice(0, 20);
    if (p.preferredPosition) playerFields.position = String(p.preferredPosition).slice(0, 40);
    if (p.medicalNotes) playerFields.medicalInfo = String(p.medicalNotes).slice(0, 2000);
    if (p.ageGroup) playerFields.ageGroup = String(p.ageGroup).slice(0, 20);
    playerId = await createDocument(pid, 'players', playerFields, sa);
  }

  const regFields: Record<string, any> = {
    clubId,
    seasonId,
    playerId,
    player: {
      firstName,
      lastName,
      dateOfBirth: p.dateOfBirth || undefined,
      gender: p.gender || undefined,
      preferredPosition: p.preferredPosition || undefined,
      playedBefore: p.playedBefore || undefined,
      ageGroup: p.ageGroup || undefined,
      medicalNotes: p.medicalNotes || undefined,
      jerseySizeRequested: p.jerseySizeRequested || undefined,
    },
    parents,
    parentEmails,
    status: (payload?.status === 'pending_review' ? 'pending_review' : 'pending_payment'),
    productId: payload?.productId || undefined,
    productName: payload?.productName || undefined,
    pricingTierId: payload?.pricingTierId || undefined,
    pricingTierLabel: payload?.pricingTierLabel || undefined,
    registrationFeeCents: Number.isFinite(payload?.registrationFeeCents) ? payload.registrationFeeCents : undefined,
    couponCode: payload?.couponCode || undefined,
    couponDiscountCents: Number.isFinite(payload?.couponDiscountCents) ? payload.couponDiscountCents : undefined,
    amountPaidCents: Number.isFinite(payload?.amountPaidCents) ? payload.amountPaidCents : undefined,
    stripeSurchargeCents: Number.isFinite(payload?.stripeSurchargeCents) ? payload.stripeSurchargeCents : undefined,
    earlyBirdApplied: payload?.earlyBirdApplied === true,
    customAnswers: payload?.customAnswers || undefined,
    customAnswerLabels: payload?.customAnswerLabels || undefined,
    source: returnPlayerId ? 'returning' : 'cold',
    promotedToPlayerId: playerId,
    createdAt: now,
    createdByUid: claims.uid,
  };
  if (idempotencyKey) regFields.idempotencyKey = idempotencyKey;

  const registrationId = await createDocument(pid, 'registrations', regFields, sa);

  // Funnel stage 1 — auto-write the 'register' checkpoint.
  try {
    await patchDocument(pid, `players/${playerId}`, {
      'funnelProgress.register': {
        completedAt: now,
        by: 'system',
        meta: { registrationId, seasonId },
      },
    }, sa);
  } catch (err) {
    console.warn('[register] funnel stamp failed (non-fatal):', (err as Error).message);
  }

  return json({ ok: true, registrationId, playerId });
}

async function handlePlayersCreate(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  const claims = await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const name = String(payload?.name || '').slice(0, 100).trim();
  if (!name) return json({ ok: false, error: 'name_required' }, 400);
  const team = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  const clubId = team?.data?.clubId ? String(team.data.clubId) : '';
  const parentEmails: string[] = Array.isArray(payload?.parentEmails)
    ? payload.parentEmails.map((e: any) => normEmail(e)).filter(Boolean)
    : [];
  // linkSelfAsParent: onboarding wizard case where the coach is
  // adding their own kid. Skips the two-call dance (create then
  // toggle-self-parent) that had a silent-failure mode — either call
  // could fail and the wizard would advance without the link. Now
  // parentIds is stamped in the same write as the player create.
  const linkSelfAsParent = payload?.linkSelfAsParent === true;
  const parentIds: string[] = linkSelfAsParent ? [claims.uid] : [];
  if (linkSelfAsParent && claims.email) {
    const callerEmail = normEmail(claims.email);
    if (callerEmail && !parentEmails.includes(callerEmail)) parentEmails.push(callerEmail);
  }
  const fields: Record<string, any> = {
    name,
    teamId,
    teamIds: [teamId],
    parentIds,
    parentEmails,
    isActive: true,
    createdAt: new Date(),
    createdBy: claims.uid,
  };
  if (clubId) fields.clubId = clubId;
  if (payload?.dateOfBirth) fields.dateOfBirth = String(payload.dateOfBirth);
  if (typeof payload?.jerseyNumber === 'number') fields.jerseyNumber = payload.jerseyNumber;
  if (Array.isArray(payload?.positions)) fields.positions = payload.positions.slice(0, 5);
  if (payload?.isAdultPlayer === true) fields.isAdultPlayer = true;
  // Guest player fields — tournament / trial / call-up path. Missing
  // == false everywhere; only stamp when the coach explicitly toggled.
  // expiresAt is parsed from YYYY-MM-DD (native <input type="date">)
  // into UTC-noon of that calendar day, same convention as DOB storage
  // (see src/utils/dobDate.ts), so isGuestActive() comparisons don't
  // shift by a day for Denver users.
  if (payload?.isGuest === true) {
    fields.isGuest = true;
    const raw = payload?.guestExpiresAt;
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const [y, m, d] = raw.split('-').map(n => parseInt(n, 10));
      if (y && m && d) fields.expiresAt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    }
    if (typeof payload?.guestReason === 'string' && payload.guestReason.trim()) {
      fields.guestReason = String(payload.guestReason).slice(0, 80);
    }
  }
  const playerId = await createDocument(pid, 'players', fields, sa);
  await commitDocumentTransforms(
    pid,
    `teams/${teamId}`,
    [{ fieldPath: 'playerIds', kind: 'arrayUnion', value: playerId }],
    null,
    sa,
  );
  // Adult wedge bug fix (audit 2026-07-11): the linkSelfAsParent path
  // was writing player.parentIds but NEVER touching the caller's user
  // doc. Coach ended up on the roster in Firestore, but
  // resolveSenderRole still returned 'coach' because user.selfPlayerId
  // was empty. Adult-player-flavored UI (chat sender labeling,
  // dashboard "you're on the roster" copy) never fired. Fix: also
  // stamp user.selfPlayerId + user.teamIds arrayUnion + user.children
  // arrayUnion in the same handler so the roster row is coherent from
  // both sides.
  if (linkSelfAsParent) {
    const userTransforms: any[] = [
      { fieldPath: 'children', kind: 'arrayUnion', value: playerId },
      { fieldPath: 'teamIds', kind: 'arrayUnion', value: teamId },
    ];
    const userPatch: Record<string, any> = {};
    if (payload?.isAdultPlayer === true) userPatch.selfPlayerId = playerId;
    await commitDocumentTransforms(
      pid,
      `users/${claims.uid}`,
      userTransforms,
      Object.keys(userPatch).length > 0 ? userPatch : null,
      sa,
    );
    // Refresh claims so token.teamIds picks up the new team and the
    // client's next LIST doesn't 403 on the just-created roster.
    refreshClaimsForUid(claims.uid, pid, sa);
    // Stage may flip active if this was the caller's only player link.
    await stampStage(claims.uid, pid, sa);
  }
  return json({ ok: true, playerId, linkedSelfAsParent: linkSelfAsParent });
}

// ────────────────────────────────────────────────────────────────
// /players/set-kid-mode — parent (or coach) toggles kid profile
// mode on a player. Kid mode is UI-only: no separate Firebase Auth
// user, no rules changes; the parent's uid stays the actor. This
// endpoint just persists the enabled flag + PIN hash on the player
// doc so all devices see the same config.
//
// Rules block the client from writing player.kidMode directly, so
// this endpoint is the one write path.
//
// Auth (enable, disable, set-pin): caller must be in player.parentIds
// OR a coach on any of player.teamIds.
//
// Body: { playerId, action: 'enable' | 'disable' | 'set-pin', pinHash? }
//   - enable + pinHash → flip enabled=true, store hash
//   - disable → flip enabled=false, clear hash (parent forgot PIN =
//     nuclear reset, since they own the player)
//   - set-pin + pinHash → rotate hash without touching enabled
// ────────────────────────────────────────────────────────────────
async function handlePlayersSetKidMode(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  const playerId = String(payload?.playerId || '');
  const action = String(payload?.action || '');
  const pinHash = typeof payload?.pinHash === 'string' ? payload.pinHash : '';
  if (!playerId) return json({ ok: false, error: 'player_id_required' }, 400);
  if (!['enable', 'disable', 'set-pin'].includes(action)) {
    return json({ ok: false, error: 'invalid_action' }, 400);
  }
  if ((action === 'enable' || action === 'set-pin') && !/^[0-9a-f]{64}$/.test(pinHash)) {
    return json({ ok: false, error: 'invalid_pin_hash' }, 400);
  }

  const player = await getDocument(pid, `players/${playerId}`, sa).catch(() => null);
  if (!player?.data) return json({ ok: false, error: 'player_not_found' }, 404);

  const parentIds: string[] = Array.isArray(player.data.parentIds) ? player.data.parentIds : [];
  const playerTeamIds: string[] = Array.isArray(player.data.teamIds) && player.data.teamIds.length > 0
    ? player.data.teamIds
    : (player.data.teamId ? [player.data.teamId] : []);
  const isParent = parentIds.includes(claims.uid);
  let isCoach = false;
  if (!isParent && playerTeamIds.length > 0) {
    for (const teamId of playerTeamIds) {
      const team = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
      const coachIds: string[] = Array.isArray(team?.data?.coachIds) ? team.data.coachIds : [];
      if (coachIds.includes(claims.uid)) { isCoach = true; break; }
    }
  }
  if (!isParent && !isCoach) {
    return json({ ok: false, error: 'not_authorized' }, 403);
  }

  const now = new Date();
  const patch: Record<string, any> = { updatedAt: now };
  if (action === 'enable') {
    patch.kidMode = {
      enabled: true,
      pinHash,
      enabledAt: now,
      enabledByUid: claims.uid,
    };
  } else if (action === 'disable') {
    // Nuclear reset — parent forgot PIN or wants kid mode off. Clear
    // both flag + hash so re-enable starts from scratch.
    patch.kidMode = { enabled: false, pinHash: null, enabledAt: null, enabledByUid: null };
  } else {
    // set-pin — rotate hash without touching the enabled flag. Merge
    // by reading current kidMode + only touching pinHash.
    const current = player.data.kidMode || {};
    patch.kidMode = {
      enabled: current.enabled === true,
      pinHash,
      enabledAt: current.enabledAt || now,
      enabledByUid: current.enabledByUid || claims.uid,
    };
  }
  await patchDocument(pid, `players/${playerId}`, patch, sa);
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /players/set-active — soft-delete / restore a player.
// Body: { teamId, playerId, isActive }
// ────────────────────────────────────────────────────────────────
async function handlePlayersSetActive(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const playerId = String(payload?.playerId || '');
  if (!playerId) return json({ ok: false, error: 'player_id_required' }, 400);
  const patch: Record<string, any> = {
    isActive: payload?.isActive === true,
    updatedAt: new Date(),
  };
  if (payload?.isActive === false) patch.deletedAt = new Date();
  else patch.deletedAt = null;
  await patchDocument(pid, `players/${playerId}`, patch, sa);
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /players/promote-guest — flip a guest player into a permanent
// squad member. Clears isGuest / expiresAt / guestReason. Stats,
// media, invites, XP, badges — all preserved. The guest's parent
// (via existing invite claim) also keeps their team access, which is
// the intended outcome: the tournament ringer sticks around.
//
// Auth: coach-of-team on any team the player is on.
// Body:  { teamId, playerId }
// ────────────────────────────────────────────────────────────────
async function handlePlayersPromoteGuest(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const playerId = String(payload?.playerId || '');
  if (!playerId) return json({ ok: false, error: 'player_id_required' }, 400);
  const player = await getDocument(pid, `players/${playerId}`, sa).catch(() => null);
  if (!player?.data) return json({ ok: false, error: 'player_not_found' }, 404);
  // Defense-in-depth: verify the target player is actually on the team
  // whose coach is calling. requireCoachOfTeam(teamId) above proves the
  // caller is a coach of teamId; this check proves the player belongs
  // to that team, so a rogue coach can't promote a guest on some other
  // team by supplying their own teamId.
  const pTeamIds: string[] = Array.isArray(player.data.teamIds) && player.data.teamIds.length > 0
    ? player.data.teamIds
    : (player.data.teamId ? [player.data.teamId] : []);
  if (!pTeamIds.includes(teamId)) {
    return json({ ok: false, error: 'player_not_on_team' }, 403);
  }
  const patch: Record<string, any> = {
    isGuest: false,
    expiresAt: null,
    guestReason: null,
    updatedAt: new Date(),
  };
  await patchDocument(pid, `players/${playerId}`, patch, sa);
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /players/link-parent — coach adds a parent (uid + email) to a
// player on their team. Auto-fans out user.teamIds too.
// Body: { teamId, playerId, parentUid, parentEmail? }
// ────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────
// /players/stamp-funnel — stamp a funnelProgress.{key} entry on a
// player from a coach who isn't necessarily on that player's team.
//
// Use case: SendOfferModal writes funnelProgress.offer_sent to a
// player in the same CLUB but on a different team. The coach isn't
// on the target player's team.coachIds so a client updateDoc 403s
// against the players.update rule (parent-branch blocks funnel
// mutations; coach-branch requires onTeam(player.teamId)).
//
// Auth: caller must be in the same club as the player (compared via
// player.clubId in userDoc.clubIds), or platform admin.
//
// Body: { playerId, key: 'offer_sent' | 'tryouts' | ..., meta? }
// ────────────────────────────────────────────────────────────────
async function handlePlayersStampFunnel(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  const playerId = String(payload?.playerId || '');
  const key = String(payload?.key || '');
  if (!playerId) return json({ ok: false, error: 'player_id_required' }, 400);
  const ALLOWED_KEYS = new Set([
    'register', 'tryouts', 'offer_sent', 'offer_accept',
    'external_league', 'club_dues',
  ]);
  if (!ALLOWED_KEYS.has(key)) return json({ ok: false, error: 'invalid_stage_key' }, 400);

  const [player, user] = await Promise.all([
    getDocument(pid, `players/${playerId}`, sa).catch(() => null),
    getDocument(pid, `users/${claims.uid}`, sa).catch(() => null),
  ]);
  if (!player?.data) return json({ ok: false, error: 'player_not_found' }, 404);
  const playerClubId: string = player.data.clubId ? String(player.data.clubId) : '';
  const callerClubIds: string[] = Array.isArray(user?.data?.clubIds) ? user.data.clubIds : [];
  const isPlatformAdmin = user?.data?.isClubAdmin === true;
  if (!isPlatformAdmin && (!playerClubId || !callerClubIds.includes(playerClubId))) {
    return json({ ok: false, error: 'not_authorized' }, 403);
  }

  const now = new Date();
  const meta = payload?.meta && typeof payload.meta === 'object' ? payload.meta : {};
  // Restrict meta to a small allowlist so a caller can't stuff
  // arbitrary bytes onto the player doc via this endpoint.
  const cleanMeta: Record<string, any> = {};
  for (const k of ['offerId', 'teamId', 'teamName', 'registrationId', 'seasonId', 'note']) {
    if (meta[k] !== undefined && meta[k] !== null) {
      const v = meta[k];
      if (typeof v === 'string') cleanMeta[k] = v.slice(0, 200);
      else if (typeof v === 'number' && Number.isFinite(v)) cleanMeta[k] = v;
    }
  }
  await patchDocument(pid, `players/${playerId}`, {
    [`funnelProgress.${key}`]: {
      completedAt: now,
      by: claims.uid,
      meta: cleanMeta,
    },
  }, sa);
  return json({ ok: true });
}

async function handlePlayersLinkParent(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const playerId = String(payload?.playerId || '');
  const parentUid = String(payload?.parentUid || '');
  if (!playerId || !parentUid) return json({ ok: false, error: 'ids_required' }, 400);

  // Consent gate (audit 2026-07-10): the target uid MUST exist as a
  // real user AND its email MUST already be on the player's
  // parentEmails. Without this, a coach could pass any uid — random
  // uid from another club, a support account, a personal alt — and
  // silently attach them as a parent + fan the coach's team onto
  // the victim's user.teamIds. The player.parentEmails membership
  // check acts as "the coach already added this email to the player,
  // so linking the uid behind that email is the intended action".
  const targetUser = await getDocument(pid, `users/${parentUid}`, sa).catch(() => null);
  if (!targetUser?.data) {
    return json({ ok: false, error: 'target_user_not_found' }, 404);
  }
  const player = await getDocument(pid, `players/${playerId}`, sa).catch(() => null);
  if (!player?.data) {
    return json({ ok: false, error: 'player_not_found' }, 404);
  }
  const targetEmail = targetUser.data?.email ? normEmail(targetUser.data.email) : '';
  const playerEmails: string[] = Array.isArray(player.data?.parentEmails)
    ? player.data.parentEmails.map(normEmail)
    : [];
  if (!targetEmail || !playerEmails.includes(targetEmail)) {
    return json({
      ok: false,
      error: 'consent_missing',
      message: "Add the parent's email to this player first — that's what signals they should be linked.",
    }, 403);
  }
  const parentEmail = payload?.parentEmail ? normEmail(payload.parentEmail) : targetEmail;
  const transforms: any[] = [{ fieldPath: 'parentIds', kind: 'arrayUnion', value: parentUid }];
  if (parentEmail) transforms.push({ fieldPath: 'parentEmails', kind: 'arrayUnion', value: parentEmail });
  await commitDocumentTransforms(pid, `players/${playerId}`, transforms, null, sa);
  // Fan the team onto the parent's user.teamIds so they can see the team.
  await commitDocumentTransforms(
    pid,
    `users/${parentUid}`,
    [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: teamId }],
    null,
    sa,
  );

  // Phase A: linked parent just got a team + a player link → active.
  await stampStageFor(parentUid, pid, sa);

  // Reconcile parent's custom claims so their next Firestore read
  // sees the new team in token.teamIds.
  refreshClaimsForUid(parentUid, pid, sa);

  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /players/toggle-self-parent — parent (or adult self) adds or
// removes themselves from a player's parentIds. Used by the Settings
// "Claim a player" widget, the Player Circle card, and now the
// player edit modal "This player is my kid" toggle.
//
// Authorization (on=true):
//   - Caller is already a parent → allow (no-op re-add is fine)
//   - Caller's email matches one of the player's parentEmails → allow
//   - Caller is a coach on ANY of the player's teams → allow (a coach
//     claiming their own kid on their own team is the common case;
//     they already have full write access to the player, so this
//     doesn't expand what they can do — it just doesn't force them
//     to add their own email to parentEmails first as a papercut)
//
// On success we also:
//   - arrayUnion the caller's email onto parentEmails (so future
//     signups from the same address auto-link cleanly and the Circle
//     UI shows them by email)
//   - arrayUnion each of the player's teamIds onto the user's
//     teamIds (so they see the team in the switcher)
//
// Authorization (on=false): only the caller themselves. That's not
// a security question — anyone who's ever been linked can unlink.
//
// Body: { playerId, on: boolean }
// ────────────────────────────────────────────────────────────────
async function handlePlayersToggleSelfParent(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  const playerId = String(payload?.playerId || '');
  const on = payload?.on === true;
  if (!playerId) return json({ ok: false, error: 'player_id_required' }, 400);
  const player = await getDocument(pid, `players/${playerId}`, sa).catch(() => null);
  if (!player?.data) return json({ ok: false, error: 'player_not_found' }, 404);
  const parentIds: string[] = Array.isArray(player.data.parentIds) ? player.data.parentIds : [];
  const parentEmails: string[] = Array.isArray(player.data.parentEmails)
    ? player.data.parentEmails.map(normEmail) : [];
  const playerTeamIds: string[] = Array.isArray(player.data.teamIds) && player.data.teamIds.length > 0
    ? player.data.teamIds
    : (player.data.teamId ? [player.data.teamId] : []);
  const isCurrentParent = parentIds.includes(claims.uid);
  const emailMatches = !!claims.email && parentEmails.includes(normEmail(claims.email));

  // Coach-of-team fallback: caller is a coach on the player's team.
  // Only compute if the two cheap checks above didn't already pass.
  let isCoachOnPlayerTeam = false;
  if (on && !emailMatches && !isCurrentParent && playerTeamIds.length > 0) {
    for (const teamId of playerTeamIds) {
      const team = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
      const coachIds: string[] = Array.isArray(team?.data?.coachIds) ? team.data.coachIds : [];
      if (coachIds.includes(claims.uid)) { isCoachOnPlayerTeam = true; break; }
    }
  }

  if (on && !emailMatches && !isCurrentParent && !isCoachOnPlayerTeam) {
    return json({ ok: false, error: 'not_authorized' }, 403);
  }
  if (!on && !isCurrentParent) {
    return json({ ok: true, noop: true });  // already off
  }

  const playerTransforms: any[] = [
    { fieldPath: 'parentIds', kind: on ? 'arrayUnion' : 'arrayRemove', value: claims.uid },
  ];
  // On claim, mirror the caller's email into parentEmails so the
  // Circle UI can display them by email and future re-bootstraps
  // auto-link. Skip if the email is already there.
  if (on && claims.email && !parentEmails.includes(normEmail(claims.email))) {
    playerTransforms.push({ fieldPath: 'parentEmails', kind: 'arrayUnion', value: normEmail(claims.email) });
  }
  await commitDocumentTransforms(pid, `players/${playerId}`, playerTransforms, null, sa);

  // On claim, fan the player's teams onto the user so they see the
  // team in the switcher. On unclaim, leave user.teamIds alone —
  // they might still be a coach on it, and yanking it here would
  // hide the team from a coach who was just cleaning up a mis-link.
  //
  // Also stamp user.selfPlayerId when the target player is an adult
  // (audit 2026-07-11: prior shape only touched parentIds so the
  // downstream helpers.isAdultPlayer(user) check kept returning false
  // for adults who self-claimed via this endpoint — the flag never
  // propagated to the user side). Off-path clears selfPlayerId
  // when the caller is unlinking their own adult self-player.
  const userTransforms: any[] = [];
  const userPatch: Record<string, any> = {};
  if (on && playerTeamIds.length > 0) {
    userTransforms.push({ fieldPath: 'teamIds', kind: 'arrayUnion', value: playerTeamIds });
  }
  if (on && player.data.isAdultPlayer === true) {
    userPatch.selfPlayerId = playerId;
    userTransforms.push({ fieldPath: 'children', kind: 'arrayUnion', value: playerId });
  } else if (!on && player.data.isAdultPlayer === true) {
    // Firestore rules block clients from writing selfPlayerId, but
    // this handler uses the service account so it can clear.
    userPatch.selfPlayerId = null;
  }
  if (userTransforms.length > 0 || Object.keys(userPatch).length > 0) {
    await commitDocumentTransforms(
      pid,
      `users/${claims.uid}`,
      userTransforms,
      Object.keys(userPatch).length > 0 ? userPatch : null,
      sa,
    );
  }

  // Phase A: self-parent toggle → recompute stage. `on` fans
  // parentIds + teams (goes active). `off` removes parentIds only —
  // still recompute in case this was their only link.
  await stampStage(claims.uid, pid, sa);

  // Reconcile caller's claims — teamIds grew (on) or unchanged (off).
  // Always call so the client's next getIdToken(true) sees fresh
  // claims either way.
  refreshClaimsForUid(claims.uid, pid, sa);

  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /players/set-teams — bulk assign a player to a set of teams. Used
// by People page bulk-assign + TransferPlayerModal + edit modal.
// Body: { playerId, teamIds }  (destructive set, not diff)
// Caller must coach EVERY team being added and every team being
// removed (safety) — worker checks both sides.
// ────────────────────────────────────────────────────────────────
async function handlePlayersSetTeams(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  const playerId = String(payload?.playerId || '');
  const newTeamIds: string[] = Array.isArray(payload?.teamIds)
    ? payload.teamIds.filter((t: any) => typeof t === 'string' && t)
    : [];
  if (!playerId) return json({ ok: false, error: 'player_id_required' }, 400);
  const player = await getDocument(pid, `players/${playerId}`, sa).catch(() => null);
  if (!player?.data) return json({ ok: false, error: 'player_not_found' }, 404);
  const oldTeamIds: string[] = Array.isArray(player.data.teamIds)
    ? player.data.teamIds
    : (player.data.teamId ? [player.data.teamId] : []);
  const added = newTeamIds.filter(t => !oldTeamIds.includes(t));
  const removed = oldTeamIds.filter(t => !newTeamIds.includes(t));
  // Caller must coach every team on either side of the diff.
  for (const t of [...added, ...removed]) {
    await requireCoachOfTeam(req, env, t);
  }
  const patch: Record<string, any> = {
    teamIds: newTeamIds,
    teamId: newTeamIds[0] || '',
    updatedAt: new Date(),
  };
  await patchDocument(pid, `players/${playerId}`, patch, sa);
  // Fan out to teams and parents.
  const parentIds: string[] = Array.isArray(player.data.parentIds) ? player.data.parentIds : [];
  for (const t of added) {
    await commitDocumentTransforms(
      pid, `teams/${t}`,
      [{ fieldPath: 'playerIds', kind: 'arrayUnion', value: playerId }],
      null, sa,
    ).catch(() => undefined);
    for (const parentUid of parentIds) {
      await commitDocumentTransforms(
        pid, `users/${parentUid}`,
        [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: t }],
        null, sa,
      ).catch(() => undefined);
    }
  }
  for (const t of removed) {
    await commitDocumentTransforms(
      pid, `teams/${t}`,
      [{ fieldPath: 'playerIds', kind: 'arrayRemove', value: playerId }],
      null, sa,
    ).catch(() => undefined);
    // Only trim parent's teamIds if no OTHER player of theirs ties
    // them to this team. Reuses the logic from /teams/unshare-player.
    for (const parentUid of parentIds) {
      const otherPlayers = await runQuery(
        pid, 'players',
        [{ field: 'parentIds', op: 'ARRAY_CONTAINS', value: parentUid }],
        sa, 50,
      ).catch(() => []);
      const stillTied = otherPlayers.some((p: any) => {
        if (p.id === playerId) return false;
        const teams: string[] = Array.isArray(p.data?.teamIds)
          ? p.data.teamIds
          : (p.data?.teamId ? [p.data.teamId] : []);
        return teams.includes(t);
      });
      if (!stillTied) {
        await commitDocumentTransforms(
          pid, `users/${parentUid}`,
          [{ fieldPath: 'teamIds', kind: 'arrayRemove', value: t }],
          null, sa,
        ).catch(() => undefined);
      }
    }
  }
  // Reconcile claims for every parent whose teamIds changed. Fires
  // once per parent regardless of add/remove — cheap module-registry
  // push, actual round-trip runs under ctx.waitUntil after response.
  if (added.length > 0 || removed.length > 0) {
    for (const parentUid of parentIds) refreshClaimsForUid(parentUid, pid, sa);
  }
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /users/set-teams — bulk assign a STAFF user (coach/team_manager)
// to a set of teams. Used by People page staff editor + bulk-assign.
// Body: { targetUid, teamIds }  (destructive set)
// Caller must coach every team on either side of the diff.
// ────────────────────────────────────────────────────────────────
async function handleUsersSetTeams(req: Request, env: Env, payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  const targetUid = String(payload?.targetUid || '');
  const newTeamIds: string[] = Array.isArray(payload?.teamIds)
    ? payload.teamIds.filter((t: any) => typeof t === 'string' && t)
    : [];
  if (!targetUid) return json({ ok: false, error: 'target_uid_required' }, 400);
  const target = await getDocument(pid, `users/${targetUid}`, sa).catch(() => null);
  if (!target?.data) return json({ ok: false, error: 'target_not_found' }, 404);
  const oldTeamIds: string[] = Array.isArray(target.data.teamIds)
    ? target.data.teamIds
    : (target.data.teamId ? [target.data.teamId] : []);
  const added = newTeamIds.filter(t => !oldTeamIds.includes(t));
  const removed = oldTeamIds.filter(t => !newTeamIds.includes(t));
  for (const t of [...added, ...removed]) {
    await requireCoachOfTeam(req, env, t);
  }
  // Also patch team.coachIds for added/removed if the target is a coach.
  const isCoach = target.data.role === 'coach' || target.data.role === 'team_manager';
  for (const t of added) {
    if (isCoach) {
      await commitDocumentTransforms(
        pid, `teams/${t}`,
        [{ fieldPath: 'coachIds', kind: 'arrayUnion', value: targetUid }],
        null, sa,
      ).catch(() => undefined);
    }
  }
  for (const t of removed) {
    if (isCoach) {
      await commitDocumentTransforms(
        pid, `teams/${t}`,
        [{ fieldPath: 'coachIds', kind: 'arrayRemove', value: targetUid }],
        null, sa,
      ).catch(() => undefined);
    }
  }
  await patchDocument(
    pid,
    `users/${targetUid}`,
    { teamIds: newTeamIds, teamId: newTeamIds[0] || '', updatedAt: new Date() },
    sa,
  );
  // Reconcile target's custom claims — teamIds was fully replaced.
  refreshClaimsForUid(targetUid, pid, sa);
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// onboardingStage — Spine refactor Phase A (3.9.161).
//
// Server-derived state machine that replaces the runtime Firestore
// parentIds query in AppLayout at src/App.tsx:159-230. The gate
// derivation used to run on every mount + burn a 3s timeout on
// mobile networks that stalled + flash the OnboardingGate for
// 200-800ms on every load. Now the worker stamps a single field
// on the user doc and the client reads it synchronously.
//
// Values (see onboarding-stage design §1):
//   'active'          — full app access. Has ≥1 team OR ≥1 linked
//                       player OR role === 'club_admin'.
//   'needs_team'      — coach/team_manager, teamIds empty.
//   'needs_player'    — parent, approved !== false, no player links.
//   'pending_parent'  — parent, approved === false (approval-gated).
//   undefined         — legacy user; client fallback covers it and
//                       lazy heal via /users/heal-team-membership
//                       lands one first-sign-in stamp.
//
// IMPORTANT: `active` means past onboarding, NOT authorized to
// write. All worker write guards must still check
// trial/subscription state independently
// (reference_onboarding_writes_are_worker).
export type OnboardingStage = 'active' | 'needs_team' | 'needs_player' | 'pending_parent';

/**
 * Compute the correct onboardingStage from a user doc's data.
 *
 * For parents we have to check whether any player has them on
 * `parentIds` — that's the one extra doc read this incurs, which is
 * fine because computeStage() runs on worker cold-path writes, not
 * on the client hot-path anymore.
 */
async function computeStage(
  userData: any,
  claimsUid: string,
  pid: string,
  sa: ServiceAccount,
): Promise<OnboardingStage> {
  const role = String(userData?.role || '');
  const teamIds: string[] = Array.isArray(userData?.teamIds) ? userData.teamIds : [];
  const hasTeam = teamIds.length > 0 || (typeof userData?.teamId === 'string' && userData.teamId.length > 0);
  if (role === 'club_admin' || userData?.isClubAdmin === true) return 'active';
  if (role === 'coach' || role === 'team_manager') return hasTeam ? 'active' : 'needs_team';
  if (role === 'parent') {
    if (userData?.approved === false) return 'pending_parent';
    // Existing parentIds lookup — the single query that moves off the
    // client hot path onto the worker cold path.
    try {
      const players = await runQuery(
        pid, 'players',
        [{ field: 'parentIds', op: 'ARRAY_CONTAINS', value: claimsUid }],
        sa, 1,
      );
      return players.length > 0 ? 'active' : 'needs_player';
    } catch {
      // Fail open — matches the legacy App.tsx:211 catch that
      // defaulted to gate-none rather than stranding the user.
      return 'active';
    }
  }
  // Unknown role (staff variants, admin-imports) — treat as active.
  return 'active';
}

/**
 * Convenience: recompute and patch `onboardingStage` on a user doc.
 * Only writes when the stored value differs (idempotent + cheap on
 * repeated calls). Callers use this from any endpoint that mutates
 * user.teamIds, players.parentIds, teams.coachIds, or user.role.
 */
async function stampStage(
  claimsUid: string,
  pid: string,
  sa: ServiceAccount,
): Promise<void> {
  try {
    const snap = await getDocument(pid, `users/${claimsUid}`, sa).catch(() => null);
    if (!snap?.data) return;
    const currentStage = snap.data?.onboardingStage;
    const nextStage = await computeStage(snap.data, claimsUid, pid, sa);
    if (currentStage !== nextStage) {
      await patchDocument(pid, `users/${claimsUid}`, { onboardingStage: nextStage }, sa);
    }
  } catch (err) {
    console.warn('[stampStage] non-fatal', (err as Error)?.message || err);
  }
}

/**
 * Same as stampStage but for a target uid other than the caller —
 * used by /teams/add-coach, /teams/share-player, and any endpoint
 * that grants membership to somebody else.
 */
async function stampStageFor(
  targetUid: string,
  pid: string,
  sa: ServiceAccount,
): Promise<void> {
  await stampStage(targetUid, pid, sa);
}

// ────────────────────────────────────────────────────────────────
// /users/heal-team-membership — sync user.teamIds with the truth in
// team.coachIds. Called on sign-in as a defense-in-depth measure:
// some coaches ended up on team.coachIds without a matching entry
// on user.teamIds (root cause TBD — possibly a lost arrayUnion in
// an early flow or a hand-edit), which lets them WRITE via the
// worker's requireCoachOfTeam (which honors team.coachIds) but 403s
// every READ (which only checked user.teamIds). See Nick Barker
// 2026-07-09: "you can add a kid and it is in firestore, but they
// disappear from the squad".
//
// Idempotent + safe to spam: only ADDS teamIds (no removes), only
// touches teams where the caller is genuinely on coachIds. No body.
// ────────────────────────────────────────────────────────────────
async function handleUsersHealTeamMembership(req: Request, env: Env, _payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  // Load user first — need role, teamId (legacy singular), teamIds
  // (canonical), clubIds for the heal set + diagnostic response.
  //
  // Phantom user guard (audit 2026-07-10): if the /users/{uid} doc
  // doesn't exist yet, we must NOT create one via arrayUnion patches
  // (Firestore commit with a transform+patch on a missing doc creates
  // it, leaving a fields-partial phantom user with no email / uid /
  // createdAt). The /users/bootstrap endpoint is the sole legitimate
  // create path; heal running before bootstrap indicates a client
  // race, not a real user. Return a soft 200 so the client's periodic
  // heal loop stops complaining without blocking downstream work.
  const currentUser = await getDocument(pid, `users/${claims.uid}`, sa).catch(() => null);
  if (!currentUser?.data) {
    return json({
      ok: true,
      status: 'user_doc_missing',
      hint: 'bootstrap the user doc first via /users/bootstrap',
    });
  }
  const legacyTeamId: string | null = typeof currentUser?.data?.teamId === 'string' && currentUser.data.teamId
    ? currentUser.data.teamId
    : null;
  const existing: string[] = Array.isArray(currentUser?.data?.teamIds) ? currentUser.data.teamIds : [];
  const role = currentUser?.data?.role || null;
  const clubIds = Array.isArray(currentUser?.data?.clubIds) ? currentUser.data.clubIds : [];

  // Find every team whose coachIds contains this uid. Firestore's
  // structured query supports array-contains on a single field.
  const coachTeams = await runQuery(pid, 'teams', [
    { field: 'coachIds', op: 'ARRAY_CONTAINS', value: claims.uid },
  ], sa, 200).catch(err => {
    console.warn('[heal] runQuery failed', err?.message || err);
    return [];
  });
  const coachTeamIds = coachTeams.map(t => t.id).filter(Boolean);

  // Union heal source: teams from coachIds discovery + legacy teamId
  // (some accounts have teamId singular but no teamIds — the AddPlayer
  // client rule and PlayerList subscription both check teamIds, so
  // failing to lift the legacy value silently strands them).
  const healSet = new Set<string>(coachTeamIds);
  if (legacyTeamId) healSet.add(legacyTeamId);
  const heal = Array.from(healSet);

  const toAdd = heal.filter(id => !existing.includes(id));
  if (toAdd.length > 0) {
    await commitDocumentTransforms(
      pid,
      `users/${claims.uid}`,
      [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: toAdd }],
      null,
      sa,
    );
  }

  // Spine refactor Phase A: after any teamIds mutation OR whenever
  // the user has no stamped onboardingStage yet, recompute + stamp
  // it. Lazy migration — every user backfills exactly once, exactly
  // when they need it. Also convergent under drift: if a worker
  // endpoint anywhere ever mutates membership without stamping stage,
  // the next sign-in through here corrects it silently.
  const finalTeamIds = toAdd.length > 0 ? [...existing, ...toAdd] : existing;
  const currentStage = currentUser?.data?.onboardingStage;
  const projectedUserData = { ...(currentUser?.data || {}), teamIds: finalTeamIds };
  const nextStage = await computeStage(projectedUserData, claims.uid, pid, sa);
  const stageChanged = currentStage !== nextStage;
  if (stageChanged) {
    try {
      await patchDocument(pid, `users/${claims.uid}`, { onboardingStage: nextStage }, sa);
    } catch (err) {
      console.warn('[heal] stampStage failed', (err as Error)?.message || err);
    }
  }

  // Custom claims: heal is also the natural place to reconcile the
  // JWT claim payload with the just-updated teamIds set. Fire-and-
  // forget — mutation stays committed if the Identity Toolkit call
  // fails (see refreshClaimsForUid comment).
  if (toAdd.length > 0) {
    refreshClaimsForUid(claims.uid, pid, sa);
  }

  return json({
    ok: true,
    added: toAdd,
    teamIds: finalTeamIds,
    foundTeams: coachTeamIds.length,
    legacyTeamId,
    role,
    clubIds,
    onboardingStage: nextStage,
    stageChanged,
  });
}

// ────────────────────────────────────────────────────────────────
// /users/refresh-claims — self-serve claim reconciliation. Client
// AuthContext fires this after every sign-in so token.clubIds and
// token.teamIds match Firestore state. Also correct target of a
// manual retry after a stale-claim 403.
//
// No payload required — target uid is always the caller.
// ────────────────────────────────────────────────────────────────
async function handleUsersRefreshClaims(req: Request, env: Env, _payload: any): Promise<Response> {
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);
  refreshClaimsForUid(claims.uid, pid, sa);
  return json({ ok: true });
}

// ════════════════════════════════════════════════════════════════
// XP + BADGES — Phase 1: coach recognition tokens
// ════════════════════════════════════════════════════════════════
//
// The whole system is opt-in per team via team.xpConfig.enabled.
// Coaches award a "recognition token" to a specific kid with a
// required short note ("crushed the defensive shape today"). Each
// award:
//   1. Writes an immutable player_xp_events audit doc.
//   2. Increments players/{id}.xp + xpCareer via commit-transform.
//   3. Awards the "coach_pick" badge on the first-ever recognition,
//      and bumps its `count` field on repeats (Coach's Pick × N).
//   4. Writes a parent_whispers doc so the note lands in the parents'
//      inbox alongside their existing whispers stream — no email or
//      push added in Phase 1 (avoid over-notification while we
//      validate the shape).
//
// Weekly cap enforced at the worker: at most 2 recognitions per kid
// per coach per Monday-Monday week (America/Denver, per the worker
// timezone memory). Cap is on the (coach, kid) pair so a big roster
// isn't rationed by a shared pool, but no kid can be spammed.
// ────────────────────────────────────────────────────────────────

// Whisper XP: fixed +50 per whisper. Decision 2026-07-13 (replaces
// the old /xp/award-recognition mechanic, which is deleted). Coach
// gets no amount slider on a whisper — the whole point is that a
// whisper is a "you leveled up" moment, uniformly emotional; no
// coach math while writing.
const WHISPER_XP = 50;

// Coach's Pick badge is now DERIVED: earned once when a player's
// cumulative coach-authored XP (coach_live grants + coach_whisper
// whispers + legacy coach_recognition events) crosses this
// threshold. No coach flag, no metric drift. Historical badges
// stamped by the old Recognize flow keep their earnedAt + count
// fields untouched.
const COACH_PICK_XP_THRESHOLD = 200;
// Includes kudos_coach_convert (2026-07-14) because a coach who
// promotes a Circle-member kudos to XP is authoring the recognition
// with the same intent as a whisper or live grant. Kudos → XP
// conversions count toward Coach's Pick.
const COACH_SOURCE_TYPES = ['coach_recognition', 'coach_live', 'coach_whisper', 'kudos_coach_convert'];

// Coach-live raw XP grant constants. Separate quota lane from
// coach_recognition: recognitions are warm whispered notes capped
// at 2/kid/week; coach_live is the tap-during-practice gesture
// bounded by a daily-XP ceiling so bulk grants ("winning team,
// +10 each") still fit inside a healthy cadence. All caps are
// per-player-per-calendar-day, America/Denver rolling.
//
// 2026-07-17 curve tune: tightened per-player daily ceiling from
// 500 to 200 to match the new XP curve (BASE=100 / GROWTH=1.40 in
// src/utils/xpLevel.ts). 200 XP is still roughly a full level jump
// on the new curve at mid-ladder (was ~2 levels on the old flatter
// curve), so a healthy practice can still move the needle without
// letting a single day compress the whole season arc.
const COACH_LIVE_XP_PER_PLAYER_PER_DAY = 200;
const COACH_LIVE_XP_MIN = 1;
// Single-grant ceiling matches the daily-per-player cap post-2026-07-17
// rebalance. Prior 500 ceiling was meaningless once the daily dropped to
// 200 — any 201-500 grant would pass single-value validation and then
// bounce off the daily cap with an opaque error. Keeping them equal so
// the "Amount must be 1-200 XP" message tells the truth end-to-end.
const COACH_LIVE_XP_MAX = 200;
const COACH_LIVE_PLAYERS_MAX = 40;
const COACH_LIVE_REASON_MIN = 1;
const COACH_LIVE_REASON_MAX = 80;
const COACH_LIVE_PRESETS_MAX = 20;

/** Midnight America/Denver of the given instant, as ms.
 *
 * Audit 2026-07-11: prior impl subtracted "Denver intra-day seconds"
 * from now.getTime(). Off by ±1h across a DST boundary. Fix: resolve
 * the concrete Denver UTC offset that applies at that calendar day
 * via a noon probe (unambiguous re: DST transitions) and reconstruct
 * Denver midnight as an absolute UTC millisecond. */
function startOfDayDenverMs(now = new Date()): number {
  const dateKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now); // en-CA → 'YYYY-MM-DD'
  const [y, m, d] = dateKey.split('-').map(n => parseInt(n, 10));
  const probeUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(probeUtc));
  const g = (t: string) => parseInt(parts.find(p => p.type === t)?.value || '0', 10);
  const denverAsIfUtc = Date.UTC(
    g('year'), g('month') - 1, g('day'),
    g('hour'), g('minute'), g('second'),
  );
  const offsetMs = denverAsIfUtc - probeUtc;
  return Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs;
}

/** Denver calendar-day key used as the rolling-counter sub-field on
 *  players/{id}.xpDailyGrantCount. Format 'dYYYYMMDD' so Firestore
 *  field-path syntax doesn't need escaping in transform paths. */
function dailyKeyDenver(now = new Date()): string {
  const dateKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  return 'd' + dateKey.replace(/-/g, '');
}

/** Best-effort delete of a player_xp_events audit doc to undo an
 *  orphan when the follow-up player transform failed. Worker's
 *  commitDocumentTransforms is single-doc so we can't wrap both
 *  writes in one commit. Rare double failure logs for offline
 *  reconciliation. */
async function deleteAuditEventBestEffort(
  eventId: string,
  pid: string,
  sa: ServiceAccount,
): Promise<void> {
  if (!eventId) return;
  try {
    const token = await getAccessToken(sa, 'https://www.googleapis.com/auth/datastore');
    const url = `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents/player_xp_events/${encodeURIComponent(eventId)}`;
    const r = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) console.warn('[xp] audit undo delete failed', eventId, r.status);
  } catch (err) {
    console.warn('[xp] audit undo delete threw', eventId, (err as Error).message);
  }
}

/** Monday 00:00 America/Denver as a millisecond timestamp. Windows
 *  reset weekly so a coach's quota rolls over at the start of the
 *  next practice week (matches the streak-Sunday-skip cadence).
 *  Denver rather than UTC per worker_timezone memory. */
function startOfWeekDenverMs(now = new Date()): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value || '';
  const y = parseInt(get('year'), 10);
  const m = parseInt(get('month'), 10);
  const d = parseInt(get('day'), 10);
  const dow = get('weekday'); // 'Mon','Tue',...
  const dowIdx = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(dow);
  // Days back to Monday. Mon=0, Sun=6, Sat=5, ...
  const backToMon = dowIdx === 0 ? 6 : dowIdx - 1;
  // Build a Date representing Monday of this week at midnight LOCAL
  // Denver. Simplest approach: compute from now, subtract days +
  // walk hours/minutes/seconds back to zero.
  const currentMinutes = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  const daysBackMs = backToMon * 24 * 60 * 60 * 1000;
  const intraDayMs = (currentMinutes * 60 + parseInt(get('second'), 10)) * 1000;
  return now.getTime() - daysBackMs - intraDayMs;
}

/**
 * Sum all coach-authored XP for a player. Includes legacy
 * coach_recognition (from before the 2026-07-13 refactor) plus
 * coach_live grants plus coach_whisper whispers. Used to decide
 * whether the derived Coach's Pick badge threshold has been crossed.
 *
 * Bounded scan — runQuery caps at 50 per call. Only invoked when
 * the player does NOT yet have the coach_pick badge; once earned,
 * we never re-check.
 */
async function sumCoachAuthoredXp(
  pid: string,
  playerId: string,
  sa: ServiceAccount,
): Promise<number> {
  let total = 0;
  for (const source of COACH_SOURCE_TYPES) {
    try {
      const events = await runQuery(
        pid,
        'player_xp_events',
        [
          { field: 'playerId', op: 'EQUAL', value: playerId },
          { field: 'source', op: 'EQUAL', value: source },
        ],
        sa,
        50,
      );
      for (const ev of events) {
        const n = Number((ev.data as any)?.xp);
        if (Number.isFinite(n) && n > 0) total += n;
      }
    } catch (err) {
      console.warn(`[xp] coach-xp sum failed for source ${source}:`, (err as Error).message);
    }
  }
  return total;
}

/**
 * Auto-grant the Coach's Pick badge if the player's cumulative
 * coach-authored XP crosses COACH_PICK_XP_THRESHOLD. No-op when the
 * badge is already earned (single-earn semantic — earnedAt is set
 * once and never bumped). Legacy `count` from the old Recognize
 * flow is preserved untouched on any historical badge.
 *
 * Called AFTER the current event has been written and the player's
 * xp/xpCareer transforms have committed, so the sum includes the
 * just-landed event. Non-fatal on any failure — the primary XP
 * award still succeeds even if the badge check errors.
 *
 * Returns `earned: true` only when THIS call was the one that
 * crossed the threshold (used by callers to include a "just earned
 * Coach's Pick" flag in the response payload).
 */
async function maybeGrantCoachPick(
  pid: string,
  sa: ServiceAccount,
  playerId: string,
  existingBadges: Record<string, any>,
  seasonId: string,
  seasonName: string,
): Promise<{ earned: boolean }> {
  try {
    const existing: any = existingBadges?.coach_pick;
    if (existing?.earnedAt) return { earned: false };
    const total = await sumCoachAuthoredXp(pid, playerId, sa);
    if (total < COACH_PICK_XP_THRESHOLD) return { earned: false };
    const now = new Date();
    const badgeUpdate: Record<string, any> = {
      earnedAt: now,
      context: seasonName || '',
    };
    if (seasonId) badgeUpdate.seasonId = seasonId;
    await patchDocument(pid, `players/${playerId}`, { 'badges.coach_pick': badgeUpdate }, sa);
    return { earned: true };
  } catch (err) {
    console.warn('[xp] coach_pick derivation failed (non-fatal):', (err as Error).message);
    return { earned: false };
  }
}

/**
 * POST /xp/award-whisper — awards a fixed +50 XP to a player after
 * the client has written the whisper doc. Client is responsible for
 * the parent_whispers Firestore write (email fanout too); this
 * endpoint owns the XP side only. Rationale: whispers already write
 * client-side via the composer with all the email/push machinery;
 * teasing that apart would double the surface. XP live server-side
 * so the transform + coach_pick derivation stay atomic.
 *
 * No cap. If the whisper was earned by the moment (not chased for
 * XP), coaches self-regulate. The 50 XP payload is fixed on the
 * worker side — clients cannot override.
 */
async function handleXpAwardWhisper(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  await requireCoachOfTeam(req, env, teamId);
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);

  const playerId = String(payload?.playerId || '');
  if (!playerId) return json({ ok: false, error: 'player_id_required' }, 400);

  const teamDoc = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  if (!teamDoc?.data) return json({ ok: false, error: 'team_not_found' }, 404);
  const teamData: any = teamDoc.data;
  if (teamData?.xpConfig?.enabled !== true) {
    return json({ ok: false, error: 'xp_not_enabled' }, 403);
  }
  // Ship 2 per-source gate. Whisper +50 has its own toggle now — the
  // coach can silence Whisper XP without disabling other Coach paths.
  // Mirrors isXpSourceEnabled in src/utils/xpSource.ts: explicit false
  // blocks, missing key defaults on (Ship 1 teams stay unchanged since
  // whisper has no coarse fallback).
  const whisperFlag = teamData?.xpConfig?.sources?.whisper;
  if (whisperFlag === false) {
    return json({ ok: false, error: 'xp_source_disabled' }, 403);
  }
  const clubId = teamData.clubId ? String(teamData.clubId) : '';

  const playerDoc = await getDocument(pid, `players/${playerId}`, sa).catch(() => null);
  if (!playerDoc?.data) return json({ ok: false, error: 'player_not_found' }, 404);
  const player: any = playerDoc.data;
  const playerTeams: string[] = Array.isArray(player.teamIds)
    ? player.teamIds
    : (player.teamId ? [player.teamId] : []);
  if (!playerTeams.includes(teamId)) {
    return json({ ok: false, error: 'player_not_on_team' }, 403);
  }
  const playerName = String(player.name || 'Player');

  let seasonId = '';
  let seasonName = '';
  try {
    const seasonQ = await runQuery(
      pid,
      'seasons',
      [
        { field: 'teamId', op: 'EQUAL', value: teamId },
        { field: 'isActive', op: 'EQUAL', value: true },
      ],
      sa,
      1,
    );
    if (seasonQ.length > 0) {
      seasonId = seasonQ[0].id;
      seasonName = String((seasonQ[0].data as any)?.name || '');
    }
  } catch (err) {
    console.warn('[xp] season lookup failed:', (err as Error).message);
  }

  const now = new Date();
  const eventFields: Record<string, any> = {
    playerId,
    playerName,
    teamId,
    xp: WHISPER_XP,
    source: 'coach_whisper',
    awardedBy: claims.uid,
    awardedByRole: 'coach',
    createdAt: now,
  };
  if (seasonId) eventFields.seasonId = seasonId;
  if (clubId) eventFields.clubId = clubId;

  const eventId = await createDocument(pid, 'player_xp_events', eventFields, sa);
  await commitDocumentTransforms(
    pid,
    `players/${playerId}`,
    [
      { fieldPath: 'xp', kind: 'increment', value: WHISPER_XP },
      { fieldPath: 'xpCareer', kind: 'increment', value: WHISPER_XP },
    ],
    null,
    sa,
  );

  const currentBadges = (player.badges && typeof player.badges === 'object') ? player.badges : {};
  const pick = await maybeGrantCoachPick(pid, sa, playerId, currentBadges, seasonId, seasonName);

  return json({
    ok: true,
    eventId,
    xp: WHISPER_XP,
    totalXp: (typeof player.xp === 'number' ? player.xp : 0) + WHISPER_XP,
    coachPickEarned: pick.earned,
  });
}

// ────────────────────────────────────────────────────────────────
// POST /xp/convert-kudos — coach one-taps a Circle member's kudos
// note into +N XP. Client already wrote the kudos doc; this
// endpoint stamps the audit event, increments xp/xpCareer, updates
// the kudos doc with the xpAwarded/xpEventId links, and derives
// Coach's Pick if applicable.
//
// Idempotent-ish: uses deterministic event id `kudos-${kudosId}` so
// double-tap converts as a Firestore 409 no-op (AlreadyExistsError).
// See project_player_circle_mission memory for context.
// ────────────────────────────────────────────────────────────────
async function handleXpConvertKudos(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  await requireCoachOfTeam(req, env, teamId);
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);

  const playerId = String(payload?.playerId || '');
  const kudosId = String(payload?.kudosId || '');
  const amountRaw = Number(payload?.amount);
  const coachNote = String(payload?.coachNote || '').trim();

  if (!playerId) return json({ ok: false, error: 'player_id_required' }, 400);
  if (!kudosId) return json({ ok: false, error: 'kudos_id_required' }, 400);
  if (!Number.isFinite(amountRaw) || amountRaw < COACH_LIVE_XP_MIN || amountRaw > COACH_LIVE_XP_MAX) {
    return json({ ok: false, error: 'amount_out_of_range' }, 400);
  }
  const amount = Math.round(amountRaw);
  const now = new Date();

  const teamDoc = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  if (!teamDoc?.data) return json({ ok: false, error: 'team_not_found' }, 404);
  const teamData: any = teamDoc.data;
  if (teamData?.xpConfig?.enabled !== true) {
    return json({ ok: false, error: 'xp_not_enabled' }, 403);
  }
  // Per-source gate: coach can disable the Kudos->XP convert action
  // via team.xpConfig.sources.kudosConvert = false. Absent = on.
  if (teamData?.xpConfig?.sources?.kudosConvert === false) {
    return json({ ok: false, error: 'xp-source-disabled' }, 403);
  }
  const clubId = teamData.clubId ? String(teamData.clubId) : '';

  const playerDoc = await getDocument(pid, `players/${playerId}`, sa).catch(() => null);
  if (!playerDoc?.data) return json({ ok: false, error: 'player_not_found' }, 404);
  const player: any = playerDoc.data;
  const playerTeams: string[] = Array.isArray(player.teamIds)
    ? player.teamIds
    : (player.teamId ? [player.teamId] : []);
  if (!playerTeams.includes(teamId)) {
    return json({ ok: false, error: 'player_not_on_team' }, 403);
  }
  const playerName = String(player.name || 'Player');

  // Load the kudos doc so we can carry sender info into the audit
  // event + fail cleanly if it doesn't exist or was already converted.
  const kudosDoc = await getDocument(pid, `kudos/${kudosId}`, sa).catch(() => null);
  if (!kudosDoc?.data) return json({ ok: false, error: 'kudos_not_found' }, 404);
  const kudos: any = kudosDoc.data;
  if (kudos.xpEventId) {
    return json({ ok: false, error: 'kudos_already_converted', xpEventId: kudos.xpEventId }, 409);
  }
  if (String(kudos.playerId || '') !== playerId) {
    return json({ ok: false, error: 'kudos_player_mismatch' }, 400);
  }

  let seasonId = '';
  let seasonName = '';
  try {
    const seasonQ = await runQuery(
      pid,
      'seasons',
      [
        { field: 'teamId', op: 'EQUAL', value: teamId },
        { field: 'isActive', op: 'EQUAL', value: true },
      ],
      sa,
      1,
    );
    if (seasonQ.length > 0) {
      seasonId = seasonQ[0].id;
      seasonName = String((seasonQ[0].data as any)?.name || '');
    }
  } catch (err) {
    console.warn('[xp/convert-kudos] season lookup failed:', (err as Error).message);
  }

  let coachName = '';
  try {
    const coachDoc = await getDocument(pid, `users/${claims.uid}`, sa).catch(() => null);
    if (coachDoc?.data) coachName = String((coachDoc.data as any)?.name || '');
  } catch { /* non-fatal */ }

  // Deterministic doc id — safe against double-tap.
  const eventId = `kudos-${kudosId}`;
  const eventFields: Record<string, any> = {
    playerId,
    playerName,
    teamId,
    xp: amount,
    source: 'kudos_coach_convert',
    awardedBy: claims.uid,
    awardedByRole: 'coach',
    awardedByName: coachName || null,
    note: coachNote || String(kudos.note || ''),
    sourceRef: kudosId,
    createdAt: now,
  };
  if (seasonId) eventFields.seasonId = seasonId;
  if (clubId) eventFields.clubId = clubId;

  try {
    await createDocument(pid, 'player_xp_events', eventFields, sa, eventId);
  } catch (err: any) {
    if (err?.name === 'AlreadyExistsError') {
      return json({ ok: false, error: 'kudos_already_converted' }, 409);
    }
    throw err;
  }

  try {
    await commitDocumentTransforms(
      pid,
      `players/${playerId}`,
      [
        { fieldPath: 'xp', kind: 'increment', value: amount },
        { fieldPath: 'xpCareer', kind: 'increment', value: amount },
      ],
      null,
      sa,
    );
  } catch (err) {
    // Orphan the audit doc if the player transform fails. Best-effort
    // undo matches the whisper handler pattern (see
    // deleteAuditEventBestEffort in the file).
    await deleteAuditEventBestEffort(pid, sa, eventId);
    throw err;
  }

  // Stamp the kudos doc bidirectionally so the profile UI can show
  // "coach converted this to +N XP" chrome and hide the "Convert to
  // XP" button for future viewers.
  try {
    await patchDocument(pid, `kudos/${kudosId}`, {
      xpAwarded: amount,
      xpAwardedBy: claims.uid,
      xpAwardedByName: coachName || '',
      xpAwardedAt: now,
      xpEventId: eventId,
      xpNote: coachNote || '',
    }, sa);
  } catch (err) {
    console.warn('[xp/convert-kudos] kudos stamp failed (non-fatal):', (err as Error).message);
  }

  // Coach's Pick derivation — kudos_coach_convert IS in
  // COACH_SOURCE_TYPES, so this sum includes the just-landed event.
  const pick = await maybeGrantCoachPick(
    pid, sa, playerId, player.badges || {}, seasonId, seasonName,
  );

  return json({
    ok: true,
    eventId,
    xp: amount,
    totalXp: (typeof player.xp === 'number' ? player.xp : 0) + amount,
    coachPickEarned: pick.earned,
    kudosId,
  });
}

// ────────────────────────────────────────────────────────────────
// POST /admin/player-reset-xp — platform-admin-only. Nukes XP,
// xpCareer, badges (all slugs), xpDailyGrantCount on a player and
// deletes their player_xp_events audit trail. Intended for the
// scenario where a coach entered stats manually + accidentally
// tripped the first-stat badge crossings, and the family wants a
// clean slate so future REAL crossings still fire.
//
// Does NOT touch player.stats (goals/assists/saves/etc.) — those
// have their own Fix flow at src/pages/Stats.tsx. If the coach also
// wants to reset raw stats, they do it separately.
//
// Patrick 2026-07-14: "he wants to roll that back. can you clear
// that out for them so it is back not nothing and they can still
// earn them?"
// ────────────────────────────────────────────────────────────────
async function handleAdminPlayerResetXp(req: Request, env: Env, payload: any): Promise<Response> {
  // Dual auth: accept EITHER a Firebase platform-admin ID token
  // (direct curl/browser-console path) OR the shared x-api-key
  // (goalkickr-admin Next.js portal path, which proxies through
  // its own session cookie). Matches the /generate-drill-diagram
  // pattern in worker/src/index.ts:762.
  const providedKey = req.headers.get('x-api-key') || '';
  const keyOk = !!(env as any).ADMIN_API_KEY && providedKey && providedKey === (env as any).ADMIN_API_KEY;
  if (!keyOk) {
    await requirePlatformAdmin(req, env);
  }
  const { pid, sa } = projectAndSA(env);

  const rawIds = Array.isArray(payload?.playerIds) ? payload.playerIds : [];
  const playerIds: string[] = Array.from(new Set(
    rawIds.map((v: any) => String(v || '')).filter((v: string) => v.length > 0)
  ));
  if (playerIds.length === 0) return json({ ok: false, error: 'players_required' }, 400);
  if (playerIds.length > 20) return json({ ok: false, error: 'too_many_players', message: 'Max 20 per call.' }, 400);

  const results: Array<{ playerId: string; eventsDeleted: number; ok: boolean; error?: string }> = [];

  for (const playerId of playerIds) {
    let eventsDeleted = 0;
    try {
      // 1) Delete every player_xp_events doc for this player.
      // runQuery caps at 100 per page; loop until empty.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const events = await runQuery(
          pid,
          'player_xp_events',
          [{ field: 'playerId', op: 'EQUAL', value: playerId }],
          sa,
          100,
        );
        if (events.length === 0) break;
        for (const ev of events) {
          try {
            await deleteAuditEventBestEffort(pid, sa, ev.id);
            eventsDeleted++;
          } catch { /* keep going */ }
        }
        if (events.length < 100) break;
      }

      // 2) Reset xp/xpCareer/badges/xpDailyGrantCount on the player doc.
      // patchDocument replaces the specified fields; using empty map
      // for badges/xpDailyGrantCount clears them.
      await patchDocument(pid, `players/${playerId}`, {
        xp: 0,
        xpCareer: 0,
        badges: {},
        xpDailyGrantCount: {},
      }, sa);

      results.push({ playerId, eventsDeleted, ok: true });
    } catch (err) {
      results.push({ playerId, eventsDeleted, ok: false, error: (err as Error).message });
    }
  }

  return json({ ok: true, results });
}

// ────────────────────────────────────────────────────────────────
// Route dispatcher. index.ts calls this once for /guard/* paths
// so we don't have to add a dozen if-blocks to the main handler.
// Returns null when the pathname isn't a guarded-write route.
// ────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────
// POST /xp/grant-coach — coach hands out live XP to one-or-many
// players. Primary UX: tap "Grant XP" at practice, pick who, pick
// how much, pick reason, ship. Distinct from /xp/award-recognition
// which is a private whisper with a per-week cap; this is the
// bulk-friendly, cap-by-XP-per-day gesture.
// ────────────────────────────────────────────────────────────────
async function handleXpGrantCoach(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  await requireCoachOfTeam(req, env, teamId);
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);

  const rawIds = Array.isArray(payload?.playerIds) ? payload.playerIds : [];
  const playerIds: string[] = Array.from(new Set(
    rawIds.map((v: any) => String(v || '')).filter((v: string) => v.length > 0)
  ));
  const amountRaw = Number(payload?.amount);
  const reason = String(payload?.reason || '').trim();
  const savePreset = payload?.savePreset === true;

  if (playerIds.length === 0) return json({ ok: false, error: 'players_required' }, 400);
  if (playerIds.length > COACH_LIVE_PLAYERS_MAX) {
    return json({ ok: false, error: 'too_many_players', message: `Max ${COACH_LIVE_PLAYERS_MAX} players per grant.` }, 400);
  }
  if (!Number.isFinite(amountRaw) || amountRaw < COACH_LIVE_XP_MIN || amountRaw > COACH_LIVE_XP_MAX) {
    return json({ ok: false, error: 'amount_out_of_range', message: `Amount must be ${COACH_LIVE_XP_MIN}-${COACH_LIVE_XP_MAX} XP.` }, 400);
  }
  const amount = Math.round(amountRaw);
  if (reason.length < COACH_LIVE_REASON_MIN) return json({ ok: false, error: 'reason_required' }, 400);
  if (reason.length > COACH_LIVE_REASON_MAX) return json({ ok: false, error: 'reason_too_long' }, 400);

  const teamDoc = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  if (!teamDoc?.data) return json({ ok: false, error: 'team_not_found' }, 404);
  const teamData: any = teamDoc.data;
  if (teamData?.xpConfig?.enabled !== true) {
    return json({ ok: false, error: 'xp_not_enabled' }, 403);
  }
  // Per-source gate: coach can disable the Grant XP action end-to-end
  // via team.xpConfig.sources.coachLiveGrant = false. Absent = on.
  if (teamData?.xpConfig?.sources?.coachLiveGrant === false) {
    return json({ ok: false, error: 'xp-source-disabled' }, 403);
  }
  const clubId = teamData.clubId ? String(teamData.clubId) : '';

  // Active season for stamping — non-fatal.
  let seasonId = '';
  try {
    const seasonQ = await runQuery(pid, 'seasons', [
      { field: 'teamId', op: 'EQUAL', value: teamId },
      { field: 'isActive', op: 'EQUAL', value: true },
    ], sa, 1);
    if (seasonQ.length > 0) seasonId = seasonQ[0].id;
  } catch (err) {
    console.warn('[xp] grant-coach season lookup failed:', (err as Error).message);
  }

  // Caller display name for the audit + kid toast.
  let awardedByName = 'Coach';
  try {
    const u = await getDocument(pid, `users/${claims.uid}`, sa);
    const n = (u?.data as any)?.name;
    if (typeof n === 'string' && n.trim()) awardedByName = n.trim();
  } catch { /* non-fatal */ }

  const now = new Date();
  const dayKey = dailyKeyDenver(now);
  const counterPath = `xpDailyGrantCount.${dayKey}`;

  // Audit 2026-07-11 hardening pass. Two audit-noted followups closed:
  //
  //   #1 CROSS-REQUEST CAP RACE. Prior shape read player_xp_events for
  //   the current day and summed. Two concurrent requests both saw
  //   dailySum=0 and both wrote — total > 500 XP. Fix: shift ceiling
  //   onto the PLAYER doc as a rolling counter sub-field
  //   xpDailyGrantCount.{dayKey}. Read player.updateTime, check
  //   counter, then commit an updateTime-preconditioned transform
  //   that increments counter + xp + xpCareer atomically. Concurrent
  //   modification invalidates the precondition and Firestore
  //   returns FAILED_PRECONDITION; we retry up to MAX_RETRIES.
  //
  //   #2 TWO-WRITE ATOMICITY. Worker's commitDocumentTransforms is
  //   single-doc. Compromise: write audit first, attempt player
  //   commit, on any player-fail call deleteAuditEventBestEffort()
  //   to undo the orphan audit. Rare double failure is logged.
  const MAX_RETRIES = 3;

  const results = await Promise.all(playerIds.map(async (playerId): Promise<{ playerId: string; ok: boolean; error?: string; xp?: number }> => {
    try {
      let attempt = 0;
      let lastError: string = 'write_failed';
      while (attempt < MAX_RETRIES) {
        attempt++;
        const playerDoc = await getDocument(pid, `players/${playerId}`, sa).catch(() => null);
        const player: any = playerDoc?.data;
        if (!player) return { playerId, ok: false, error: 'player_not_found' };
        const playerTeams: string[] = Array.isArray(player.teamIds)
          ? player.teamIds
          : (player.teamId ? [player.teamId] : []);
        if (!playerTeams.includes(teamId)) return { playerId, ok: false, error: 'player_not_on_team' };
        const playerName = String(player.name || 'Player');

        const counterMap: any = (player.xpDailyGrantCount && typeof player.xpDailyGrantCount === 'object')
          ? player.xpDailyGrantCount
          : {};
        const rawDaily = Number(counterMap[dayKey]);
        const dailySum = Number.isFinite(rawDaily) && rawDaily >= 0 ? rawDaily : 0;
        if (dailySum + amount > COACH_LIVE_XP_PER_PLAYER_PER_DAY) {
          return { playerId, ok: false, error: 'daily_cap_reached' };
        }

        const eventFields: Record<string, any> = {
          playerId,
          playerName,
          teamId,
          xp: amount,
          source: 'coach_live',
          awardedBy: claims.uid,
          awardedByRole: 'coach',
          awardedByName,
          note: reason,
          createdAt: now,
        };
        if (seasonId) eventFields.seasonId = seasonId;
        if (clubId) eventFields.clubId = clubId;

        const eventId = await createDocument(pid, 'player_xp_events', eventFields, sa);

        try {
          await commitDocumentTransforms(
            pid,
            `players/${playerId}`,
            [
              { fieldPath: 'xp', kind: 'increment', value: amount },
              { fieldPath: 'xpCareer', kind: 'increment', value: amount },
              { fieldPath: counterPath, kind: 'increment', value: amount },
            ],
            null,
            sa,
            playerDoc?.updateTime ? { updateTime: playerDoc.updateTime } : undefined,
          );
          return { playerId, ok: true, xp: amount };
        } catch (commitErr) {
          await deleteAuditEventBestEffort(eventId, pid, sa);
          if (commitErr instanceof PreconditionFailedError) {
            lastError = 'precondition_retry';
            continue;
          }
          console.error('[xp] grant-coach player commit failed', playerId, (commitErr as Error).message);
          lastError = 'write_failed';
          break;
        }
      }
      return { playerId, ok: false, error: lastError === 'precondition_retry' ? 'retry_exhausted' : lastError };
    } catch (err) {
      console.error('[xp] grant-coach write failed for', playerId, (err as Error).message);
      return { playerId, ok: false, error: 'write_failed' };
    }
  }));

  const grantedCount = results.filter(r => r.ok).length;

  // Derived Coach's Pick badge check. For every player that got at
  // least one grant this call, sum their coach-authored XP and, if
  // it crossed the threshold, stamp the badge (single-earn). Runs
  // AFTER the primary grants land so the sum includes them. Only
  // hits Firestore for players that don't yet have the badge.
  const picksEarned: Record<string, boolean> = {};
  await Promise.all(results.filter(r => r.ok).map(async (r) => {
    try {
      const playerDoc = await getDocument(pid, `players/${r.playerId}`, sa).catch(() => null);
      const existingBadges: any = (playerDoc?.data as any)?.badges || {};
      // Cheap early exit — skip the sum query if badge already earned.
      if (existingBadges?.coach_pick?.earnedAt) return;
      const pick = await maybeGrantCoachPick(pid, sa, r.playerId, existingBadges, seasonId, '');
      if (pick.earned) picksEarned[r.playerId] = true;
    } catch (err) {
      console.warn('[xp] grant-coach coach_pick derivation failed:', (err as Error).message);
    }
  }));

  // Optional preset save. Fires only if at least one grant landed —
  // no reason to memorialize a phrase the coach never actually used.
  if (savePreset && grantedCount > 0) {
    const currentPresets: any[] = Array.isArray(teamData?.xpConfig?.coachRewards)
      ? teamData.xpConfig.coachRewards
      : [];
    // Case-insensitive dedup — "Winning team" and "winning team" collapse.
    const norm = (s: string) => s.trim().toLowerCase();
    const dupe = currentPresets.some((p: any) => p && norm(String(p.label || '')) === norm(reason) && Number(p.amount) === amount);
    if (!dupe) {
      if (currentPresets.length >= COACH_LIVE_PRESETS_MAX) {
        return json({
          ok: true,
          granted: grantedCount,
          results,
          picksEarned,
          presetError: 'presets_full',
          message: `Grants sent. Presets are full (${COACH_LIVE_PRESETS_MAX} max) — free one up to save this.`,
        });
      }
      try {
        const preset = {
          id: crypto.randomUUID(),
          label: reason,
          amount,
          createdAt: now,
          createdByUid: claims.uid,
        };
        await commitDocumentTransforms(pid, `teams/${teamId}`, [
          { fieldPath: 'xpConfig.coachRewards', kind: 'arrayUnion', value: preset },
        ], null, sa);
      } catch (err) {
        console.warn('[xp] preset save failed (non-fatal):', (err as Error).message);
      }
    }
  }

  return json({ ok: true, granted: grantedCount, results, picksEarned });
}

// ────────────────────────────────────────────────────────────────
// POST /xp/reward-presets — add / delete saved coach-live presets.
// ────────────────────────────────────────────────────────────────
async function handleXpRewardPresets(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  await requireCoachOfTeam(req, env, teamId);
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);

  const action = String(payload?.action || '');
  if (action !== 'add' && action !== 'delete') {
    return json({ ok: false, error: 'action_required' }, 400);
  }

  const teamDoc = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  const teamData: any = teamDoc?.data;
  if (!teamData) return json({ ok: false, error: 'team_not_found' }, 404);
  if (teamData?.xpConfig?.enabled !== true) {
    return json({ ok: false, error: 'xp_not_enabled' }, 403);
  }

  const current: any[] = Array.isArray(teamData?.xpConfig?.coachRewards)
    ? teamData.xpConfig.coachRewards
    : [];

  if (action === 'add') {
    const label = String(payload?.preset?.label || '').trim();
    const amountRaw = Number(payload?.preset?.amount);
    if (label.length < COACH_LIVE_REASON_MIN || label.length > COACH_LIVE_REASON_MAX) {
      return json({ ok: false, error: 'label_invalid' }, 400);
    }
    if (!Number.isFinite(amountRaw) || amountRaw < COACH_LIVE_XP_MIN || amountRaw > COACH_LIVE_XP_MAX) {
      return json({ ok: false, error: 'amount_invalid' }, 400);
    }
    const amount = Math.round(amountRaw);
    if (current.length >= COACH_LIVE_PRESETS_MAX) {
      return json({ ok: false, error: 'presets_full' }, 409);
    }
    const norm = (s: string) => s.trim().toLowerCase();
    if (current.some((p: any) => p && norm(String(p.label || '')) === norm(label) && Number(p.amount) === amount)) {
      return json({ ok: false, error: 'preset_duplicate' }, 409);
    }
    const preset = {
      id: crypto.randomUUID(),
      label,
      amount,
      createdAt: new Date(),
      createdByUid: claims.uid,
    };
    await commitDocumentTransforms(pid, `teams/${teamId}`, [
      { fieldPath: 'xpConfig.coachRewards', kind: 'arrayUnion', value: preset },
    ], null, sa);
    return json({ ok: true, preset });
  }

  // delete
  const presetId = String(payload?.presetId || '');
  if (!presetId) return json({ ok: false, error: 'preset_id_required' }, 400);
  const remaining = current.filter((p: any) => !p || p.id !== presetId);
  if (remaining.length === current.length) {
    return json({ ok: false, error: 'preset_not_found' }, 404);
  }
  await patchDocument(pid, `teams/${teamId}`, { 'xpConfig.coachRewards': remaining }, sa);
  return json({ ok: true, removedId: presetId });
}

// ═══════════════════════════════════════════════════════════════
// POST /xp/backfill-preview + POST /xp/backfill-commit
//
// Two-phase retroactive XP sweep. When a coach enables xpConfig for
// the first time (or when a coach on an already-enabled team wants
// to grant credit for pre-XP history), preview shows exactly what
// will be awarded, then commit writes it atomically.
//
// Idempotency:
//   - team.xpConfig.backfilledAt is the fast-fail gate on the second
//     modal click (returns 409 already_backfilled)
//   - every event's Firestore doc id is deterministic
//     (backfill-{playerId}-{source}-{sourceRef}) so re-hitting commit
//     after a partial-success crash treats duplicate audits as an
//     idempotent skip (via AlreadyExistsError) rather than
//     double-crediting XP
//
// Copy discipline: reason strings on emitted events read as "Retro
// credit: First goal" etc. No em dashes, no emojis (feedback rules).
// ═══════════════════════════════════════════════════════════════

async function handleXpBackfillPreview(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  if (!teamId) return json({ ok: false, error: 'teamId_required' }, 400);
  await requireCoachOfTeam(req, env, teamId);
  await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);

  try {
    const plan = await computeBackfillPlan({ teamId, projectId: pid, sa });
    return json({
      ok: true,
      teamId: plan.teamId,
      computedAtMs: plan.computedAtMs,
      lines: plan.lines,
      totals: plan.totals,
      alreadyBackfilled: plan.alreadyBackfilled,
    });
  } catch (err) {
    console.error('[xp/backfill-preview] compute failed', (err as Error).message);
    return json({ ok: false, error: 'preview_failed' }, 500);
  }
}

/** Emit one event + paired player-doc transform for one badge.
 *  Returns 'granted' on success, 'skipped' when the deterministic
 *  event already exists (idempotency win). Any other error throws
 *  and the caller decides whether to unwind. */
async function applyBackfillBadge(
  pid: string,
  sa: ServiceAccount,
  teamId: string,
  playerId: string,
  playerName: string,
  badge: ComputedBadge,
  claims: { uid: string; name?: string | null },
): Promise<'granted' | 'skipped'> {
  const eventId = backfillEventId(playerId, badge.source as any, badge.sourceRef);
  const eventFields = {
    teamId,
    playerId,
    playerName,
    source: badge.source,
    sourceRef: badge.sourceRef,
    xp: badge.xp,
    reason: `Retro credit: ${badge.label}`,
    occurredAt: new Date(badge.earnedAtMs),
    backfilled: true,
    awardedBy: claims.uid,
    awardedByRole: 'coach',
    awardedByName: claims.name || 'Coach',
    createdAt: new Date(),
  };
  try {
    await createDocument(pid, 'player_xp_events', eventFields, sa, eventId);
  } catch (err) {
    if (err instanceof AlreadyExistsError) {
      // Idempotent no-op — this exact event was written on a
      // previous run. Don't re-apply XP or re-stamp the badge; a
      // previous attempt already handled both.
      return 'skipped';
    }
    throw err;
  }
  // Increment xp + xpCareer + stamp the badge in ONE atomic commit
  // so a partial success is impossible. Badge earnedAt uses the
  // historical date (per Patrick's Q2 decision) so the locker reads
  // "Sept 2025" instead of today.
  await commitDocumentTransforms(
    pid,
    `players/${playerId}`,
    [
      { fieldPath: 'xp', kind: 'increment', value: badge.xp },
      { fieldPath: 'xpCareer', kind: 'increment', value: badge.xp },
    ],
    {
      [`badges.${badge.slug}`]: {
        earnedAt: new Date(badge.earnedAtMs),
        source: 'backfill',
      },
    },
    sa,
  );
  return 'granted';
}

async function handleXpBackfillCommit(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  if (!teamId) return json({ ok: false, error: 'teamId_required' }, 400);
  await requireCoachOfTeam(req, env, teamId);
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);

  // Fresh plan — coach's client-supplied expectedTotalXp must match
  // the freshly-computed totals so they can never commit a plan
  // they didn't see.
  let plan: BackfillPlan;
  try {
    plan = await computeBackfillPlan({ teamId, projectId: pid, sa });
  } catch (err) {
    console.error('[xp/backfill-commit] compute failed', (err as Error).message);
    return json({ ok: false, error: 'preview_failed' }, 500);
  }

  if (plan.alreadyBackfilled) {
    return json({ ok: false, error: 'already_backfilled' }, 409);
  }

  const expected = Number(payload?.expectedTotalXp);
  if (!Number.isFinite(expected) || expected !== plan.totals.xp) {
    return json({
      ok: false,
      error: 'preview_stale',
      currentTotals: plan.totals,
    }, 409);
  }

  // If the coach explicitly opted OUT of retroactive credit (e.g.
  // via the "Turn on without retro credit" link), payload.skipGrants
  // === true skips the write loop and only flips the enable +
  // backfilledAt markers so future modal clicks are a no-op.
  const skipGrants = payload?.skipGrants === true;

  // First-time enable branch: if xpConfig.enabled is not yet true,
  // flip it now BEFORE the grants land so downstream reads see the
  // enabled state consistently.
  const teamDoc = await getDocument(pid, `teams/${teamId}`, sa);
  const currentlyEnabled = teamDoc?.data?.xpConfig?.enabled === true;
  if (!currentlyEnabled) {
    await patchDocument(pid, `teams/${teamId}`, {
      'xpConfig.enabled': true,
      'xpConfig.enabledAt': new Date(),
    }, sa);
  }

  let grantedCount = 0;
  let grantedXp = 0;
  const errors: Array<{ playerId: string; slug: string; message: string }> = [];

  if (!skipGrants) {
    for (const line of plan.lines) {
      for (const badge of line.badges) {
        try {
          const outcome = await applyBackfillBadge(pid, sa, teamId, line.playerId, line.playerName, badge, {
            uid: claims.uid,
            name: (claims as any).name || 'Coach',
          });
          if (outcome === 'granted') {
            grantedCount += 1;
            grantedXp += badge.xp;
          }
          // 'skipped' → prior run already handled this event, no
          // action needed. Counts toward "already applied" totals
          // but we don't double-count against grantedXp.
        } catch (err) {
          const msg = (err as Error).message || 'unknown';
          console.error('[xp/backfill-commit] grant failed', line.playerId, badge.slug, msg);
          errors.push({ playerId: line.playerId, slug: badge.slug, message: msg });
        }
      }
    }
  }

  // Stamp the durable marker + summary. Even if some grants errored,
  // the ones that succeeded are permanent; on retry the deterministic
  // ids will 409-skip and only the un-emitted events run.
  const summary = {
    xpGranted: grantedXp,
    badgesGranted: grantedCount,
    playerCount: plan.lines.length,
    ranAt: new Date(),
    ranByUid: claims.uid,
    ranByName: (claims as any).name || 'Coach',
  };
  await patchDocument(pid, `teams/${teamId}`, {
    'xpConfig.backfilledAt': new Date(),
    'xpConfig.backfillSummary': summary,
  }, sa);

  return json({
    ok: true,
    summary,
    errors: errors.length > 0 ? errors : undefined,
    skipped: skipGrants,
  });
}

// ═══════════════════════════════════════════════════════════════
// POST /dev-plans/log-tap + POST /dev-plans/log-verify
//
// FEATURE A ("I did it" whisper): every kid/parent tap on a dev-
// plan practice-log button goes through /dev-plans/log-tap. The
// worker:
//   1. Appends a new PracticeLogEntry to the goal's practiceLog[]
//      (same shape the client used to write directly)
//   2. Emits ONE parent_whispers doc per day per player with
//      kind='did_it', using deterministic id
//      `did_it-{playerId}-{YYYYMMDD-Denver}` so subsequent taps on
//      any goal that same day 409-idempotent no-op the whisper
//      without preventing the log entry from being recorded
//
// FEATURE B (coach verify): coach taps "Saw this" on a specific
// log entry via /dev-plans/log-verify. Worker stamps verifiedBy
// on the entry and emits a coach_verify whisper with deterministic
// id `verify-{playerId}-{logId}` so a coach who re-taps just gets
// the existing ack.
//
// Auth:
//   - log-tap accepts either a team coach OR a parent of the player
//   - log-verify accepts team coaches only
// Both endpoints require requireUser first for the caller uid.
// ═══════════════════════════════════════════════════════════════

/** Return YYYYMMDD in America/Denver (matches feedback_worker_timezone
 *  standing rule). Used as the whisper-idempotency day key. */
function denverDayKeyYYYYMMDD(now: Date = new Date()): string {
  const s = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
  // en-CA yields "YYYY-MM-DD" — strip the dashes for the doc-id key.
  return s.replace(/-/g, '');
}

/** Return "YYYY-MM-DD" in America/Denver — the docId shape for
 *  players/{pid}/dev_checkins/{dayKey}. Kept dashed (unlike the
 *  whisper key) so the docId reads like a date at a glance and is
 *  naturally sortable. */
function denverDayKey(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

/** True when uid is on the player's parentIds array. */
async function isParentOfPlayer(pid: string, sa: ServiceAccount, uid: string, playerId: string): Promise<boolean> {
  try {
    const doc = await getDocument(pid, `players/${playerId}`, sa);
    const parentIds: any[] = Array.isArray(doc?.data?.parentIds) ? doc!.data.parentIds : [];
    return parentIds.includes(uid);
  } catch { return false; }
}

async function handleDevPlansLogTap(req: Request, env: Env, payload: any): Promise<Response> {
  const planId = String(payload?.planId || '');
  const goalId = String(payload?.goalId || '');
  const playerId = String(payload?.playerId || '');
  const teamId = String(payload?.teamId || '');
  if (!planId || !goalId || !playerId || !teamId) {
    return json({ ok: false, error: 'missing_required' }, 400);
  }
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);

  // Coach-or-parent gate. Coaches always pass; otherwise verify
  // parent linkage on the player doc.
  let isCoach = false;
  try {
    await requireCoachOfTeam(req, env, teamId);
    isCoach = true;
  } catch { /* not a coach on this team — fall through to parent check */ }
  if (!isCoach) {
    const isParent = await isParentOfPlayer(pid, sa, claims.uid, playerId);
    if (!isParent) return json({ ok: false, error: 'not_authorized' }, 403);
  }

  // Load the plan, mutate the target goal's practiceLog.
  const planDoc = await getDocument(pid, `development_plans/${planId}`, sa);
  if (!planDoc?.data) return json({ ok: false, error: 'plan_not_found' }, 404);
  const plan: any = planDoc.data;
  const goals: any[] = Array.isArray(plan.goals) ? plan.goals : [];
  const goal = goals.find(g => g?.id === goalId);
  if (!goal) return json({ ok: false, error: 'goal_not_found' }, 404);

  // Build the entry client-parity shape.
  const now = new Date();
  const actorName = String((await getDocument(pid, `users/${claims.uid}`, sa).catch(() => null))?.data?.name || 'Family');
  const entry = {
    id: `log_${Date.now()}`,
    date: now,
    note: String(payload?.note || '').slice(0, 500),
    minutes: typeof payload?.minutes === 'number' && payload.minutes > 0 ? Math.min(payload.minutes, 600) : undefined,
    loggedBy: claims.uid,
    loggedByName: actorName,
  };
  // Player-scoped check-in — the streak's source of truth. Doc id is
  // the Denver day key so a second tap same day is a silent 409 no-op
  // ("streak sees a single day" per player_scoped_streak design). The
  // practiceLog append below stays for the coach's plan-review UI;
  // the streak calc no longer reads from it. Retiring plan A and
  // creating plan B for the same kid has zero effect on the counter.
  //
  // ORDER MATTERS 2026-07-21: write the check-in FIRST. If it fails
  // (non-AlreadyExists), return 500 so the client knows not to run
  // recomputeAndPersistPlayerStreak — otherwise the recompute would
  // read stale checkins and silently write a LOWER streak to cache,
  // clobbering the legit prior value with no user-facing error.
  const dayKey = denverDayKey(now);
  const goalTitleForCheckin = String(goal.title || '');
  const checkinRole = isCoach ? 'coach' : 'parent';
  try {
    await createDocument(
      pid,
      `players/${playerId}/dev_checkins`,
      {
        date: now,
        dayKey,
        loggedBy: claims.uid,
        loggedByRole: checkinRole,
        loggedByName: actorName,
        planId,
        goalId,
        goalTitle: goalTitleForCheckin,
        teamId,
        note: entry.note || '',
      },
      sa,
      dayKey,
    );
  } catch (err) {
    if (err instanceof AlreadyExistsError) {
      // Same-day re-tap. Streak-side idempotency intact — fall through
      // to the practiceLog append so the coach still sees every tap.
    } else {
      // Real failure. Do NOT commit the practiceLog patch — a lone
      // plan-side write with no check-in leaves the streak source of
      // truth out of sync. Client retries the whole tap.
      console.warn('[dev-plans/log-tap] dev_checkins write failed:', (err as Error).message);
      return json({ ok: false, error: 'checkin_write_failed' }, 500);
    }
  }

  const updatedGoals = goals.map(g => {
    if (g?.id !== goalId) return g;
    const nextLog = Array.isArray(g.practiceLog) ? [...g.practiceLog, entry] : [entry];
    return { ...g, practiceLog: nextLog };
  });
  await patchDocument(pid, `development_plans/${planId}`, { goals: updatedGoals }, sa);

  // Whisper (Feature A) — deterministic id per player per Denver
  // day means a second goal-tap same day is a silent 409 no-op.
  const goalTitle = String(goal.title || 'his practice');
  const playerName = String(plan.playerName || 'Your player');
  const message = `${playerName} did practice today: ${goalTitle}`;
  const whisperId = `did_it-${playerId}-${denverDayKeyYYYYMMDD(now)}`;
  try {
    await createDocument(pid, 'parent_whispers', {
      playerId,
      playerName,
      teamId,
      coachUid: claims.uid,
      coachName: actorName,
      coachAvatarUrl: null,
      message,
      kind: 'did_it',
      planId,
      goalId,
      goalTitle,
      logId: entry.id,
      recipientEmails: [],
      recipientCount: 0,
      createdAt: now,
    }, sa, whisperId);
  } catch (err) {
    if (err instanceof AlreadyExistsError) {
      // Second tap same day — whisper for this day already exists.
      // The log entry above still landed; no user-visible failure.
    } else {
      console.warn('[dev-plans/log-tap] whisper fanout failed (non-fatal):', (err as Error).message);
    }
  }

  return json({ ok: true, updatedGoals, entry });
}

async function handleDevPlansLogVerify(req: Request, env: Env, payload: any): Promise<Response> {
  const planId = String(payload?.planId || '');
  const goalId = String(payload?.goalId || '');
  const logId = String(payload?.logId || '');
  const playerId = String(payload?.playerId || '');
  const teamId = String(payload?.teamId || '');
  if (!planId || !goalId || !logId || !playerId || !teamId) {
    return json({ ok: false, error: 'missing_required' }, 400);
  }
  await requireCoachOfTeam(req, env, teamId);
  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);

  const planDoc = await getDocument(pid, `development_plans/${planId}`, sa);
  if (!planDoc?.data) return json({ ok: false, error: 'plan_not_found' }, 404);
  const plan: any = planDoc.data;
  const goals: any[] = Array.isArray(plan.goals) ? plan.goals : [];
  const goal = goals.find(g => g?.id === goalId);
  if (!goal) return json({ ok: false, error: 'goal_not_found' }, 404);
  const log: any[] = Array.isArray(goal.practiceLog) ? goal.practiceLog : [];
  const entry = log.find(l => l?.id === logId);
  if (!entry) return json({ ok: false, error: 'log_entry_not_found' }, 404);

  // Idempotent: if verifiedBy already exists, keep it (first ack
  // wins). Whisper create still 409s on the deterministic id so no
  // re-fanout.
  const now = new Date();
  const coachName = String((await getDocument(pid, `users/${claims.uid}`, sa).catch(() => null))?.data?.name || 'Coach');
  const alreadyVerified = !!entry.verifiedBy;
  if (!alreadyVerified) {
    const updatedGoals = goals.map(g => {
      if (g?.id !== goalId) return g;
      const nextLog = (Array.isArray(g.practiceLog) ? g.practiceLog : []).map((l: any) => {
        if (l?.id !== logId) return l;
        return { ...l, verifiedBy: { uid: claims.uid, name: coachName, at: now } };
      });
      return { ...g, practiceLog: nextLog };
    });
    await patchDocument(pid, `development_plans/${planId}`, { goals: updatedGoals }, sa);
  }

  const goalTitle = String(goal.title || 'his practice');
  const playerName = String(plan.playerName || 'Your player');
  const message = `Coach ${coachName} saw ${playerName} work on ${goalTitle}.`;
  const whisperId = `verify-${playerId}-${logId}`;
  try {
    await createDocument(pid, 'parent_whispers', {
      playerId,
      playerName,
      teamId,
      coachUid: claims.uid,
      coachName,
      coachAvatarUrl: null,
      message,
      kind: 'coach_verify',
      planId,
      goalId,
      goalTitle,
      logId,
      recipientEmails: [],
      recipientCount: 0,
      createdAt: now,
    }, sa, whisperId);
  } catch (err) {
    if (err instanceof AlreadyExistsError) {
      // Silent — a prior verify on this entry already emitted the whisper.
    } else {
      console.warn('[dev-plans/log-verify] whisper fanout failed (non-fatal):', (err as Error).message);
    }
  }

  return json({
    ok: true,
    verifiedBy: { uid: claims.uid, name: coachName, at: now },
    alreadyVerified,
  });
}

// ────────────────────────────────────────────────────────────────
// POST /surveys/response-created — public endpoint. The client
// (PublicSurvey.tsx) fires this fire-and-forget after addDoc on
// survey_responses succeeds. The worker looks up the parent
// survey doc for title + teamId, reads team.coachIds, and pushes
// "{name} completed {title}" to every coach with an FCM token.
//
// PUBLIC by design — public surveys can be filled out by
// unauthenticated parents (cold link in email / SMS). No auth
// scope check; the worst-case abuse (someone spamming this with
// fake surveyIds) resolves to a Firestore read miss + 404. The
// endpoint does NOT accept any user-provided display copy — the
// title comes from the survey doc, respondentName from the survey
// response the client just wrote, so a bad actor can't hijack the
// notification body.
//
// Idempotency: the client only calls once per submit. If a retry
// storms it, we accept the extra push (parents doing survey twice
// is already handled by the client's localStorage duplicate guard).
//
// fromUid excludes the responding coach from their own push so a
// coach who fills out their own team's survey doesn't self-notify.
// ────────────────────────────────────────────────────────────────
async function handleSurveyResponseCreated(_req: Request, env: Env, payload: any): Promise<Response> {
  const surveyId = String(payload?.surveyId || '');
  const clientRespondentName = payload?.respondentName ? String(payload.respondentName).slice(0, 100) : '';
  const fromUid = payload?.fromUid ? String(payload.fromUid) : '';
  if (!surveyId) return json({ ok: false, error: 'survey_id_required' }, 400);

  const { pid, sa } = projectAndSA(env);

  const surveyDoc = await getDocument(pid, `surveys/${surveyId}`, sa).catch(() => null);
  if (!surveyDoc?.data) return json({ ok: false, error: 'survey_not_found' }, 404);
  const survey: any = surveyDoc.data;
  const title = String(survey.title || 'the survey').slice(0, 100);
  const teamId = String(survey.teamId || '');
  if (!teamId) return json({ ok: false, error: 'survey_missing_team' }, 400);
  // Anonymity is enforced server-side: even if a client (or a direct
  // POST to this public endpoint) supplies a respondentName, we drop
  // it when the survey is flagged anonymous so the push body falls
  // through to "Someone completed …" below.
  const respondentName = survey.isAnonymous === true ? '' : clientRespondentName;

  // Private-notify surveys: only the survey creator gets the new-
  // response ping. Other coaches on the team are skipped. Default
  // (survey.isPrivate !== true) preserves the existing all-coaches
  // fanout.
  let recipients: string[];
  if (survey.isPrivate === true) {
    const creator = typeof survey.createdBy === 'string' && survey.createdBy.length > 0
      ? [survey.createdBy]
      : [];
    recipients = fromUid ? creator.filter(uid => uid !== fromUid) : creator;
    if (recipients.length === 0) {
      return json({ ok: true, sent: 0, note: 'no_creator_recipient' });
    }
  } else {
    const teamDoc = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
    if (!teamDoc?.data) return json({ ok: false, error: 'team_not_found' }, 404);
    const team: any = teamDoc.data;
    const coachIds: string[] = Array.isArray(team.coachIds)
      ? team.coachIds.filter((u: unknown) => typeof u === 'string' && u.length > 0)
      : [];
    recipients = fromUid ? coachIds.filter(uid => uid !== fromUid) : coachIds;
    if (recipients.length === 0) {
      return json({ ok: true, sent: 0, note: 'no_coach_recipients' });
    }
  }

  if (!env.FCM_SERVICE_ACCOUNT) {
    return json({ ok: false, error: 'fcm-not-configured' }, 503);
  }

  // Resolve FCM tokens across all coaches, honoring push prefs.
  // 'broadcast' is the closest pref key (informational, non-message).
  // Absent prefs default true — matches DEFAULT_PUSH_PREFS on client.
  const tokens: string[] = [];
  for (const uid of recipients) {
    try {
      const uDoc = await getDocument(pid, `users/${uid}`, sa).catch(() => null);
      if (!uDoc?.data) continue;
      const u: any = uDoc.data;
      if (u.isActive === false) continue;
      if (u.pushPreferences && u.pushPreferences.broadcast === false) continue;
      const arr: string[] = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
      for (const t of arr) {
        if (typeof t === 'string' && t.length > 10) tokens.push(t);
      }
    } catch { /* ignore per-user lookup failures */ }
  }
  const uniqueTokens = Array.from(new Set(tokens));
  if (uniqueTokens.length === 0) {
    return json({ ok: true, sent: 0, note: 'no_tokens' });
  }

  // Anonymous surveys don't leak a name — respondentName is empty for
  // survey.isAnonymous === true (client strips it before POST). "Someone"
  // keeps the notif informational without exposing the token owner.
  const name = respondentName || 'Someone';
  const pushTitle = 'Survey response';
  const pushBody = `${name} completed ${title}`;
  const appOrigin = env.APP_ORIGIN || 'https://app.goalkickr.com';
  const url = `${appOrigin}/surveys/${surveyId}`;

  const { sendPush } = await import('./fcm');
  try {
    const result = await sendPush(uniqueTokens, {
      title: pushTitle,
      body: pushBody,
      url,
      badge: 1,
    }, env.FCM_SERVICE_ACCOUNT);
    return json({ ok: true, sent: result.sent, tokens: uniqueTokens.length });
  } catch (err: any) {
    console.warn('[surveys] response-created push failed', err);
    return json({ ok: false, error: 'push_failed', detail: String(err?.message || err).slice(0, 200) }, 502);
  }
}

export async function routeWriteGuard(
  pathname: string,
  req: Request,
  env: Env,
  payload: any,
): Promise<Response | null> {
  switch (pathname) {
    case '/users/bootstrap':       return handleUsersBootstrap(req, env, payload);
    case '/users/set-widget-player': return handleUsersSetWidgetPlayer(req, env, payload);
    case '/users/set-role':        return handleUsersSetRole(req, env, payload);
    case '/users/set-self-role':   return handleUsersSetSelfRole(req, env, payload);
    case '/claim/invite':          return handleClaimInvite(req, env, payload);
    case '/claim/parent-invite':   return handleClaimInvite(req, env, payload);  // legacy alias
    case '/claim/coach-invite':    return handleClaimCoachInvite(req, env, payload);
    case '/claim/player-link':     return handleClaimPlayerLink(req, env, payload);
    case '/claim/offer-accept':    return handleClaimOfferAccept(req, env, payload);
    case '/claim/offer-decline':   return handleClaimOfferDecline(req, env, payload);
    case '/teams/create':          return handleTeamsCreate(req, env, payload);
    case '/clubs/create':          return handleClubsCreate(req, env, payload);
    case '/teams/add-coach':       return handleTeamsAddCoach(req, env, payload);
    case '/teams/remove-coach':    return handleTeamsRemoveCoach(req, env, payload);
    case '/teams/share-player':    return handleTeamsSharePlayer(req, env, payload);
    case '/teams/unshare-player':  return handleTeamsUnsharePlayer(req, env, payload);
    case '/teams/transfer-head':   return handleTeamsTransferHead(req, env, payload);
    case '/teams/archive':         return handleTeamsArchive(req, env, payload);
    case '/teams/restore':         return handleTeamsRestore(req, env, payload);
    case '/teams/set-staff-permissions': return handleTeamsSetStaffPermissions(req, env, payload);
    case '/teams/set-staff-role':  return handleTeamsSetStaffRole(req, env, payload);
    case '/users/approve':         return handleUsersApprove(req, env, payload);
    case '/users/deactivate':      return handleUsersDeactivate(req, env, payload);
    case '/users/set-teams':       return handleUsersSetTeams(req, env, payload);
    case '/users/heal-team-membership': return handleUsersHealTeamMembership(req, env, payload);
    case '/users/refresh-claims':  return handleUsersRefreshClaims(req, env, payload);
    case '/players/create':        return handlePlayersCreate(req, env, payload);
    case '/events/batch-create':   return handleEventsBatchCreate(req, env, payload);
    case '/events/rsvp':           return handleEventsRsvp(req, env, payload);
    case '/events/mark-paid':      return handleEventsMarkPaid(req, env, payload);
    case '/clubs/personal-create-if-missing': return handleClubsPersonalCreateIfMissing(req, env, payload);
    case '/leagues/create':        return handleLeaguesCreate(req, env, payload);
    case '/leagues/fixture-create': return handleLeaguesFixtureCreate(req, env, payload);
    case '/leagues/report-score':  return handleLeaguesReportScore(req, env, payload);
    case '/leagues/recompute':     return handleLeaguesRecompute(req, env, payload);
    case '/players/set-active':    return handlePlayersSetActive(req, env, payload);
    case '/players/link-parent':   return handlePlayersLinkParent(req, env, payload);
    case '/players/stamp-funnel':  return handlePlayersStampFunnel(req, env, payload);
    case '/players/toggle-self-parent': return handlePlayersToggleSelfParent(req, env, payload);
    case '/players/set-kid-mode':  return handlePlayersSetKidMode(req, env, payload);
    case '/players/set-teams':     return handlePlayersSetTeams(req, env, payload);
    case '/players/promote-guest': return handlePlayersPromoteGuest(req, env, payload);
    case '/club/set-admin':        return handleClubSetAdmin(req, env, payload);
    case '/club/remove-admin':     return handleClubRemoveAdmin(req, env, payload);
    case '/xp/award-whisper':      return handleXpAwardWhisper(req, env, payload);
    case '/xp/grant-coach':        return handleXpGrantCoach(req, env, payload);
    case '/xp/convert-kudos':      return handleXpConvertKudos(req, env, payload);
    case '/admin/player-reset-xp': return handleAdminPlayerResetXp(req, env, payload);
    case '/admin/send-player-invite': return handleAdminSendPlayerInvite(req, env as any, payload);
    case '/xp/reward-presets':     return handleXpRewardPresets(req, env, payload);
    case '/xp/backfill-preview':   return handleXpBackfillPreview(req, env, payload);
    case '/xp/backfill-commit':    return handleXpBackfillCommit(req, env, payload);
    case '/dev-plans/log-tap':     return handleDevPlansLogTap(req, env, payload);
    case '/dev-plans/log-verify':  return handleDevPlansLogVerify(req, env, payload);
    case '/register/submit':       return handleRegisterSubmit(req, env, payload);
    case '/parent/pool-status':    return handleParentPoolStatus(req, env, payload);
    case '/surveys/response-created': return handleSurveyResponseCreated(req, env, payload);
    default:                       return null;
  }
}
