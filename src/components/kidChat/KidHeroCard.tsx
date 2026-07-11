// KidHeroCard — the kid's identity hero on KidDashboard. Dedicated
// component, NOT a variant of the Squad tile.
//
// Design won a 3-way bake-off (portrait-hero vs achievement-hud vs
// FIFA-card). The portrait layout keeps the kid's photo as the
// anchor so the streak bubble can't dominate the face again (Patrick
// audit 2026-07-11), and the momentum row + locker preview replace
// the last-season stats grid (goals/assists/saves/games) which read
// as demotivating when nobody was logging them.
//
// Grafts:
//  - B's explicit "Lv N -> Lv N+1" progress rail (only when xpConfig
//    is enabled) between momentum row and next-up callout.
//  - C's closest-reachable-milestone picker for the next-up callout
//    (streak-band vs XP nearness, whichever is closer).

import React from 'react';
import type { Player, Team } from '../../types';
import { computeXpLevel } from '../../utils/xpLevel';
import { computeDobAge } from '../../utils/dobDate';
import { badgeImageSrc, badgeSrcSet, badgeLabel } from '../../utils/badgeMeta';

// Same slot order as PlayerXpCard so "6 of 11" stays consistent
// across surfaces. If either list changes, update both.
const BADGE_SLOTS = [
  'first_goal',
  'first_assist',
  'first_save',
  'first_clean_sheet',
  'first_potm',
  'perfect_attendance',
  'streak_5',
  'streak_10',
  'streak_25',
  'streak_50',
  'coach_pick',
] as const;

const STREAK_MILESTONES = [5, 10, 25, 50] as const;

interface KidHeroCardProps {
  player: Player;
  team: Team | null | undefined;
}

const FlameIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path fillRule="evenodd" d="M12.963 2.286a.75.75 0 00-1.071-.136 9.742 9.742 0 00-3.539 6.176 7.547 7.547 0 01-1.705-1.715.75.75 0 00-1.152-.082A9 9 0 1015.68 4.534a7.46 7.46 0 01-2.717-2.248zM15.75 14.25a3.75 3.75 0 11-7.313-1.172c.628.465 1.35.81 2.133 1a5.99 5.99 0 011.925-3.545 3.75 3.75 0 013.255 3.717z" clipRule="evenodd" />
  </svg>
);

const TrendIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <polyline points="4 17 10 11 14 15 20 7" />
    <polyline points="14 7 20 7 20 13" />
  </svg>
);

const StarIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M12 2l2.9 6.9L22 10l-5.5 4.8L18 22l-6-3.5L6 22l1.5-7.2L2 10l7.1-1.1L12 2z" />
  </svg>
);

const LockIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <rect x="4" y="10" width="16" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>
);

const ShieldIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" />
  </svg>
);

const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? '?';
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

// Pick the single most motivating "next up" line. XP wins when it's
// close (within 100 XP) because a level-up in one session feels
// earned; otherwise the nearest streak-badge threshold wins over a
// generic day+1 nudge because reaching a named milestone is more
// aspirational than an incremental tick.
function pickNextUp(
  streak: number,
  xpEnabled: boolean,
  xpToNext: number | null,
  levelNext: number | null,
): { text: string; icon: 'flame' | 'trend' } {
  // Near-XP wins: within a session of leveling up.
  if (xpEnabled && xpToNext != null && levelNext != null && xpToNext > 0 && xpToNext <= 100) {
    return { text: `${xpToNext} XP to Level ${levelNext}`, icon: 'trend' };
  }
  // Nearest streak badge milestone if it's within a reasonable
  // window from the current streak.
  if (streak > 0) {
    const nextMilestone = STREAK_MILESTONES.find(m => m > streak);
    if (nextMilestone && nextMilestone - streak <= 7) {
      const remaining = nextMilestone - streak;
      return {
        text: remaining === 1
          ? `1 day to the ${nextMilestone}-day streak badge`
          : `${remaining} days to the ${nextMilestone}-day streak badge`,
        icon: 'flame',
      };
    }
    return { text: `Log today to hit day ${streak + 1}`, icon: 'flame' };
  }
  // XP fallback when streak is zero and we're XP-enabled.
  if (xpEnabled && xpToNext != null && levelNext != null && xpToNext > 0) {
    return { text: `${xpToNext} XP to Level ${levelNext}`, icon: 'trend' };
  }
  return { text: 'Log a practice today to start a streak', icon: 'flame' };
}

