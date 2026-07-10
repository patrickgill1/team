import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import type { DevelopmentGoal, DevelopmentPlan, PracticeLogEntry } from '../types';

// Shared dev-plan write actions. Used by both PlayerDevelopment (the
// dedicated full-plan view) AND PlayerProfile (the inline overview
// card). Patrick's "things work two ways" complaint was about this —
// the same action should write the same thing whether you tap it from
// the profile or from the full plan page.

/** Log "I did it today" for one goal on one plan. Returns the updated
 *  goals array so callers can immediately reconcile local state +
 *  recompute the streak. Idempotent within a day — taps on the same
 *  goal twice the same day each write a log entry, but the streak
 *  derived from unique-day counts dedupes them. */
export async function quickDidIt(
  plan: DevelopmentPlan,
  goalId: string,
  actor: { uid: string; name: string }
): Promise<DevelopmentGoal[]> {
  const entry: PracticeLogEntry = {
    id: `log_${Date.now()}`,
    date: new Date(),
    note: 'Did it today',
    loggedBy: actor.uid,
    loggedByName: actor.name,
  };
  const updatedGoals: DevelopmentGoal[] = plan.goals.map(g =>
    g.id === goalId ? { ...g, practiceLog: [...(g.practiceLog || []), entry] } : g
  );
  await updateDoc(doc(db, 'development_plans', plan.id), { goals: updatedGoals });
  // Invalidate the Dashboard tonight-goal cache so the next Dashboard
  // mount refetches instead of showing the stale "not logged today"
  // state for a beat. Fire-and-forget dynamic import so devPlanActions
  // stays lightweight for callers that never touch the cache.
  try {
    const { invalidateCache } = await import('./queryCache');
    invalidateCache(`dashboard:tonightGoal:${plan.playerId}`);
  } catch { /* non-fatal */ }
  return updatedGoals;
}

/** Coerce a practiceLog entry's `date` to a Date regardless of how
 *  it was stored. Three valid shapes:
 *    - Firestore Timestamp object (.toDate())
 *    - plain JS Date already converted on read
 *    - corrupted { seconds, nanoseconds } map left behind by the
 *      old cleanFirestoreData bug that flattened nested Timestamps
 *      on writeback (Patrick's pre-v3.2.57 entries). Treat the map
 *      shape as a Timestamp manually so existing entries auto-heal
 *      in render without a Firestore migration.
 *  Returns null if nothing valid can be derived. */
