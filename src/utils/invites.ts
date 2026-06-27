/**
 * Invites — Phase 3 of the seasons + invites redesign.
 *
 * Replaces the email-up-front + approval-queue flow with shareable links:
 *   - Player invite (`type: 'player'`) → tied to a specific playerId. Holding
 *     the link is the trust signal; the parent that consumes it gets pushed
 *     into player.parentIds and is auto-approved.
 *   - Coach / team-manager invite (`type: 'coach' | 'team_manager'`) → grants
 *     the named role on a team. Reusable up to maxUses (default 3 for staff).
 *
 * Coexists with the legacy player.inviteCode flow during transition; the
 * new /join/<inviteId> page checks both.
 */

import {
  collection, doc, getDoc, setDoc, updateDoc, addDoc, runTransaction,
  serverTimestamp, arrayUnion, increment,
} from 'firebase/firestore';
import { db } from './firebase';
import { getShareOrigin } from './origin';
import type { Invite } from '../types';

const COLL = 'invites';

// 12-char URL-safe slug — short enough to text, long enough to be unguessable.
function newSlug(): string {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
}

const DEFAULT_TTL_DAYS = 30;
const STAFF_DEFAULT_USES = 3;
const PLAYER_DEFAULT_USES = 5;

interface CreatePlayerInviteOpts {
  teamId: string;
  playerId: string;
  createdBy: string;
  ttlDays?: number;
  maxUses?: number | null; // null = unlimited
  note?: string;
  /** Family relationship of the invitee. Defaults to 'parent' when
   *  unset (every legacy invite). Stamped on the new user's doc by
   *  consumeInvite so the directory can show 'Grandparent of X'. */
  relationship?: 'parent' | 'grandparent' | 'aunt_uncle' | 'guardian' | 'sibling' | 'other';
  /** When true: invitee IS the player (adult-team format). On
   *  consume, the joining user gets selfPlayerId pointed at the
   *  player AND the player doc gets isAdultPlayer=true. */
  isAdultPlayer?: boolean;
}
interface CreateStaffInviteOpts {
  teamId: string;
  role: 'assistant_coach' | 'head_coach' | 'team_manager';
  createdBy: string;
  ttlDays?: number;
  maxUses?: number | null;
  note?: string;
}

export async function createPlayerInvite(opts: CreatePlayerInviteOpts): Promise<Invite> {
  const id = newSlug();
  const ttl = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const expiresAt = new Date(Date.now() + ttl * 24 * 3600 * 1000);
  // Firestore rejects `undefined` values, so build the doc with only the
  // fields we have. Omit `note` when the caller didn't pass one.
  const inv: any = {
    id,
    type: 'player',
    teamId: opts.teamId,
    playerId: opts.playerId,
    createdBy: opts.createdBy,
    createdAt: serverTimestamp(),
    expiresAt,
    maxUses: opts.maxUses === undefined ? PLAYER_DEFAULT_USES : opts.maxUses,
    usedCount: 0,
    usedBy: [],
  };
  if (opts.note) inv.note = opts.note;
  if (opts.relationship && opts.relationship !== 'parent') inv.relationship = opts.relationship;
  if (opts.isAdultPlayer) inv.isAdultPlayer = true;
  await setDoc(doc(db, COLL, id), inv);
  return { ...inv, createdAt: new Date() } as Invite;
}

export async function createStaffInvite(opts: CreateStaffInviteOpts): Promise<Invite> {
  const id = newSlug();
  const ttl = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const expiresAt = new Date(Date.now() + ttl * 24 * 3600 * 1000);
  const inv: any = {
    id,
    type: opts.role === 'team_manager' ? 'team_manager' : 'coach',
    teamId: opts.teamId,
    role: opts.role,
    createdBy: opts.createdBy,
    createdAt: serverTimestamp(),
    expiresAt,
    maxUses: opts.maxUses === undefined ? STAFF_DEFAULT_USES : opts.maxUses,
    usedCount: 0,
    usedBy: [],
  };
  if (opts.note) inv.note = opts.note;
  await setDoc(doc(db, COLL, id), inv);
  return { ...inv, createdAt: new Date() } as Invite;
}

