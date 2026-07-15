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
// Shell model — InlineDevPlanCard carries its own Card Contract
// shell + "Development Plan" header, so this component does NOT
// double-wrap it in a ProfileCard when there are active plans (that
// used to render a doubled ring + doubled title, a "card on a card"
// look flagged in code review 2026-07-15). Instead:
//   - Active plans → render InlineDevPlanCard directly (self-shelled).
//     A follow-up ProfileCard hosts the Earlier drawer if any.
//   - No active plans (only history OR fully empty) → single
//     ProfileCard hosts either the empty CTA or the Earlier drawer.

interface Props {
  activePlans: DevelopmentPlan[];
  completedPlans: DevelopmentPlan[];
  activeSeason: Season | null;
  playerId: string;
  player: Player;
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
  // Split completed plans into two buckets so the drawer label is
  // honest. Legacy plans (no seasonId stamped at write time) can't be
  // truthfully bucketed as "this season" alongside a real Spring 2026
  // completion, so they get their own "Older plans" bucket.
  // Grace clause: without an active season we lump everything into
  // Older so nothing silently drops.
  const earlierThisSeason = activeSeason?.id
    ? completedPlans.filter(p => (p as any).seasonId === activeSeason.id)
    : [];
  const olderPlans = activeSeason?.id
    ? completedPlans.filter(p => !(p as any).seasonId)
    : completedPlans;

  const first = player.name?.split(' ')[0] || 'this player';

  const hasAnyEarlier = earlierThisSeason.length > 0 || olderPlans.length > 0;

  if (activePlans.length === 0 && !hasAnyEarlier) {
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

  const renderDrawer = (label: string, plans: DevelopmentPlan[], keyPrefix: string) => (
    <details key={keyPrefix} className="rounded-xl bg-surface-input/40 ring-1 ring-line-default/10">
      <summary className="group cursor-pointer list-none p-3 flex items-center justify-between gap-3">
        <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">
          {label} ({plans.length})
        </span>
        <svg className="w-4 h-4 text-ink-primary/40 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </summary>
      <ul className="border-t border-line-default/10 p-2 flex flex-col gap-1.5">
        {plans.map(p => (
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
  );

  return (
    <>
      {activePlans.length > 0 && (
        <InlineDevPlanCard
          plans={activePlans}
          playerId={playerId}
          actor={actor}
          currentStreakDays={(player as any).currentStreakDays || 0}
          onUpdated={onUpdated}
        />
      )}
      {activePlans.length > 1 && (
        <p className="text-[11px] text-ink-primary/50 -mt-2">
          {first} has {activePlans.length} active plans. Tap Open plan above to see them all.
        </p>
      )}

      {hasAnyEarlier && (
        <ProfileCard eyebrow="Development" title={activePlans.length === 0 ? 'Plan history' : 'Also from this player'}>
          <div className="flex flex-col gap-2">
            {earlierThisSeason.length > 0 && renderDrawer('Earlier this season', earlierThisSeason, 'earlier-this-season')}
            {olderPlans.length > 0 && renderDrawer('Older plans', olderPlans, 'older-plans')}
          </div>
        </ProfileCard>
      )}
    </>
  );
};

export default DevelopmentPlanCard;
