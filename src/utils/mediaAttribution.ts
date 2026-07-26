// Single source of truth for "is this clip about this player?" — used
// by the Browse-by-Player counts, the "This Season" row on the parent
// Netflix tab, and the picker sheet's per-player clip counts. Every
// consumer must reuse this to keep counts consistent (a kid who
// assisted on a teammate's goal shows up in that teammate's clip AND
// in their own bucket).

import type { PlayerMedia as PlayerMediaType } from '../types';

export function mediaBelongsToPlayer(m: PlayerMediaType, playerId: string): boolean {
  if (!playerId) return false;
  if (m.playerId === playerId) return true;
  if ((m.taggedPlayerIds || []).includes(playerId)) return true;
  if (m.goalScorerId === playerId) return true;
  const assists = m.assistByIds;
  if (Array.isArray(assists) && assists.includes(playerId)) return true;
  return false;
}
