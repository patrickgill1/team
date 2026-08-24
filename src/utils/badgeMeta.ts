// Central badge registry. Every badge slug that appears anywhere in
// the app (display, grant, wall-post, notification) resolves through
// this table so the label, art asset, and grant metadata live in one
// place. Add a new slug here BEFORE writing the grant site so the
// rendered chip picks it up automatically.

export type BadgeSlug =
  | 'coach_pick'
  | 'first_goal'
  | 'first_assist'
  | 'first_save'
  | 'first_clean_sheet'
  | 'first_potm'
  | 'hat_trick'
  | 'perfect_attendance'
  | 'streak_5'
  | 'streak_10'
  | 'streak_25'
  | 'streak_50';

export interface BadgeMeta {
  label: string;
  /** Short one-liner used in wall posts + celebration toasts. */
  celebration?: string;
  /** Canonical XP the player receives on earning this badge. Scaled
   *  against the coach-recognition default of 75 XP: firsts are worth
   *  more than a single recognition, streaks scale steeply, season-long
   *  achievements dominate. Consumed by the badge grant helpers so
   *  every badge write is paired with an xp/xpCareer increment. */
  xp: number;
}

export const BADGE_META: Record<BadgeSlug, BadgeMeta> = {
  // coach_pick is DERIVED (2026-07-13+): earned once when cumulative
  // coach-authored XP crosses 200. No direct grant XP — the badge is
  // recognition-of-a-pattern, not a payout. xp: 0 so any code path
  // that reads BADGE_META.coach_pick.xp for a sum doesn't double-count.
  coach_pick:         { label: "Coach's Pick",       celebration: 'crossed the Coach\'s Pick threshold!',  xp: 0 },
  first_goal:         { label: 'First Goal',         celebration: 'scored their first goal!',              xp: 100 },
  first_assist:       { label: 'First Assist',       celebration: 'notched their first assist!',           xp: 100 },
  first_save:         { label: 'First Save',         celebration: 'made their first save!',                xp: 100 },
  first_clean_sheet:  { label: 'First Clean Sheet',  celebration: 'kept a clean sheet!',                   xp: 100 },
  first_potm:         { label: 'First POTM',         celebration: 'won their first Player of the Match!',  xp: 150 },
  hat_trick:          { label: 'Hat Trick',          celebration: 'bagged a hat trick!',                   xp: 150 },
  perfect_attendance: { label: 'Perfect Attendance', celebration: 'made every event this season!',         xp: 200 },
  streak_5:           { label: '5-Day Streak',       celebration: 'is on a 5-day training streak!',        xp: 50 },
  streak_10:          { label: '10-Day Streak',      celebration: 'hit a 10-day streak!',                  xp: 100 },
  streak_25:          { label: '25-Day Streak',      celebration: 'reached a 25-day streak!',              xp: 200 },
  streak_50:          { label: '50-Day Streak',      celebration: 'crushed a 50-day streak!',              xp: 400 },
};

export function badgeXp(slug: string): number {
  return (BADGE_META as any)[slug]?.xp || 0;
}

// Per-badge position eligibility. When null, the badge is universal
// (any position can earn it). When an array, only the listed
// positions have a realistic path to it.
//
// Reasoning per slug:
//  - first_save: keeper-only. A striker doesn't touch keeper stats.
//  - first_clean_sheet: backline achievement. Keepers + defenders share
//    the moment; midfielders and forwards don't get credit today.
//  - Everything else universal — anyone can score, anyone can win POTM,
//    anyone can log practice, anyone can be recognized.
//
// Enforcement is display-only. If a striker somehow gets stamped a
// save (deflection off the line, coach override), the badge lands
// on their doc and shows in their locker regardless — see
// filterVisibleBadgeSlots which unions eligible + earned.
export const BADGE_POSITION_ELIGIBILITY: Record<string, string[] | null> = {
  first_goal: null,
  first_assist: null,
  first_save: ['Goalkeeper'],
  first_clean_sheet: ['Goalkeeper', 'Defender'],
  first_potm: null,
  hat_trick: null,
  perfect_attendance: null,
  streak_5: null,
  streak_10: null,
  streak_25: null,
  streak_50: null,
  coach_pick: null,
};

/** True when the badge slug is realistically earnable given a
 *  player's position(s). Universal badges always return true. If the
 *  player has no position set, return true (generous default — better
 *  to show aspirational slots than to hide everything). */
export function isBadgeEligibleForPositions(slug: string, positions: string[]): boolean {
  const eligible = BADGE_POSITION_ELIGIBILITY[slug];
  if (eligible == null) return true;
  if (!positions || positions.length === 0) return true;
  return positions.some(p => eligible.includes(p));
}

/** Filter a slot list to the slugs a player should SEE in their
 *  locker. Union of (eligible-for-position) + (already-earned) so a
 *  rare cross-position earn (striker who bagged a save on a
 *  deflection) still shows up celebrated instead of being hidden.
 *
 *  positions: pass all positions the player rosters at (Player.position
 *  singular + Player.positions[] combined; caller normalizes). */
export function filterVisibleBadgeSlots(
  slots: readonly string[],
  positions: string[],
  earnedBadges: Record<string, unknown> | null | undefined,
): string[] {
  const earned = earnedBadges || {};
  return slots.filter(slug =>
    isBadgeEligibleForPositions(slug, positions) || Boolean(earned[slug])
  );
}

// Available PNG sizes on disk under /public/badges/. Not every size is
// used everywhere — chip renders lean on the small ones, celebration
// surfaces (hero, modal, wall) can pull the larger.
const AVAILABLE_SIZES = [48, 72, 128, 192, 256, 384] as const;

export function badgeImageSrc(slug: string, size: number = 128): string {
  const nearest = AVAILABLE_SIZES.reduce((best, s) =>
    Math.abs(s - size) < Math.abs(best - size) ? s : best, AVAILABLE_SIZES[0]);
  return `/badges/${slug}_${nearest}.png`;
}

export function badgeSrcSet(slug: string, displayPx: number): string {
  // Emit 1x / 2x / 3x so hi-DPI screens still get crisp art without
  // over-fetching the 384px file for a 20px chip. Only includes sizes
  // large enough to matter.
  const needed = AVAILABLE_SIZES.filter(s => s >= displayPx);
  const one = needed[0] || AVAILABLE_SIZES[AVAILABLE_SIZES.length - 1];
  const two = needed.find(s => s >= displayPx * 2) || one;
  const three = needed.find(s => s >= displayPx * 3) || two;
  const parts: string[] = [];
  parts.push(`/badges/${slug}_${one}.png 1x`);
  if (two !== one) parts.push(`/badges/${slug}_${two}.png 2x`);
  if (three !== two) parts.push(`/badges/${slug}_${three}.png 3x`);
  return parts.join(', ');
}

export function badgeLabel(slug: string): string {
  return (BADGE_META as any)[slug]?.label
    || slug.split('_').map(w => w[0]?.toUpperCase() + w.slice(1)).join(' ');
}
