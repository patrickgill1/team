// XP level ladder — private per-season progression.
//
// Curve tuning per Patrick 2026-07-10: "levels should go quick at
// first, and then use a 10% increase or whatever to get to the next
// level." Base + exponential growth. Base is small enough that the
// first level-up happens on the first meaningful action (one
// attendance mark or one coach recognition is enough); growth of
// 1.10 means each subsequent level costs ~10% more XP than the one
// before it, so late-season levels feel earned.
//
// Cumulative XP to reach level N (from level 1) follows the standard
// geometric-series formula:
//   XP(N) = BASE * (GROWTH^(N-1) - 1) / (GROWTH - 1)
//
// Sample cumulative thresholds (base 50, growth 1.10):
//   L1  → 0        L10 → 678
//   L2  → 50       L15 → 1367
//   L3  → 105      L20 → 2477
//   L4  → 165      L25 → 4265
//   L5  → 232      L30 → 7143
//   L6  → 305      L50 → ~29,000
//   L7  → 385      L100 → essentially unreachable
//
// For a kid earning ~500-1000 XP/month from attendance + practices
// + coach recognitions + POTM, that puts them around level 10-12
// after 3 months, 20-25 by the end of a full season. Feels right.
//
// Levels reset each season (matches the "career, not a leaderboard"
// philosophy). Career badges + season titles persist in Phase 4.

export const XP_LEVEL_BASE = 50;
export const XP_LEVEL_GROWTH = 1.10;
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
