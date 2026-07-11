// KidHeroCard — the kid's identity hero on KidDashboard. A single
// consolidated card that owns EVERYTHING identity: photo, name, rarity
// tier, streak, badges, level, XP progress, locker. Redesigned
// 2026-07-11 to eliminate the redundancy the previous version had with
// PlayerXpCard (streak-chip AND streak-tile, level-tile AND xp-rail,
// badges-tile AND locker). One hero card, one source of truth per
// number.
//
// Layout is a three-column top row (avatar | identity + metric tiles |
// theme button + big level numeral), a full-width XP progress rail
// below it, and a 9-slot locker under that. Subtle stadium background
// and a crimson ring at the outer edge sell "this is the kid's card"
// without a gradient rainbow.
//
// The "Theme / Skins" button is a monetization placeholder — no click
// handler in v1 by design. Silent tap.

import React from 'react';
import type { Player, Team } from '../../types';
import { computeXpLevel } from '../../utils/xpLevel';
import { computeDobAge } from '../../utils/dobDate';
import { badgeImageSrc, badgeSrcSet, badgeLabel } from '../../utils/badgeMeta';

// Same slot order as PlayerXpCard so "N / 11" stays consistent across
// surfaces. Update both if either list changes.
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
const LOCKER_SLOTS = 9;

interface KidHeroCardProps {
  player: Player;
  team: Team | null | undefined;
}

const FlameIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path fillRule="evenodd" d="M12.963 2.286a.75.75 0 00-1.071-.136 9.742 9.742 0 00-3.539 6.176 7.547 7.547 0 01-1.705-1.715.75.75 0 00-1.152-.082A9 9 0 1015.68 4.534a7.46 7.46 0 01-2.717-2.248zM15.75 14.25a3.75 3.75 0 11-7.313-1.172c.628.465 1.35.81 2.133 1a5.99 5.99 0 011.925-3.545 3.75 3.75 0 013.255 3.717z" clipRule="evenodd" />
  </svg>
);

// Soccer ball icon for the JUGGLES metric tile (personal best). Same
// style family as the other monoline stroked icons.
const BallIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <polygon points="12,8 15.5,10.5 14,14.5 10,14.5 8.5,10.5" />
  </svg>
);

const ShieldIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" />
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

// Hex XP glyph used in the SEASON XP metric tile.
const HexXpIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
    <path d="M12 2l8.66 5v10L12 22 3.34 17V7L12 2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <text x="12" y="15.5" textAnchor="middle" fontSize="7.5" fontWeight="900" fill="currentColor" fontFamily="ui-sans-serif, system-ui, sans-serif">XP</text>
  </svg>
);

// Monoline t-shirt for the "Theme / Skins" placeholder pill.
const ShirtIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M8 3l-5 3 2 4 3-1v12h12V9l3 1 2-4-5-3-3 2h-6L8 3z" />
  </svg>
);

const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? '?';
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

// Progressive rarity tier keyed off level so the chip feels earned as
// the kid climbs. Non-XP teams show ROOKIE forever (which reads as a
// neutral "player" label rather than a demotion).
function rarityFor(level: number | null): string {
  if (level == null) return 'ROOKIE';
  if (level >= 10) return 'LEGEND';
  if (level >= 7) return 'ELITE';
  if (level >= 4) return 'PRO';
  if (level >= 2) return 'RISING';
  return 'ROOKIE';
}

// Warm-orange tone scale for the streak flame pill. Matches Dashboard
// MyPlayerCard + Squad PlayerCard heroLayout so the streak reads the
// same everywhere. Blazing gradient at 25+, gradient at 10+, solid
// orange at 5+, soft at 1-4.
function streakBadgeTone(streak: number): string {
  if (streak >= 25) return 'bg-gradient-to-br from-amber-300 to-orange-600 ring-amber-200/60';
  if (streak >= 10) return 'bg-gradient-to-br from-orange-400 to-orange-600 ring-orange-200/50';
  if (streak >= 5) return 'bg-orange-500 ring-orange-300/50';
  return 'bg-orange-500/85 ring-orange-300/40';
}

