import type { Player } from '../types';

// ── Auto team split for adult pickup teams ───────────────────────
//
// Snake-draft algorithm that takes a roster + N sides and produces
// balanced teams based on each player's self-reported profile:
//   - highestLevelPlayed (recreational → pro, weight 2x)
//   - skillLevel (1–5, weight 1x)
//
// Design choices:
//   1. highestLevelPlayed is weighted double because it's harder to
//      game (nobody rates themselves down on lifetime achievement).
//      Self-reported skill can be inflated or sandbagged; ignoring
//      it entirely would lose useful current-form info, but leaning
//      on the tier signal keeps the balance honest.
//   2. Snake draft (round 1: A→B→C→D, round 2: D→C→B→A, etc.) is
//      the simplest fairness algorithm that scales past 2 teams.
//      Hungarian / integer-linear-programming would be optimal but
//      overkill for a Saturday pickup at picnic-table math scale.
//   3. Missing signals default to a middle score (level=select,
//      skill=3). Players who haven't filled out their profile land
//      in the middle of the pack, not the top or bottom.
//   4. Ties broken by a deterministic hash of playerId + seed —
//      lets us produce a NEW shuffle on demand ("reroll") without
//      the algorithm being random-random (same seed = same split).

const LEVEL_SCORES: Record<NonNullable<Player['highestLevelPlayed']>, number> = {
  recreational: 1,
  select:       2,
  high_school:  3,
  college_d3:   4,
  college_d2:   5,
  college_d1:   6,
  semi_pro:     7,
  pro:          8,
};

const DEFAULT_LEVEL_SCORE = LEVEL_SCORES.select; // "middle of the pack"
const DEFAULT_SKILL_SCORE = 3;

export function playerScore(p: Player): number {
  const levelBase = p.highestLevelPlayed
    ? LEVEL_SCORES[p.highestLevelPlayed]
    : DEFAULT_LEVEL_SCORE;
  const skill = typeof p.skillLevel === 'number' ? p.skillLevel : DEFAULT_SKILL_SCORE;
  return levelBase * 2 + skill;
}

// Tiny non-cryptographic hash so we can jitter tiebreaks without
// pulling in a lib. Deterministic given the same seed + playerId,
// which is exactly what the reroll story needs.
function hash(seed: number, id: string): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  }
  return (h >>> 0);
}

export interface SplitOptions {
  /** How many teams to produce. Default 2 (Saturday pickup). */
  numSides?: number;
  /** Reshuffle knob. Same seed → same split. Reroll bumps seed. */
  seed?: number;
  /** Method label persisted with the split. Default 'snake'. */
  method?: 'snake' | 'random';
}

export interface SplitResult {
  method: 'snake' | 'random';
  sides: Array<{ label: string; playerIds: string[] }>;
}

/**
 * Split a roster into balanced sides via snake draft.
 *
 * Snake order across N sides for 12 players in 2 teams: A B B A A B B A A B B A
 * Highest-scored player always goes first to side A; the next
 * highest goes to side B; the one after that to side B again; etc.
 * This spreads the top of the roster more evenly than pure round-robin.
 */
export function splitTeams(roster: Player[], opts: SplitOptions = {}): SplitResult {
  const numSides = Math.max(2, Math.min(4, opts.numSides ?? 2));
  const seed = opts.seed ?? 0;
  const method: 'snake' | 'random' = opts.method ?? 'snake';

  if (method === 'random') {
    // Straight shuffle. Deterministic when seeded so reroll produces
    // a fresh order on the same seed bump.
    const shuffled = [...roster].sort((a, b) => hash(seed, a.id) - hash(seed, b.id));
    const sides: SplitResult['sides'] = Array.from({ length: numSides }, (_, i) => ({
      label: sideLabel(i),
      playerIds: [] as string[],
    }));
    shuffled.forEach((p, i) => sides[i % numSides].playerIds.push(p.id));
    return { method, sides };
  }

  // Snake draft, seeded tiebreak.
  const sorted = [...roster].sort((a, b) => {
    const diff = playerScore(b) - playerScore(a);
    if (diff !== 0) return diff;
    return hash(seed, a.id) - hash(seed, b.id);
  });

  const sides: SplitResult['sides'] = Array.from({ length: numSides }, (_, i) => ({
    label: sideLabel(i),
    playerIds: [] as string[],
  }));

  let sideIdx = 0;
  let direction = 1;
  for (const p of sorted) {
    sides[sideIdx].playerIds.push(p.id);
    // Snake — reverse direction at the ends.
    if (direction === 1 && sideIdx === numSides - 1) {
      direction = -1;
    } else if (direction === -1 && sideIdx === 0) {
      direction = 1;
    } else {
      sideIdx += direction;
    }
  }

  return { method, sides };
}

function sideLabel(i: number): string {
  // Team A / Team B / Team C / Team D. Good enough for a picnic
  // table; coaches can rename later once we surface that UI.
  return `Team ${String.fromCharCode(65 + i)}`;
}

// ── Human-readable helpers for the UI ────────────────────────────

export const LEVEL_LABELS: Record<NonNullable<Player['highestLevelPlayed']>, string> = {
  recreational: 'Recreational',
  select:       'Select / Club',
  high_school:  'High school',
  college_d3:   'College D3',
  college_d2:   'College D2',
  college_d1:   'College D1',
  semi_pro:     'Semi-pro',
  pro:          'Pro',
};

export const LEVEL_ORDER: Array<NonNullable<Player['highestLevelPlayed']>> = [
  'recreational',
  'select',
  'high_school',
  'college_d3',
  'college_d2',
  'college_d1',
  'semi_pro',
  'pro',
];

export function averageScore(playerIds: string[], roster: Player[]): number {
  if (playerIds.length === 0) return 0;
  const rosterById = new Map(roster.map(p => [p.id, p]));
  const scores = playerIds
    .map(id => rosterById.get(id))
    .filter((p): p is Player => !!p)
    .map(playerScore);
  if (scores.length === 0) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}
