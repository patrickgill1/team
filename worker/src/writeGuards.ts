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
  };
  await patchDocument(pid, `users/${claims.uid}`, initialFields, sa);

  // Email-match auto-link. Parents get pre-approved when their email
  // was already on a player's parentEmails (added by the coach who
  // invited them). Idempotent — arrayUnion won't duplicate.
  const linked: { playerId: string; teamIds: string[] }[] = [];
  if (email && wantRole !== 'coach') {
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
    if (teamsToAdd.length > 0) {
      await commitDocumentTransforms(
        pid,
        `users/${claims.uid}`,
        [{ fieldPath: 'teamIds', kind: 'arrayUnion', value: teamsToAdd }],
        { approved: true, approvalStatus: 'auto-email-match' },
        sa,
      );
    }
  }

  return json({ ok: true, uid: claims.uid, linkedCount: linked.length });
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
    case '/club/set-admin':        return handleClubSetAdmin(req, env, payload);
    case '/club/remove-admin':     return handleClubRemoveAdmin(req, env, payload);
    default:                       return null;
  }
}
