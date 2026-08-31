# Firestore rules test suite

Guards against the "coach can suddenly no longer do X" class of bug
that hit this codebase every time we shipped a gate split without
manually running through every affected path.

## Running

```
npm run test:rules
```

The script spins up the Firestore emulator on port 8080 in the
background, loads `firestore.rules` from repo root, runs the Jest
suite, and tears the emulator down. No live Firestore access; every
test hits an isolated in-memory project.

## Coverage principle

Each test asserts one caller × one action × one collection.
Add a test when you ship a new rule OR a new gate. The goal is
"if this rule regresses, at least one test fails."

Canonical roster (starter set — extend freely):

- Coach on team CREATE event → allowed
- Assistant coach on team CREATE dev plan → allowed
- Team manager on team CREATE dev plan → allowed
- Non-staff on team CREATE dev plan → denied
- Parent on team UPDATE event with rsvp fields only → allowed
- Parent on team UPDATE event with title change → denied
- Anonymous READ single player_media doc → allowed (public share)
- Anonymous LIST player_media → denied
- Coach on team X READ player from team Y (different club) → denied
- Trial-lapsed coach CREATE full_games with YouTube source → allowed
- Trial-lapsed coach CREATE full_games with native upload → denied

## Fixture shape

Each test builds a minimal Firestore state (teams/, users/,
players/) then asserts `getFirestore(auth)` against the rule.
Helpers live in `tests/rules/helpers.ts`.
