// Per-level tier labels for the XP system. Patrick's warm-only
// progression 2026-07-13: no "Rookie" / "Beginner" floor because
// a U10 seeing "Beginner" on their card every open is the opposite
// of the emotional lift the hero is supposed to deliver.
//
// Single source of truth. Used by:
//   - src/pages/Dashboard.tsx (MyPlayerCard LEVEL cell subtitle)
//   - src/components/player/PlayerXpCard.tsx (rarity chip label)
// so the label a player sees on the dashboard matches what they
// see on their profile Season Card.
export function playerTier(level: number): string {
  if (level >= 6) return 'GOAT';
  if (level === 5) return 'CAPTAIN';
  if (level === 4) return 'PLAYMAKER';
  if (level === 3) return 'GAME READY';
  if (level === 2) return 'RISING STAR';
  return 'NEW SIGNING';
}
