// PlayerXpCard — the "career, not a leaderboard" surface on
// PlayerProfile. Shows the kid's current-season XP + badges as a
// personal journey card. Renders NOTHING when team.xpConfig.enabled
// !== true, so coaches who haven't opted in never see it.
//
// Coach-facing: adds a "Recognize" pill that opens the recognition
// modal. Parent-facing: read-only celebration card. No cross-kid
// numbers, no ranks. See goalkickr-xp memo (Phase 1).

import React from 'react';
import { Player, Team } from '../../types';

interface Props {
  player: Player;
  team: Team | null | undefined;
  isCoach: boolean;
  onRecognize: () => void;
}

const PlayerXpCard: React.FC<Props> = ({ player, team, isCoach, onRecognize }) => {
  const xpConfig = (team as any)?.xpConfig;
  if (!team || xpConfig?.enabled !== true) return null;

  const xp = typeof (player as any).xp === 'number' ? (player as any).xp : 0;
  const badges: Record<string, any> = ((player as any).badges && typeof (player as any).badges === 'object')
    ? (player as any).badges
    : {};
  const badgeEntries = Object.entries(badges);
  const badgeCount = badgeEntries.length;

  // Coach-pick surfaces its running count as a small chip since it's
  // the only repeat-earnable badge in Phase 1. Everything else is a
  // one-shot with earnedAt.
  const coachPickCount = typeof badges?.coach_pick?.count === 'number' ? badges.coach_pick.count : 0;

  return (
    <section className="px-4 sm:px-6 pt-2">
      <div className="max-w-6xl mx-auto rounded-2xl bg-gradient-to-br from-brand-primary/20 via-brand-primary/8 to-transparent ring-1 ring-brand-primary/25 shadow-lg overflow-hidden">
        <div className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3 border-b border-brand-primary/10">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-extrabold uppercase tracking-[0.22em] text-brand-primary-soft">Your season</p>
            <p className="mt-0.5 text-sm font-bold text-ink-primary leading-tight">
              <span className="tabular-nums">{xp.toLocaleString()}</span>{' '}
              <span className="text-ink-primary/55 font-medium">XP earned</span>
            </p>
          </div>
          {isCoach && (
            <button
              type="button"
              onClick={onRecognize}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-full bg-brand-primary text-white text-[11px] font-black uppercase tracking-wider ring-1 ring-brand-primary/60 shadow-md hover:brightness-110 active:scale-[0.98] transition"
              aria-label={`Recognize ${player.name}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" />
              </svg>
              Recognize
            </button>
          )}
        </div>

        <div className="px-4 sm:px-5 py-3">
          {badgeCount === 0 ? (
            <p className="text-[12px] text-ink-primary/60 leading-snug">
              {isCoach
                ? 'No badges yet. Recognize a moment worth remembering — the first one lands the "Coach\'s Pick" badge.'
                : 'Badges appear here as they\'re earned. Coach recognitions, POTM, streaks, and season milestones all count.'}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {badgeEntries.map(([slug, meta]) => (
                <BadgeChip
                  key={slug}
                  slug={slug}
                  count={typeof meta?.count === 'number' ? meta.count : undefined}
                  context={meta?.context}
                />
              ))}
              {coachPickCount >= 5 && (
                <span className="text-[10px] font-bold text-ink-primary/45 uppercase tracking-wider">
                  {coachPickCount} coach recognitions
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

const BADGE_META: Record<string, { label: string; tone: string }> = {
  coach_pick: { label: "Coach's Pick", tone: 'text-amber-300 bg-amber-500/15 ring-amber-400/30' },
  first_goal: { label: 'First Goal',   tone: 'text-emerald-300 bg-emerald-500/15 ring-emerald-400/30' },
  first_potm: { label: 'First POTM',   tone: 'text-amber-300 bg-amber-500/15 ring-amber-400/30' },
  first_assist: { label: 'First Assist', tone: 'text-brand-primary-soft bg-brand-primary/15 ring-brand-primary/30' },
  perfect_attendance: { label: 'Perfect Attendance', tone: 'text-sky-300 bg-sky-500/15 ring-sky-400/30' },
  streak_10: { label: '10-Day Streak', tone: 'text-violet-300 bg-violet-500/15 ring-violet-400/30' },
};

const BadgeChip: React.FC<{ slug: string; count?: number; context?: string }> = ({ slug, count, context }) => {
  const meta = BADGE_META[slug] || { label: slug.replace(/_/g, ' '), tone: 'text-ink-primary/70 bg-line-default/[0.08] ring-line-default/15' };
  const label = count && count > 1 ? `${meta.label} × ${count}` : meta.label;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full ring-1 px-2.5 py-1 text-[11px] font-black tracking-wide ${meta.tone}`}
      title={context || ''}
    >
      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
        <path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" />
      </svg>
      {label}
    </span>
  );
};

export default PlayerXpCard;
