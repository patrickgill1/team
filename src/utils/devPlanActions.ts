import { doc, updateDoc } from 'firebase/firestore';
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
  return updatedGoals;
}

/** Walk every practice-log date across this player's active plans,
 *  bucket by day, count consecutive days ending today (or yesterday if
 *  they haven't tapped yet today). Persist to players/{id}.
 *  currentStreakDays. Same algorithm PlayerDevelopment uses — extracted
 *  so the cached badge stays consistent regardless of where the
 *  "I did it" tap came from. */
export async function recomputeAndPersistPlayerStreak(
  playerId: string,
  activePlansAfterUpdate: DevelopmentPlan[]
): Promise<number> {
  try {
    const dayKeys = new Set<string>();
    for (const p of activePlansAfterUpdate) {
      for (const g of (p.goals || [])) {
        for (const l of ((g as any).practiceLog || [])) {
          const d = l.date?.toDate ? l.date.toDate() : new Date(l.date);
          dayKeys.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
        }
      }
    }
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    let cursor: Date;
    const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
    const yKey = `${yesterday.getFullYear()}-${yesterday.getMonth()}-${yesterday.getDate()}`;
    if (dayKeys.has(todayKey)) cursor = today;
    else if (dayKeys.has(yKey)) cursor = yesterday;
    else {
      await updateDoc(doc(db, 'players', playerId), {
        currentStreakDays: 0,
        currentStreakUpdatedAt: new Date(),
      });
      return 0;
    }
    let streak = 0;
    while (true) {
      const k = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
      if (dayKeys.has(k)) {
        streak++;
        cursor = new Date(cursor.getTime() - 86_400_000);
      } else break;
    }
    await updateDoc(doc(db, 'players', playerId), {
      currentStreakDays: streak,
      currentStreakUpdatedAt: new Date(),
    });
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
