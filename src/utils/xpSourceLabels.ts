// Copy locked by product spec — do not paraphrase without a fresh
// review. Kids read these labels literally. Shared by every surface
// that renders player_xp_events entries (recent XP feed, coach
// recognitions archive, season timeline chips) so the whole app
// stays copy-consistent when we tweak a label.
//
// Every map in this file is exhaustive over PlayerXpEvent['source'].
// If TypeScript complains a new source is missing, add it here — do
// NOT reintroduce a fuzzy titleCase fallback. Missing entries are a
// product decision (naming, color), not a runtime accident.

import type { PlayerXpEvent } from '../types';

type XpSource = PlayerXpEvent['source'];

// Player-facing labels. Warm, short, kid-legible. Rendered on the
// kid's XP history feed and the season timeline chips.
export const SOURCE_LABEL: Record<XpSource, string> = {
  coach_live: 'Coach grant',
  coach_whisper: 'Whisper',
  kudos_coach_convert: 'Kudos', // Circle-member note promoted to XP by coach
  dev_plan_log: 'Practice logged',
  practice_attendance: 'Practice attendance',
  game_attendance: 'Game attendance',
  effort_bonus: 'Effort bonus',
  rsvp_going: 'RSVP going',
  first_goal: 'First goal',
  first_assist: 'First assist',
  first_save: 'First save',
  first_clean_sheet: 'First clean sheet',
  first_potm: 'First Player of the Match',
  perfect_attendance: 'Perfect attendance',
  streak_milestone: 'Streak milestone',
  gametape_watched: 'Watched clip',
  coach_recognition: 'Coach recognition', // legacy, no new writes
};

// Color chip per source, grouped by category so a scan of the XP feed
// reads as "warm coach moments / cyan milestones / muted habits" without
// having to read every label.
//
//  - coach-authored (coach_live, coach_whisper, kudos_coach_convert):
//    amber, the warm "someone SAW you" color.
//  - stats-earned (first_*, perfect_attendance): brand primary cyan,
//    the milestone/achievement color used for badges elsewhere.
//  - habit-earned (dev_plan_log, streak_milestone, practice_attendance,
//    game_attendance, effort_bonus, rsvp_going, gametape_watched): muted
//    secondary ink so the daily-grind rows recede visually next to the
//    rarer milestones.
//  - coach_recognition (legacy): muted grey; legacy rows should not
//    compete with live-earn chrome.
export function dotClassForSource(source: XpSource): string {
  switch (source) {
    // Coach-authored — warm amber
    case 'coach_live':
    case 'coach_whisper':
    case 'kudos_coach_convert':
      return 'bg-amber-500';

    // Stats-earned milestones — brand cyan
    case 'first_goal':
    case 'first_assist':
    case 'first_save':
    case 'first_clean_sheet':
    case 'first_potm':
    case 'perfect_attendance':
      return 'bg-brand-primary';

    // Habit-earned daily grind — muted secondary
    case 'dev_plan_log':
    case 'streak_milestone':
    case 'practice_attendance':
    case 'game_attendance':
    case 'effort_bonus':
    case 'rsvp_going':
    case 'gametape_watched':
      return 'bg-ink-secondary/60';

    // Legacy read-only — greyed out
    case 'coach_recognition':
      return 'bg-ink-secondary/30';
  }
}

// Whether an XP source is a "milestone" worth calling out on the
// season timeline. Filters out coach_live (bulk practice grants,
// noise). Everything else is a legitimate story beat — the milestones
// (first_*, streak, perfect_attendance) obviously belong, and the
// habit rows read as a low-key drumbeat that tells the season's
// story without demanding attention.
export function isTimelineSource(source: XpSource): boolean {
  return source !== 'coach_live';
}

// Coach-log labels. The player-facing SOURCE_LABEL above is copy-locked
// for kids ("Whisper", "Kudos", short and warm). The coach XP log wants
// a slightly more descriptive read that names what the coach did, since
// the coach is looking at a mix of every player and every source and
// scanning for accountability rather than celebration.
//
// Exhaustive over PlayerXpEvent['source']. No fuzzy fallback: an
// unknown source string means either the enum drifted from the worker
// or a caller is passing garbage — both are bugs we want visible as
// the literal 'XP grant' label rather than a made-up titlecased slug.
const COACH_SOURCE_LABEL_MAP: Record<XpSource, string> = {
  coach_live: 'Coach recognition',
  coach_whisper: 'Coach whisper',
  kudos_coach_convert: 'Kudos converted',
  dev_plan_log: 'Practice tap',
  practice_attendance: 'Practice attendance',
  game_attendance: 'Game attendance',
  effort_bonus: 'Effort bonus',
  rsvp_going: 'RSVP going',
  first_goal: 'First goal',
  first_assist: 'First assist',
  first_save: 'First save',
  first_clean_sheet: 'First clean sheet',
  first_potm: 'First Player of the Match',
  perfect_attendance: 'Perfect attendance',
  streak_milestone: 'Streak milestone',
  gametape_watched: 'Gametape watched',
  coach_recognition: 'Coach recognition',
};

// Coach-facing label for an XP source string. Accepts any string so a
// row with a drifted/legacy source slug still renders something (the
// generic 'XP grant') rather than blanking the row — callers don't
// have to narrow to PlayerXpEvent['source'] before rendering a log row.
export function coachSourceLabel(source: string | undefined | null): string {
  const key = (source || '').trim();
  if (!key) return 'XP grant';
  return (COACH_SOURCE_LABEL_MAP as Record<string, string>)[key] || 'XP grant';
}

// Ordered list of source keys the coach log filter dropdown offers.
// Mirrors the writer set today. New sources auto-appear in the feed
// (fallback label handles them); they won't show as a filter option
// until this list adds them, which is deliberate — filter chips should
// only show categories the coach has language for. Order groups coach
// actions first, then stat milestones, then habit signals.
// Typed as string[] (not XpSource[]) so callers can do
// `canonical.includes(unknownString)` without extra narrowing when they
// merge in surprise sources scraped from live rows. Contents are still
// the exhaustive canonical set below.
export const COACH_LOG_SOURCE_OPTIONS: readonly string[] = [
  'coach_live',
  'coach_whisper',
  'kudos_coach_convert',
  'first_goal',
  'first_assist',
  'first_save',
  'first_clean_sheet',
  'first_potm',
  'perfect_attendance',
  'streak_milestone',
  'dev_plan_log',
  'practice_attendance',
  'game_attendance',
  'effort_bonus',
  'rsvp_going',
  'gametape_watched',
];
