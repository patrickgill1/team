import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import type { DevelopmentGoal, DevelopmentPlan, PracticeLogEntry } from '../types';
import { workerFetch } from './workerFetch';
import { debugWarn } from './debug';

// Shared dev-plan write actions. Used by both PlayerDevelopment (the
// dedicated full-plan view) AND PlayerProfile (the inline overview
// card). Patrick's "things work two ways" complaint was about this —
// the same action should write the same thing whether you tap it from
// the profile or from the full plan page.

/** Log "I did it today" for one goal on one plan.
 *
 *  Routes through the worker at POST /dev-plans/log-tap so the write
 *  is paired with a "did_it" parent_whispers doc atomically. The
 *  whisper is idempotent per player per Denver day: subsequent taps
 *  same-day get a Firestore 409 that the worker silently swallows,
 *  so a kid who taps 3 goals only sends one whisper. Client falls
 *  back to a direct Firestore write if the worker call fails
 *  (network flake, worker cold-start miss) so the "I did it" gesture
 *  is NEVER lost — just the whisper might be missed.
 *
 *  Returns the updated goals array so callers can immediately
 *  reconcile local state + recompute the streak. */
export async function quickDidIt(
  plan: DevelopmentPlan,
  goalId: string,
  actor: { uid: string; name: string }
): Promise<DevelopmentGoal[]> {
  const optimisticEntry: PracticeLogEntry = {
    id: `log_${Date.now()}`,
    date: new Date(),
    note: 'Did it today',
    loggedBy: actor.uid,
    loggedByName: actor.name,
  };
  const optimisticGoals: DevelopmentGoal[] = plan.goals.map(g =>
    g.id === goalId ? { ...g, practiceLog: [...(g.practiceLog || []), optimisticEntry] } : g
  );

  let updatedGoals: DevelopmentGoal[] = optimisticGoals;
  try {
    const res = await workerFetch('/dev-plans/log-tap', {
      method: 'POST',
      body: JSON.stringify({
        planId: plan.id,
        goalId,
        playerId: plan.playerId,
        teamId: plan.teamId,
      }),
    });
    const data: any = await res.json();
    if (res.ok && data?.ok && Array.isArray(data.updatedGoals)) {
      updatedGoals = data.updatedGoals as DevelopmentGoal[];
    } else {
      throw new Error(data?.error || `log-tap-${res.status}`);
    }
  } catch (err) {
    // Rescue path — worker unavailable, fall back to the client
    // write so the tap is never lost. No whisper fires here; the
    // primary path takes care of that when the worker is healthy.
    debugWarn('[dev-plans] log-tap worker fallback:', err);
    try {
      await updateDoc(doc(db, 'development_plans', plan.id), { goals: optimisticGoals });
    } catch (fallbackErr) {
      // Both paths dead — surface to caller so the UI can retry.
      throw fallbackErr;
    }
  }

  // Invalidate the Dashboard tonight-goal cache so the next Dashboard
  // mount refetches instead of showing the stale "not logged today"
  // state for a beat.
  try {
    const { invalidateCache } = await import('./queryCache');
    invalidateCache(`dashboard:tonightGoal:${plan.playerId}`);
  } catch { /* non-fatal */ }
  return updatedGoals;
}

/** Coach acknowledges seeing a specific log entry. Routes through
 *  the worker at POST /dev-plans/log-verify. Server stamps
 *  verifiedBy on the entry AND fires a coach_verify parent_whispers
 *  doc (deterministic id per log entry, so re-taps are idempotent). */
export async function coachVerifyLogEntry(opts: {
  plan: DevelopmentPlan;
  goalId: string;
  logId: string;
}): Promise<{ verifiedBy: { uid: string; name: string; at: Date }; alreadyVerified: boolean }> {
  const { plan, goalId, logId } = opts;
  const res = await workerFetch('/dev-plans/log-verify', {
    method: 'POST',
    body: JSON.stringify({
      planId: plan.id,
      goalId,
      logId,
      playerId: plan.playerId,
      teamId: plan.teamId,
    }),
  });
  const data: any = await res.json();
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || `log-verify-${res.status}`);
  }
  return {
    verifiedBy: {
      uid: data.verifiedBy.uid,
      name: data.verifiedBy.name,
      at: data.verifiedBy.at ? new Date(data.verifiedBy.at) : new Date(),
    },
    alreadyVerified: data.alreadyVerified === true,
  };
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

