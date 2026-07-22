import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { where } from 'firebase/firestore';
import type { DevelopmentPlan, Drill } from '../../types';
import { didItToday, quickDidIt, recomputeAndPersistPlayerStreak } from '../../utils/devPlanActions';
import { resolveGoalVideo } from '../../utils/resolveGoalVideo';
import { useFirestore } from '../../hooks/useFirestore';
import CloudflareStreamIframe from '../common/CloudflareStreamIframe';

// Player Profile's dev-plan card. Shows the kid's active goals with a
// per-goal "I DID IT TODAY" button + a Streak chip + a clear link
// down to the full plan view. Same write path as PlayerDevelopment
// so the dev plan only has ONE way to mark a goal practiced —
// regardless of whether you tap it from the profile or the full plan.
//
// "Show me how" accordion (2026-07-21): when a goal carries a demo
// video (Cloudflare Stream drill snapshot OR YouTube reference links)
// or a written description, the kid gets a small warm chip that
// expands INLINE beneath the goal row. Does NOT full-screen — the
// kid stays on their scroll position. Video URL is live-resolved
// through resolveGoalVideo() so a coach re-upload propagates without
// re-importing the goal.

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
  /** Kid-in-app double (2026-07-17): true when this card is rendered
   *  inside the kid mode shell (KidDashboard). Doubles the practice
   *  micro-XP from +5 to +10 on the "I did it" tap. Defaults false so
   *  the parent PlayerProfile callsite keeps the base amount. */
  isKidActor?: boolean;
}

