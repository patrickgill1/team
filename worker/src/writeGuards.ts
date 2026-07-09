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
  requireSelf,
  AuthError,
} from './auth';
import { parseServiceAccount, ServiceAccount } from './fcm';
import {
  getDocument,
  patchDocument,
  createDocument,
  runQuery,
  commitDocumentTransforms,
  FirestoreDoc,
} from './firestore';

interface Env {
  FIREBASE_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT?: string;
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
  const wantRole: 'coach' | 'parent' = payload?.role === 'coach' ? 'coach' : 'parent';
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
    // Always stamp approved + parent role when there was a match —
    // even if the initial write set role='coach' from the client
    // default. The email match is the source of truth for parent
    // status. If they're ALSO a coach somewhere (their email on
    // team.coachIds), the per-team check picks that up separately;
    // the global role stays 'parent'.
    const patch: Record<string, any> = {
      approved: true,
      approvalStatus: 'auto-email-match',
    };
    if (wantRole === 'coach') {
      patch.role = 'parent';
    }
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
      // player, or team just deleted). Still patch role + approved
      // so at least the identity is right.
      await patchDocument(pid, `users/${claims.uid}`, patch, sa);
    }
  }

  return json({
    ok: true,
    uid: claims.uid,
    linkedCount: linked.length,
    // Return the resolved role so the client can update its cached
    // userData without a round-trip refresh. Callers that don't need
    // this ignore the field.
    role: linked.length > 0 && wantRole === 'coach' ? 'parent' : wantRole,
  });
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
  if (invite.expiresAt) {
    const exp = typeof invite.expiresAt === 'string'
      ? new Date(invite.expiresAt).getTime()
      : (typeof invite.expiresAt?.seconds === 'number' ? invite.expiresAt.seconds * 1000 : 0);
    if (exp && exp < Date.now()) return json({ ok: false, error: 'invite_expired' }, 410);
  }
  const usedCount = typeof invite.usedCount === 'number' ? invite.usedCount : 0;
  const maxUses = typeof invite.maxUses === 'number' ? invite.maxUses : 1;
  if (usedCount >= maxUses) return json({ ok: false, error: 'invite_exhausted' }, 410);
  const usedBy: string[] = Array.isArray(invite.usedBy) ? invite.usedBy : [];
  if (usedBy.includes(claims.uid)) {
    // Already claimed by this uid — respond OK so client retries are
    // safe. Matches the old client's early-return posture.
    return json({ ok: true, teamId: invite.teamId, playerId: invite.playerId, idempotent: true });
  }
  const teamId = String(invite.teamId || '');
  if (!teamId) return json({ ok: false, error: 'invite_missing_team' }, 400);
  const inviteType = String(invite.type || '');

  const nowIso = new Date();
  const userTransforms: any[] = [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: teamId }];
  const userPatch: Record<string, any> = {
    approved: true,
    approvalStatus: 'auto',
    approvedAt: nowIso,
    invitedBy: invite.createdBy || null,
    invitedVia: inviteId,
    teamId, // legacy single-team pointer
  };

  if (inviteType === 'player') {
    const playerId = String(invite.playerId || '');
    if (!playerId) return json({ ok: false, error: 'invite_missing_player' }, 400);
    const isAdultPlayer = invite.isAdultPlayer === true;
    const relationship = String(invite.relationship || 'parent');

    const playerPatch: Record<string, any> = {};
    if (isAdultPlayer) playerPatch.isAdultPlayer = true;
    await commitDocumentTransforms(
      pid,
      `players/${playerId}`,
      [{ fieldPath: 'parentIds', kind: 'arrayUnion', value: claims.uid }],
      Object.keys(playerPatch).length ? playerPatch : null,
      sa,
    );

    userPatch.role = 'parent';
    userPatch.relationship = relationship;
    if (isAdultPlayer) userPatch.selfPlayerId = playerId;
  } else if (inviteType === 'coach') {
    userPatch.role = 'coach';
    userPatch.coachLevel = String(invite.role || 'assistant_coach');
  } else if (inviteType === 'team_manager') {
    userPatch.role = 'team_manager';
  } else {
    return json({ ok: false, error: 'unknown_invite_type' }, 400);
  }

  await commitDocumentTransforms(pid, `users/${claims.uid}`, userTransforms, userPatch, sa);

  // Mark invite consumed.
  await commitDocumentTransforms(
    pid,
    `invites/${inviteId}`,
    [
      { fieldPath: 'usedCount', kind: 'increment', value: 1 },
      { fieldPath: 'usedBy', kind: 'arrayUnion', value: claims.uid },
    ],
    null,
    sa,
  );

  // Post-primary: coach + team_manager joining a NON-solo club
  // inherit coverage from the club. Deferred until after the main
  // writes so a bad club-lookup can't block the invite consume.
  if (inviteType === 'coach' || inviteType === 'team_manager') {
    try {
      const teamDoc = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
      const teamData: any = teamDoc?.data || {};
      const clubId = teamData.clubId ? String(teamData.clubId) : '';
      if (clubId) {
        const clubDoc = await getDocument(pid, `clubs/${clubId}`, sa).catch(() => null);
        const clubData: any = clubDoc?.data || {};
        if (clubData.isDefaultSoloClub !== true) {
          await patchDocument(
            pid,
            `users/${claims.uid}`,
            { coverageSource: 'club', coverageClubId: clubId },
            sa,
          );
        }
      }
    } catch (err) {
      console.warn('[claim-invite] club coverage stamp failed:', (err as Error).message);
    }
  }

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
  if (invite.status === 'claimed') return json({ ok: false, error: 'already_used' }, 409);
  if (typeof invite.expiresAt === 'string' && new Date(invite.expiresAt).getTime() < Date.now()) {
    return json({ ok: false, error: 'invite_expired' }, 410);
  }
  const teamId = String(invite.teamId || '');
  if (!teamId) return json({ ok: false, error: 'invite_missing_team' }, 400);
  const coachLevel = invite.coachLevel === 'assistant' ? 'assistant' : 'head_coach';

  await commitDocumentTransforms(
    pid,
    `teams/${teamId}`,
    [{ fieldPath: 'coachIds', kind: 'arrayUnion', value: claims.uid }],
    null,
    sa,
  );
  const userPatch: Record<string, any> = {
    role: 'coach',
    coachLevel,
    approved: true,
    approvalStatus: 'invite-consumed',
  };
  if (invite.clubId) {
    userPatch.coverageSource = 'club';
    userPatch.coverageClubId = String(invite.clubId);
  }
  await commitDocumentTransforms(
    pid,
    `users/${claims.uid}`,
    [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: teamId }],
    userPatch,
    sa,
  );
  await patchDocument(
    pid,
    `coach_invites/${inviteId}`,
    { status: 'claimed', claimedBy: claims.uid, claimedAt: new Date() },
    sa,
  );
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

  const playerPatch: Record<string, any> = {};
  if (isAdultClaim) playerPatch.isAdultPlayer = true;
  await commitDocumentTransforms(
    pid,
    `players/${playerId}`,
    [{ fieldPath: 'parentIds', kind: 'arrayUnion', value: claims.uid }],
    Object.keys(playerPatch).length ? playerPatch : null,
    sa,
  );

  const teamIds: string[] = Array.isArray(player.teamIds) && player.teamIds.length > 0
    ? player.teamIds
    : (player.teamId ? [player.teamId] : []);
  const userPatch: Record<string, any> = {
    approved: true,
    approvalStatus: 'player-link',
  };
  if (isAdultClaim) userPatch.selfPlayerId = playerId;
  const userTransforms: any[] = [
    { fieldPath: 'children', kind: 'arrayUnion', value: playerId },
  ];
  if (teamIds.length > 0) {
    userTransforms.push({ fieldPath: 'teamIds', kind: 'arrayUnion', value: teamIds });
  }
  await commitDocumentTransforms(pid, `users/${claims.uid}`, userTransforms, userPatch, sa);
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
  const playerId = String(offer.playerId || '');
  await patchDocument(
    pid,
    `offers/${offerId}`,
    { status: 'accepted', acceptedAt: new Date(), acceptedBy: claims.uid },
    sa,
  );
  if (playerId && teamId) {
    await commitDocumentTransforms(
      pid,
      `players/${playerId}`,
      [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: teamId }],
      { teamId },
      sa,
    );
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
  if (offer.parentEmail && normEmail(offer.parentEmail) !== normEmail(claims.email)) {
    return json({ ok: false, error: 'wrong_recipient' }, 403);
  }
  await patchDocument(
    pid,
    `offers/${offerId}`,
    { status: 'declined', declinedAt: new Date(), declinedBy: claims.uid, declineReason: String(payload?.reason || '').slice(0, 500) },
    sa,
  );
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
  };
  if (audienceType) teamFields.audienceType = audienceType;
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

  const userPatch: Record<string, any> = {
    role: 'coach',
    coachLevel: 'head_coach',
    approved: true,
    approvalStatus: 'self-created-team',
  };
  const userTransforms: any[] = [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: newTeamId }];
  const effectiveClubId = newClubId || requestedClubId;
  if (effectiveClubId) {
    userTransforms.push({ fieldPath: 'clubIds', kind: 'arrayUnion', value: effectiveClubId });
  }
  await commitDocumentTransforms(pid, `users/${claims.uid}`, userTransforms, userPatch, sa);

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

  const userPatch: Record<string, any> = {
    role: alsoCoach ? 'coach' : 'club_admin',
    approved: true,
    approvalStatus: 'self-created-club',
    // NOT platform admin — that's a separate flag Patrick controls.
    // isClubAdmin here is only true for platform admins per legacy
    // naming; do not stamp it based on club ownership.
  };
  const userTransforms: any[] = [{ fieldPath: 'clubIds', kind: 'arrayUnion', value: clubId }];
  if (teamId) {
    userPatch.coachLevel = 'head_coach';
    userTransforms.push({ fieldPath: 'teamIds', kind: 'arrayUnion', value: teamId });
  }
  await commitDocumentTransforms(pid, `users/${claims.uid}`, userTransforms, userPatch, sa);

  return json({ ok: true, clubId, teamId });
}

