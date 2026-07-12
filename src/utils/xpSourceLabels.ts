// Copy locked by product spec — do not paraphrase without a fresh
// review. Kids read these labels literally. Shared by every surface
// that renders player_xp_events entries (recent XP feed, coach
// recognitions archive, season timeline chips) so the whole app
// stays copy-consistent when we tweak a label.

import type { PlayerXpEvent } from '../types';

export const SOURCE_LABEL: Record<PlayerXpEvent['source'], string> = {
  coach_recognition: 'Coach recognition',
  coach_live: 'Coach grant',
  attendance: 'Attendance',
  potm: 'Player of the match',
  goal: 'First goal',
  assist: 'First assist',
  save: 'First save',
  clean_sheet: 'Clean sheet',
  dev_plan_log: 'Practice logged',
  streak_milestone: 'Streak milestone',
  team_win: 'Team win',
  play_time: 'Playing time',
  backfill: 'XP backfill',
};

// Color mapping per source family. Coach = brand crimson, first-stats
// = amber, streak = warm orange, attendance = emerald, dev-plan =
// brand-primary-soft (cyan-pink). Everything else falls back to a
// neutral ink dot so the row stays legible without introducing a new
// palette color.
export function dotClassForSource(source: PlayerXpEvent['source']): string {
  switch (source) {
    case 'coach_recognition':
    case 'coach_live':
      return 'bg-brand-primary';
    case 'goal':
    case 'assist':
    case 'save':
    case 'clean_sheet':
    case 'potm':
      return 'bg-amber-500';
    case 'streak_milestone':
      return 'bg-orange-500';
    case 'attendance':
      return 'bg-emerald-500';
    case 'dev_plan_log':
      return 'bg-brand-primary-soft';
    default:
      return 'bg-ink-secondary/40';
  }
}

// Whether an XP source is a "milestone" worth calling out on the
// season timeline. Filters out coach_live (bulk practice grants —
// noise) and play_time (implicit, not a moment). Everything else is
// a legitimate story beat.
export function isTimelineSource(source: PlayerXpEvent['source']): boolean {
  return source !== 'coach_live' && source !== 'play_time' && source !== 'backfill';
}