export interface FetchedInvite extends Invite {
  expired: boolean;
  exhausted: boolean;
  revoked: boolean;
}

export async function fetchInvite(id: string): Promise<FetchedInvite | null> {
  if (!id) return null;
  const snap = await getDoc(doc(db, COLL, id));
  if (!snap.exists()) return null;
  const v: any = snap.data();
  const expiresAt: Date = v.expiresAt?.toDate ? v.expiresAt.toDate() : new Date(v.expiresAt);
  const expired = expiresAt.getTime() < Date.now();
  const exhausted = v.maxUses != null && (v.usedCount || 0) >= v.maxUses;
  const revoked = !!v.revokedAt;
  return {
    id: snap.id,
    type: v.type,
    teamId: v.teamId,
    playerId: v.playerId,
    role: v.role,
    createdBy: v.createdBy,
    createdAt: v.createdAt?.toDate ? v.createdAt.toDate() : new Date(v.createdAt || Date.now()),
    expiresAt,
    maxUses: v.maxUses,
    usedCount: v.usedCount || 0,
    usedBy: v.usedBy || [],
    revokedAt: v.revokedAt?.toDate ? v.revokedAt.toDate() : undefined,
    note: v.note,
    expired,
    exhausted,
    revoked,
  };
}

/**
 * Mark an invite consumed by `uid` and apply its side-effects atomically:
 *   - player invite → push uid into player.parentIds, mark user approved
 *   - staff invite  → set user's role + coachLevel (coach) or role (team_manager)
 *
 * Caller is responsible for first creating/signing-in the user. We just
 * link them to the team/player and bump the counter.
 */
