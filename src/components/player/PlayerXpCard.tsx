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
import { computeXpLevel } from '../../utils/xpLevel';
import BadgeIcon from './BadgeIcon';

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
  const level = computeXpLevel(xp);
  const badges: Record<string, any> = ((player as any).badges && typeof (player as any).badges === 'object')
    ? (player as any).badges
    : {};
  const badgeEntries = Object.entries(badges);
  const badgeCount = badgeEntries.length;
  const coachPickCount = typeof badges?.coach_pick?.count === 'number' ? badges.coach_pick.count : 0;

  return (
    <section className="px-4 sm:px-6 pt-2">
      <div className="max-w-6xl mx-auto rounded-2xl bg-gradient-to-br from-brand-primary/20 via-brand-primary/8 to-transparent ring-1 ring-brand-primary/25 shadow-lg overflow-hidden">
        {/* Header: level (big) + XP + Recognize action. Kicker sits
            above the level number so it reads "YOUR SEASON · Level 8"
            in the parent's scan path. */}
        <div className="px-4 sm:px-5 pt-3 pb-3 flex items-start justify-between gap-3 border-b border-brand-primary/10">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-extrabold uppercase tracking-[0.22em] text-brand-primary-soft">Your season</p>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl sm:text-3xl font-black text-ink-primary leading-none tabular-nums">
                Lv {level.level}
              </span>
              <span className="text-[11px] font-bold text-ink-primary/55 leading-none tabular-nums">
                {xp.toLocaleString()} XP
              </span>
            </div>
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

        {/* Progress bar row: fill + label below. Progress renders even
            at 0% so the shape is stable when a kid first joins. */}
        <div className="px-4 sm:px-5 pt-3 pb-1">
          <div className="relative h-2 w-full rounded-full bg-line-default/[0.12] ring-1 ring-line-default/10 overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-brand-primary via-brand-primary-soft to-brand-primary transition-all duration-700 ease-out"
              style={{ width: `${level.progressPercent}%` }}
              aria-hidden
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-primary/55 font-semibold tabular-nums">
            <span>{level.xpIntoLevel} / {level.nextLevelThreshold - level.currentLevelThreshold} into Lv {level.level}</span>
            <span>{level.xpToNextLevel} to Lv {level.level + 1}</span>
          </div>
        </div>

        <div className="px-4 sm:px-5 pt-2 pb-3">
          {badgeCount === 0 ? (
            <p className="text-[12px] text-ink-primary/60 leading-snug">
              {isCoach
                ? 'No badges yet. Recognize a moment worth remembering — the first one lands the "Coach\'s Pick" badge.'
                : 'Badges appear here as they\'re earned. Coach recognitions, POTM, streaks, and season milestones all count.'}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {badgeEntries.map(([slug, meta]) => (
                <BadgeIcon
                  key={slug}
                  slug={slug}
                  size={28}
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

export default PlayerXpCard;
