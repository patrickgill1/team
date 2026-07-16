import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DevelopmentPlan } from '../../types';
import { didItToday, quickDidIt, recomputeAndPersistPlayerStreak } from '../../utils/devPlanActions';

// Player Profile's dev-plan card. Shows the kid's active goals with a
// per-goal "I DID IT TODAY" button + a Streak chip + a clear link
// down to the full plan view. Same write path as PlayerDevelopment
// so the dev plan only has ONE way to mark a goal practiced —
// regardless of whether you tap it from the profile or the full plan.

interface Props {
  plans: DevelopmentPlan[];
  playerId: string;
  actor: { uid: string; name: string } | null;
  /** Current streak cached on the player doc (so we can render it
   *  without re-summing every log entry). */
  currentStreakDays?: number;
  /** Fired after a successful tap so the parent can reload the player
   *  + plans (the streak chip etc. will re-render with fresh data). */
  onUpdated?: () => void;
}

const InlineDevPlanCard: React.FC<Props> = ({ plans, playerId, actor, currentStreakDays, onUpdated }) => {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [localPlans, setLocalPlans] = useState<DevelopmentPlan[]>(plans);

  // Sync local state when the parent reloads.
  React.useEffect(() => { setLocalPlans(plans); }, [plans]);

  const activePlans = localPlans.filter(p => p.status === 'active');
  // Flatten goals across active plans so the card shows a single list
  // (most kids have one active plan; if they have more, we don't make
  // them dig into each one).
  const goals = activePlans.flatMap(p => p.goals.map(g => ({ plan: p, goal: g })));

  // Compute the TRUE streak from the active plans we have. If the
  // cached currentStreakDays prop (read from player doc by the
  // parent) disagrees, display the computed value AND silently
  // write it back to the player doc. The chip on the profile would
  // otherwise stay stuck at the stale value forever — Patrick:
  // "on his profile it says 5, in the development plan it says 6."
  // Self-heal runs once per mount + once per plans change.
  const [computedStreak, setComputedStreak] = useState<number>(currentStreakDays || 0);
  useEffect(() => {
    if (activePlans.length === 0) { setComputedStreak(0); return; }
    let cancelled = false;
    (async () => {
      try {
        const { computeStreakDays, recomputeAndPersistPlayerStreak } = await import('../../utils/devPlanActions');
        const fresh = computeStreakDays(activePlans);
        if (cancelled) return;
        setComputedStreak(fresh);
        if (fresh !== (currentStreakDays || 0)) {
          // Silent fix — no actor → no milestone wall post (the cached
          // value was just lagging behind reality; this isn't a
          // celebration moment).
          await recomputeAndPersistPlayerStreak(playerId, activePlans);
        }
      } catch (err) {
        console.warn('InlineDevPlanCard streak self-heal skipped', err);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localPlans, currentStreakDays, playerId]);

  const streak = computedStreak;

  const handleDidIt = async (plan: DevelopmentPlan, goalId: string) => {
    if (!actor) return;
    setBusy(goalId);
    try {
      const updated = await quickDidIt(plan, goalId, actor);
      // Optimistic update.
      setLocalPlans(prev => prev.map(p => p.id === plan.id ? { ...p, goals: updated } : p));
      // Persist streak. Use the optimistic plans so the streak math
      // reflects the new log entry.
      const optimisticActive = localPlans
        .map(p => p.id === plan.id ? { ...p, goals: updated } : p)
        .filter(p => p.status === 'active');
      // Pass the actor so the streak helper can fire a milestone
      // wall post (5/10/25/50/100 day crossings). AWAIT (not void)
      // because the parent's onUpdated reload refetches the player
      // doc — if the streak write hasn't landed yet, the dashboard
      // streak chip stays at the old count even though the dev plan
      // page locally shows the new number. Patrick: "i go to the
      // development plan and it says 5 day is complete, but still
      // shows 4."
      await recomputeAndPersistPlayerStreak(playerId, optimisticActive, actor);
      onUpdated?.();
    } finally {
      setBusy(null);
    }
  };

  if (activePlans.length === 0) {
    return (
      <div className="bg-surface-elevated ring-1 ring-line-default/15 rounded-2xl p-4 sm:p-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-extrabold uppercase tracking-widest text-ink-primary/55">Development Plan</h2>
          <button
            onClick={() => navigate('/development')}
            className="text-xs font-bold text-ink-primary/65 hover:text-ink-primary"
          >
            Open plan →
          </button>
        </div>
        <p className="text-sm text-ink-primary/70">
          No active plan yet — coach can build one from <button onClick={() => navigate('/development')} className="text-brand-primary-soft underline">Development</button>.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-surface-elevated ring-1 ring-line-default/15 rounded-2xl p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-extrabold uppercase tracking-widest text-ink-primary/55">Development Plan</h2>
        <div className="flex items-center gap-2">
          {streak > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-500 text-white text-[11px] font-extrabold">
              {streak}-day streak
            </span>
          )}
          <button
            onClick={() => navigate('/development')}
            className="text-xs font-bold text-ink-primary/65 hover:text-ink-primary"
          >
            Open plan →
          </button>
        </div>
      </div>

      <ul className="space-y-3">
        {goals.map(({ plan, goal }) => {
          // Per-goal session count — replaces the verified-count
          // progress bar (verification flow removed; coach judges
          // progress in person at practice).
          const sessions = (goal.practiceLog || []).length;
          const doneToday = didItToday(goal);
          return (
            <li key={goal.id} className="rounded-xl bg-line-default/[0.03] ring-1 ring-line-default/10 p-3">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-ink-primary">{goal.title}</span>
                    {sessions > 0 && (
                      <span className="text-[9px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded bg-brand-primary/15 text-ink-primary ring-1 ring-brand-primary-soft/30">
                        {sessions} session{sessions === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  {goal.focus && <p className="text-[11px] text-ink-primary/60 mt-0.5 italic">{goal.focus}</p>}
                </div>
                <button
                  type="button"
                  // Truly disable when today's already logged — was
                  // cursor-default-styled but still tappable, which
                  // let parents pile up 4+ log entries for the same
                  // day on a single goal. The streak math dedupes,
                  // but the noise was confusing in the plan view.
                  disabled={busy === goal.id || !actor || doneToday}
                  onClick={() => handleDidIt(plan, goal.id)}
                  className={`shrink-0 px-3 py-2 rounded-xl text-[11px] font-extrabold uppercase tracking-widest transition ${
                    doneToday
                      ? 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/40 cursor-default'
                      : 'bg-brand-primary text-white hover:bg-brand-primary disabled:opacity-50'
                  }`}
                  title={doneToday ? 'Already logged today — keep the streak alive tomorrow!' : 'Tap to log a practice for today'}
                >
                  {busy === goal.id ? '…' : doneToday ? 'Done today' : 'I did it!'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="text-[10px] text-ink-primary/40 mt-3 text-center">
        One tap = one practice day. Streak survives missing today by tapping tomorrow.
      </p>
    </div>
  );
};

export default InlineDevPlanCard;
