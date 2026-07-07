// Per-team staff permissions.
//
// Every team has a small set of gated capabilities. Head coach has
// all of them implicitly. Assistants and managers get role-defaulted
// versions on promotion, and the head coach can override any of them
// per-person via team.staffPermissions[uid][key].
//
// Storage: team.staffPermissions is a map `{ [uid]: PermissionMap }`.
// Absent uid = fall back to role defaults. Absent key on an existing
// map = fall back to role default for THAT key. That way we can add
// new permission keys later without a migration — existing entries
// just fall back to whatever the new default is.
//
// See discussion at 2026-07-07 planning session for the defaults.

export type StaffPermissionKey =
  | 'gameday'         // Run GameDay (subs, minutes, stats)
  | 'planPractice'    // Plan practice (assign drills to a session)
  | 'manageRoster'    // Add / edit players (not delete)
  | 'uploadDrills'    // Upload drills to the library
  | 'postMedia'       // Post media / assign POTM
  | 'manageSchedule'  // Create / edit events
  | 'chat'            // Team chat + announcements
  | 'viewDues'        // See payment / dues info (Club Pro)
  | 'deletePlayers';  // DANGER: delete players from the roster

export type StaffPermissionMap = Partial<Record<StaffPermissionKey, boolean>>;

// Every listed key here is the union — makes it easy to iterate for
// UI (checkbox list) without repeating.
export const ALL_STAFF_PERMISSIONS: StaffPermissionKey[] = [
  'gameday',
  'planPractice',
  'manageRoster',
  'uploadDrills',
  'postMedia',
  'manageSchedule',
  'chat',
  'viewDues',
  'deletePlayers',
];

// Human-facing label + short hint for the toggles.
export const STAFF_PERMISSION_META: Record<StaffPermissionKey, { label: string; hint: string; group: 'coaching' | 'content' | 'logistics' | 'danger' }> = {
  gameday:         { label: 'Run GameDay',          hint: 'Subs, minutes, stats during live games.',                        group: 'coaching' },
  planPractice:    { label: 'Plan practice',        hint: 'Assign drills to a session.',                                    group: 'coaching' },
  manageRoster:    { label: 'Manage roster',        hint: 'Add and edit players. Deleting is separate (danger).',           group: 'coaching' },
  uploadDrills:    { label: 'Upload drills',        hint: 'Add drills to the team library.',                                group: 'content' },
  postMedia:       { label: 'Post media / POTM',    hint: 'Upload photos, clips, and assign Player of the Match.',          group: 'content' },
  manageSchedule:  { label: 'Manage schedule',      hint: 'Create and edit events.',                                        group: 'logistics' },
  chat:            { label: 'Chat + announcements', hint: 'Post to team chat and send team-wide announcements.',            group: 'logistics' },
  viewDues:        { label: 'View dues',            hint: 'See payment and dues info (Club Pro).',                          group: 'logistics' },
  deletePlayers:   { label: 'Delete players',       hint: 'Off by default even for assistants. Head coach opts in per person.', group: 'danger' },
};

// Defaults for each role. Assistant vs manager only differ on
// planPractice (assistant only by default) and viewDues (manager
// only by default). Everything else lines up because a modern team
// staff shares most operational surfaces.
export const DEFAULT_PERMISSIONS_ASSISTANT: Required<StaffPermissionMap> = {
  gameday: true,
  planPractice: true,
  manageRoster: true,
  uploadDrills: true,
  postMedia: true,
  manageSchedule: true,
  chat: true,
  viewDues: false,
  deletePlayers: false,
};

export const DEFAULT_PERMISSIONS_MANAGER: Required<StaffPermissionMap> = {
  gameday: true,
  planPractice: false,
  manageRoster: true,
  uploadDrills: true,
  postMedia: true,
  manageSchedule: true,
  chat: true,
  viewDues: true,
  deletePlayers: false,
};

