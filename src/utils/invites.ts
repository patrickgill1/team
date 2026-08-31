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
  // 2026-07-19: was dropping opts.relationship==='parent' as a legacy
  // "no real info" signal, which meant mom/dad accepters ended up
  // with user.relationship=undefined and the self-Kudos gate couldn't
  // tell them from grandma-with-undefined. Now we stamp whatever
  // the caller picked (including 'parent') and let the worker + the
  // ParentDirectory chip helper handle the display.
  if (opts.relationship) inv.relationship = opts.relationship;
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

// 2026-08-31: team-level self-serve invite for ADULT teams. One link
// the coach shares with a whole pickup group / league; each recipient
// signs in with their own account and the worker creates their player
// doc automatically (name from their user profile). No coach setup
// per person, no pre-created players. Youth self-serve is a separate
// path (needs a form for kid details, deferred).
interface CreateTeamSelfServeAdultInviteOpts {
  teamId: string;
  createdBy: string;
  ttlDays?: number;
  /** null = unlimited. Reasonable for a season-long pickup link. */
  maxUses?: number | null;
  note?: string;
}

export async function createTeamSelfServeAdultInvite(
  opts: CreateTeamSelfServeAdultInviteOpts,
): Promise<Invite> {
  const id = newSlug();
  const ttl = opts.ttlDays ?? 90;
  const expiresAt = new Date(Date.now() + ttl * 24 * 3600 * 1000);
  const inv: any = {
    id,
    type: 'team_self_serve_adult',
    teamId: opts.teamId,
    createdBy: opts.createdBy,
    createdAt: serverTimestamp(),
    expiresAt,
    // Default unlimited so a coach shares one link with a 60-person
    // pickup and doesn't have to regenerate.
    maxUses: opts.maxUses === undefined ? null : opts.maxUses,
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

  // The full read-verify-mutate-write cascade lives on the worker.
  // Client just posts the invite id; server checks the token, applies
  // side-effects (player.parentIds, user.role/teamIds, invite.usedBy,
  // coverageSource for club-covered coaches) with the service account,
  // and returns the result.
  //
  // Rejection reasons are mapped back to the legacy client string
  // codes ('not-found', 'expired', 'exhausted', etc.) so InviteJoin's
  // error copy doesn't need to change.
  try {
    const { workerFetch } = await import('./workerFetch');
    const res = await workerFetch('/claim/invite', {
      method: 'POST',
      body: JSON.stringify({ inviteId }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      const code = String(data?.error || `http-${res.status}`);
      // Map worker error codes to the strings the caller UI expects.
      const legacyReason =
        code === 'invite_not_found'    ? 'not-found' :
        code === 'invite_revoked'      ? 'revoked' :
        code === 'invite_expired'      ? 'expired' :
        code === 'invite_exhausted'    ? 'exhausted' :
        code === 'already_used'        ? 'already-used' :
        code === 'invite_missing_team' ? 'invite-malformed' :
        code === 'invite_missing_player' ? 'invite-malformed' :
        code === 'unknown_invite_type' ? 'unknown-invite-type' :
        code === 'not-signed-in'       ? 'user-doc-missing' :
        code;
      return { ok: false, reason: legacyReason };
    }
    return {
      ok: true,
      type: (data.type as Invite['type']) || 'player',
      teamId: String(data.teamId || ''),
      playerId: data.playerId ? String(data.playerId) : undefined,
    };
  } catch (err) {
    console.warn('[consumeInvite] worker call failed', err);
    return { ok: false, reason: String((err as any)?.message || err) };
  }
}

export async function revokeInvite(inviteId: string): Promise<void> {
  await updateDoc(doc(db, COLL, inviteId), { revokedAt: serverTimestamp() });
}

/** Build the share URL — used by both Copy and SMS buttons. */
export function inviteUrl(inviteId: string): string {
  // Use the canonical app origin — window.location.origin on
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
