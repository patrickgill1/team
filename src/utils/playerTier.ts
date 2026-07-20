// Per-level tier labels for the XP system. Patrick's warm-only
// progression 2026-07-13: no "Rookie" / "Beginner" floor because
// a U10 seeing "Beginner" on their card every open is the opposite
// of the emotional lift the hero is supposed to deliver.
//
// 2026-07-17 rebalance: renamed the ladder to a soccer-native
// career arc that fits the new BASE=100 / GROWTH=1.40 curve
// (see xpLevel.ts). L1-L4 are the "getting on the pitch" arc;
// L5-L6 is the standard end-of-season landing; L7-L8 rewards a
// standout season; L9-L19 is legendary territory.
//
// 2026-07-17 addendum: GOAT tier restored at L20+ per Patrick.
// Original rebalance retired GOAT because it fired at L6 = 305 XP
// on the old curve (a week-1 unlock). L20 on the new curve is
// deep career-mode territory that a single season cannot reach,
// so the label actually means something again.
//
// 2026-07-20 rename: swapped the role-claim labels (STARTER,
// PLAYMAKER, CAPTAIN, TALISMAN) for effort/growth/impact labels.
// The old set caused dissonance for kids whose actual lineup role
// did not match the chip on their card (a Level 7 sub reading
// "CAPTAIN" every open felt off, and a Level 3 kid reading
// "STARTER" who wasn't in the starting eleven felt worse). The
// new ladder describes the journey the XP earned, not a position
// on the team sheet, so no kid can be contradicted by Saturday's
// lineup.
//
// Single source of truth. Used by:
//   - src/pages/Dashboard.tsx (MyPlayerCard LEVEL cell subtitle)
//   - src/components/player/PlayerXpCard.tsx (rarity chip label)
//   - src/components/player/LevelProgressBar.tsx (season progress card)
//   - src/components/kidChat/KidHeroCard.tsx (rarity chip label)
// so the label a player sees on the dashboard matches what they
// see on their profile Season Card and hero card.
export function playerTier(level: number): string {
  if (level >= 20) return 'GOAT';
  if (level >= 9) return 'LEGEND';
  if (level === 8) return 'CLUB HERO';
  if (level === 7) return 'UNSTOPPABLE';
  if (level === 6) return 'DIFFERENCE MAKER';
  if (level === 5) return 'RISING STAR';
  if (level === 4) return 'IN FORM';
  if (level === 3) return 'GAME READY';
  if (level === 2) return 'ON THE BALL';
  return 'FIRST KICK';
}
