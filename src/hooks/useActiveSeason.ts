import { useEffect, useState } from 'react';
import { getActiveSeasonForTeam } from '../utils/seasons';
import { useTeam } from '../contexts/TeamContext';
import type { Season } from '../types';

/**
 * Watch the active season for the currently selected team. Returns null
 * while loading, then either the active Season doc or null if the team
 * has no active season (e.g. pre-Phase-1 migration).
 *
 * Stays cheap because getActiveSeasonForTeam memoizes per teamId.
 */
export function useActiveSeason(): { season: Season | null; loading: boolean; refresh: () => void } {
  const { selectedTeamId } = useTeam();
  const [season, setSeason] = useState<Season | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!selectedTeamId) {
      setSeason(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    getActiveSeasonForTeam(selectedTeamId)
      .then((s) => { if (!cancelled) setSeason(s); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedTeamId, tick]);

  return {
    season,
    loading,
    refresh: () => setTick((t) => t + 1),
  };
}
