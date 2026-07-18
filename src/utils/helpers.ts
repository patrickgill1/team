import { Timestamp } from 'firebase/firestore';

export const cleanFirestoreData = (data: any): any => {
  if (data === null || data === undefined) {
    return null;
  }

  if (Array.isArray(data)) {
    return data.map(item => cleanFirestoreData(item));
  }

  if (data instanceof Date) {
    return data;
  }

  // Firestore Timestamp passthrough. Without this, recursing into a
  // Timestamp's enumerable fields converts it to a plain
  // { seconds, nanoseconds } map on write — the SDK then stores it
  // as a map, not a Timestamp, and the next read gives back
  // 'Invalid Date'. Patrick hit this on dev-plan practiceLog
  // entries: his 'I did it today' taps from prior days rendered as
  // 'Invalid Date' because their nested Timestamps had been
  // flattened by the previous version of this helper on the
  // writeback round-trip.
  if (data instanceof Timestamp) {
    return data;
  }

  if (typeof data === 'object') {
    const cleaned: any = {};

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        cleaned[key] = cleanFirestoreData(value);
      }
    }

    return cleaned;
  }

  return data;
};

export const formatDate = (date: Date | Timestamp): string => {
  const dateObj = date instanceof Timestamp ? date.toDate() : date;
  return dateObj.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
};

export const formatDateTime = (date: Date | Timestamp): string => {
  const dateObj = date instanceof Timestamp ? date.toDate() : date;
  return dateObj.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

export const generateId = (): string => {
  return Math.random().toString(36).substr(2, 9);
};

export const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

export const validateJerseyNumber = (number: number, existingNumbers: number[], currentPlayerId?: string): boolean => {
  return number > 0 && number <= 99 && !existingNumbers.includes(number);
};

export const capitalizeFirst = (str: string): string => {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
};

export const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;
  return text.substr(0, maxLength) + '...';
};

export const sortByDate = <T extends { createdAt: Date | Timestamp }>(items: T[], ascending = false): T[] => {
  return items.sort((a, b) => {
    const dateA = a.createdAt instanceof Timestamp ? a.createdAt.toDate() : a.createdAt;
    const dateB = b.createdAt instanceof Timestamp ? b.createdAt.toDate() : b.createdAt;
    return ascending ? dateA.getTime() - dateB.getTime() : dateB.getTime() - dateA.getTime();
  });
};

export const isCoach = (userRole: string): boolean => {
  return userRole === 'coach';
};

// Team managers and coaches share most management permissions (generating
// invites, viewing rosters, etc.) but only coaches can affect coaching data
// like POTM, dev plans, attendance. Use this when a screen needs the broader
// "any team staff member" gate.
export const isTeamStaff = (userRole: string): boolean => {
  return userRole === 'coach' || userRole === 'team_manager';
};

// ────────────────────────────────────────────────────────────────
// TEAM-SCOPED role helpers — per the coach-role-model memory:
// user.role is GLOBAL identity ('coach' | 'parent' | ...). WHICH
// teams the user coaches lives on team.coachIds (and team.managerIds
// for staff). Gating a team-specific feature on the global role
// alone is a bug: a coach of Team A viewing Team B (where they're
// a parent of a kid) would still see coach-only UI.
//
// Use these when the gate is about "can this user act as a coach
// ON THIS TEAM", not "does this user have coach identity anywhere."
// Callers that don't have a team object (settings pages, top-of-app
// role-mode toggles) legitimately stay on isCoach(userData.role).
// ────────────────────────────────────────────────────────────────
export const isCoachOfTeam = (
  user: { uid?: string } | null | undefined,
  team: { coachIds?: string[] } | null | undefined,
): boolean => {
  if (!user?.uid || !team) return false;
  return Array.isArray(team.coachIds) && team.coachIds.includes(user.uid);
};

// Broader team-staff check: coach OR team_manager on THIS team.
// Use when a feature is available to both roles (roster edit,
// invite generation, event creation).
export const isStaffOfTeam = (
  user: { uid?: string } | null | undefined,
  team: { coachIds?: string[]; managerIds?: string[] } | null | undefined,
): boolean => {
  if (!user?.uid || !team) return false;
  const uid = user.uid;
  return (Array.isArray(team.coachIds) && team.coachIds.includes(uid))
    || (Array.isArray(team.managerIds) && team.managerIds.includes(uid));
};

// Hardcoded super-admin (app owner). Can do anything in the UI,
// regardless of role/coachLevel — including removing other head coaches.
const OWNER_EMAILS = ['patrickgill4@gmail.com'];

export const isOwner = (user: { email?: string } | null | undefined): boolean => {
  if (!user?.email) return false;
  return OWNER_EMAILS.includes(user.email.toLowerCase());
};

