// @ts-nocheck
import type { Club, ClubAdminScope } from '../types';
import { ALL_CLUB_SCOPES } from '../types';

// Re-export so callers can import everything from one place.
export { ALL_CLUB_SCOPES };

/**
 * Resolve the scopes a user holds on a given club.
 *
 *   Owner            -> every scope, always (implicit).
 *   Has adminScopes  -> exactly that list.
 *   In adminUids     -> all scopes (legacy 'director' fallback).
 *   None of the above -> empty.
 *
 * Resolution lives in JS (not in firestore.rules) so the UI can do
 * fine-grained gating without a doc read on every click. The
 * rules layer keeps the coarse 'is the user authorized to write
 * anywhere in this club' check; scoped enforcement is the team
 * app's responsibility AND the admin portal's job to surface.
 */
export function resolveClubScopes(uid: string | null | undefined, club: Club | null | undefined): ClubAdminScope[] {
  if (!uid || !club) return [];
  if (club.ownerUid === uid) return [...ALL_CLUB_SCOPES];
  const scoped = club.adminScopes?.[uid];
  if (Array.isArray(scoped)) return scoped as ClubAdminScope[];
  if (Array.isArray(club.adminUids) && club.adminUids.includes(uid)) return [...ALL_CLUB_SCOPES];
  return [];
}

/** True iff the user has the requested scope on the club. */
export function hasClubScope(uid: string | null | undefined, club: Club | null | undefined, scope: ClubAdminScope): boolean {
  const scopes = resolveClubScopes(uid, club);
  return scopes.includes(scope);
}

/** Friendly label for the scope chips + checkbox labels. */
export const CLUB_SCOPE_LABELS: Record<ClubAdminScope, { label: string; hint: string }> = {
  financials:    { label: 'Financials',    hint: 'Revenue, refunds, payouts, payments setup' },
  rosters:       { label: 'Rosters',       hint: 'Add and edit players + parents' },
  registrations: { label: 'Registrations', hint: 'Open, close, refund registration cycles' },
  events:        { label: 'Events',        hint: 'Games and practices' },
  comms:         { label: 'Comms',         hint: 'Chat blasts and push notifications' },
  tickets:       { label: 'Tickets',       hint: 'Support and helpdesk inboxes' },
  admins:        { label: 'Admins',        hint: 'Grant or revoke other admins (director power)' },
};

/** Useful preset for the 'second director' role Patrick described. */
export const DIRECTOR_PRESET: ClubAdminScope[] = ['rosters', 'registrations', 'events', 'comms', 'tickets', 'admins'];

/** Preset for a registrar / treasurer who handles money but not the rest. */
export const TREASURER_PRESET: ClubAdminScope[] = ['financials', 'registrations'];

/** Preset for a comms-only volunteer. */
export const COMMUNICATIONS_PRESET: ClubAdminScope[] = ['comms', 'tickets'];
