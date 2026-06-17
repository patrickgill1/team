// Rotating content for the "just updated" splash. Pulled at random
// each time the user opens the app on a freshly-installed bundle.
//
// Edit freely — these are starter items. Mix Patrick's own coaching
// notes in here whenever you want; the splash treats them all the
// same. Keep `text` under ~120 characters so it fits on a phone in
// 2–3 lines. Attribution is optional and only rendered if present.

export type WelcomeBackKind = 'quote' | 'trivia' | 'skill' | 'practice';

export interface WelcomeBackItem {
  kind: WelcomeBackKind;
  text: string;
  attribution?: string;
}

export const WELCOME_BACK_CONTENT: WelcomeBackItem[] = [
  // ── Quotes ───────────────────────────────────────────────────────
  {
    kind: 'quote',
    text: 'Everything I know about morality and the obligations of men, I owe it to football.',
    attribution: 'Albert Camus',
  },
  {
    kind: 'quote',
    text: 'I learned all about life with a ball at my feet.',
    attribution: 'Ronaldinho',
  },
  {
    kind: 'quote',
    text: 'The more difficult the victory, the greater the happiness in winning.',
    attribution: 'Pelé',
  },
  {
    kind: 'quote',
    text: 'Talent without working hard is nothing.',
    attribution: 'Cristiano Ronaldo',
  },
  {
    kind: 'quote',
    text: 'You have to fight to reach your dream. You have to sacrifice and work hard for it.',
    attribution: 'Lionel Messi',
  },
  {
    kind: 'quote',
    text: 'Football is a game of mistakes. Whoever makes the fewest mistakes wins.',
    attribution: 'Johan Cruyff',
  },
  {
    kind: 'quote',
    text: 'Play the way you face. Always.',
    attribution: 'Coach',
  },

  // ── Trivia ───────────────────────────────────────────────────────
  {
    kind: 'trivia',
    text: 'The first World Cup was held in 1930 in Uruguay. Thirteen teams played; Uruguay won it on home soil.',
  },
  {
    kind: 'trivia',
    text: 'A regulation soccer field can be wider than an American football field is long.',
  },
  {
    kind: 'trivia',
    text: 'Pelé scored over 1,000 professional goals across club and country.',
  },
  {
    kind: 'trivia',
    text: 'The average professional player runs 7 miles in a single 90-minute match.',
  },
  {
    kind: 'trivia',
    text: 'The fastest goal in World Cup history was scored 10.8 seconds after kickoff — Hakan Şükür, 2002.',
  },
  {
    kind: 'trivia',
    text: 'Brazil is the only country to have played in every single FIFA World Cup.',
  },

  // ── Skill tips ───────────────────────────────────────────────────
  {
    kind: 'skill',
    text: 'A great first touch moves the ball AWAY from pressure, not toward it.',
  },
  {
    kind: 'skill',
    text: 'Your plant foot points where the ball will go — not where you want it to go.',
  },
  {
    kind: 'skill',
    text: 'Look up BEFORE you receive the ball. The picture you take then is the one you play from.',
  },
  {
    kind: 'skill',
    text: 'Defending is mostly about angles. Cut the line first, win the ball second.',
  },
  {
    kind: 'skill',
    text: 'The strongest players defend with their bodies — not just their feet.',
  },
  {
    kind: 'skill',
    text: 'Two-touch is faster than one-touch when one-touch is bad.',
  },

  // ── Practice ideas ───────────────────────────────────────────────
  {
    kind: 'practice',
    text: 'Five minutes of juggling every day. Alternate feet. No hands. Count personal bests.',
  },
  {
    kind: 'practice',
    text: 'Wall passes: 50 with each foot. Inside of foot. Quick, low, accurate.',
  },
  {
    kind: 'practice',
    text: 'Cone weave at game pace. Both feet. Keep the ball close enough to step on.',
  },
  {
    kind: 'practice',
    text: 'One-v-one in a 10x10 box with a teammate. Win the ball, change direction, repeat.',
  },
  {
    kind: 'practice',
    text: 'Receive a ball with your back to goal. Half-turn. Score in two touches or fewer.',
  },
];

export function getRandomWelcomeBackItem(): WelcomeBackItem {
  return WELCOME_BACK_CONTENT[Math.floor(Math.random() * WELCOME_BACK_CONTENT.length)];
}

// Display labels for the small chip that sits above the content.
// Kept here so the splash component can stay layout-only.
export const KIND_LABEL: Record<WelcomeBackKind, string> = {
  quote: 'Quote',
  trivia: 'Did you know',
  skill: 'Skill tip',
  practice: 'Practice idea',
};
