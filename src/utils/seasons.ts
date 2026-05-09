/**
 * Seasons helpers — Phase 2 of the seasons + invites redesign.
 *
 * Reads are written to prefer the new per-season buckets but fall back to
 * the legacy denormalized fields so existing data keeps rendering during
 * the rollout. New writes should always stamp the active seasonId.
 */

import { collection, query, where, getDocs, doc, getDoc, addDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import type { Player, PlayerStats, Season } from '../types';

// ────────────────────────────────────────────────────────────────────────────
// Stats lookup with legacy fallback
// ────────────────────────────────────────────────────────────────────────────

const EMPTY_STATS: PlayerStats = {
  gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0, saves: 0, cleanSheets: 0,
};

const sumStats = (a: PlayerStats, b: Partial<PlayerStats>): PlayerStats => ({
  gamesPlayed: (a.gamesPlayed || 0) + (b.gamesPlayed || 0),
  goals: (a.goals || 0) + (b.goals || 0),
  assists: (a.assists || 0) + (b.assists || 0),
  yellowCards: (a.yellowCards || 0) + (b.yellowCards || 0),
  redCards: (a.redCards || 0) + (b.redCards || 0),
  minutesPlayed: (a.minutesPlayed || 0) + (b.minutesPlayed || 0),
  saves: (a.saves || 0) + (b.saves || 0),
  cleanSheets: (a.cleanSheets || 0) + (b.cleanSheets || 0),
});

/**
 * Stats for a single season. Falls back to legacy `stats` field if the
 * player's `statsBySeasonId` bucket for the requested season isn't there
 * yet (e.g. pre-Phase-1-migration data).
 */
export function getPlayerStats(player: Pick<Player, 'stats' | 'statsBySeasonId'> | null | undefined, seasonId?: string | null): PlayerStats {
  if (!player) return { ...EMPTY_STATS };
  if (seasonId && player.statsBySeasonId?.[seasonId]) {
    return { ...EMPTY_STATS, ...player.statsBySeasonId[seasonId] };
  }
  // No season (or bucket missing) — return legacy aggregate.
  return { ...EMPTY_STATS, ...(player.stats || {}) };
}

/**
 * Lifetime aggregate across every season. Prefers summed buckets; falls
 * back to legacy `stats` if no buckets exist (pre-migration).
 */
export function getPlayerLifetimeStats(player: Pick<Player, 'stats' | 'statsBySeasonId' | 'statsLifetime'>): PlayerStats {
  if (player.statsLifetime) return { ...EMPTY_STATS, ...player.statsLifetime };
  const buckets = player.statsBySeasonId || {};
  const seasonIds = Object.keys(buckets);
  if (seasonIds.length === 0) return { ...EMPTY_STATS, ...(player.stats || {}) };
  return seasonIds.reduce<PlayerStats>((acc, sid) => sumStats(acc, buckets[sid] || {}), { ...EMPTY_STATS });
}

// ────────────────────────────────────────────────────────────────────────────
// Active season for a team
// ────────────────────────────────────────────────────────────────────────────

/**
 * Cache so we don't refetch on every render. Cleared by setActiveSeason().
 */
const activeSeasonCache = new Map<string, Season | null>();

export async function getActiveSeasonForTeam(teamId: string): Promise<Season | null> {
  if (!teamId) return null;
  if (activeSeasonCache.has(teamId)) return activeSeasonCache.get(teamId)!;
  try {
    const q = query(collection(db, 'seasons'), where('teamId', '==', teamId), where('isActive', '==', true));
    const snap = await getDocs(q);
    const docSnap = snap.docs[0];
    if (!docSnap) {
      activeSeasonCache.set(teamId, null);
      return null;
    }
    const d: any = docSnap.data();
    const season: Season = {
      id: docSnap.id,
      teamId: d.teamId,
      clubId: d.clubId,
      name: d.name,
      startDate: d.startDate?.toDate ? d.startDate.toDate() : new Date(d.startDate),
      endDate: d.endDate?.toDate ? d.endDate.toDate() : new Date(d.endDate),
      isActive: d.isActive,
      archivedAt: d.archivedAt?.toDate ? d.archivedAt.toDate() : undefined,
      createdAt: d.createdAt?.toDate ? d.createdAt.toDate() : new Date(d.createdAt || Date.now()),
    };
    activeSeasonCache.set(teamId, season);
    return season;
  } catch (err) {
    console.warn('[seasons] getActiveSeasonForTeam failed', err);
    return null;
  }
}

export function clearActiveSeasonCache(teamId?: string) {
  if (teamId) activeSeasonCache.delete(teamId);
  else activeSeasonCache.clear();
}

export async function getAllSeasonsForTeam(teamId: string): Promise<Season[]> {
  if (!teamId) return [];
  const q = query(collection(db, 'seasons'), where('teamId', '==', teamId));
  const snap = await getDocs(q);
  return snap.docs.map(d => {
    const v: any = d.data();
    return {
      id: d.id,
      teamId: v.teamId,
      clubId: v.clubId,
      name: v.name,
      startDate: v.startDate?.toDate ? v.startDate.toDate() : new Date(v.startDate),
      endDate: v.endDate?.toDate ? v.endDate.toDate() : new Date(v.endDate),
      isActive: !!v.isActive,
      archivedAt: v.archivedAt?.toDate ? v.archivedAt.toDate() : undefined,
      createdAt: v.createdAt?.toDate ? v.createdAt.toDate() : new Date(v.createdAt || Date.now()),
    };
  }).sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
}

// ────────────────────────────────────────────────────────────────────────────
// Stamping helpers — call from any code that creates new content so the new
// row gets a seasonId from the start.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Stamp a payload with seasonId before write. Resolves the active season
 * for the team and adds the seasonId to the object. No-op if the team has
 * no active season yet (pre-migration).
 */
export async function withSeasonId<T extends { teamId?: string; seasonId?: string }>(payload: T): Promise<T & { seasonId?: string }> {
  if (payload.seasonId || !payload.teamId) return payload;
  const season = await getActiveSeasonForTeam(payload.teamId);
  return season ? { ...payload, seasonId: season.id } : payload;
}
