// TodaysDevelopmentCard — the parent-facing "log tonight's practice"
// action card. Reshapes the earlier tonight-goal ribbon around a
// mockup Patrick approved on 2026-07-13:
//
//   * Kicker "TODAY'S DEVELOPMENT" in crimson
//   * Sub-line: "Logged today · <plan title>" (or "This week ·")
//   * Focus text (goal or focus body)
//   * Large "N DAY STREAK" chip on the right (emerald)
//   * 7-day grid with checkmark circles for logged days
//   * BIG red "I DID IT" CTA when today isn't logged
//   * "LOGGED TODAY" confirm state when today is logged
//
// Clicking I DID IT calls the worker /dev-plans/log-tap endpoint
// directly (no need to hydrate the full plan doc client-side —
// worker just needs planId + goalId + playerId + teamId) and
// optimistically flips the local state so the UI responds
// instantly. Rolls back on error.

import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { workerFetch } from '../../utils/workerFetch';

export interface TonightGoal {
  planId: string;
  goalId: string;
  planTitle: string;
  goalTitle: string;
  focus?: string;
  loggedToday: boolean;
  streakDays: number;
  thisWeek: { date: Date; logged: boolean; isFuture: boolean }[];
}

interface Props {
  goal: TonightGoal;
  playerId: string;
  teamId: string;
  /** Called after a successful "I did it" tap so the parent can
   *  update its cached TonightGoal state (streak + logged flags). */
  onLogged?: (updated: TonightGoal) => void;
}

const DAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const FlameIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path fillRule="evenodd" d="M12.963 2.286a.75.75 0 00-1.071-.136 9.742 9.742 0 00-3.539 6.176 7.547 7.547 0 01-1.705-1.715.75.75 0 00-1.152-.082A9 9 0 1015.68 4.534a7.46 7.46 0 01-2.717-2.248z" clipRule="evenodd" />
  </svg>
);

const CheckIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    <polyline points="5 12 10 17 19 8" />
  </svg>
);

const TodaysDevelopmentCard: React.FC<Props> = ({ goal, playerId, teamId, onLogged }) => {
  const [busy, setBusy] = useState(false);
  // Local optimistic overlay so a successful tap paints immediately
  // and survives the parent's re-render before the worker returns.
  const [overlay, setOverlay] = useState<{ streakBump: number; loggedToday: boolean } | null>(null);

  const streak = goal.streakDays + (overlay?.streakBump || 0);
  const loggedToday = overlay?.loggedToday ?? goal.loggedToday;

  const todayIdx = useMemo(() => {
    const now = new Date();
    return goal.thisWeek.findIndex((d) => isSameDay(d.date, now));
  }, [goal.thisWeek]);

  const thisWeekEffective = useMemo(() => {
    if (!overlay?.loggedToday || todayIdx < 0) return goal.thisWeek;
    return goal.thisWeek.map((d, i) => (i === todayIdx ? { ...d, logged: true } : d));
  }, [goal.thisWeek, overlay, todayIdx]);

  const handleDidIt = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy || loggedToday) return;
    setBusy(true);
    // Optimistic: paint today as logged + bump streak by 1
    setOverlay({ streakBump: 1, loggedToday: true });
    try {
      const res = await workerFetch('/dev-plans/log-tap', {
        method: 'POST',
        body: JSON.stringify({
          planId: goal.planId,
          goalId: goal.goalId,
          playerId,
          teamId,
        }),
      });
      if (!res.ok) throw new Error(`log-tap-${res.status}`);
      onLogged?.({
        ...goal,
        loggedToday: true,
        streakDays: streak,
        thisWeek: thisWeekEffective,
      });
    } catch (err) {
      // Rollback and let the user retry.
      setOverlay(null);
      console.warn('[todays-dev] log-tap failed', err);
      alert("Couldn't save that tap. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="relative overflow-hidden rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 shadow-lg shadow-black/5">
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand-primary via-brand-primary-soft to-transparent pointer-events-none" aria-hidden />

      <div className="relative px-4 pt-3.5 pb-4">
        {/* Row 1: kicker + sub + focus (left), big streak chip (right) */}
        <div className="flex items-start justify-between gap-3">
          <Link to={`/development?expand=${encodeURIComponent(goal.planId)}`} className="flex-1 min-w-0 block">
            <div className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.3em] text-brand-primary">
              <FlameIcon className="w-3.5 h-3.5" />
              Today&apos;s Development
            </div>
            <div className="text-[11px] text-ink-primary/55 mt-1">
              <span className={loggedToday ? 'text-emerald-300 font-bold' : ''}>
                {loggedToday ? 'Logged today' : 'This week'}
              </span>
              <span className="text-ink-primary/30"> · </span>
              <span className="text-ink-primary/75 font-bold">{goal.planTitle}</span>
            </div>
            <div className="text-[15px] font-bold text-ink-primary leading-snug mt-1.5">
              {goal.focus || goal.goalTitle}
            </div>
          </Link>
          {streak > 0 && (
            <div className="flex-shrink-0 inline-flex flex-col items-center justify-center px-3 py-2 rounded-xl bg-emerald-500/10 ring-1 ring-emerald-400/40">
              <div className="text-[22px] font-black text-emerald-300 leading-none tabular-nums">{streak}</div>
              <div className="text-[9px] font-black tracking-widest uppercase text-emerald-300/80 mt-0.5">Day Streak</div>
            </div>
          )}
        </div>

        {/* Row 2: 7-day grid, checkmark circles for logged days, brand-primary pulse for today. */}
        <div className="mt-4 flex items-stretch justify-between gap-1.5">
          {thisWeekEffective.map((d, i) => {
            const isToday = i === todayIdx;
            return (
              <div key={i} className="flex flex-col items-center gap-1.5 flex-1">
                <span className={`text-[10px] font-black uppercase tracking-widest ${isToday ? 'text-brand-primary' : 'text-ink-primary/40'}`}>
                  {DAY_LETTER[d.date.getDay()]}
                </span>
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center ring-1 transition-colors ${
                    d.logged
                      ? 'bg-emerald-500/20 ring-emerald-400/60 text-emerald-300'
                      : isToday
                        ? 'ring-brand-primary/50 text-brand-primary-soft'
                        : 'ring-line-default/25 text-transparent'
                  }`}
                  aria-label={d.logged ? 'logged' : isToday ? 'today, not logged' : 'not logged'}
                >
                  {d.logged ? <CheckIcon className="w-3.5 h-3.5" /> : null}
                </div>
              </div>
            );
          })}
        </div>

        {/* Row 3: I DID IT CTA or "Logged today" confirm */}
        {loggedToday ? (
          <div className="mt-4 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500/10 ring-1 ring-emerald-400/30 text-emerald-300 text-[11px] font-black uppercase tracking-widest">
            <CheckIcon className="w-4 h-4" />
            Logged today
          </div>
        ) : (
          <button
            type="button"
            onClick={handleDidIt}
            disabled={busy}
            className="mt-4 w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-brand-primary hover:brightness-110 text-white text-[13px] font-black uppercase tracking-[0.2em] shadow-lg shadow-brand-primary/30 active:scale-[0.98] transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy ? 'Logging…' : 'I Did It'}
          </button>
        )}
      </div>
    </section>
  );
};

export default TodaysDevelopmentCard;
