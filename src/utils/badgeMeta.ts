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
  | 'perfect_attendance'
  | 'streak_5'
  | 'streak_10'
  | 'streak_25'
  | 'streak_50';

export interface BadgeMeta {
  label: string;
  /** Short one-liner used in wall posts + celebration toasts. */
  celebration?: string;
}

export const BADGE_META: Record<BadgeSlug, BadgeMeta> = {
  coach_pick: { label: "Coach's Pick", celebration: 'earned a Coach Recognition!' },
  first_goal: { label: 'First Goal', celebration: 'scored their first goal!' },
  first_assist: { label: 'First Assist', celebration: 'notched their first assist!' },
  first_save: { label: 'First Save', celebration: 'made their first save!' },
  first_clean_sheet: { label: 'First Clean Sheet', celebration: 'kept a clean sheet!' },
  first_potm: { label: 'First POTM', celebration: 'won their first Player of the Match!' },
  perfect_attendance: { label: 'Perfect Attendance', celebration: 'made every event this season!' },
  streak_5: { label: '5-Day Streak', celebration: 'is on a 5-day training streak!' },
  streak_10: { label: '10-Day Streak', celebration: 'hit a 10-day streak!' },
  streak_25: { label: '25-Day Streak', celebration: 'reached a 25-day streak!' },
  streak_50: { label: '50-Day Streak', celebration: 'crushed a 50-day streak!' },
};

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
