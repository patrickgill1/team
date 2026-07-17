// XP level ladder — private per-season progression.
//
// Curve tuning per Patrick 2026-07-17 rebalance: the 1.10 growth
// curve was too flat — a committed kid was hitting L20+ mid-season,
// which drained the meaning out of the top labels. Bumped BASE to
// 100 and GROWTH to 1.40 so the top of the ladder actually reads
// like a career arc, not a treadmill. Base + exponential growth.
// Base is still small enough that the first level-up happens on
// the first meaningful action (one attendance mark or one coach
// recognition is enough); growth of 1.40 means each subsequent
// level costs ~40% more XP than the one before it, so late-season
// levels feel earned.
//
// Cumulative XP to reach level N (from level 1) follows the standard
// geometric-series formula:
//   XP(N) = BASE * (GROWTH^(N-1) - 1) / (GROWTH - 1)
//
// Sample cumulative thresholds (base 100, growth 1.40, rounded):
//   L1 -> 0        L6 -> 1095
//   L2 -> 100      L7 -> 1632
//   L3 -> 240      L8 -> 2385
//   L4 -> 436      L9 -> 3439
//   L5 -> 710
//
// A typical 12-game season should land a kid in L5-L6; a standout
// season lands L7-L8; L9+ is career/legendary territory that only
// shows up after multiple strong seasons stack. Feels right for
// "a career, not a leaderboard."
//
// Levels reset each season (matches the "career, not a leaderboard"
// philosophy). Career badges + season titles persist in Phase 4.

export const XP_LEVEL_BASE = 100;
export const XP_LEVEL_GROWTH = 1.40;
export const XP_LEVEL_CAP = 200; // safety ceiling; nobody should hit this in youth soccer

/**
 * Cumulative XP required to REACH level N (i.e. transition from
 * level N-1 to level N). Level 1 is 0 XP. Returns a rounded integer.
 */
export function xpThresholdForLevel(level: number): number {
  if (level <= 1) return 0;
  const raw = XP_LEVEL_BASE * (Math.pow(XP_LEVEL_GROWTH, level - 1) - 1) / (XP_LEVEL_GROWTH - 1);
  return Math.round(raw);
}

export interface XpLevelProgress {
  level: number;
  /** Cumulative XP at the start of the current level. */
  currentLevelThreshold: number;
  /** Cumulative XP required to reach the next level. */
  nextLevelThreshold: number;
  /** XP earned since hitting the current level. */
  xpIntoLevel: number;
  /** XP remaining until the next level-up. */
  xpToNextLevel: number;
  /** Progress bar fill 0-100. */
  progressPercent: number;
}

/**
 * Given a player's total XP, return level + progress. Pure function
 * so the same input always gives the same shape; safe to call from
 * every render.
 */
export function computeXpLevel(xp: number): XpLevelProgress {
  const safeXp = Math.max(0, Math.floor(xp));
  // Walk up levels until the next threshold overshoots our XP.
  // Bounded by XP_LEVEL_CAP so a runaway loop can't happen even if
  // someone force-writes a huge XP number.
  let level = 1;
  while (level < XP_LEVEL_CAP && xpThresholdForLevel(level + 1) <= safeXp) {
    level++;
  }
  const currentLevelThreshold = xpThresholdForLevel(level);
  const nextLevelThreshold = xpThresholdForLevel(level + 1);
  const span = Math.max(1, nextLevelThreshold - currentLevelThreshold);
  const xpIntoLevel = safeXp - currentLevelThreshold;
  const xpToNextLevel = Math.max(0, nextLevelThreshold - safeXp);
  const progressPercent = Math.min(100, Math.max(0, Math.round((xpIntoLevel / span) * 100)));
  return {
    level,
    currentLevelThreshold,
    nextLevelThreshold,
    xpIntoLevel,
    xpToNextLevel,
    progressPercent,
  };
}
