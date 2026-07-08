// Hand-authored drill diagrams for the seed library. Preferred over
// AI-generated data because the AI's spatial reasoning was
// producing nonsense diagrams on real drills (four players in a
// clump when the drill needs a circle of players around a ring).
//
// Coordinate system: 0..100 in both x and y (top-left origin). See
// src/components/drills/DrillDiagram.tsx for the renderer.
//
// Keyed by the drill's title. Matcher is a normalized lowercase
// string so minor casing / punctuation drift doesn't break the match.

// Local type mirror to avoid pulling the main-app tsconfig into the
// worker build. Must match the shape in src/types/index.ts.
export interface ManualDiagram {
  field: 'none' | 'half' | 'full' | 'grid' | 'circle';
  cones?: Array<{ x: number; y: number; color?: 'orange' | 'yellow' | 'red' | 'blue' }>;
  players?: Array<{
    x: number;
    y: number;
    team: 'attack' | 'defense' | 'neutral' | 'keeper';
    label?: string;
  }>;
  balls?: Array<{ x: number; y: number }>;
  goals?: Array<{ x: number; y: number; orientation: 'n' | 's' | 'e' | 'w' }>;
  movements?: Array<{
    from: { x: number; y: number };
    to: { x: number; y: number };
    type: 'run' | 'pass' | 'dribble' | 'shot';
    label?: string;
  }>;
  caption?: string;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function findManualDiagram(title: string): ManualDiagram | null {
  const key = normalize(title);
  const hit = DIAGRAM_LIBRARY[key];
  return hit || null;
}

export function isInLibrary(title: string): boolean {
  return !!DIAGRAM_LIBRARY[normalize(title)];
}

const DIAGRAM_LIBRARY: Record<string, ManualDiagram> = {
  // ── Dribbling ────────────────────────────────────────────────
  [normalize('Cone Weave')]: {
    field: 'grid',
    cones: [
      { x: 20, y: 50 }, { x: 32, y: 40 }, { x: 44, y: 55 },
      { x: 56, y: 42 }, { x: 68, y: 55 }, { x: 80, y: 50 },
    ],
    players: [
      { x: 12, y: 50, team: 'attack', label: '1' },
      { x: 8, y: 65, team: 'attack', label: '2' },
      { x: 8, y: 35, team: 'attack', label: '3' },
    ],
    balls: [{ x: 12, y: 50 }],
    movements: [
      { from: { x: 12, y: 50 }, to: { x: 82, y: 50 }, type: 'dribble' },
    ],
    caption: 'Dribble through cones inside + outside foot, return down the outside.',
  },

  [normalize('Sharks and Minnows')]: {
    field: 'grid',
    cones: [
      { x: 15, y: 15 }, { x: 85, y: 15 },
      { x: 15, y: 85 }, { x: 85, y: 85 },
    ],
    players: [
      // Sharks (defenders) in the middle
      { x: 40, y: 45, team: 'defense', label: 'S' },
      { x: 60, y: 55, team: 'defense', label: 'S' },
      // Minnows (attackers with balls) on one side
      { x: 22, y: 25, team: 'attack', label: '1' },
      { x: 22, y: 45, team: 'attack', label: '2' },
      { x: 22, y: 65, team: 'attack', label: '3' },
      { x: 22, y: 85, team: 'attack', label: '4' },
    ],
    balls: [
      { x: 22, y: 25 }, { x: 22, y: 45 }, { x: 22, y: 65 }, { x: 22, y: 85 },
    ],
    movements: [
      { from: { x: 22, y: 45 }, to: { x: 82, y: 45 }, type: 'dribble', label: 'go' },
    ],
    caption: 'Minnows dribble across on "go"; sharks try to knock out.',
  },

  [normalize('Traffic Light Dribbling')]: {
    field: 'grid',
    players: [
      { x: 25, y: 30, team: 'attack', label: '1' },
      { x: 45, y: 25, team: 'attack', label: '2' },
      { x: 65, y: 35, team: 'attack', label: '3' },
      { x: 35, y: 55, team: 'attack', label: '4' },
      { x: 60, y: 60, team: 'attack', label: '5' },
      { x: 75, y: 55, team: 'attack', label: '6' },
      { x: 30, y: 75, team: 'attack', label: '7' },
      { x: 55, y: 78, team: 'attack', label: '8' },
    ],
    balls: [
      { x: 25, y: 30 }, { x: 45, y: 25 }, { x: 65, y: 35 },
      { x: 35, y: 55 }, { x: 60, y: 60 }, { x: 75, y: 55 },
      { x: 30, y: 75 }, { x: 55, y: 78 },
    ],
    caption: 'Coach calls green/yellow/red; kids match pace with their touch.',
  },

  // ── Passing ─────────────────────────────────────────────────
  [normalize('Pass and Follow')]: {
    field: 'grid',
    players: [
      { x: 20, y: 40, team: 'attack', label: '1' },
      { x: 20, y: 50, team: 'attack', label: '2' },
      { x: 20, y: 60, team: 'attack', label: '3' },
      { x: 80, y: 40, team: 'attack', label: '4' },
      { x: 80, y: 50, team: 'attack', label: '5' },
      { x: 80, y: 60, team: 'attack', label: '6' },
    ],
    balls: [{ x: 20, y: 40 }],
    movements: [
      { from: { x: 20, y: 40 }, to: { x: 80, y: 40 }, type: 'pass', label: '1' },
      { from: { x: 20, y: 40 }, to: { x: 78, y: 40 }, type: 'run', label: '2' },
    ],
    caption: 'Pass across, jog to the end of the opposite line.',
  },

  [normalize('Two-Touch Passing Square')]: {
    field: 'grid',
    cones: [
      { x: 30, y: 30 }, { x: 70, y: 30 },
      { x: 30, y: 70 }, { x: 70, y: 70 },
    ],
    players: [
      { x: 30, y: 25, team: 'attack', label: '1' },
      { x: 75, y: 30, team: 'attack', label: '2' },
      { x: 70, y: 75, team: 'attack', label: '3' },
      { x: 25, y: 70, team: 'attack', label: '4' },
    ],
    balls: [{ x: 30, y: 25 }],
    movements: [
      { from: { x: 30, y: 30 }, to: { x: 70, y: 30 }, type: 'pass', label: '1' },
      { from: { x: 70, y: 30 }, to: { x: 70, y: 70 }, type: 'pass', label: '2' },
      { from: { x: 70, y: 70 }, to: { x: 30, y: 70 }, type: 'pass', label: '3' },
      { from: { x: 30, y: 70 }, to: { x: 30, y: 30 }, type: 'pass', label: '4' },
    ],
    caption: 'Two-touch — receive, redirect. Change direction on coach cue.',
  },

  [normalize('Rondo 4v1')]: {
    field: 'circle',
    players: [
      { x: 50, y: 15, team: 'attack', label: 'A' },
      { x: 85, y: 50, team: 'attack', label: 'B' },
      { x: 50, y: 85, team: 'attack', label: 'C' },
      { x: 15, y: 50, team: 'attack', label: 'D' },
      { x: 50, y: 50, team: 'defense', label: 'X' },
    ],
    balls: [{ x: 50, y: 15 }],
    movements: [
      { from: { x: 50, y: 15 }, to: { x: 85, y: 50 }, type: 'pass', label: '1' },
      { from: { x: 85, y: 50 }, to: { x: 50, y: 85 }, type: 'pass', label: '2' },
    ],
    caption: '4 outside, 1 defender inside. Keep possession; defender wins → swap.',
  },

  [normalize('Rondo 5v2')]: {
    field: 'circle',
    players: [
      { x: 50, y: 12, team: 'attack', label: 'A' },
      { x: 82, y: 32, team: 'attack', label: 'B' },
      { x: 78, y: 72, team: 'attack', label: 'C' },
      { x: 22, y: 72, team: 'attack', label: 'D' },
      { x: 18, y: 32, team: 'attack', label: 'E' },
      { x: 40, y: 50, team: 'defense', label: 'X' },
      { x: 60, y: 50, team: 'defense', label: 'Y' },
    ],
    balls: [{ x: 50, y: 12 }],
    movements: [
      { from: { x: 50, y: 12 }, to: { x: 82, y: 32 }, type: 'pass', label: '1' },
      { from: { x: 82, y: 32 }, to: { x: 78, y: 72 }, type: 'pass', label: '2' },
    ],
    caption: '5 outside, 2 defenders inside. Move the ball around the pressure.',
  },

  [normalize('Diamond Passing Pattern')]: {
    field: 'grid',
    players: [
      { x: 50, y: 15, team: 'attack', label: '1' },
      { x: 85, y: 50, team: 'attack', label: '2' },
      { x: 50, y: 85, team: 'attack', label: '3' },
      { x: 15, y: 50, team: 'attack', label: '4' },
    ],
    balls: [{ x: 50, y: 15 }],
    movements: [
      { from: { x: 50, y: 15 }, to: { x: 85, y: 50 }, type: 'pass', label: '1' },
      { from: { x: 85, y: 50 }, to: { x: 50, y: 85 }, type: 'pass', label: '2' },
      { from: { x: 50, y: 85 }, to: { x: 15, y: 50 }, type: 'pass', label: '3' },
      { from: { x: 15, y: 50 }, to: { x: 50, y: 15 }, type: 'pass', label: '4' },
    ],
    caption: 'One-two-touch around the diamond. Reverse direction on cue.',
  },

  [normalize('Give and Go')]: {
    field: 'grid',
    players: [
      { x: 25, y: 60, team: 'attack', label: '1' },
      { x: 55, y: 45, team: 'attack', label: '2' },
      { x: 70, y: 60, team: 'defense', label: 'D' },
    ],
    balls: [{ x: 25, y: 60 }],
    movements: [
      { from: { x: 25, y: 60 }, to: { x: 55, y: 45 }, type: 'pass', label: '1' },
      { from: { x: 25, y: 60 }, to: { x: 60, y: 65 }, type: 'run', label: '2' },
      { from: { x: 55, y: 45 }, to: { x: 65, y: 65 }, type: 'pass', label: '3' },
    ],
    caption: 'Pass, sprint past defender, receive return ball in stride.',
  },

  // ── Shooting / finishing ─────────────────────────────────────
  [normalize('1v1 to Goal')]: {
    field: 'half',
    goals: [{ x: 50, y: 6, orientation: 's' }],
    players: [
      { x: 50, y: 12, team: 'keeper', label: 'GK' },
      { x: 50, y: 45, team: 'defense', label: 'D' },
      { x: 50, y: 78, team: 'attack', label: 'A' },
    ],
    balls: [{ x: 50, y: 78 }],
    movements: [
      { from: { x: 50, y: 78 }, to: { x: 50, y: 30 }, type: 'dribble', label: '1' },
      { from: { x: 50, y: 30 }, to: { x: 50, y: 6 }, type: 'shot', label: '2' },
    ],
    caption: 'Attacker takes on defender then goes to goal.',
  },

  [normalize('Cross and Finish')]: {
    field: 'half',
    goals: [{ x: 50, y: 6, orientation: 's' }],
    players: [
      { x: 50, y: 12, team: 'keeper', label: 'GK' },
      { x: 85, y: 45, team: 'attack', label: 'W' },
      { x: 40, y: 30, team: 'attack', label: 'S1' },
      { x: 55, y: 30, team: 'attack', label: 'S2' },
    ],
    balls: [{ x: 85, y: 45 }],
    movements: [
      { from: { x: 85, y: 45 }, to: { x: 85, y: 25 }, type: 'dribble', label: '1' },
      { from: { x: 85, y: 25 }, to: { x: 45, y: 20 }, type: 'pass', label: '2' },
      { from: { x: 40, y: 30 }, to: { x: 45, y: 15 }, type: 'run', label: '3' },
    ],
    caption: 'Winger drives, whips a cross; strikers time front + back post runs.',
  },

  // ── Defending ────────────────────────────────────────────────
  [normalize('1v1 Defending in a Box')]: {
    field: 'grid',
    cones: [
      { x: 20, y: 25 }, { x: 80, y: 25 },
      { x: 20, y: 75 }, { x: 80, y: 75 },
    ],
    players: [
      { x: 30, y: 50, team: 'defense', label: 'D' },
      { x: 70, y: 50, team: 'attack', label: 'A' },
    ],
    balls: [{ x: 70, y: 50 }],
    movements: [
      { from: { x: 70, y: 50 }, to: { x: 25, y: 50 }, type: 'dribble' },
    ],
    caption: 'Attacker tries to reach the far line; defender jockeys + tackles.',
  },

  [normalize('Delay and Contain')]: {
    field: 'grid',
    players: [
      { x: 45, y: 50, team: 'defense', label: 'D' },
      { x: 20, y: 50, team: 'attack', label: 'A' },
    ],
    balls: [{ x: 20, y: 50 }],
    movements: [
      { from: { x: 20, y: 50 }, to: { x: 80, y: 50 }, type: 'dribble' },
      { from: { x: 45, y: 50 }, to: { x: 55, y: 55 }, type: 'run', label: 'jockey' },
    ],
    caption: 'Defender delays the attacker: low stance, side-on, patient.',
  },

  [normalize('Shadow Defending')]: {
    field: 'grid',
    players: [
      { x: 30, y: 40, team: 'attack', label: 'A' },
      { x: 45, y: 40, team: 'defense', label: 'D' },
    ],
    balls: [{ x: 30, y: 40 }],
    movements: [
      { from: { x: 30, y: 40 }, to: { x: 70, y: 30 }, type: 'dribble', label: '1' },
      { from: { x: 45, y: 40 }, to: { x: 60, y: 30 }, type: 'run', label: 'mirror' },
    ],
    caption: 'Mirror the attacker without tackling — footwork + spacing only.',
  },

  // ── Goalkeeping ──────────────────────────────────────────────
  [normalize('Distribution Practice')]: {
    field: 'half',
    goals: [{ x: 50, y: 6, orientation: 's' }],
    players: [
      { x: 50, y: 12, team: 'keeper', label: 'GK' },
      { x: 25, y: 55, team: 'attack', label: 'T1' },
      { x: 75, y: 55, team: 'attack', label: 'T2' },
      { x: 50, y: 78, team: 'attack', label: 'T3' },
    ],
    balls: [{ x: 50, y: 12 }],
    movements: [
      { from: { x: 50, y: 12 }, to: { x: 25, y: 55 }, type: 'pass', label: '1' },
      { from: { x: 50, y: 12 }, to: { x: 75, y: 55 }, type: 'pass', label: '2' },
      { from: { x: 50, y: 12 }, to: { x: 50, y: 78 }, type: 'pass', label: '3' },
    ],
    caption: 'GK cycles through throws, side-volleys, drop-kicks to each target.',
  },

  // ── Fitness / warm-up ───────────────────────────────────────
  [normalize('Dynamic Warm-Up Circuit')]: {
    field: 'grid',
    cones: [
      { x: 15, y: 25 }, { x: 40, y: 25 }, { x: 65, y: 25 }, { x: 85, y: 25 },
      { x: 15, y: 75 }, { x: 40, y: 75 }, { x: 65, y: 75 }, { x: 85, y: 75 },
    ],
    players: [
      { x: 10, y: 50, team: 'attack', label: '1' },
      { x: 10, y: 60, team: 'attack', label: '2' },
      { x: 10, y: 70, team: 'attack', label: '3' },
    ],
    movements: [
      { from: { x: 15, y: 50 }, to: { x: 85, y: 50 }, type: 'run' },
    ],
    caption: 'Rotate stations: high knees, butt kicks, side shuffle, back-pedal.',
  },

  [normalize('Ladder Quick Feet')]: {
    field: 'grid',
    cones: [
      { x: 25, y: 45 }, { x: 25, y: 55 },
      { x: 35, y: 45 }, { x: 35, y: 55 },
      { x: 45, y: 45 }, { x: 45, y: 55 },
      { x: 55, y: 45 }, { x: 55, y: 55 },
      { x: 65, y: 45 }, { x: 65, y: 55 },
      { x: 75, y: 45 }, { x: 75, y: 55 },
    ],
    players: [
      { x: 18, y: 50, team: 'attack', label: '1' },
    ],
    movements: [
      { from: { x: 20, y: 50 }, to: { x: 80, y: 50 }, type: 'run' },
    ],
    caption: 'Ladder patterns — in-in-out-out, lateral shuffles, karaokes.',
  },

  // ── Team / tactical ─────────────────────────────────────────
  [normalize('Small-Sided 3v3 Possession')]: {
    field: 'grid',
    cones: [
      { x: 15, y: 20 }, { x: 85, y: 20 },
      { x: 15, y: 80 }, { x: 85, y: 80 },
    ],
    players: [
      { x: 30, y: 35, team: 'attack', label: 'A' },
      { x: 50, y: 30, team: 'attack', label: 'B' },
      { x: 45, y: 60, team: 'attack', label: 'C' },
      { x: 55, y: 45, team: 'defense', label: 'X' },
      { x: 35, y: 55, team: 'defense', label: 'Y' },
      { x: 65, y: 60, team: 'defense', label: 'Z' },
    ],
    balls: [{ x: 30, y: 35 }],
    movements: [
      { from: { x: 30, y: 35 }, to: { x: 50, y: 30 }, type: 'pass' },
    ],
    caption: 'Keep-away 3v3. Target: X consecutive passes = point.',
  },

  [normalize('Playing Out From the Back')]: {
    field: 'half',
    goals: [{ x: 50, y: 6, orientation: 's' }],
    players: [
      { x: 50, y: 12, team: 'keeper', label: 'GK' },
      { x: 35, y: 30, team: 'attack', label: 'CB' },
      { x: 65, y: 30, team: 'attack', label: 'CB' },
      { x: 15, y: 45, team: 'attack', label: 'FB' },
      { x: 85, y: 45, team: 'attack', label: 'FB' },
      { x: 50, y: 55, team: 'attack', label: 'CM' },
      { x: 40, y: 75, team: 'defense', label: 'F' },
      { x: 60, y: 75, team: 'defense', label: 'F' },
    ],
    balls: [{ x: 50, y: 12 }],
    movements: [
      { from: { x: 50, y: 12 }, to: { x: 35, y: 30 }, type: 'pass', label: '1' },
      { from: { x: 35, y: 30 }, to: { x: 50, y: 55 }, type: 'pass', label: '2' },
    ],
    caption: 'GK to CB to CM. Use the keeper as an out under press.',
  },

  // ── Fun / small-sided ───────────────────────────────────────
  [normalize('King of the Ring')]: {
    field: 'circle',
    players: [
      { x: 50, y: 20, team: 'attack', label: '1' },
      { x: 72, y: 30, team: 'attack', label: '2' },
      { x: 82, y: 55, team: 'attack', label: '3' },
      { x: 68, y: 75, team: 'attack', label: '4' },
      { x: 45, y: 82, team: 'attack', label: '5' },
      { x: 25, y: 72, team: 'attack', label: '6' },
      { x: 18, y: 50, team: 'attack', label: '7' },
      { x: 30, y: 28, team: 'attack', label: '8' },
    ],
    balls: [
      { x: 50, y: 20 }, { x: 72, y: 30 }, { x: 82, y: 55 }, { x: 68, y: 75 },
      { x: 45, y: 82 }, { x: 25, y: 72 }, { x: 18, y: 50 }, { x: 30, y: 28 },
    ],
    caption: 'Everyone dribbles in the circle, shields their ball, kicks out others.',
  },

  [normalize('Numbers Up Transition')]: {
    field: 'half',
    goals: [{ x: 50, y: 6, orientation: 's' }],
    players: [
      { x: 50, y: 12, team: 'keeper', label: 'GK' },
      { x: 35, y: 35, team: 'defense', label: 'D' },
      { x: 65, y: 35, team: 'defense', label: 'D' },
      { x: 35, y: 65, team: 'attack', label: 'A' },
      { x: 50, y: 62, team: 'attack', label: 'A' },
      { x: 65, y: 65, team: 'attack', label: 'A' },
    ],
    balls: [{ x: 50, y: 62 }],
    movements: [
      { from: { x: 50, y: 62 }, to: { x: 50, y: 20 }, type: 'run', label: 'attack' },
    ],
    caption: '3v2 to goal — attackers exploit the extra man before recovery.',
  },
};

export default DIAGRAM_LIBRARY;
