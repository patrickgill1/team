import { collection, doc, getDoc, getDocs, updateDoc } from 'firebase/firestore';
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

/** Build the day-key Set for a player from their check-in subcollection
 *  (players/{playerId}/dev_checkins/*). Doc-id AND `data.dayKey` are
 *  Denver "YYYY-MM-DD" per the worker; we prefer the stored dayKey
 *  string over re-bucketing the Timestamp so the client's phone tz
 *  can never disagree with the worker's Denver truth.
 *
 *  THROWS on read failure. Caller (recomputeAndPersistPlayerStreak)
 *  must abort persist rather than write an empty-Set-derived streak
 *  of 0 that would silently clobber a legit cached value. */
async function loadCheckinDayKeys(playerId: string): Promise<Set<string>> {
  const dayKeys = new Set<string>();
  const snap = await getDocs(collection(db, 'players', playerId, 'dev_checkins'));
  snap.forEach(docSnap => {
    const data = docSnap.data() as any;
    if (data?.voided === true) return; // soft-delete path (coach undo)
    // Prefer the stored Denver dayKey. Fall back to the docId (also
    // Denver dayKey per worker), then to a Timestamp coercion for any
    // legacy row that predates the dayKey field.
    let key: string | null = null;
    if (typeof data?.dayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.dayKey)) {
      key = data.dayKey;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(docSnap.id)) {
      key = docSnap.id;
    } else {
      const d = coerceLogDate(data?.date);
      if (d) key = denverKeyOfDate(d);
    }
    if (key) dayKeys.add(key);
  });
  return dayKeys;
}

/** Recompute + persist the player's practice streak.
 *
 *  Source of truth (2026-07-21 player-scoped rework): the
 *  players/{id}/dev_checkins subcollection, populated by the worker
 *  on every "I did it" tap. Streak is plan-agnostic — retiring plan
 *  A and creating plan B for the same kid has zero effect on the
 *  counter. Prior implementation read from active plans only, so
 *  archiving a plan silently reset the streak (the design's fix).
 *
 *  `activePlansAfterUpdate` is accepted for API back-compat but no
 *  longer consulted for the streak math. Kept in the signature so
 *  every existing call site continues to compile without change.
 *
 *  When `actor` is provided, also detects streak-milestone crossings
 *  (5/10/25/50 day) and fires an auto-post to the team wall.
 *  Fire-and-forget — the streak still persists if the post fails.
 *
 *  Sunday-skip is preserved via computeStreakDaysFromKeys (the
 *  streak_sunday_skip memory rule). */