export async function consumeInvite(inviteId: string, uid: string): Promise<{ ok: true; type: Invite['type']; teamId: string; playerId?: string } | { ok: false; reason: string }> {
  if (!inviteId || !uid) return { ok: false, reason: 'missing-args' };

  return runTransaction(db, async (tx) => {
    const inviteRef = doc(db, COLL, inviteId);
    const userRef = doc(db, 'users', uid);

    const inviteSnap = await tx.get(inviteRef);
    if (!inviteSnap.exists()) return { ok: false, reason: 'not-found' as const };
    const inv: any = inviteSnap.data();
    if (inv.revokedAt) return { ok: false, reason: 'revoked' as const };
    const expiresAt: Date = inv.expiresAt?.toDate ? inv.expiresAt.toDate() : new Date(inv.expiresAt);
    if (expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' as const };
    if (inv.maxUses != null && (inv.usedCount || 0) >= inv.maxUses) return { ok: false, reason: 'exhausted' as const };
    if (Array.isArray(inv.usedBy) && inv.usedBy.includes(uid)) {
      return { ok: true as const, type: inv.type, teamId: inv.teamId, playerId: inv.playerId };
    }

    const userSnap = await tx.get(userRef);
    if (!userSnap.exists()) return { ok: false, reason: 'user-doc-missing' as const };

    // Side-effects per invite type ----
    if (inv.type === 'player') {
      if (!inv.playerId) return { ok: false, reason: 'invite-malformed' as const };
      const playerRef = doc(db, 'players', inv.playerId);
      // Adult-player invites: the joining user IS the player. Stamp
      // isAdultPlayer on the player doc so UI labels flip from
      // 'your kid' to 'you'. Permissions still flow through
      // parentIds (the adult is their own parent in the data) so
      // nothing else has to branch on the flag.
      const isAdultPlayer = !!(inv as any).isAdultPlayer;
      const playerPatch: Record<string, any> = { parentIds: arrayUnion(uid) };
      if (isAdultPlayer) playerPatch.isAdultPlayer = true;
      tx.update(playerRef, playerPatch);
      // Stamp relationship from the invite (default 'parent' for
      // legacy invites that pre-date the field) so the directory
      // can label them as "Grandparent of Hunter" etc.
      const relationship = (inv as any).relationship || 'parent';
      const userPatch: Record<string, any> = {
        role: 'parent',
        relationship,
        teamId: inv.teamId,
        teamIds: arrayUnion(inv.teamId),
        approved: true,
        approvalStatus: 'auto',
        approvedAt: serverTimestamp(),
        invitedBy: inv.createdBy,
        invitedVia: inviteId,
      };
      if (isAdultPlayer) userPatch.selfPlayerId = inv.playerId;
      tx.update(userRef, userPatch);
    } else if (inv.type === 'coach') {
      tx.update(userRef, {
        role: 'coach',
        coachLevel: inv.role || 'assistant_coach',
        teamId: inv.teamId,
        teamIds: arrayUnion(inv.teamId),
        approved: true,
        approvalStatus: 'auto',
        approvedAt: serverTimestamp(),
        invitedBy: inv.createdBy,
        invitedVia: inviteId,
      });
    } else if (inv.type === 'team_manager') {
      tx.update(userRef, {
        role: 'team_manager',
        teamId: inv.teamId,
        teamIds: arrayUnion(inv.teamId),
        approved: true,
        approvalStatus: 'auto',
        approvedAt: serverTimestamp(),
        invitedBy: inv.createdBy,
        invitedVia: inviteId,
      });
    } else {
      return { ok: false, reason: 'unknown-invite-type' as const };
    }

    tx.update(inviteRef, {
      usedCount: increment(1),
      usedBy: arrayUnion(uid),
    });

    return { ok: true as const, type: inv.type as Invite['type'], teamId: inv.teamId, playerId: inv.playerId };
  }).then(async (result: any) => {
    // Post-transaction: an invited coach / team_manager joining a
    // team that belongs to a real (non-default-solo) club inherits
    // their coverage from the club. They don't need to start their
    // own trial — the club owner is paying for the platform on
    // their staff's behalf. Stamp coverageSource so useTrialGate
    // can un-gate without re-doing this lookup on every render.
    //
    // Outside the transaction because it needs reads from teams +
    // clubs collections, and getting those into the same tx for
    // every invite consume would balloon doc-read costs on parent
    // invites that don't care.
    if (!result.ok) return result;
    if (result.type !== 'coach' && result.type !== 'team_manager') return result;
    try {
      const teamSnap = await getDoc(doc(db, 'teams', result.teamId));
      if (!teamSnap.exists()) return result;
      const teamData: any = teamSnap.data();
      const clubId: string | undefined = teamData.clubId;
      if (!clubId) return result;
      const clubSnap = await getDoc(doc(db, 'clubs', clubId));
      if (!clubSnap.exists()) return result;
      const clubData: any = clubSnap.data();
      // Skip default-solo clubs — those are the implicit wrapper
      // around a single-coach team and the owner pays as a
      // Coach-tier subscriber, not as a club. Their invited
      // assistant coaches still need to pay.
      if (clubData.isDefaultSoloClub === true) return result;
      await updateDoc(doc(db, 'users', uid), {
        coverageSource: 'club',
        coverageClubId: clubId,
      });
    } catch (err) {
      // Non-fatal — coach still joins the team, just hits the
      // trial gate. Better than failing the whole invite consume.
      console.warn('[consumeInvite] club coverage stamp failed', err);
    }
    return result;
  });
}

export async function revokeInvite(inviteId: string): Promise<void> {
  await updateDoc(doc(db, COLL, inviteId), { revokedAt: serverTimestamp() });
}

/** Build the share URL — used by both Copy and SMS buttons. */
export function inviteUrl(inviteId: string): string {
  // Use the canonical web origin (firefc.app) — window.location.origin on
  // the Capacitor iOS shell is `capacitor://localhost`, which a recipient
  // can't open.
  return `${getShareOrigin()}/join/${inviteId}`;
}

/** Build a tel:// or sms:// link with prefilled message, for the iOS share sheet. */
export function smsShareLink(playerName: string, inviteId: string): string {
  const url = inviteUrl(inviteId);
  const body = `Join ${playerName} on GoalKickr: ${url}`;
  return `sms:&body=${encodeURIComponent(body)}`;
}
