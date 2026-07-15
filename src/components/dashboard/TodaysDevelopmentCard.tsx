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
      {/* 2026-07-15: killed the red-fade top accent bar. Patrick's
          screenshot flagged it as fighting the solid red "I DID IT"
          button below (ambient chrome vs solid CTA = visual
          inconsistency). The card body already has enough presence
          from the ring + shadow. */}

      <div className="relative px-3 pt-2.5 pb-3">
        {/* Row 1: kicker + streak chip inline (compact), so the focus
            text gets the full card width on the next row. Tightened
            2026-07-13 after Patrick pushed back on card height. */}
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.28em] text-brand-primary min-w-0">
            <FlameIcon className="w-3 h-3 flex-shrink-0" />
            <span className="truncate">Today&apos;s Development</span>
          </div>
          {streak > 0 && (
            <span className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/12 ring-1 ring-emerald-400/40 text-emerald-300 text-[10px] font-black tracking-[0.18em] uppercase tabular-nums">
              <FlameIcon className="w-2.5 h-2.5" />
              {streak} Day
            </span>
          )}
        </div>

        {/* Row 2: sub-line (Logged today · plan title). Compact. */}
        <div className="text-[10.5px] text-ink-primary/55 mt-1">
          <span className={loggedToday ? 'text-emerald-300 font-bold' : ''}>
            {loggedToday ? 'Logged today' : 'This week'}
          </span>
          <span className="text-ink-primary/30"> · </span>
          <span className="text-ink-primary/75 font-bold">{goal.planTitle}</span>
        </div>

        {/* Row 3: focus text — full width, tighter font so short focus
            lines fit on one line. Falls back to line-clamp-2 for
            longer entries so the card never overflows. */}
        <Link to={`/development?expand=${encodeURIComponent(goal.planId)}`} className="block">
          <div className="text-[13px] font-bold text-ink-primary leading-snug mt-1 line-clamp-2">
            {goal.focus || goal.goalTitle}
          </div>
        </Link>

        {/* Row 4: 6-day grid (Mon–Sat, Sunday skipped per streak rule).
            Circles trimmed 28 → 22px. */}
        <div className="mt-2.5 flex items-stretch justify-between gap-1">
          {thisWeekEffective.map((d, i) => {
            const isToday = i === todayIdx;
            return (
              <div key={i} className="flex flex-col items-center gap-1 flex-1">
                <span className={`text-[9px] font-black uppercase tracking-widest ${isToday ? 'text-brand-primary' : 'text-ink-primary/40'}`}>
                  {DAY_LETTER[d.date.getDay()]}
                </span>
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center ring-1 transition-colors ${
                    d.logged
                      ? 'bg-emerald-500/20 ring-emerald-400/60 text-emerald-300'
                      : isToday
                        ? 'ring-brand-primary/50 text-brand-primary-soft'
                        : 'ring-line-default/25 text-transparent'
                  }`}
                  aria-label={d.logged ? 'logged' : isToday ? 'today, not logged' : 'not logged'}
                >
                  {d.logged ? <CheckIcon className="w-3 h-3" /> : null}
                </div>
              </div>
            );
          })}
        </div>

        {/* Row 5: I DID IT CTA or "Logged today" confirm — compact
            padding so the whole card fits in ~200px vertical space. */}
        {loggedToday ? (
          <div className="mt-2.5 w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 ring-1 ring-emerald-400/30 text-emerald-300 text-[10px] font-black uppercase tracking-[0.2em]">
            <CheckIcon className="w-3.5 h-3.5" />
            Logged today
          </div>
        ) : (
          <button
            type="button"
            onClick={handleDidIt}
            disabled={busy}
            className="mt-2.5 w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-brand-primary hover:brightness-110 text-white text-[11px] font-black uppercase tracking-[0.2em] shadow shadow-brand-primary/30 active:scale-[0.98] transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy ? 'Logging…' : 'I Did It'}
          </button>
        )}
      </div>
    </section>
  );
};

export default TodaysDevelopmentCard;
