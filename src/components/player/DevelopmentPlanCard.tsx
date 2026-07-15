import React from 'react';
import { Link } from 'react-router-dom';
import type { DevelopmentPlan, Season, Player } from '../../types';
import ProfileCard from './ProfileCard';
import InlineDevPlanCard from './InlineDevPlanCard';

// DevelopmentPlanCard — the Story-slot home for a player's active
// development plan(s). Promoted out of the Stats tab in the 2026-07-15
// refactor because a plan-in-motion is a narrative moment, not a
// number, and parents were missing it buried three cards deep on
// Stats. Youth-only render is gated by the parent (isAdultTeam), same
// as the section it replaced.
//
// Layout:
//   1. Primary active plan → InlineDevPlanCard (streak chip + I-did-it
//      buttons per goal, unchanged from Stats behavior)
//   2. Additional active plans → a compact list of titles + streak
//      that link into /development (kept simple to keep the story
//      tab scannable)
//   3. Earlier plans this season → collapsed <details> summary. Legacy
//      plans with no seasonId are surfaced here via the grace clause
//      so nothing gets silently dropped.

interface Props {
  activePlans: DevelopmentPlan[];
  completedPlans: DevelopmentPlan[];
  activeSeason: Season | null;
  playerId: string;
  teamId: string;
  player: Player;
  isCoach: boolean;
  actor: { uid: string; name: string } | null;
  onUpdated: () => void;
}

const DevelopmentPlanCard: React.FC<Props> = ({
  activePlans,
  completedPlans,
  activeSeason,
  playerId,
  player,
  actor,
  onUpdated,
}) => {
  // Filter completed plans to this season. Grace clause: plans with
  // NO seasonId (legacy, pre-field) still surface in the Earlier
  // section so nothing silently drops. When there's no active season
  // (rare, e.g. between-season gap), fall back to showing all.
  const earlierPlans = completedPlans.filter(p => {
    const pid = (p as any).seasonId;
    if (!activeSeason?.id) return true;
    return !pid || pid === activeSeason.id;
  });

  const first = player.name?.split(' ')[0] || 'this player';

  if (activePlans.length === 0 && earlierPlans.length === 0) {
    return (
      <ProfileCard eyebrow="Development" title="Plan" centered>
        <p className="text-sm text-ink-primary/70 leading-snug">
          No plan in motion. Coach can start one and we&rsquo;ll track the reps here.
        </p>
        <Link
          to="/development"
          className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-brand-primary/10 ring-1 ring-brand-primary/30 text-brand-primary-soft text-xs font-bold hover:bg-brand-primary/15 transition"
        >
          Open Development
        </Link>
      </ProfileCard>
    );
  }

  return (
    <ProfileCard eyebrow="Development" title="Plan">
      {activePlans.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-[11px] font-black uppercase tracking-widest text-ink-primary/55">
            In motion
          </p>
          <InlineDevPlanCard
            plans={activePlans}
            playerId={playerId}
            actor={actor}
            currentStreakDays={(player as any).currentStreakDays || 0}
            onUpdated={onUpdated}
          />
          {activePlans.length > 1 && (
            <p className="text-[11px] text-ink-primary/50">
              {first} has {activePlans.length} active plans. Tap Open plan above to see them all.
            </p>
          )}
        </div>
      )}

      {earlierPlans.length > 0 && (
        <details className="rounded-xl bg-surface-input/40 ring-1 ring-line-default/10">
          <summary className="cursor-pointer list-none p-3 flex items-center justify-between gap-3">
            <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">
              Earlier plans this season ({earlierPlans.length})
            </span>
            <svg className="w-4 h-4 text-ink-primary/40" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </summary>
          <ul className="border-t border-line-default/10 p-2 flex flex-col gap-1.5">
            {earlierPlans.map(p => (
              <li key={p.id} className="rounded-lg px-3 py-2 bg-surface-elevated ring-1 ring-line-default/10">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink-primary truncate">{p.title}</p>
                    {p.completedAt && (
                      <p className="text-[11px] text-ink-primary/50 mt-0.5">
                        Wrapped {new Date(p.completedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </p>
                    )}
                  </div>
                  <span className="text-[10px] font-black uppercase tracking-widest text-emerald-500">Done</span>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </ProfileCard>
  );
};

export default DevelopmentPlanCard;
