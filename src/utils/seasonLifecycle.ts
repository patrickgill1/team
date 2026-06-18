import type { SeasonLifecycle } from '../types';

// Valid forward transitions for the season state machine. We keep
// archive accessible from anywhere except draft (you can throw away a
// draft outright, but in-flight seasons should be ended first).
//
// We allow exactly one backward path: registration_open ↔ tryouts
// since clubs often reopen registration mid-tryout if numbers are
// light. Beyond that, everything moves forward — easier to reason
// about + matches how clubs actually run.

const TRANSITIONS: Record<SeasonLifecycle, SeasonLifecycle[]> = {
  draft: ['registration_open', 'archived'],
  registration_open: ['tryouts', 'roster_locked', 'archived'],
  tryouts: ['registration_open', 'roster_locked', 'archived'],
  roster_locked: ['in_season', 'archived'],
  in_season: ['ended', 'archived'],
  ended: ['archived'],
  archived: [],
};

export function validSeasonTransitions(from: SeasonLifecycle): SeasonLifecycle[] {
  return TRANSITIONS[from] || [];
}

export function canTransitionSeason(from: SeasonLifecycle, to: SeasonLifecycle): boolean {
  return validSeasonTransitions(from).includes(to);
}

export function seasonLifecycleLabel(s: SeasonLifecycle): string {
  switch (s) {
    case 'draft': return 'Draft';
    case 'registration_open': return 'Registration open';
    case 'tryouts': return 'Tryouts';
    case 'roster_locked': return 'Roster locked';
    case 'in_season': return 'In season';
    case 'ended': return 'Ended';
    case 'archived': return 'Archived';
  }
}

export function seasonLifecycleTone(s: SeasonLifecycle): { bg: string; text: string; ring: string } {
  switch (s) {
    case 'draft': return { bg: 'bg-slate-100', text: 'text-slate-700', ring: 'ring-slate-300' };
    case 'registration_open': return { bg: 'bg-crimson-100', text: 'text-crimson-800', ring: 'ring-crimson-300' };
    case 'tryouts': return { bg: 'bg-violet-100', text: 'text-violet-800', ring: 'ring-violet-300' };
    case 'roster_locked': return { bg: 'bg-amber-100', text: 'text-amber-800', ring: 'ring-amber-300' };
    case 'in_season': return { bg: 'bg-emerald-100', text: 'text-emerald-800', ring: 'ring-emerald-300' };
    case 'ended': return { bg: 'bg-slate-100', text: 'text-slate-600', ring: 'ring-slate-300' };
    case 'archived': return { bg: 'bg-slate-100', text: 'text-slate-500', ring: 'ring-slate-200' };
  }
}

/** Map any legacy boolean flags to a lifecycle state when one isn't set
 *  yet. Older seasons predate the lifecycle field — we infer rather
 *  than backfill, so the model is forward-only. */
export function inferSeasonLifecycle(season: { lifecycle?: SeasonLifecycle; registrationOpen?: boolean; isActive?: boolean; archivedAt?: Date | null }): SeasonLifecycle {
  if (season.lifecycle) return season.lifecycle;
  if (season.archivedAt) return 'archived';
  if (season.registrationOpen) return 'registration_open';
  if (season.isActive === false) return 'ended';
  return 'draft';
}