export function coerceLogDate(raw: any): Date | null {
  if (!raw) return null;
  if (typeof raw.toDate === 'function') {
    try { return raw.toDate(); } catch { /* fall through */ }
  }
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'number' || typeof raw === 'string') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw.seconds === 'number') {
    const ms = raw.seconds * 1000 + Math.floor((raw.nanoseconds || 0) / 1e6);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Bucket every practice-log date across the player's active plans
 *  into a Set of day keys ("YYYY-M-D"). Used by streak math + any other
 *  consumer that needs "did they practice on day X". */
export function buildPracticeDayKeys(activePlans: DevelopmentPlan[]): Set<string> {
  const dayKeys = new Set<string>();
  for (const p of activePlans) {
    for (const g of (p.goals || [])) {
      for (const l of ((g as any).practiceLog || [])) {
        const d = coerceLogDate(l.date);
        if (!d) continue;
        dayKeys.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
      }
    }
  }
  return dayKeys;
}

/** Walk back from today, counting consecutive practice days.
 *
 *  `restDayOfWeek` is optional (0=Sun … 6=Sat, or null/undefined for
 *  no rest day). When set, that day is SKIPPED — it doesn't count
 *  toward the streak and missing it doesn't break it. This lets a
 *  team observing any religious/cultural day off keep streaks alive
 *  by practicing the other six days.
 *
 *  Backward compat: when the caller doesn't pass a rest day, we
 *  default to Sunday (0), matching the original hard-coded behavior.
 *  Coaches who want NO rest day pass `null` explicitly.
 *
 *  Today gets a free pass: if you haven't logged yet today, we start
 *  walking from yesterday instead of penalizing you mid-day. */
export function computeStreakDays(
  activePlans: DevelopmentPlan[],
  restDayOfWeek: number | null | undefined = 0,
): number {
  const dayKeys = buildPracticeDayKeys(activePlans);
  if (dayKeys.size === 0) return 0;
  const skipDow: number | null = (restDayOfWeek === null || restDayOfWeek === undefined) ? 0 : restDayOfWeek;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  const todayKey = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
  // If today is unlogged AND not the rest day, start from yesterday.
  // When today IS the rest day, leave the cursor; the loop skips it.
  if (!dayKeys.has(todayKey) && (skipDow == null || cursor.getDay() !== skipDow)) {
    cursor.setDate(cursor.getDate() - 1);
  }
  let streak = 0;
  for (;;) {
    if (skipDow != null && cursor.getDay() === skipDow) {
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }
    const k = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
    if (dayKeys.has(k)) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else break;
  }
  return streak;
}

/** Walk every practice-log date across this player's active plans,
 *  bucket by day, count consecutive days ending today (Sundays skipped).
 *  Persist to players/{id}.currentStreakDays. Same algorithm
 *  PlayerDevelopment uses — extracted so the cached badge stays
 *  consistent regardless of where the "I did it" tap came from.
 *
 *  When `actor` is provided, also detects streak-milestone crossings
 *  (5/10/25/50/100 day) and fires an auto-post to the team wall.
 *  Fire-and-forget — the streak still persists if the post fails. */
export async function recomputeAndPersistPlayerStreak(
  playerId: string,
  activePlansAfterUpdate: DevelopmentPlan[],
  actor?: { uid: string; name: string; role?: string }
): Promise<number> {
  try {
    // Read the prior streak + player name/team + team rest-day config
    // BEFORE computing so we honor the team's practice-streak setting
    // (undefined → default Sunday-skip for back-compat). One extra
    // round-trip per tap, but only on 'I did it today' — light traffic.
    let priorStreak = 0;
    let playerName: string | undefined;
    let teamId: string | null | undefined;
    let restDayOfWeek: number | null | undefined = 0;
    let existingBadges: Record<string, any> | undefined;
    try {
      const snap = await getDoc(doc(db, 'players', playerId));
      if (snap.exists()) {
        const data = snap.data() as any;
        priorStreak = typeof data.currentStreakDays === 'number' ? data.currentStreakDays : 0;
        playerName = data.name;
        teamId = data.teamId;
        existingBadges = data.badges;
      }
    } catch (err) {
      console.warn('streak prior read failed', err);
    }
    if (teamId) {
      try {
        const teamSnap = await getDoc(doc(db, 'teams', teamId));
        if (teamSnap.exists()) {
          const cfg = (teamSnap.data() as any).streakConfig;
          if (cfg && Object.prototype.hasOwnProperty.call(cfg, 'restDayOfWeek')) {
            restDayOfWeek = cfg.restDayOfWeek === null ? null : Number(cfg.restDayOfWeek);
          }
        }
      } catch (err) {
        console.warn('team streak config read failed', err);
      }
    }

    const streak = computeStreakDays(activePlansAfterUpdate, restDayOfWeek);

    // Piggyback the streak-milestone badge grants onto the same
    // updateDoc so we don't cost an extra round-trip. Fires only on
    // priorStreak < N && streak >= N — a kid at prior=30 who already
    // crossed pre-ship doesn't get retroactive badges.
    const { computeStreakBadgePatch } = await import('./badgeGrants');
    const badgePatch = computeStreakBadgePatch(priorStreak, streak, existingBadges, { playerName });
    await updateDoc(doc(db, 'players', playerId), {
      currentStreakDays: streak,
      currentStreakUpdatedAt: new Date(),
      ...badgePatch,
    });

    if (actor && playerName && teamId) {
      try {
        const { streakMilestoneCrossed, autoPostStreakMilestoneToWall } = await import('./autoPostToWall');
        const milestone = streakMilestoneCrossed(priorStreak, streak);
        if (milestone) {
          void autoPostStreakMilestoneToWall({ name: playerName, teamId }, milestone, actor);
        }
      } catch (err) {
        console.warn('streak milestone post skipped', err);
      }
    }

    return streak;
  } catch (err) {
    console.warn('recomputeAndPersistPlayerStreak failed', err);
    return 0;
  }
}

/** Did this goal get a practice log entry today? Used by the inline
 *  card on PlayerProfile to flip the button state to "Done today ✓"
 *  so the parent isn't confused into re-tapping. */
export function didItToday(goal: DevelopmentGoal): boolean {
  if (!goal.practiceLog || goal.practiceLog.length === 0) return false;
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
  return goal.practiceLog.some(l => {
    const d = (l.date as any)?.toDate ? (l.date as any).toDate() : new Date(l.date);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === todayKey;
  });
}