export const isHeadCoach = (user: { role?: string; coachLevel?: string; email?: string } | null | undefined): boolean => {
  if (!user) return false;
  if (isOwner(user)) return true;
  return user.role === 'coach' && user.coachLevel === 'head_coach';
};

export const isParent = (userRole: string): boolean => {
  return userRole === 'parent';
};

// True when the user IS the player themself (adult-league path:
// Saturday pickup group, college club teams, rec leagues for adults
// where there is no parent intermediary).
//
// Signal is `selfPlayerId` set on the user doc. The companion
// Player doc carries `isAdultPlayer: true` but we don't need to read
// the player doc here — selfPlayerId is set ONLY when the user joined
// via an adult-league invite (see invites.ts consumeInvite).
//
// Used by chat, RSVP, and dashboard copy to swap "parent" → "player"
// language without a Firestore cross-doc lookup.
export const isAdultPlayer = (user: { selfPlayerId?: string } | null | undefined): boolean => {
  return !!user?.selfPlayerId;
};

// Resolves the senderRole stamped on chat/wall messages. Adult
// players write as 'player' so the bubble label reads correctly;
// everyone else falls through to their user role.
export const resolveSenderRole = (user: { role?: string; selfPlayerId?: string } | null | undefined): 'coach' | 'parent' | 'player' => {
  if (!user) return 'parent';
  if (isAdultPlayer(user)) return 'player';
  if (user.role === 'coach') return 'coach';
  return 'parent';
};

export const getFileExtension = (filename: string): string => {
  return filename.slice(((filename.lastIndexOf('.') - 1) >>> 0) + 2);
};

export const isValidImageFile = (file: File): boolean => {
  const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
  return validTypes.includes(file.type) && file.size <= 5 * 1024 * 1024; // 5MB limit
};

/**
 * Get a player's positions as an array. Reads the new `positions[]` field
 * if present, falls back to the legacy single `position` string. Useful
 * for forms, role-specific stat displays, etc.
 */
export const getPlayerPositions = (player: { positions?: string[]; position?: string } | null | undefined): string[] => {
  if (!player) return [];
  if (Array.isArray(player.positions) && player.positions.length > 0) return player.positions;
  if (player.position) return [player.position];
  return [];
};

/** Joined display label for one or more positions ("Goalkeeper · Midfielder"). */
export const getPlayerPositionsLabel = (player: { positions?: string[]; position?: string } | null | undefined): string => {
  return getPlayerPositions(player).join(' · ');
};

/** True if any of the player's positions is Goalkeeper. Used to show keeper-only stats. */
export const isGoalkeeper = (player: { positions?: string[]; position?: string } | null | undefined): boolean => {
  return getPlayerPositions(player).some(p => p.toLowerCase() === 'goalkeeper');
};

/** True for users with club-admin access. Three paths grant it:
 *  (1) userData.isClubAdmin === true — platform-controlled flag for
 *      Patrick's super-admin role, granted on a per-account basis.
 *  (2) userData.role === 'club_admin' — assigned when someone goes
 *      through the "Start a club, I'm not a coach" onboarding path
 *      (director / registrar / treasurer flow). They run a real club
 *      via clubs.ownerUid but aren't on any team roster.
 *  (3) User owns a personal solo club (auto-created the first time
 *      they set a fee on an event) — clubIds contains
 *      `personal_{uid}`. Opens /club so a standalone coach can
 *      finish Stripe Connect and start collecting drop-in fees
 *      without needing platform-owner intervention.
 *  Any path opens the /club overview and the per-team toolbars for
 *  any team that belongs to a club they own. */
export const isClubAdmin = (userData: any): boolean => {
  if (!userData) return false;
  if (userData.isClubAdmin === true) return true;
  if (userData.role === 'club_admin') return true;
  if (userData.uid) {
    const soloId = `personal_${userData.uid}`;
    if (userData.clubId === soloId) return true;
    if (Array.isArray(userData.clubIds) && userData.clubIds.includes(soloId)) return true;
  }
  return false;
};

/** Who is allowed to upload + edit + tag + thumbnail clips on a team.
 *  Staff (coach / team manager / club admin / owner) are always in;
 *  parents are only in if the coach has explicitly added their uid to
 *  team.mediaUploaders (e.g. the tracking-cam parent). Returning false
 *  means the upload/edit UI should be hidden, not just disabled, to
 *  avoid the "why is this button greyed out" support question. */
export const canManageTeamMedia = (
  userData: { uid?: string; role?: string; email?: string; isClubAdmin?: boolean } | null | undefined,
  team: { mediaUploaders?: string[] } | null | undefined,
): boolean => {
  if (!userData) return false;
  if (isOwner(userData)) return true;
  if (isClubAdmin(userData)) return true;
  if (userData.role && isTeamStaff(userData.role)) return true;
  const uid = userData.uid;
  if (uid && Array.isArray(team?.mediaUploaders) && team!.mediaUploaders!.includes(uid)) return true;
  return false;
};