const InlineDevPlanCard: React.FC<Props> = ({ plans, playerId, actor, currentStreakDays, onUpdated, isKidActor = false }) => {
  const navigate = useNavigate();
  const { getDocuments } = useFirestore();
  const [busy, setBusy] = useState<string | null>(null);
  const [localPlans, setLocalPlans] = useState<DevelopmentPlan[]>(plans);
  // Per-goal accordion state. Single-open at a time so the card
  // doesn't sprawl when a kid taps a few in a row. Local, not
  // persisted — the "show me how" reveal is a fresh gesture each
  // session, not a preference.
  const [openGoalId, setOpenGoalId] = useState<string | null>(null);

  // Sync local state when the parent reloads.
  React.useEffect(() => { setLocalPlans(plans); }, [plans]);

  const activePlans = localPlans.filter(p => p.status === 'active');
  // Flatten goals across active plans so the card shows a single list
  // (most kids have one active plan; if they have more, we don't make
  // them dig into each one).
  const goals = activePlans.flatMap(p => p.goals.map(g => ({ plan: p, goal: g })));

  // Live drill cache for resolveGoalVideo(). Mirrors the pattern in
  // PlayerDevelopment.tsx — one unconstrained read of the `drills`
  // collection filtered client-side by the set of teamIds represented
  // in this player's active plans. Non-fatal on failure: resolver
  // just falls back to the goal's snapshot streamUid.
  //
  // The teamId set is memoized as a JOIN key so the effect only re-
  // fires when the underlying teams actually change (not on every
  // localPlans reference swap after a "did it" tap).
  const [drillsById, setDrillsById] = useState<Record<string, Drill>>({});
  const teamIdsKey = useMemo(() => {
    const ids = Array.from(new Set(activePlans.map(p => p.teamId).filter(Boolean)));
    ids.sort();
    return ids.join(',');
  }, [activePlans]);
  useEffect(() => {
    if (!teamIdsKey) return;
    const teamIds = teamIdsKey.split(',').filter(Boolean);
    if (teamIds.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        // Prefer the narrowest possible read: a single `in` query for
        // up to 10 teamIds (Firestore's `in` cap). Falls back to the
        // unconstrained fetch used by PlayerDevelopment if there are
        // more teams than that (a kid on 10+ teams is not a real case
        // but the fallback keeps behavior correct if it ever appears).
        const raw = teamIds.length <= 10
          ? await getDocuments('drills', [where('teamId', 'in', teamIds)])
          : await getDocuments('drills', []);
        if (cancelled) return;
        const map: Record<string, Drill> = {};
        for (const d of (raw as any[])) {
          if (d.isActive === false) continue;
          if (!teamIds.includes(d.teamId)) continue;
          map[d.id] = d as Drill;
        }
        setDrillsById(map);
      } catch {
        /* non-fatal — goals fall back to their snapshot streamUid */
      }
    })();
    return () => { cancelled = true; };
  }, [teamIdsKey, getDocuments]);

  // Streak chip. The cached currentStreakDays on the player doc is
  // the SOURCE OF TRUTH — the worker (via /dev-plans/log-tap +
  // players/{id}/dev_checkins) keeps it fresh across active AND
  // archived plans. Plan-shape math here only sees active plans, so
  // a kid with 30 days on retired plan A + a new plan B would render
  // as day 1 if we trusted plan math. Prefer the cached value; only
  // fall back to plan math if the cache is missing.
  //
  // Self-heal effect: if the plan-shape math and cache disagree,
  // trigger a recompute (source-of-truth read) and mirror its return
  // into local state — do NOT display the plan-derived value.
  const [displayStreak, setDisplayStreak] = useState<number>(currentStreakDays || 0);
  useEffect(() => { setDisplayStreak(currentStreakDays || 0); }, [currentStreakDays]);
  useEffect(() => {
    if (activePlans.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const { computeStreakDays, recomputeAndPersistPlayerStreak } = await import('../../utils/devPlanActions');
        const planShapeStreak = computeStreakDays(activePlans);
        if (planShapeStreak !== (currentStreakDays || 0)) {
          // Silent fix — no actor → no milestone wall post.
          const persisted = await recomputeAndPersistPlayerStreak(playerId, activePlans);
          if (!cancelled) setDisplayStreak(persisted);
        }
      } catch (err) {
        console.warn('InlineDevPlanCard streak self-heal skipped', err);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localPlans, currentStreakDays, playerId]);

  const streak = displayStreak;

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
      await recomputeAndPersistPlayerStreak(playerId, optimisticActive, actor, isKidActor);
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
          No active plan yet, coach can build one from <button onClick={() => navigate('/development')} className="text-brand-primary-soft underline">Development</button>.
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
          // "Show me how" availability: any of Stream demo video
          // (live-resolved from the source drill), coach-attached
          // YouTube links, or a written description qualifies.
          const { streamUid, streamReady } = resolveGoalVideo(goal, drillsById);
          const youTubeLinks = (goal.videoLinks || []).filter(l => Boolean(l.youtubeId));
          const otherLinks = (goal.videoLinks || []).filter(l => !l.youtubeId);
          const description = (goal.description || '').trim();
          const hasHelp = Boolean(streamUid) || youTubeLinks.length > 0 || otherLinks.length > 0 || description.length > 0;
          const isOpen = openGoalId === goal.id;
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
                  {hasHelp && (
                    <button
                      type="button"
                      onClick={() => setOpenGoalId(prev => (prev === goal.id ? null : goal.id))}
                      aria-expanded={isOpen}
                      aria-controls={`goal-help-${goal.id}`}
                      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-brand-primary/15 hover:bg-brand-primary/20 ring-1 ring-brand-primary/25 text-brand-primary text-[12px] font-semibold transition"
                    >
                      {Boolean(streamUid) || youTubeLinks.length > 0 || otherLinks.length > 0 ? (
                        <svg
                          className="w-3.5 h-3.5"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          aria-hidden
                        >
                          <polygon points="6 4 20 12 6 20 6 4" />
                        </svg>
                      ) : (
                        <svg
                          className="w-3.5 h-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden
                        >
                          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                        </svg>
                      )}
                      <span>{isOpen ? 'Hide' : 'Show me how'}</span>
                    </button>
                  )}
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
                      ? 'bg-emerald-500/25 text-emerald-800 dark:text-emerald-100 ring-1 ring-emerald-500/50 cursor-default'
                      : 'bg-brand-primary text-white hover:bg-brand-primary disabled:opacity-50'
                  }`}
                  title={doneToday ? 'Already logged today, keep the streak alive tomorrow.' : 'Tap to log a practice for today'}
                >
                  {busy === goal.id ? '…' : doneToday ? 'Done today' : 'I did it!'}
                </button>
              </div>

              {/* Inline "Show me how" accordion body. Lives INSIDE
                  the same <li> so the kid's scroll position stays
                  put — no modal, no full-screen sheet. Rounded,
                  soft, warm, matches PhotoTape / KidHeroCard vibe.
                  Rendered only when open to keep the Cloudflare
                  iframe out of the DOM for closed goals (avoids
                  autoloading N videos on a plan with many goals). */}
              {hasHelp && isOpen && (
                <div
                  id={`goal-help-${goal.id}`}
                  className="mt-3 rounded-xl bg-surface-input ring-1 ring-line-default/20 p-3 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200"
                >
                  {streamUid && (
                    <div>
                      <p className="text-[12px] font-semibold text-ink-primary/70 mb-1.5">
                        Coach demo
                      </p>
                      <div className="aspect-video w-full max-h-[220px] rounded-lg overflow-hidden bg-black ring-1 ring-line-default/10">
                        <CloudflareStreamIframe
                          uid={streamUid}
                          streamReady={streamReady === true}
                          title={`${goal.title}, coach demo`}
                          allow="accelerometer; gyroscope; encrypted-media; picture-in-picture; fullscreen"
                          iframeClassName="w-full h-full block border-0"
                        />
                      </div>
                    </div>
                  )}

                  {youTubeLinks.length > 0 && (
                    <div>
                      <p className="text-[12px] font-semibold text-ink-primary/70 mb-1.5">
                        Watch and learn
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {youTubeLinks.map(link => (
                          <a
                            key={link.id}
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group block w-36 rounded-lg overflow-hidden ring-1 ring-line-default/15 bg-black hover:ring-2 hover:ring-brand-primary transition"
                          >
                            <div className="relative aspect-video bg-black">
                              <img
                                src={`https://i.ytimg.com/vi/${link.youtubeId}/mqdefault.jpg`}
                                alt={link.title || 'Tutorial'}
                                className="w-full h-full object-cover"
                                loading="lazy"
                              />
                              <div className="absolute inset-0 flex items-center justify-center bg-black/25 group-hover:bg-black/15 transition-colors">
                                <div className="w-9 h-9 rounded-full bg-red-600 flex items-center justify-center shadow-md">
                                  <svg className="w-3.5 h-3.5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                                    <path d="M8 5v14l11-7z" />
                                  </svg>
                                </div>
                              </div>
                            </div>
                            <div className="px-2 py-1.5 bg-surface-elevated">
                              <p className="text-[11px] font-semibold text-ink-primary/85 line-clamp-2 leading-snug">
                                {link.title || 'YouTube tutorial'}
                              </p>
                            </div>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {otherLinks.length > 0 && (
                    <div>
                      <p className="text-[12px] font-semibold text-ink-primary/70 mb-1.5">
                        More to check out
                      </p>
                      <ul className="space-y-1">
                        {otherLinks.map(link => (
                          <li key={link.id}>
                            <a
                              href={link.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[13px] font-semibold text-brand-primary hover:underline break-all"
                            >
                              {link.title || link.url}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {description && (
                    <div>
                      <p className="text-[12px] font-semibold text-ink-primary/70 mb-1.5">
                        What to do
                      </p>
                      <p className="text-[14px] text-ink-primary/90 whitespace-pre-wrap leading-relaxed">
                        {description}
                      </p>
                    </div>
                  )}
                </div>
              )}
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
