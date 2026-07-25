import { Team } from '../types';

/** Per-source XP toggle keys. See team.xpConfig.sources on the type
 *  for the full list + fallbacks.
 *
 *  Ship 1 coarse keys `participation` + `badges` still exist on the
 *  team doc for backwards compat and act as fallbacks below. They're
 *  not valid keys to pass to `isXpSourceEnabled` — the caller should
 *  always ask about the specific action.
 *
 *  `kidChat` stays in the union for backwards compat (older team docs
 *  may have persisted the flag), but the write path was removed
 *  2026-07-17 when chat became intrinsically motivated. It intentionally
 *  no longer appears in XP_SOURCE_LABELS so the toggle disappears from
 *  the UI. */
export type XpSourceKey =
  | 'practice'
  | 'rsvp'
  | 'kidChat'
  | 'practiceAttendance'
  | 'gameAttendance'
  | 'effortBonus'
  | 'firstGoal'
  | 'firstAssist'
  | 'firstSave'
  | 'firstCleanSheet'
  | 'firstPotm'
  | 'streaks'
  | 'perfectAttendance'
  | 'whisper'
  | 'coachLiveGrant'
  | 'kudosConvert'
  | 'gametape';

/** Which Ship 1 coarse key covers each per-source key when the
 *  per-source key is missing (undefined). `whisper` has no coarse
 *  fallback — it was introduced with Ship 2. Attendance + effort keys
 *  are Ship 3 (2026-07-17) and have no coarse fallback either — default
 *  on when absent. */
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
  // Ship 2 coach-action keys — no coarse fallback, no legacy behavior
  // to inherit. Default on when absent (handled below).
  coachLiveGrant: null,
  kudosConvert: null,
  // Ship 3 attendance + effort keys — no coarse fallback. Default on
  // when absent so existing XP-enabled teams pick up the new grants
  // without needing to re-open Coach XP Config.
  practiceAttendance: null,
  gameAttendance: null,
  effortBonus: null,
  // Gametape "Got it" tap +3 XP. No coarse fallback; default on when
  // absent so existing XP-enabled teams pick it up without touching
  // Coach XP Config.
  gametape: null,
};

/** Warm-voice labels for the per-source toggles surfaced in
 *  CoachXpConfig. Not used at grant time.
 *
 *  `kidChat` intentionally omitted here — the toggle was removed from
 *  the UI on 2026-07-17 when kid-chat XP was retired. The key stays in
 *  the union above for backwards compat with team docs that persisted
 *  the flag. Using Partial<Record<>> so callers that iterate
 *  `Object.keys(XP_SOURCE_LABELS)` naturally skip it. */
export const XP_SOURCE_LABELS: Partial<Record<XpSourceKey, string>> = {
  practice: 'Practice log',
  rsvp: 'RSVP flip',
  practiceAttendance: 'Practice attended',
  gameAttendance: 'Game attended',
  effortBonus: 'Effort bonus',
  firstGoal: 'First goal',
  firstAssist: 'First assist',
  firstSave: 'First save',
  firstCleanSheet: 'First clean sheet',
  firstPotm: 'First POTM',
  streaks: 'Streak badges',
  perfectAttendance: 'Perfect attendance',
  whisper: 'Whisper XP',
  coachLiveGrant: 'Live grant',
  kudosConvert: 'Kudos to XP',
  gametape: 'Gametape watched',
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
