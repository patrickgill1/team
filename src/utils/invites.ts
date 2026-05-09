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
  const inv: Omit<Invite, 'createdAt'> & { createdAt: any } = {
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
    note: opts.note,
  };
  await setDoc(doc(db, COLL, id), inv);
  return { ...inv, createdAt: new Date() };
}

export async function createStaffInvite(opts: CreateStaffInviteOpts): Promise<Invite> {
  const id = newSlug();
  const ttl = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const expiresAt = new Date(Date.now() + ttl * 24 * 3600 * 1000);
  const inv: Omit<Invite, 'createdAt'> & { createdAt: any } = {
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
    note: opts.note,
  };
  await setDoc(doc(db, COLL, id), inv);
  return { ...inv, createdAt: new Date() };
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
      tx.update(playerRef, { parentIds: arrayUnion(uid) });
      tx.update(userRef, {
        role: 'parent',
        teamId: inv.teamId,
        teamIds: arrayUnion(inv.teamId),
        approved: true,
        approvalStatus: 'auto',
        approvedAt: serverTimestamp(),
        invitedBy: inv.createdBy,
        invitedVia: inviteId,
      });
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
  });
}

export async function revokeInvite(inviteId: string): Promise<void> {
  await updateDoc(doc(db, COLL, inviteId), { revokedAt: serverTimestamp() });
}

/** Build the share URL — used by both Copy and SMS buttons. */
export function inviteUrl(inviteId: string): string {
  const origin = (typeof window !== 'undefined' && window.location?.origin) || 'https://firefc16.com';
  return `${origin}/join/${inviteId}`;
}

/** Build a tel:// or sms:// link with prefilled message, for the iOS share sheet. */
export function smsShareLink(playerName: string, inviteId: string): string {
  const url = inviteUrl(inviteId);
  const body = `Join ${playerName} on Fire FC: ${url}`;
  return `sms:&body=${encodeURIComponent(body)}`;
}
