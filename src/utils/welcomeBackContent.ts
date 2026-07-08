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
  {
    kind: 'quote',
    text: 'Success is no accident. It is hard work, perseverance, learning, studying, sacrifice, and most of all, love of what you are doing.',
    attribution: 'Pelé',
  },
  {
    kind: 'quote',
    text: 'The vision of a champion is bent over, drenched in sweat, at the point of exhaustion, when nobody else is looking.',
    attribution: 'Mia Hamm',
  },
  {
    kind: 'quote',
    text: 'If you can\'t outplay them, outwork them.',
    attribution: 'Ben Hogan',
  },
  {
    kind: 'quote',
    text: 'The best players are the ones who care the most.',
    attribution: 'Abby Wambach',
  },
  {
    kind: 'quote',
    text: 'You have to fight to reach your dream. You have to sacrifice and work hard for it.',
    attribution: 'Marta',
  },
  {
    kind: 'quote',
    text: 'Somewhere behind the athlete you\'ve become and the hours of practice and the coaches who have pushed you is a little kid who fell in love with the game.',
    attribution: 'Mia Hamm',
  },
  {
    kind: 'quote',
    text: 'I don\'t forget any of the players I\'ve coached. Not one.',
    attribution: 'Sir Alex Ferguson',
  },
  {
    kind: 'quote',
    text: 'A champion is someone who gets up when they can\'t.',
    attribution: 'Jack Dempsey',
  },
  {
    kind: 'quote',
    text: 'Kids don\'t care what you know until they know that you care.',
    attribution: 'Coach',
  },
  {
    kind: 'quote',
    text: 'Your child will remember how the game made them feel long after they forget the score.',
    attribution: 'For parents',
  },
  {
    kind: 'quote',
    text: 'The six most powerful words a parent can say after a game: I love watching you play.',
    attribution: 'For parents',
  },
  {
    kind: 'quote',
    text: 'Every pro was once a kid who wouldn\'t put the ball down.',
  },
  {
    kind: 'quote',
    text: 'Confidence is a stat you build one small win at a time.',
    attribution: 'Coach',
  },
  {
    kind: 'quote',
    text: 'The players who make the team better are the ones the team wants to make better.',
    attribution: 'Coach',
  },
  {
    kind: 'quote',
    text: 'You are your kid\'s biggest fan, not their toughest critic.',
    attribution: 'For parents',
  },
  {
    kind: 'quote',
    text: 'The scoreboard doesn\'t teach the lesson. The next practice does.',
    attribution: 'Coach',
  },
  {
    kind: 'quote',
    text: 'Play with your head up. Play with your heart open.',
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
  {
    kind: 'trivia',
    text: 'A goal scored with your back to the net, kicked over your head, is called a "bicycle kick." Pelé claimed to have invented it. He probably didn\'t.',
  },
  {
    kind: 'trivia',
    text: 'The word "soccer" was actually invented in England, from the term "association football." Americans just kept the nickname.',
  },
  {
    kind: 'trivia',
    text: 'A nutmeg is passing the ball between an opponent\'s legs. The name might come from cockney slang for legs, or from 19th-century merchants tricking each other with fake nutmegs.',
  },
  {
    kind: 'trivia',
    text: 'The longest recorded professional game lasted 3 hours and 23 minutes — Norway 1946, in the mud, no substitutions.',
  },
  {
    kind: 'trivia',
    text: 'The youngest World Cup goal scorer was Pelé at 17. The oldest was Cameroon\'s Roger Milla at 42.',
  },
  {
    kind: 'trivia',
    text: 'The corner arc is a quarter circle with a radius of one yard. It\'s the ONLY curve on the field besides the center circle.',
  },
  {
    kind: 'trivia',
    text: 'Referees didn\'t use whistles until 1878. Before that, they waved handkerchiefs. Nottingham Forest were the first to try it.',
  },
  {
    kind: 'trivia',
    text: 'A soccer ball has 32 panels: 20 hexagons + 12 pentagons. The pattern is called a truncated icosahedron. Same shape as a carbon-60 molecule.',
  },
  {
    kind: 'trivia',
    text: 'The record for keepie-uppies (juggling without dropping the ball) is over 24 hours. A guy in Malaysia did it in 1997. He was 27.',
  },
  {
    kind: 'trivia',
    text: 'Goalkeepers weren\'t allowed to use their hands anywhere on the field until 1912. Before that they could pick it up anywhere in their own half.',
  },
  {
    kind: 'trivia',
    text: 'The average professional match ball is inflated to about 12 psi. Under-inflated balls swerve MORE. Over-inflated balls swerve LESS.',
  },
  {
    kind: 'trivia',
    text: 'FIFA rules say a goal must be at least "24 feet wide and 8 feet high." That\'s been unchanged since 1863.',
  },
  {
    kind: 'trivia',
    text: 'Ancient China played a form of soccer called Cuju around 200 BC. The Han emperor was a fan.',
  },
  {
    kind: 'trivia',
    text: 'A soccer field is called a "pitch" in most of the world. That\'s because early cricket fields were rolled flat with a heavy stone called a pitcher.',
  },
  {
    kind: 'trivia',
    text: 'The most goals ever scored in a single professional match: 149. AS Adema beat SOE Olympique 149-0 in Madagascar, 2002. In protest.',
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
  {
    kind: 'skill',
    text: 'Slow feet, quick decisions. Fast feet, slow decisions. The pros do the first.',
  },
  {
    kind: 'skill',
    text: 'When you\'re tired, your first touch gets sloppy. So the good habit is to practice your first touch when you\'re tired.',
  },
  {
    kind: 'skill',
    text: 'Shooting is confidence, not power. Aim, plant, follow through.',
  },
  {
    kind: 'skill',
    text: 'Never chase the ball. Cover the space it\'s going to.',
  },
  {
    kind: 'skill',
    text: 'The best defensive skill is patience. Wait one more second.',
  },
  {
    kind: 'skill',
    text: 'Your weak foot isn\'t a weakness. It\'s a project.',
  },
  {
    kind: 'skill',
    text: 'Communicate with your teammate\'s NAME. Not "hey" or "man on." A name is faster in the ear.',
  },
  {
    kind: 'skill',
    text: 'Great teammates apologize first. Great teammates congratulate loudest.',
  },
  {
    kind: 'skill',
    text: 'You can\'t control the ref. You can control what happens on the next play.',
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
  {
    kind: 'practice',
    text: 'Wall ball with your weak foot only. 100 touches. It\'ll suck. Do it anyway.',
  },
  {
    kind: 'practice',
    text: 'Play a whole game in your head before you get in the car. Where do you want the ball? Who\'s open?',
  },
  {
    kind: 'practice',
    text: 'Serve yourself a ball off the wall, take a first touch to a target cone, shoot. 25 reps each foot.',
  },
  {
    kind: 'practice',
    text: 'Watch 15 minutes of a pro match with the sound off. Just study one player\'s movement without the ball.',
  },
  {
    kind: 'practice',
    text: 'Do the Coerver scissors — over the ball, no touch, cut with the other foot. Both feet. 30 reps.',
  },
  {
    kind: 'practice',
    text: 'Backyard game with mom or dad: two-touch keep-away, 2 minutes. Loser dribbles a lap.',
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