// Shape of the team fields this module reads. Anything more specific
// belongs on the Team type in types/index.ts — this is just the
// minimum surface hasStaffPermission cares about, so the helper can
// be called with a partial team object without a cast.
export interface TeamPermissionInput {
  headCoachId?: string;
  assistantCoachIds?: string[];
  managerIds?: string[];
  coachIds?: string[];
  staffPermissions?: Record<string, StaffPermissionMap>;
}

/**
 * Does `user` have `key` permission on `team`?
 *
 * Head coach on the team → always true (all permissions).
 * Otherwise:
 *   1. Explicit override in team.staffPermissions[uid][key] wins.
 *   2. If the user is an assistant, fall back to
 *      DEFAULT_PERMISSIONS_ASSISTANT[key].
 *   3. If the user is a manager, fall back to
 *      DEFAULT_PERMISSIONS_MANAGER[key].
 *   4. Otherwise (parents, unrelated coaches from another team,
 *      unauthed) → false.
 *
 * Coach-role users NOT specifically on this team return false.
 * The whole point of this migration is to replace global
 * isCoach(userData.role) checks that couldn't tell those apart.
 */
export function hasStaffPermission(
  user: { uid?: string } | null | undefined,
  team: TeamPermissionInput | null | undefined,
  key: StaffPermissionKey,
): boolean {
  if (!user?.uid || !team) return false;
  const uid = user.uid;
  if (team.headCoachId === uid) return true;
  const explicit = team.staffPermissions?.[uid]?.[key];
  if (typeof explicit === 'boolean') return explicit;
  const isAssistant = Array.isArray(team.assistantCoachIds) && team.assistantCoachIds.includes(uid);
  if (isAssistant) return DEFAULT_PERMISSIONS_ASSISTANT[key];
  const isManager = Array.isArray(team.managerIds) && team.managerIds.includes(uid);
  if (isManager) return DEFAULT_PERMISSIONS_MANAGER[key];
  return false;
}

/**
 * Convenience: is the user any kind of staff on this team? Head
 * coach OR assistant OR manager. Useful for "is this user allowed
 * to see the roster page at all" kind of gates that don't map to a
 * specific permission.
 */
export function isTeamStaff(
  user: { uid?: string } | null | undefined,
  team: TeamPermissionInput | null | undefined,
): boolean {
  if (!user?.uid || !team) return false;
  const uid = user.uid;
  if (team.headCoachId === uid) return true;
  if (Array.isArray(team.assistantCoachIds) && team.assistantCoachIds.includes(uid)) return true;
  if (Array.isArray(team.managerIds) && team.managerIds.includes(uid)) return true;
  return false;
}

/**
 * Effective permission map for a user on a team, with defaults
 * merged in. Used by the Staff Management UI to show what a person
 * actually gets in real life — the raw staffPermissions[uid] map
 * only shows overrides, so the checkboxes would look wrong without
 * filling in the missing keys from role defaults.
 */
export function effectivePermissions(
  user: { uid?: string } | null | undefined,
  team: TeamPermissionInput | null | undefined,
): StaffPermissionMap {
  if (!user?.uid || !team) return {};
  const uid = user.uid;
  if (team.headCoachId === uid) {
    // Everything on for the head coach; no map to show or edit.
    return ALL_STAFF_PERMISSIONS.reduce<StaffPermissionMap>((acc, k) => {
      acc[k] = true;
      return acc;
    }, {});
  }
  const isAssistant = Array.isArray(team.assistantCoachIds) && team.assistantCoachIds.includes(uid);
  const isManager = Array.isArray(team.managerIds) && team.managerIds.includes(uid);
  const defaults = isAssistant ? DEFAULT_PERMISSIONS_ASSISTANT
                : isManager   ? DEFAULT_PERMISSIONS_MANAGER
                : {} as Required<StaffPermissionMap>;
  const overrides = team.staffPermissions?.[uid] || {};
  return { ...defaults, ...overrides };
}