// ────────────────────────────────────────────────────────────────
// /teams/add-coach — head coach adds another coach to their team.
// Body: { teamId, coachUid, coachLevel? ('head_coach' | 'assistant') }
// Verifies caller is a coach on the target team.
// ────────────────────────────────────────────────────────────────
async function handleTeamsAddCoach(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const coachUid = String(payload?.coachUid || '');
  if (!coachUid) return json({ ok: false, error: 'coach_uid_required' }, 400);
  const coachLevel = payload?.coachLevel === 'head_coach' ? 'head_coach' : 'assistant';

  await commitDocumentTransforms(
    pid,
    `teams/${teamId}`,
    [{ fieldPath: 'coachIds', kind: 'arrayUnion', value: coachUid }],
    null,
    sa,
  );
  await commitDocumentTransforms(
    pid,
    `users/${coachUid}`,
    [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: teamId }],
    { role: 'coach', coachLevel },
    sa,
  );
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /teams/remove-coach — head coach removes a coach from their team.
// ────────────────────────────────────────────────────────────────
async function handleTeamsRemoveCoach(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const coachUid = String(payload?.coachUid || '');
  if (!coachUid) return json({ ok: false, error: 'coach_uid_required' }, 400);

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
  await commitDocumentTransforms(
    pid,
    `users/${targetUid}`,
    [{ fieldPath: 'clubIds', kind: 'arrayUnion', value: clubId }],
    { isClubAdmin: true },
    sa,
  );
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
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /users/set-role — coach changes another user's role in the
// Parent Directory (parent ↔ coach). Requires caller to be a coach
// on a team the target user shares.
// ────────────────────────────────────────────────────────────────
async function handleUsersSetRole(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  await requireCoachOfTeam(req, env, teamId);
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
  const patch: Record<string, any> = { role: nextRole, approved: true };
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
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// /users/deactivate — coach removes / suspends a user on their team.
// Body: { teamId, targetUid, reject?: boolean }  reject=true also
// flips approved:false (post-reject state); default just deactivates.
// ────────────────────────────────────────────────────────────────
async function handleUsersDeactivate(req: Request, env: Env, payload: any): Promise<Response> {
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
    }
  } else {
    if (!userTeamIds.includes(teamId)) {
      await commitDocumentTransforms(
        pid, userTeamsPath,
        [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: teamId }],
        null, sa,
      );
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
  const playerId = await createDocument(pid, 'players', fields, sa);
  await commitDocumentTransforms(
    pid,
    `teams/${teamId}`,
    [{ fieldPath: 'playerIds', kind: 'arrayUnion', value: playerId }],
    null,
    sa,
  );
  return json({ ok: true, playerId, linkedSelfAsParent: linkSelfAsParent });
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
// /players/link-parent — coach adds a parent (uid + email) to a
// player on their team. Auto-fans out user.teamIds too.
// Body: { teamId, playerId, parentUid, parentEmail? }
// ────────────────────────────────────────────────────────────────
async function handlePlayersLinkParent(req: Request, env: Env, payload: any): Promise<Response> {
  const teamId = String(payload?.teamId || '');
  await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);
  const playerId = String(payload?.playerId || '');
  const parentUid = String(payload?.parentUid || '');
  if (!playerId || !parentUid) return json({ ok: false, error: 'ids_required' }, 400);
  const parentEmail = payload?.parentEmail ? normEmail(payload.parentEmail) : '';
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
  if (on && playerTeamIds.length > 0) {
    await commitDocumentTransforms(
      pid,
      `users/${claims.uid}`,
      [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: playerTeamIds }],
      null,
      sa,
    );
  }
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
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// Route dispatcher. index.ts calls this once for /guard/* paths
// so we don't have to add a dozen if-blocks to the main handler.
// Returns null when the pathname isn't a guarded-write route.
// ────────────────────────────────────────────────────────────────
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
    case '/players/create':        return handlePlayersCreate(req, env, payload);
    case '/events/batch-create':   return handleEventsBatchCreate(req, env, payload);
    case '/players/set-active':    return handlePlayersSetActive(req, env, payload);
    case '/players/link-parent':   return handlePlayersLinkParent(req, env, payload);
    case '/players/toggle-self-parent': return handlePlayersToggleSelfParent(req, env, payload);
    case '/players/set-teams':     return handlePlayersSetTeams(req, env, payload);
    case '/club/set-admin':        return handleClubSetAdmin(req, env, payload);
    case '/club/remove-admin':     return handleClubRemoveAdmin(req, env, payload);
    default:                       return null;
  }
}