const KidHeroCard: React.FC<KidHeroCardProps> = ({ player, team }) => {
  const streak = Math.max(0, Number((player as any).currentStreakDays ?? 0) | 0);
  const xp = Math.max(0, Number((player as any).xp ?? 0) | 0);
  const badges = ((player as any).badges ?? {}) as Record<string, unknown>;
  const xpEnabled = Boolean((team as any)?.xpConfig?.enabled);
  const isPotm = Boolean((player as any).isCurrentPotm);
  const jugglesBest = Math.max(0, Number((player as any).juggles?.best ?? 0) | 0);

  const age = player.dateOfBirth ? computeDobAge(player.dateOfBirth as any) : null;
  const level = xpEnabled ? computeXpLevel(xp) : null;
  const badgeCount = BADGE_SLOTS.reduce((acc, slot) => acc + (badges[slot] ? 1 : 0), 0);
  const totalBadgeSlots = BADGE_SLOTS.length;
  const initials = getInitials(player.name);
  const rarity = rarityFor(level ? level.level : null);
  const streakTone = streakBadgeTone(streak);

  // Locker: earned badges first, then locks. If the kid has more than
  // 9 badges we still render 9 cells but the last shows a "+N" overflow
  // hint so a full trophy shelf still degrades gracefully.
  const earnedSlots = BADGE_SLOTS.filter((s) => badges[s]);
  const overflow = Math.max(0, earnedSlots.length - LOCKER_SLOTS);
  const lockerCells: Array<{ kind: 'earned'; slug: string } | { kind: 'lock' } | { kind: 'overflow'; count: number }> = [];
  const showEarned = overflow > 0 ? earnedSlots.slice(0, LOCKER_SLOTS - 1) : earnedSlots.slice(0, LOCKER_SLOTS);
  for (const s of showEarned) lockerCells.push({ kind: 'earned', slug: s });
  if (overflow > 0) {
    lockerCells.push({ kind: 'overflow', count: overflow + 1 });
  } else {
    const remaining = LOCKER_SLOTS - lockerCells.length;
    for (let i = 0; i < remaining; i++) lockerCells.push({ kind: 'lock' });
  }

  // Stadium background: layered photo hero (Patrick's kid_card_bg.jpg
  // in public/hero/) with a dark scrim overlay so the pitch reads as
  // texture and the content stays legible. The synthetic light blooms
  // + crimson wash from the previous iteration stay as a fallback if
  // the photo hasn't been dropped in yet.
  const stadiumBg: React.CSSProperties = {
    backgroundImage: [
      'linear-gradient(180deg, rgba(15,15,20,0.72) 0%, rgba(15,15,20,0.55) 45%, rgba(15,15,20,0.82) 100%)',
      'url(/hero/kid_card_bg.jpg)',
      'radial-gradient(ellipse 55% 40% at 18% -5%, rgba(255,255,255,0.09), transparent 60%)',
      'radial-gradient(ellipse 55% 40% at 82% -5%, rgba(255,255,255,0.09), transparent 60%)',
      'radial-gradient(ellipse 80% 45% at 50% 110%, rgba(200,32,44,0.10), transparent 65%)',
    ].join(', '),
    backgroundSize: 'auto, cover, auto, auto, auto',
    backgroundPosition: 'center, center bottom, top left, top right, bottom center',
    backgroundRepeat: 'no-repeat',
  };

  return (
    <div className="relative rounded-3xl overflow-hidden bg-surface-elevated ring-1 ring-brand-primary/25 shadow-[0_18px_50px_-24px_rgba(200,32,44,0.45)]">
      {/* Stadium wash + inner crimson rim. Both are absolute so they
          sit behind content without affecting layout. */}
      <div className="absolute inset-0 pointer-events-none" style={stadiumBg} aria-hidden />
      <div className="absolute inset-0 pointer-events-none rounded-3xl ring-1 ring-inset ring-brand-primary/20" aria-hidden />

      {/* TOP ROW — avatar | identity + tiles | theme + level */}
      <div className="relative grid grid-cols-[auto_1fr_auto] gap-3 sm:gap-4 items-start p-4 sm:p-5">
        {/* LEFT: circular avatar with crimson ring + streak shield */}
        <div className="relative shrink-0">
          <div className={
            'w-20 h-20 sm:w-24 sm:h-24 rounded-full overflow-hidden bg-surface-input flex items-center justify-center ring-2 ' +
            (isPotm ? 'ring-amber-400' : 'ring-brand-primary/60')
          }>
            {player.profilePhotoUrl ? (
              <img
                src={player.profilePhotoUrl}
                alt={player.name}
                className="w-full h-full object-cover"
                draggable={false}
              />
            ) : (
              <span className="text-2xl sm:text-3xl font-black text-brand-primary tracking-tight">
                {initials}
              </span>
            )}
          </div>

          {/* Streak flame pill — shows the CURRENT streak day count
              (not the last milestone), matching the flame+number
              treatment on Dashboard MyPlayerCard + Squad PlayerCard.
              Day 6 shows "6", day 12 shows "12". Warm-orange scale
              intensifies at 5/10/25 thresholds. */}
          {streak > 0 && (
            <span
              className={`absolute -bottom-1 -left-1 z-10 inline-flex items-center gap-0.5 h-8 min-w-8 px-1.5 rounded-full text-[12px] font-black tabular-nums text-white ring-2 ring-offset-2 ring-offset-transparent shadow-[0_2px_6px_rgba(200,32,44,0.35)] ${streakTone}`}
              title={`${streak}-day practice streak`}
              aria-label={`${streak}-day practice streak`}
            >
              <FlameIcon className="w-3.5 h-3.5 shrink-0" />
              {streak}
            </span>
          )}

          {isPotm && (
            <div className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-amber-400 text-amber-950 flex items-center justify-center shadow-sm">
              <StarIcon className="w-3.5 h-3.5" />
            </div>
          )}
        </div>

        {/* CENTER: rarity chip + name + 3 metric tiles. Colors are
            light-on-dark by design because the card carries a photo
            background + dark scrim regardless of theme mode. */}
        <div className="min-w-0">
          <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-brand-primary/25 text-brand-primary-soft text-[10px] font-black uppercase tracking-widest ring-1 ring-brand-primary/40">
            <StarIcon className="w-3 h-3" />
            {rarity}
          </div>
          <h2 className="mt-1 text-xl sm:text-2xl font-black text-white leading-tight truncate drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)]">
            {player.name}
          </h2>
          {(age != null || player.jerseyNumber != null) && (
            <div className="text-[10px] uppercase tracking-widest font-bold text-white/70 mt-0.5 flex items-center gap-2">
              {age != null && <span>Age {age}</span>}
              {player.jerseyNumber != null && (
                <span>
                  <span className="opacity-60">No.</span>{' '}
                  <span className="tabular-nums">{player.jerseyNumber}</span>
                </span>
              )}
            </div>
          )}

        </div>

        {/* RIGHT: Theme/Skins placeholder pill above LEVEL numeral.
            The pill has no onClick in v1 by design — Patrick's
            monetization tease. When XP is off, the LEVEL block is
            hidden and only the pill remains. */}
        <div className="shrink-0 flex flex-col items-end gap-2">
          <button
            type="button"
            aria-label="Theme and skins (coming soon)"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full ring-1 ring-white/40 text-white/90 text-[9px] font-black uppercase tracking-widest bg-black/20 backdrop-blur-sm hover:bg-black/30 transition"
          >
            <ShirtIcon className="w-3 h-3" />
            <span>Theme</span>
          </button>
          {xpEnabled && level && (
            <div className="flex flex-col items-center">
              <div className="text-[10px] font-black uppercase tracking-widest text-white/70">Level</div>
              <div className="text-4xl sm:text-5xl font-black text-brand-primary-soft leading-none tabular-nums drop-shadow-[0_2px_10px_rgba(200,32,44,0.55)]">
                {level.level}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Metric tiles — full-width row so labels like "JUGGLES" and
          "BADGES" have room to render whole instead of truncating
          inside the squeezed identity column. Streak already shows
          on the avatar flame pill, so tiles are Juggles / Badges /
          XP. When XP is off the row collapses to a 2-col grid. */}
      <div className="relative px-4 sm:px-5 pb-2">
        <div className={'grid gap-1.5 sm:gap-2 ' + (xpEnabled ? 'grid-cols-3' : 'grid-cols-2')}>
          <MetricTile
            icon={<BallIcon className="w-3.5 h-3.5 text-emerald-400" />}
            label="Juggles"
            value={String(jugglesBest)}
            hint="best"
          />
          <MetricTile
            icon={<ShieldIcon className="w-3.5 h-3.5 text-amber-500" />}
            label="Badges"
            value={String(badgeCount)}
            hint={`/ ${totalBadgeSlots}`}
          />
          {xpEnabled && level && (
            <MetricTile
              icon={<HexXpIcon className="w-3.5 h-3.5 text-brand-primary" />}
              label="XP"
              value={xp.toLocaleString()}
              hint="season"
            />
          )}
        </div>
      </div>

      {/* XP PROGRESS RAIL — full width, only when XP is enabled. The
          center number matches the bar fill: within-current-level XP,
          not the running season total (which is on the Season XP tile
          above). Prior version showed cumulative xp / next-level
          threshold which contradicted a partial fill at higher levels. */}
      {xpEnabled && level && (
        <div className="relative px-4 sm:px-5 pb-3">
          <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest tabular-nums">
            <span className="text-white/70">Lv {level.level}</span>
            <span className="text-brand-primary-soft">
              {level.xpIntoLevel} / {level.nextLevelThreshold - level.currentLevelThreshold} XP
            </span>
            <span className="text-white/70">Lv {level.level + 1}</span>
          </div>
          <div className="mt-1.5 relative h-1.5 w-full rounded-full bg-white/10 ring-1 ring-white/15 overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-brand-primary shadow-[0_0_10px_rgba(200,32,44,0.6)] transition-[width] duration-700 ease-out"
              style={{ width: `${Math.max(0, Math.min(100, level.progressPercent))}%` }}
              aria-hidden
            />
          </div>
          {level.xpToNextLevel > 0 && (
            <div className="mt-1.5 text-center text-[11px] font-semibold text-white/70">
              {level.xpToNextLevel} XP to Level {level.level + 1}
            </div>
          )}
        </div>
      )}

      {/* LOCKER — 9 slots, badges first then locks. */}
      <div className="relative px-4 sm:px-5 pt-3 pb-4 sm:pb-5 border-t border-white/10">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] font-black uppercase tracking-widest text-white/70">Locker</div>
          <div className="text-[11px] font-semibold text-white/60 tabular-nums">
            {badgeCount} of {totalBadgeSlots}
          </div>
        </div>
        <div className="grid grid-cols-9 gap-1 sm:gap-1.5">
          {lockerCells.map((cell, i) => {
            if (cell.kind === 'earned') {
              return (
                <div
                  key={`e-${cell.slug}`}
                  className="aspect-square rounded-lg bg-white/[0.04] ring-1 ring-brand-primary/40 shadow-[0_0_12px_-2px_rgba(200,32,44,0.45)] flex items-center justify-center"
                  title={badgeLabel(cell.slug)}
                  aria-label={badgeLabel(cell.slug)}
                >
                  <img
                    src={badgeImageSrc(cell.slug, 48)}
                    srcSet={badgeSrcSet(cell.slug, 32)}
                    alt=""
                    className="w-full h-full object-contain p-0.5"
                    draggable={false}
                  />
                </div>
              );
            }
            if (cell.kind === 'overflow') {
              return (
                <div
                  key={`o-${i}`}
                  className="aspect-square rounded-lg bg-brand-primary/20 ring-1 ring-brand-primary/40 flex items-center justify-center text-brand-primary-soft text-[11px] font-black tabular-nums"
                  aria-label={`${cell.count} more badges`}
                >
                  +{cell.count}
                </div>
              );
            }
            return (
              <div
                key={`l-${i}`}
                className="aspect-square rounded-lg bg-white/[0.04] ring-1 ring-white/10 flex items-center justify-center"
                aria-label="Locked slot"
              >
                <LockIcon className="w-3.5 h-3.5 text-white/25" />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

interface MetricTileProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}

const MetricTile: React.FC<MetricTileProps> = ({ icon, label, value, hint }) => (
  <div className="rounded-xl bg-white/[0.05] ring-1 ring-white/10 px-3 py-2 flex flex-col min-w-0 backdrop-blur-sm">
    {/* Tiles now sit in a full-width row (not the squeezed identity
        column), so labels + hints render whole. tracking-wider keeps
        the HUD feel without eating horizontal space. */}
    <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-white/70 whitespace-nowrap">
      <span className="shrink-0">{icon}</span>
      <span>{label}</span>
    </div>
    <div className="mt-1 flex items-baseline gap-1.5 min-w-0">
      <span className="text-xl sm:text-2xl font-black text-white tabular-nums leading-none">{value}</span>
      <span className="text-[10px] font-semibold text-white/55 tabular-nums whitespace-nowrap">{hint}</span>
    </div>
  </div>
);

export default KidHeroCard;
