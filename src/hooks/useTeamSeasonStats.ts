// @ts-nocheck
// Live per-player season stats map for one team. Subscribes to the
// `stats/` collection scoped by teamId and aggregates rows client-side
// filtered by the team's active seasonId.
//
// Reason this exists: player.stats is a LIFETIME aggregate the app
// never resets on season rollover, so any UI that reads it directly
// leaks prior-season numbers onto season-scoped surfaces. The Stats
// page uses getTeamPlayerStatsMap (which does the same aggregation)
// but as a one-shot fetch. This hook wraps the live-subscription
// version so PlayerList, Dashboard, ClubOverview, etc. can share
// the same season-scoped source of truth.
//
// See feedback_stats_scoping_model memory + the 2026-08-18 audit
// entry on player_memberships.stats being a dead-read field.

import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { getActiveSeasonForTeam } from '../utils/seasons';

export type PlayerSeasonStats = {
  gamesPlayed: number;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  minutesPlayed: number;
  saves: number;
  cleanSheets: number;
};

const EMPTY: PlayerSeasonStats = {
  gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0,
  redCards: 0, minutesPlayed: 0, saves: 0, cleanSheets: 0,
};

export interface UseTeamSeasonStatsResult {
  /** Map of playerId -> aggregated per-team per-season stats. Missing
   *  players are treated as EMPTY (start-of-season). */
  statsByPlayerId: Record<string, PlayerSeasonStats>;
  /** Active seasonId used to scope the query. Null if the team has no
   *  active season (falls back to all-time). */
  activeSeasonId: string | null;
  /** True while the initial snapshot hasn't landed. Consumers can hide
   *  a stat card during loading if they want atomic-render feel. */
  loading: boolean;
}

export function useTeamSeasonStats(teamId: string | null | undefined): UseTeamSeasonStatsResult {
  const [statsByPlayerId, setStatsByPlayerId] = useState<Record<string, PlayerSeasonStats>>({});
  const [activeSeasonId, setActiveSeasonId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!teamId);

  // Resolve active season one-shot per team change. Seasons don't
  // flip while the page is open, so no need to subscribe.
  useEffect(() => {
    if (!teamId) { setActiveSeasonId(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const season = await getActiveSeasonForTeam(teamId);
        if (!cancelled) setActiveSeasonId(season?.id || null);
      } catch {
        if (!cancelled) setActiveSeasonId(null);
      }
    })();
    return () => { cancelled = true; };
  }, [teamId]);

  useEffect(() => {
    if (!teamId) { setStatsByPlayerId({}); setLoading(false); return; }
    setLoading(true);
    const sq = query(collection(db, 'stats'), where('teamId', '==', teamId));
    const unsub = onSnapshot(sq, snap => {
      const map: Record<string, PlayerSeasonStats> = {};
      for (const d of snap.docs) {
        const r = d.data() as any;
        // Season filter — only rows tagged with the active season
        // count. Un-tagged legacy rows only surface when no active
        // season exists (team predates the seasons feature).
        if (activeSeasonId) {
          if ((r?.seasonId || null) !== activeSeasonId) continue;
        }
        // Trip-tagged rows belong to Tournaments, not season.
        if (r?.tripId) continue;
        const pid = r.playerId;
        if (!pid) continue;
        const cur = map[pid] || { ...EMPTY };
        const gid: string = typeof r.gameId === 'string' ? r.gameId : '';
        // Synthetic clip rows carry goal/assist deltas only.
        // Adjust rows store a signed gamesPlayed delta.
        const isClipRecord = gid.startsWith('clip_');
        const isAdjustRecord = gid.startsWith('adjust_');
        if (isAdjustRecord) {
          cur.gamesPlayed += r.gamesPlayed || 0;
        } else if (!isClipRecord) {
          cur.gamesPlayed += 1;
        }
        cur.goals += r.goals || 0;
        cur.assists += r.assists || 0;
        cur.saves += r.saves || 0;
        cur.yellowCards += r.yellowCards || 0;
        cur.redCards += r.redCards || 0;
        cur.minutesPlayed += r.minutesPlayed || 0;
        // Clamp to zero so a too-large negative correction can't
        // produce negative totals.
        cur.gamesPlayed = Math.max(0, cur.gamesPlayed);
        cur.goals = Math.max(0, cur.goals);
        cur.assists = Math.max(0, cur.assists);
        cur.saves = Math.max(0, cur.saves);
        cur.yellowCards = Math.max(0, cur.yellowCards);
        cur.redCards = Math.max(0, cur.redCards);
        map[pid] = cur;
      }
      setStatsByPlayerId(map);
      setLoading(false);
    }, () => { setLoading(false); });
    return () => unsub();
  }, [teamId, activeSeasonId]);

  return { statsByPlayerId, activeSeasonId, loading };
}
