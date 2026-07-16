// Shared filter helpers for PlayerMedia lists so the Media tab and
// per-membership buckets agree on what "this season" means. Extracted
// from PlayerProfile in the 2026-07-15 Direction B refactor so a
// legacy any-team clip can't sneak into a team-scoped grid.

import type { PlayerMedia, Season } from '../types';

/** Return the subset of `items` that belong to the given team AND fall
 *  inside the given season's date window. When `season` is null the
 *  time window is ignored (so passing a null season = "all-time for
 *  this team"). When `teamId` is falsy the team filter is skipped. */
export function filterMediaForSeason(
  items: PlayerMedia[],
  teamId: string | null | undefined,
  season: Season | null,
): PlayerMedia[] {
  const start = season?.startDate ? new Date(season.startDate).getTime() : -Infinity;
  const end = season?.endDate ? new Date(season.endDate).getTime() : Infinity;
  return items.filter(m => {
    if (teamId && (m as any).teamId !== teamId) return false;
    if (!season) return true;
    const t = m.createdAt instanceof Date ? m.createdAt.getTime() : new Date((m as any).createdAt || 0).getTime();
    return t >= start && t <= end;
  });
}