/** Denver-anchored day key "YYYY-MM-DD" for a JS Date. All streak
 *  bucketing/walking uses Denver time so a parent whose phone is on
 *  Eastern buckets a Denver-late-night tap into the SAME day as the
 *  worker + backfill. Fixes drift where the worker stored dayKey in
 *  Denver but the client bucketed device-local. */
export function denverKeyOfDate(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

/** Break a JS Date into its Denver-anchored Y/M/D parts. */
export function denverParts(date: Date): { y: number; m: number; d: number } {
  const key = denverKeyOfDate(date);
  const [ys, ms, ds] = key.split('-');
  return { y: parseInt(ys, 10), m: parseInt(ms, 10), d: parseInt(ds, 10) };
}

/** Previous Denver day in Y/M/D form, handling month/year rollover
 *  without going near Date arithmetic (which trips over DST). */
export function prevDenverYmd(y: number, m: number, d: number): { y: number; m: number; d: number } {
  let nd = d - 1;
  let nm = m;
  let ny = y;
  if (nd === 0) {
    nm -= 1;
    if (nm === 0) { nm = 12; ny -= 1; }
    // Last day of the new (prior) month. Date.UTC(y, m, 0) → last day
    // of the month BEFORE month `m`. For nm we want last day of nm,
    // so pass month index nm (which is 1-based → 0-based nm-1, plus 1).
    nd = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  }
  return { y: ny, m: nm, d: nd };
}

/** Day-of-week (0=Sun … 6=Sat) for a Denver Y/M/D. Timezone-invariant
 *  at noon UTC, so we anchor there. */
function dowOfYmd(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

/** Compose "YYYY-MM-DD" from Denver parts. */
export function keyFromYmd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Bucket every practice-log date across the player's active plans
 *  into a Set of Denver day keys ("YYYY-MM-DD"). Used by legacy
 *  plan-shape streak math + any other consumer that needs "did they
 *  practice on day X". Denver-anchored so a non-Denver device
 *  buckets consistently with the worker-written check-in dayKey. */
export function buildPracticeDayKeys(activePlans: DevelopmentPlan[]): Set<string> {
  const dayKeys = new Set<string>();
  for (const p of activePlans) {
    for (const g of (p.goals || [])) {
      for (const l of ((g as any).practiceLog || [])) {
        const d = coerceLogDate(l.date);
        if (!d) continue;
        dayKeys.add(denverKeyOfDate(d));
      }
    }
  }
  return dayKeys;
}

/** Walk back from today over a pre-built Set of practice day keys,
 *  counting consecutive practice days.
 *
 *  Day key shape: "YYYY-MM-DD" (Denver-anchored, zero-padded). That
 *  format is what buildPracticeDayKeys emits AND what the worker
 *  stamps on players/{pid}/dev_checkins/{dayKey} + `data.dayKey`, so
 *  every producer and consumer speaks the same key.
 *
 *  `restDayOfWeek` is optional (0=Sun … 6=Sat, or null/undefined for
 *  no rest day). When set, that day is SKIPPED — it doesn't count
 *  toward the streak and missing it doesn't break it (feedback
 *  memory: streak_sunday_skip, streaks skip Sundays for religious
 *  families).
 *
 *  Today gets a free pass: if today isn't in the set AND today isn't
 *  the rest day, walk starts from yesterday so a kid mid-day isn't
 *  penalized before they've had a chance to tap. */
export function computeStreakDaysFromKeys(
  dayKeys: Set<string>,
  restDayOfWeek: number | null | undefined = 0,
): number {
  if (dayKeys.size === 0) return 0;
  const skipDow: number | null = (restDayOfWeek === null || restDayOfWeek === undefined) ? 0 : restDayOfWeek;
  let { y, m, d } = denverParts(new Date());
  const todayKey = keyFromYmd(y, m, d);
  // If today is unlogged AND not the rest day, start from yesterday.
  // When today IS the rest day, leave the cursor; the loop skips it.
  if (!dayKeys.has(todayKey) && (skipDow == null || dowOfYmd(y, m, d) !== skipDow)) {
    ({ y, m, d } = prevDenverYmd(y, m, d));
  }
  let streak = 0;
  for (;;) {
    if (skipDow != null && dowOfYmd(y, m, d) === skipDow) {
      ({ y, m, d } = prevDenverYmd(y, m, d));
      continue;
    }
    if (dayKeys.has(keyFromYmd(y, m, d))) {
      streak++;
      ({ y, m, d } = prevDenverYmd(y, m, d));
    } else break;
  }
  return streak;
}

/** Longest-ever consecutive run in a Set of day keys (Sunday-skip
 *  aware). Used to seed players/{id}.longestStreakDays so retiring a
 *  plan can never quietly overwrite a legitimate historical peak.
 *
 *  Keys are Denver "YYYY-MM-DD" — walk between the earliest and
 *  latest key using Denver-anchored day arithmetic so DST transitions
 *  don't shift the walk off by an hour. */
export function computeLongestStreakFromKeys(
  dayKeys: Set<string>,
  restDayOfWeek: number | null | undefined = 0,
): number {
  if (dayKeys.size === 0) return 0;
  const skipDow: number | null = (restDayOfWeek === null || restDayOfWeek === undefined) ? 0 : restDayOfWeek;
  // Sort the keys as strings — "YYYY-MM-DD" is lexicographically sortable.
  const sorted = Array.from(dayKeys)
    .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort();
  if (sorted.length === 0) return 0;
  const [fy, fm, fd] = sorted[0].split('-').map(n => parseInt(n, 10));
  const lastKey = sorted[sorted.length - 1];
  let y = fy, m = fm, d = fd;
  let run = 0;
  let max = 0;
  // Walk forward Denver-day by Denver-day until we pass lastKey.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const key = keyFromYmd(y, m, d);
    const isRest = skipDow != null && dowOfYmd(y, m, d) === skipDow;
    if (isRest) {
      // Rest day bridges — do not increment, do not reset.
    } else if (dayKeys.has(key)) {
      run += 1;
      if (run > max) max = run;
    } else {
      run = 0;
    }
    if (key === lastKey) break;
    // Next Denver day: mirror prevDenverYmd but forward.
    d += 1;
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (d > daysInMonth) { d = 1; m += 1; if (m > 12) { m = 1; y += 1; } }
  }
  return max;
}

/** Walk back from today, counting consecutive practice days across
 *  the given plans. Delegates to computeStreakDaysFromKeys so callers
 *  reading plan-shape data (legacy path) share the same walk math as
 *  callers reading player check-in docs (new path). */
export function computeStreakDays(
  activePlans: DevelopmentPlan[],
  restDayOfWeek: number | null | undefined = 0,
): number {
  return computeStreakDaysFromKeys(buildPracticeDayKeys(activePlans), restDayOfWeek);
}

/** Recompute + persist the player's practice streak.
 *
 *  2026-07-24 rewire: streak recompute + practice XP + streak-badge
 *  grants all move to the worker via POST /xp/log-tap. Client is now a
 *  thin driver — it reads priorXp for the level-up whisper trigger,
 *  fires the tap, mirrors the returned streak into local state, and
 *  hands off to the wall-post helper. All player.xp / player.badges /
 *  player.currentStreakDays writes happen server-side under the service
 *  account so the audit event row + increments + badge stamps land as
 *  one atomic commit.
 *
 *  Distinction between the two call shapes:
 *   - actor present → real "I did it today" tap. Worker fires the
 *     +5 (parent/coach) or +10 (kid) practice XP grant, updates the
 *     streak, and returns the new value. Client fires the milestone
 *     wall post + level-up whisper.
 *   - actor absent → mount-effect self-heal. Worker still recomputes
 *     the streak counter + backfills any missing streak-milestone
 *     badges, but SKIPS the practice XP grant (no real tap happened).
 *     selfHeal:true tells the worker to take that shortcut. Client
 *     does NOT fire the wall post.
 *
 *  `activePlansAfterUpdate` is accepted for API back-compat but no
 *  longer consulted — check-ins are the source of truth server-side.
 *
 *  Returns the new streak, or the cached priorStreak on any failure so
 *  callers see the unchanged value rather than a spurious 0. */
export async function recomputeAndPersistPlayerStreak(
  playerId: string,
  _activePlansAfterUpdate: DevelopmentPlan[],
  actor?: { uid: string; name: string; role?: string },
  /** Kid-in-app double (2026-07-17): when the "I did it" tap fires from
   *  the kid mode shell (KidDashboard, KidHeroCard etc.), the practice
   *  micro-XP doubles from +5 to +10. Ignored when actor is absent
   *  (self-heal path never grants practice XP). */
  isKidActor: boolean = false
): Promise<number> {
  try {
    // Read the prior streak, teamId, and priorXp before firing the tap.
    // teamId is needed for the worker's auth check; priorStreak is the
    // fallback return on any failure so callers see the unchanged value;
    // priorXp lets us fire the level-up whisper after the worker returns
    // the post-write newPlayerXp.
    let priorStreak = 0;
    let teamId: string | null | undefined;
    let priorXp = 0;
    let playerName: string | undefined;
    let parentIds: string[] | undefined;
    try {
      const snap = await getDoc(doc(db, 'players', playerId));
      if (snap.exists()) {
        const data = snap.data() as any;
        priorStreak = typeof data.currentStreakDays === 'number' ? data.currentStreakDays : 0;
        teamId = data.teamId;
        priorXp = Number(data.xp) || 0;
        playerName = data.name;
        parentIds = Array.isArray(data.parentIds) ? data.parentIds : undefined;
      }
    } catch (err) {
      console.warn('streak prior read failed', err);
    }
    if (!teamId) {
      debugWarn('[dev-plans] recomputeAndPersistPlayerStreak: no teamId on player', playerId);
      return priorStreak;
    }

    const dayKey = denverKeyOfDate(new Date());
    const selfHeal = !actor;
    const body: Record<string, any> = {
      playerId,
      teamId,
      dayKey,
      isKidActor: selfHeal ? false : Boolean(isKidActor),
    };
    if (selfHeal) body.selfHeal = true;

    let streak = priorStreak;
    let newPlayerXp: number | undefined;
    try {
      const res = await workerFetch('/xp/log-tap', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        debugWarn('[dev-plans] /xp/log-tap failed — keeping prior streak', {
          status: res.status,
          error: data?.error,
        });
        return priorStreak;
      }
      if (typeof data?.newStreak === 'number') {
        streak = data.newStreak;
      } else if (typeof data?.streak === 'number') {
        streak = data.streak;
      }
      if (typeof data?.newPlayerXp === 'number') {
        newPlayerXp = data.newPlayerXp;
      }
    } catch (err) {
      debugWarn('[dev-plans] /xp/log-tap threw — keeping prior streak', err);
      return priorStreak;
    }

    // Level-up whisper: worker returns the post-write player.xp so we
    // can detect a level crossing without a second read. Fire-and-forget;
    // whisper is a nice-to-have parent notification. Skipped on self-heal
    // (no XP granted → no crossing possible).
    if (!selfHeal && typeof newPlayerXp === 'number' && newPlayerXp > priorXp) {
      try {
        const { checkLevelUpAndWhisper } = await import('./levelUp');
        void checkLevelUpAndWhisper(playerId, priorXp, newPlayerXp, teamId, {
          xpEnabled: true,
          playerData: { name: playerName, parentIds },
        });
      } catch { /* whisper is nice-to-have */ }
    }

    // Milestone wall post — only on real taps (actor present). Self-heal
    // effects must never fire a "3 day streak!" wall post on a page mount.
    if (actor && playerName) {
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

/** Did this goal get a practice log entry today (Denver)? Used by
 *  the inline card on PlayerProfile to flip the button state to
 *  "Done today" so the parent isn't confused into re-tapping. */
export function didItToday(goal: DevelopmentGoal): boolean {
  if (!goal.practiceLog || goal.practiceLog.length === 0) return false;
  const todayKey = denverKeyOfDate(new Date());
  return goal.practiceLog.some(l => {
    const d = (l.date as any)?.toDate ? (l.date as any).toDate() : new Date(l.date as any);
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return false;
    return denverKeyOfDate(d) === todayKey;
  });
}