const KidHeroCard: React.FC<KidHeroCardProps> = ({ player, team }) => {
  const streak = Math.max(0, Number((player as any).currentStreakDays ?? 0) | 0);
  const isPotm = Boolean((player as any).isCurrentPotm);
  const xp = Math.max(0, Number((player as any).xp ?? 0) | 0);
  const badges = ((player as any).badges ?? {}) as Record<string, unknown>;
  const xpEnabled = Boolean((team as any)?.xpConfig?.enabled);

  const age = player.dateOfBirth ? computeDobAge(player.dateOfBirth as any) : null;
  const level = xpEnabled ? computeXpLevel(xp) : null;
  const badgeCount = BADGE_SLOTS.reduce((acc, slot) => acc + (badges[slot] ? 1 : 0), 0);
  const totalBadgeSlots = BADGE_SLOTS.length;
  const initials = getInitials(player.name);
  const positionLabel = player.position ? player.position.toUpperCase() : 'PLAYER';

  const nextUp = pickNextUp(
    streak,
    xpEnabled,
    level?.xpToNextLevel ?? null,
    level ? level.level + 1 : null,
  );
  const NextUpIcon = nextUp.icon === 'trend' ? TrendIcon : FlameIcon;

  return (
    <div className="rounded-2xl overflow-hidden bg-surface-elevated ring-1 ring-line-default shadow-sm">
      {/* Header strip: position pill + age + jersey */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-surface-base border-b border-line-default">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-brand-primary/10 text-brand-primary">
            <ShieldIcon className="w-3 h-3" />
            {positionLabel}
          </span>
          {age != null && (
            <span className="text-[11px] font-semibold text-ink-secondary">Age {age}</span>
          )}
        </div>
        {player.jerseyNumber != null && (
          <div className="flex items-baseline gap-1 shrink-0">
            <span className="text-[10px] uppercase tracking-wider font-bold text-ink-secondary">No.</span>
            <span className="text-base font-black tabular-nums text-ink-primary leading-none">
              {player.jerseyNumber}
            </span>
          </div>
        )}
      </div>

      {/* Photo hero — full-bleed portrait; kid's face is the anchor. */}
      <div className={'relative w-full h-56 bg-surface-input overflow-hidden' + (isPotm ? ' ring-2 ring-inset ring-amber-400' : '')}>
        {player.profilePhotoUrl ? (
          <img
            src={player.profilePhotoUrl}
            alt={player.name}
            className="absolute inset-0 w-full h-full object-cover"
            draggable={false}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-28 h-28 rounded-full flex items-center justify-center bg-brand-primary/15 text-brand-primary text-4xl font-black tracking-tight">
              {initials}
            </div>
          </div>
        )}

        {/* Bottom scrim so the name reads on any photo. Black rgba
            is a scrim on a photo, not a theme color, so it's OK to
            hardcode here. */}
        <div
          className="absolute inset-x-0 bottom-0 h-36 pointer-events-none"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.45) 45%, rgba(0,0,0,0) 100%)' }}
        />

        {isPotm && (
          <div className="absolute top-3 right-3 inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-400 text-amber-950 text-[10px] font-black uppercase tracking-wider shadow-sm">
            <StarIcon className="w-3 h-3" />
            POTM
          </div>
        )}

        <div className="absolute inset-x-0 bottom-0 p-4 flex items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-white/80">My card</div>
            <h2 className="text-2xl font-black text-white leading-tight truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">
              {player.name}
            </h2>
          </div>
          {streak > 0 && (
            <div className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-orange-500 text-white text-xs font-black shadow-sm">
              <FlameIcon className="w-3.5 h-3.5" />
              <span className="tabular-nums">{streak}</span>
            </div>
          )}
        </div>
      </div>

      {/* Momentum row — forward-looking numbers only. When XP is
          disabled the row collapses to 2 tiles instead of leaving a
          gap. */}
      <div className={'grid gap-px bg-line-default ' + (xpEnabled ? 'grid-cols-3' : 'grid-cols-2')}>
        <MomentumTile label="Streak" value={streak} hint={streak === 1 ? 'day' : 'days'} accentClass="text-orange-500" />
        {xpEnabled && level && (
          <MomentumTile label="Level" value={level.level} hint={`${level.progressPercent}%`} accentClass="text-brand-primary" />
        )}
        <MomentumTile label="Badges" value={badgeCount} hint={`of ${totalBadgeSlots}`} accentClass="text-amber-500" />
      </div>

      {/* XP progress rail — explicit Lv N -> Lv N+1 endpoints so the
          ladder metaphor reads at a glance. Only renders when XP is
          enabled; skipped otherwise so the card doesn't show a
          stub. */}
      {xpEnabled && level && (
        <div className="px-4 py-3 border-t border-line-default bg-surface-elevated">
          <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-wider text-ink-secondary mb-1.5 tabular-nums">
            <span>Lv {level.level}</span>
            <span className="text-brand-primary">{level.xpIntoLevel} / {level.nextLevelThreshold - level.currentLevelThreshold} XP</span>
            <span>Lv {level.level + 1}</span>
          </div>
          <div className="relative h-2 w-full rounded-full bg-surface-input overflow-hidden ring-1 ring-line-default/50">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-brand-primary transition-[width] duration-700 ease-out"
              style={{ width: `${Math.max(0, Math.min(100, level.progressPercent))}%` }}
              aria-hidden
            />
          </div>
        </div>
      )}

      {/* Next up callout — one motivational line, chosen by
          pickNextUp above. */}
      <div className="flex items-center gap-3 px-4 py-3 bg-brand-primary text-white">
        <div className="shrink-0 w-9 h-9 rounded-full bg-white/15 flex items-center justify-center">
          <NextUpIcon className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-black uppercase tracking-wider opacity-80">Next up</div>
          <div className="text-sm font-bold leading-snug truncate">{nextUp.text}</div>
        </div>
      </div>

      {/* Locker preview — first 8 badge slots, with monoline locks
          for the not-yet-earned ones. Kid sees the empty slots
          waiting to be filled instead of a static empty state. */}
      <div className="px-4 py-3 border-t border-line-default bg-surface-base">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] font-black uppercase tracking-wider text-ink-secondary">Locker</div>
          <div className="text-[11px] font-semibold text-ink-secondary tabular-nums">
            {badgeCount} of {totalBadgeSlots}
          </div>
        </div>
        <div className="flex gap-1.5">
          {BADGE_SLOTS.slice(0, 8).map((slot) => {
            const owned = Boolean(badges[slot]);
            return (
              <div
                key={slot}
                className={
                  'shrink-0 flex-1 aspect-square rounded-lg flex items-center justify-center ' +
                  (owned
                    ? 'bg-surface-elevated ring-1 ring-line-default'
                    : 'bg-surface-input')
                }
                title={badgeLabel(slot)}
                aria-label={owned ? badgeLabel(slot) : `${badgeLabel(slot)} locked`}
              >
                {owned ? (
                  <img
                    src={badgeImageSrc(slot, 40)}
                    srcSet={badgeSrcSet(slot, 40)}
                    alt=""
                    className="w-9 h-9 object-contain"
                    draggable={false}
                  />
                ) : (
                  <LockIcon className="w-4 h-4 text-ink-secondary opacity-40" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

interface MomentumTileProps {
  label: string;
  value: number;
  hint: string;
  accentClass: string;
}

const MomentumTile: React.FC<MomentumTileProps> = ({ label, value, hint, accentClass }) => (
  <div className="bg-surface-elevated px-3 py-4 flex flex-col items-center justify-center">
    <div className="text-[10px] font-black uppercase tracking-wider text-ink-secondary mb-1">{label}</div>
    <div className={`text-3xl font-black tabular-nums leading-none ${accentClass}`}>{value}</div>
    <div className="text-[10px] font-semibold text-ink-secondary opacity-70 mt-1 tabular-nums">{hint}</div>
  </div>
);

export default KidHeroCard;