export async function recomputeAndPersistPlayerStreak(
  playerId: string,
  _activePlansAfterUpdate: DevelopmentPlan[],
  actor?: { uid: string; name: string; role?: string },
  /** Kid-in-app double (2026-07-17): when the "I did it" tap fires from
   *  the kid mode shell (KidDashboard, KidHeroCard etc.), the practice
   *  micro-XP doubles from +5 to +10. Defaults false so parent + coach
   *  callsites keep the base amount. Only affects the practice
   *  participation micro-XP — badge XP + streak milestones + wall posts
   *  are unchanged. */
  isKidActor: boolean = false
): Promise<number> {
  try {
    // Read the prior streak + player name/team + team rest-day config
    // BEFORE computing so we honor the team's practice-streak setting
    // (undefined → default Sunday-skip for back-compat). One extra
    // round-trip per tap, but only on 'I did it today' — light traffic.
    let priorStreak = 0;
    let priorLongest = 0;
    let playerName: string | undefined;
    let teamId: string | null | undefined;
    let restDayOfWeek: number | null | undefined = 0;
    let existingBadges: Record<string, any> | undefined;
    let xpEnabled = false;
    let teamDataForXp: any = null;
    let priorXp = 0;
    let parentIds: string[] | undefined;
    try {
      const snap = await getDoc(doc(db, 'players', playerId));
      if (snap.exists()) {
        const data = snap.data() as any;
        priorStreak = typeof data.currentStreakDays === 'number' ? data.currentStreakDays : 0;
        priorLongest = typeof data.longestStreakDays === 'number' ? data.longestStreakDays : 0;
        playerName = data.name;
        teamId = data.teamId;
        existingBadges = data.badges;
        priorXp = Number(data.xp) || 0;
        parentIds = Array.isArray(data.parentIds) ? data.parentIds : undefined;
      }
    } catch (err) {
      console.warn('streak prior read failed', err);
    }
    if (teamId) {
      try {
        const teamSnap = await getDoc(doc(db, 'teams', teamId));
        if (teamSnap.exists()) {
          const teamData = teamSnap.data() as any;
          const cfg = teamData.streakConfig;
          if (cfg && Object.prototype.hasOwnProperty.call(cfg, 'restDayOfWeek')) {
            restDayOfWeek = cfg.restDayOfWeek === null ? null : Number(cfg.restDayOfWeek);
          }
          // Piggyback the XP-enabled read on the same team fetch so
          // streak-badge grants can gate on the team's opt-in state.
          xpEnabled = teamData?.xpConfig?.enabled === true;
          // Stash the team-shaped payload for per-source gates below —
          // isXpSourceEnabled reads xpConfig.sources with the Ship 1
          // participation/badges coarse fallbacks if per-source keys
          // aren't defined yet on this team.
          teamDataForXp = teamData;
        }
      } catch (err) {
        console.warn('team streak config read failed', err);
      }
    }

    // Read the player-scoped check-in subcollection. This is the
    // source of truth (2026-07-21). Plan status changes can't reset
    // or shrink the streak because check-ins live on the player, not
    // on the plan.
    //
    // On transient read failure, ABORT the recompute entirely — writing
    // a 0-derived streak would silently clobber a legit priorStreak of
    // 30+ with zero user-facing error. Return prior so callers see the
    // unchanged value.
    let dayKeys: Set<string>;
    try {
      dayKeys = await loadCheckinDayKeys(playerId);
    } catch (err) {
      debugWarn('[dev-plans] loadCheckinDayKeys read failed — keeping prior streak', err);
      return priorStreak;
    }
    const streak = computeStreakDaysFromKeys(dayKeys, restDayOfWeek);
    const computedLongest = computeLongestStreakFromKeys(dayKeys, restDayOfWeek);
    // Peak is monotonic. Never let a recompute pull it downward — a
    // corrupted or partial checkin read shouldn't clobber a legit
    // historical peak stamped by the migration.
    const nextLongest = Math.max(priorLongest, computedLongest, streak);

    // Piggyback the streak-milestone badge grants onto the same
    // updateDoc so we don't cost an extra round-trip. Fires only on
    // priorStreak < N && streak >= N — a kid at prior=30 who already
    // crossed pre-ship doesn't get retroactive badges. XP-gated so
    // teams that didn't opt into XP don't silently accumulate badges.
    const { computeStreakBadgePatch } = await import('./badgeGrants');
    const { isXpSourceEnabled } = await import('./xpSource');
    // Streak-milestone badges gate on the 'streaks' per-source key
    // (falling back to 'badges' coarse for Ship 1 teams). computeStreakBadgePatch
    // returns {} when the gate is off — the outer streak-days write still commits.
    const streakBadgeXpEnabled = isXpSourceEnabled(teamDataForXp, 'streaks');
    const badgePatch = computeStreakBadgePatch(priorStreak, streak, existingBadges, { playerName, team: teamDataForXp });
    // Compose +5 practice-log micro-XP into the SAME write. When a
    // streak badge crossed on this tick, badgePatch already carries
    // an xp/xpCareer increment sentinel — Firestore's increment does
    // not stack across two updates to the same field in one write, so
    // composeMicroXpIntoPatch recomputes the badge XP amount from the
    // touched slugs and merges into a single combined increment.
    const { composeMicroXpIntoPatch } = await import('./microXp');
    // Practice tick +5 gates on the per-source 'practice' key (falling
    // back to Ship 1 'participation' coarse). Badge XP already handled above.
    const participationXpEnabled = isXpSourceEnabled(teamDataForXp, 'practice');
    const practiceMicroXpAmount = isKidActor ? 10 : 5;
    await composeMicroXpIntoPatch(badgePatch, practiceMicroXpAmount, participationXpEnabled);
    // Compute the XP that lands on this tick BEFORE the write so we
    // can trigger checkLevelUpAndWhisper against priorXp + granted.
    // badgePatch.xp is a Firestore increment sentinel, not a plain
    // number; we recompute from the touched slugs + the micro-XP add.
    let xpGrantedThisTick = 0;
    if (xpEnabled) {
      try {
        const { badgeXp } = await import('./badgeMeta');
        if (streakBadgeXpEnabled) {
          for (const key of Object.keys(badgePatch)) {
            if (key.startsWith('badges.')) {
              const slug = key.slice('badges.'.length);
              xpGrantedThisTick += badgeXp(slug) || 0;
            }
          }
        }
        if (participationXpEnabled) {
          // Must mirror composeMicroXpIntoPatch(., practiceMicroXpAmount, .) above
          // so the level-up whisper trigger stays in sync with what actually landed.
          xpGrantedThisTick += practiceMicroXpAmount;
        }
      } catch { /* ignore */ }
    }
    const writePatch: Record<string, any> = {
      currentStreakDays: streak,
      currentStreakUpdatedAt: new Date(),
      ...badgePatch,
    };
    // Only write longestStreakDays when it actually changed — the
    // common tap case (nextLongest == priorLongest) skips a field
    // mutation and keeps the write minimal.
    if (nextLongest !== priorLongest) {
      writePatch.longestStreakDays = nextLongest;
    }
    await updateDoc(doc(db, 'players', playerId), writePatch);
    if (xpEnabled && teamId && xpGrantedThisTick > 0) {
      try {
        const { checkLevelUpAndWhisper } = await import('./levelUp');
        void checkLevelUpAndWhisper(playerId, priorXp, priorXp + xpGrantedThisTick, teamId, {
          xpEnabled: true,
          playerData: { name: playerName, parentIds },
        });
      } catch { /* whisper is nice-to-have */ }
    }

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
