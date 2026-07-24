// Copy locked by product spec — do not paraphrase without a fresh
// review. Kids read these labels literally. Shared by every surface
// that renders player_xp_events entries (recent XP feed, coach
// recognitions archive, season timeline chips) so the whole app
// stays copy-consistent when we tweak a label.

import type { PlayerXpEvent } from '../types';

export const SOURCE_LABEL: Record<PlayerXpEvent['source'], string> = {
  coach_recognition: 'Coach recognition', // legacy — Recognize flow deleted 2026-07-13
  coach_live: 'Coach grant',
  coach_whisper: 'Whisper',
  kudos_coach_convert: 'Kudos', // Circle-member note promoted to XP by coach
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
    case 'coach_whisper':
    case 'kudos_coach_convert':
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
// season timeline. Filters out coach_live (bulk practice grants,
// noise) and play_time (implicit, not a moment). Everything else is
// a legitimate story beat.
export function isTimelineSource(source: PlayerXpEvent['source']): boolean {
  return source !== 'coach_live' && source !== 'play_time' && source !== 'backfill';
}

// Coach-log labels. The player-facing SOURCE_LABEL above is copy-locked
// for kids ("Whisper", "Kudos", short and warm). The coach XP log wants
// a slightly more descriptive read that names what the coach did, since
// the coach is looking at a mix of every player and every source and
// scanning for accountability rather than celebration.
//
// Keys mirror every source string the worker actually writes today (see
// worker/src/writeGuards.ts + xpBackfill.ts). Anything not in this map
// falls through titleCaseSource() so a newly-added source shows up as
// something legible instead of the raw slug.
const COACH_SOURCE_LABEL_MAP: Record<string, string> = {
  coach_recognition: 'Coach recognition',
  coach_live: 'Coach recognition',
  coach_whisper: 'Coach whisper',
  kudos_coach_convert: 'Kudos converted',
  attendance: 'Perfect attendance',
  potm: 'Player of the match',
  goal: 'First goal',
  assist: 'First assist',
  save: 'First save',
  clean_sheet: 'First clean sheet',
  dev_plan_log: 'Practice tap',
  streak_milestone: 'Streak milestone',
  team_win: 'Team win',
  play_time: 'Playing time',
  backfill: 'Retro credit',
  // Names the task called out that may show up in the future once
  // silent-grant events start writing docs. Kept here so the log
  // stays consistent the day those writers ship.
  practice_tap: 'Practice tap',
  streak_day: 'Streak day',
  first_goal: 'First goal',
  first_assist: 'First assist',
  first_save: 'First save',
  perfect_attendance: 'Perfect attendance',
  admin_grant_badge: 'Retro badge grant',
  admin_grant_xp: 'Admin XP grant',
};

function titleCaseSource(raw: string): string {
  if (!raw) return 'XP grant';
  return raw
    .split('_')
    .filter(Boolean)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase())
    .join(' ');
}

// Coach-facing label for an XP source string. Accepts any string so
// stragglers from a future writer render as titled words rather than
// a raw slug, and callers don't have to narrow to PlayerXpEvent['source']
// before rendering a log row.
export function coachSourceLabel(source: string | undefined | null): string {
  const key = (source || '').trim();
  if (!key) return 'XP grant';
  return COACH_SOURCE_LABEL_MAP[key] || titleCaseSource(key);
}

// Ordered list of source keys the coach log filter dropdown offers.
// Mirrors the writer set today. New sources auto-appear in the feed
// (fallback label handles them); they won't show as a filter option
// until this list adds them, which is deliberate — filter chips should
// only show categories the coach has language for.
export const COACH_LOG_SOURCE_OPTIONS: readonly string[] = [
  'coach_live',
  'coach_whisper',
  'kudos_coach_convert',
  'potm',
  'goal',
  'assist',
  'save',
  'clean_sheet',
  'attendance',
  'streak_milestone',
  'dev_plan_log',
  'backfill',
];
