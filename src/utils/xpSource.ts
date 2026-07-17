import { Team } from '../types';

/** Per-source XP toggle keys. See team.xpConfig.sources on the type
 *  for the full list + fallbacks. Coach live grants + kudos->XP
 *  conversion do NOT flow through this helper — those stay on
 *  whenever master is on (coach chose to grant).
 *
 *  Ship 1 coarse keys `participation` + `badges` still exist on the
 *  team doc for backwards compat and act as fallbacks below. They're
 *  not valid keys to pass to `isXpSourceEnabled` — the caller should
 *  always ask about the specific action. */
export type XpSourceKey =
  | 'practice'
  | 'rsvp'
  | 'kidChat'
  | 'firstGoal'
  | 'firstAssist'
  | 'firstSave'
  | 'firstCleanSheet'
  | 'firstPotm'
  | 'streaks'
  | 'perfectAttendance'
  | 'whisper';

/** Which Ship 1 coarse key covers each per-source key when the
 *  per-source key is missing (undefined). `whisper` has no coarse
 *  fallback — it was introduced with Ship 2. */
const COARSE_FALLBACK: Record<XpSourceKey, 'participation' | 'badges' | null> = {
  practice: 'participation',
  rsvp: 'participation',
  kidChat: 'participation',
  firstGoal: 'badges',
  firstAssist: 'badges',
  firstSave: 'badges',
  firstCleanSheet: 'badges',
  firstPotm: 'badges',
  streaks: 'badges',
  perfectAttendance: 'badges',
  whisper: null,
};

/** Warm-voice labels for the per-source toggles surfaced in
 *  CoachXpConfig. Not used at grant time. */
export const XP_SOURCE_LABELS: Record<XpSourceKey, string> = {
  practice: 'Practice log',
  rsvp: 'RSVP flip',
  kidChat: 'Kid chat',
  firstGoal: 'First goal',
  firstAssist: 'First assist',
  firstSave: 'First save',
  firstCleanSheet: 'First clean sheet',
  firstPotm: 'First POTM',
  streaks: 'Streak badges',
  perfectAttendance: 'Perfect attendance',
  whisper: 'Whisper XP',
};

/**
 * Is a specific XP source enabled for this team?
 *
 * Rules:
 *  1. Master `team.xpConfig.enabled` false (or missing) => everything off.
 *  2. `team.xpConfig.sources[key]` defined => use it (explicit wins).
 *  3. Otherwise fall back to the Ship 1 coarse key (participation or
 *     badges) if that's defined.
 *  4. Nothing set => default true. Backwards compatible with teams
 *     that only turned master on.
 */
export function isXpSourceEnabled(
  team: Team | null | undefined,
  key: XpSourceKey,
): boolean {
  if (!team?.xpConfig?.enabled) return false;
  const sources = team.xpConfig.sources;
  if (!sources) return true;
  const explicit = (sources as Record<string, unknown>)[key];
  if (explicit === false) return false;
  if (explicit === true) return true;
  // Per-source key missing — consult the coarse fallback.
  const coarse = COARSE_FALLBACK[key];
  if (coarse) {
    const coarseVal = (sources as Record<string, unknown>)[coarse];
    if (coarseVal === false) return false;
    if (coarseVal === true) return true;
  }
  // Nothing set — default on.
  return true;
}
