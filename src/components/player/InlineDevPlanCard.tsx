import React, { useState } from 'react';
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
  const streak = currentStreakDays || 0;

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
      <div className="bg-white/[0.04] backdrop-blur ring-1 ring-white/10 rounded-2xl p-5 sm:p-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-extrabold uppercase tracking-widest text-cyan-300">Development Plan</h2>
          <button
            onClick={() => navigate('/development')}
            className="text-xs font-bold text-cyan-300 hover:text-cyan-200"
          >
            Open plan →
          </button>
        </div>
        <p className="text-sm text-white/70">
          No active plan yet — coach can build one from <button onClick={() => navigate('/development')} className="text-cyan-300 underline">Development</button>.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white/[0.04] backdrop-blur ring-1 ring-white/10 rounded-2xl p-5 sm:p-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-extrabold uppercase tracking-widest text-cyan-300">Development Plan</h2>
        <div className="flex items-center gap-2">
          {streak > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-500 text-white text-[11px] font-extrabold">
              {streak}-day streak
            </span>
          )}
          <button
            onClick={() => navigate('/development')}
            className="text-xs font-bold text-cyan-300 hover:text-cyan-200"
          >
            Open plan →
          </button>
        </div>
      </div>

      <ul className="space-y-3">
        {goals.map(({ plan, goal }) => {
          const verifiedCount = (plan.goals.filter(g => g.coachVerified)).length;
          const totalCount = plan.goals.length;
          const planPct = totalCount > 0 ? Math.round((verifiedCount / totalCount) * 100) : 0;
          const doneToday = didItToday(goal);
          return (
            <li key={goal.id} className="rounded-xl bg-white/[0.03] ring-1 ring-white/10 p-3">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-white">{goal.title}</span>
                    {goal.coachVerified && (
                      <span className="text-[9px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/40">
                        Verified
                      </span>
                    )}
                  </div>
                  {goal.focus && <p className="text-[11px] text-white/60 mt-0.5 italic">{goal.focus}</p>}
                  <div className="h-1.5 rounded-full bg-white/10 mt-2 overflow-hidden">
                    <div
                      className="h-full bg-cyan-400"
                      style={{ width: `${planPct}%` }}
                    />
                  </div>
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
                      : 'bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-50'
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

      <p className="text-[10px] text-white/40 mt-3 text-center">
        One tap = one practice day. Streak survives missing today by tapping tomorrow.
      </p>
    </div>
  );
};

export default InlineDevPlanCard;
