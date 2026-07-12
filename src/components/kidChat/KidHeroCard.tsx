// KidHeroCard — the kid's identity hero on KidDashboard. Owns the
// consolidated identity block (photo, name, rarity, streak, badges,
// level, XP progress, locker) plus, as of 3.9.215, a level-gated
// SKIN frame around the whole card and a THEME modal that lets the
// kid see which frame they're on and what unlocks the next one.
//
// Skin tiers (level-derived; no store, no Firestore write, no worker):
//   NO_XP    — team.xpConfig disabled entirely. Bare card, no crimson
//              flourish, THEME pill hidden.
//   STARTER  — level 1-4.  Subtle crimson ring (previous default look).
//   BRONZE   — level 5-9.  Thin bronze metallic frame.
//   SILVER   — level 10-19. Bright silver metallic frame.
//   GOLD     — level 20+.  Rich gold frame with a subtle glow.
//
// Frames are CSS-only (linear-gradient wrapper + padded inner card).
// The THEME pill top-right opens a modal listing all four tiers with
// the kid's current one highlighted and the locked ones dimmed. No
// selection UI in v1 — the applied skin is derived from level.

import React, { useState } from 'react';
import type { Player, Team } from '../../types';
import { computeXpLevel } from '../../utils/xpLevel';
import { computeDobAge } from '../../utils/dobDate';
import { badgeImageSrc, badgeSrcSet, badgeLabel, filterVisibleBadgeSlots } from '../../utils/badgeMeta';

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

const LOCKER_SLOTS = 9;

interface KidHeroCardProps {
  player: Player;
  team: Team | null | undefined;
}

// ---------- Skin tier ladder ---------------------------------------

type SkinTier = 'NO_XP' | 'STARTER' | 'BRONZE' | 'SILVER' | 'GOLD';

interface TierMeta {
  tier: SkinTier;
  label: string;
  unlockLevel: number;
  copy: string;
}

// Kept in ascending order so nextTierMeta() can just look forward.
// NO_XP is not in this list — it's a separate state, not a rank.
const TIERS: TierMeta[] = [
  { tier: 'STARTER', label: 'Starter', unlockLevel: 1,  copy: 'Everyone starts here.' },
  { tier: 'BRONZE',  label: 'Bronze',  unlockLevel: 5,  copy: 'Reach Level 5.' },
  { tier: 'SILVER',  label: 'Silver',  unlockLevel: 10, copy: 'Reach Level 10.' },
  { tier: 'GOLD',    label: 'Gold',    unlockLevel: 20, copy: 'Reach Level 20.' },
];

function tierForLevel(level: number | null): SkinTier {
  if (level == null) return 'NO_XP';
  if (level >= 20) return 'GOLD';
  if (level >= 10) return 'SILVER';
  if (level >= 5)  return 'BRONZE';
  return 'STARTER';
}

function nextTierMeta(tier: SkinTier): TierMeta | null {
  if (tier === 'NO_XP' || tier === 'GOLD') return null;
  const idx = TIERS.findIndex(t => t.tier === tier);
  if (idx < 0 || idx >= TIERS.length - 1) return null;
  return TIERS[idx + 1];
}

// Frame styling for the outer wrapper. Returns null for NO_XP and
// STARTER (those render the plain card with no metallic wrapper).
// Colors are intentionally hardcoded warm-metallic gradients scoped
// to the card frame — they don't participate in the theme-token
// system because the frame is meant to look the same in light + dark.
function frameStyleForTier(tier: SkinTier): React.CSSProperties | null {
  if (tier === 'BRONZE') {
    return {
      background: 'linear-gradient(135deg, #7a4a1a 0%, #cd7f32 25%, #f6c07a 50%, #cd7f32 75%, #7a4a1a 100%)',
      boxShadow: '0 14px 32px -22px rgba(205,127,50,0.45)',
    };
  }
  if (tier === 'SILVER') {
    return {
      background: 'linear-gradient(135deg, #5a6068 0%, #c2c6cc 25%, #f0f2f5 50%, #c2c6cc 75%, #5a6068 100%)',
      boxShadow: '0 14px 32px -22px rgba(180,185,195,0.5)',
    };
  }
  if (tier === 'GOLD') {
    return {
      background: 'linear-gradient(135deg, #8a5a10 0%, #d4a83a 20%, #ffe28a 50%, #d4a83a 80%, #8a5a10 100%)',
      boxShadow: '0 18px 42px -20px rgba(212,168,58,0.6), 0 0 26px -8px rgba(255,223,128,0.45)',
    };
  }
  return null;
}

// Chip tone for a given tier — used both in the top-right chip stack
// next to the LEVEL numeral and in the THEME modal card list.
function tierChipClass(tier: SkinTier): string {
  switch (tier) {
    case 'BRONZE':  return 'bg-gradient-to-br from-amber-700 to-orange-800 text-amber-100 ring-amber-300/40';
    case 'SILVER':  return 'bg-gradient-to-br from-slate-400 to-slate-600 text-slate-50 ring-slate-200/50';
    case 'GOLD':    return 'bg-gradient-to-br from-amber-400 to-yellow-600 text-amber-950 ring-amber-200/60';
    case 'STARTER': return 'bg-brand-primary/30 text-brand-primary-soft ring-brand-primary/40';
    default:        return 'bg-white/10 text-white/70 ring-white/20';
  }
}

// ---------- Icons --------------------------------------------------

const FlameIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path fillRule="evenodd" d="M12.963 2.286a.75.75 0 00-1.071-.136 9.742 9.742 0 00-3.539 6.176 7.547 7.547 0 01-1.705-1.715.75.75 0 00-1.152-.082A9 9 0 1015.68 4.534a7.46 7.46 0 01-2.717-2.248zM15.75 14.25a3.75 3.75 0 11-7.313-1.172c.628.465 1.35.81 2.133 1a5.99 5.99 0 011.925-3.545 3.75 3.75 0 013.255 3.717z" clipRule="evenodd" />
  </svg>
);

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

const HexXpIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
    <path d="M12 2l8.66 5v10L12 22 3.34 17V7L12 2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <text x="12" y="15.5" textAnchor="middle" fontSize="7.5" fontWeight="900" fill="currentColor" fontFamily="ui-sans-serif, system-ui, sans-serif">XP</text>
  </svg>
);

const ShirtIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M8 3l-5 3 2 4 3-1v12h12V9l3 1 2-4-5-3-3 2h-6L8 3z" />
  </svg>
);

const CloseIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className={className} aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

// ---------- Helpers ------------------------------------------------

const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? '?';
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

function rarityFor(level: number | null): string {
  if (level == null) return 'ROOKIE';
  if (level >= 10) return 'LEGEND';
  if (level >= 7) return 'ELITE';
  if (level >= 4) return 'PRO';
  if (level >= 2) return 'RISING';
  return 'ROOKIE';
}

function streakBadgeTone(streak: number): string {
  if (streak >= 25) return 'bg-gradient-to-br from-amber-300 to-orange-600 ring-amber-200/60';
  if (streak >= 10) return 'bg-gradient-to-br from-orange-400 to-orange-600 ring-orange-200/50';
  if (streak >= 5)  return 'bg-orange-500 ring-orange-300/50';
  return 'bg-orange-500/85 ring-orange-300/40';
}

// ---------- Component ----------------------------------------------

const KidHeroCard: React.FC<KidHeroCardProps> = ({ player, team }) => {
  const [themeOpen, setThemeOpen] = useState(false);

  const streak = Math.max(0, Number((player as any).currentStreakDays ?? 0) | 0);
  const xp = Math.max(0, Number((player as any).xp ?? 0) | 0);
  const badges = ((player as any).badges ?? {}) as Record<string, unknown>;
  const xpEnabled = Boolean((team as any)?.xpConfig?.enabled);
  const isPotm = Boolean((player as any).isCurrentPotm);
  const jugglesBest = Math.max(0, Number((player as any).juggles?.best ?? 0) | 0);

  const age = player.dateOfBirth ? computeDobAge(player.dateOfBirth as any) : null;
  const level = xpEnabled ? computeXpLevel(xp) : null;

  // Position-relevant badge slots. Union of "eligible for the kid's
  // position" + "already earned" so a rare cross-position earn (a
  // striker who bagged a save on a deflection) still shows in the
  // locker. Keepers stop staring at first_goal forever; strikers
  // stop staring at first_save forever. Denominator becomes fair.
  const kidPositions: string[] = [
    ...((player as any).positions || []),
    ...((player as any).position ? [(player as any).position] : []),
  ];
  const relevantSlots = filterVisibleBadgeSlots(BADGE_SLOTS, kidPositions, badges);
  const badgeCount = relevantSlots.reduce((acc, slot) => acc + (badges[slot] ? 1 : 0), 0);
  const totalBadgeSlots = relevantSlots.length;
  const initials = getInitials(player.name);
  const rarity = rarityFor(level ? level.level : null);
  const streakTone = streakBadgeTone(streak);
  const currentTier: SkinTier = tierForLevel(level ? level.level : null);
  const upcomingTier = level ? nextTierMeta(currentTier) : null;
  const oneLevelToNext = !!(upcomingTier && level && upcomingTier.unlockLevel - level.level === 1);

  // Locker composition — earned first, then locks or overflow.
  // Uses relevantSlots so a striker never sees first_save as a lock.
  const earnedSlots = relevantSlots.filter((s) => badges[s]);
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

  // Stadium background: layered photo hero + dark scrim so the pitch
  // reads as texture and the content stays legible.
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

  // Inner card look. STARTER keeps the crimson ring flourish; NO_XP
  // strips it so the card reads "career mode, XP paused" rather than
  // pretending a tier system is running when the coach hasn't opted in.
  const innerRing =
    currentTier === 'NO_XP'
      ? 'ring-1 ring-line-default/25 shadow-[0_12px_30px_-24px_rgba(0,0,0,0.4)]'
      : 'ring-1 ring-brand-primary/25 shadow-[0_18px_50px_-24px_rgba(200,32,44,0.45)]';

  const frameStyle = frameStyleForTier(currentTier);

  const cardBody = (
    <div className={`relative rounded-3xl overflow-hidden bg-surface-elevated ${innerRing}`}>
      {/* Stadium wash + inner crimson rim. Both absolute so they sit
          behind content without affecting layout. Rim hidden on NO_XP
          so the bare card really reads bare. */}
      <div className="absolute inset-0 pointer-events-none" style={stadiumBg} aria-hidden />
      {currentTier !== 'NO_XP' && (
        <div className="absolute inset-0 pointer-events-none rounded-3xl ring-1 ring-inset ring-brand-primary/20" aria-hidden />
      )}

      {/* TOP ROW — avatar | identity + tiles | theme + level */}
      <div className="relative grid grid-cols-[auto_1fr_auto] gap-3 sm:gap-4 items-start p-4 sm:p-5">
        {/* LEFT: circular avatar with crimson ring + streak flame pill */}
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

        {/* CENTER: rarity chip + name. Light-on-dark by design because
            the card carries a photo background + dark scrim. */}
        <div className="min-w-0">
          {xpEnabled ? (
            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-brand-primary/25 text-brand-primary-soft text-[10px] font-black uppercase tracking-widest ring-1 ring-brand-primary/40">
              <StarIcon className="w-3 h-3" />
              {rarity}
            </div>
          ) : (
            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/10 text-white/85 text-[10px] font-black uppercase tracking-widest ring-1 ring-white/20">
              <ShieldIcon className="w-3 h-3" />
              Career Mode
            </div>
          )}
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

        {/* RIGHT: THEME pill (hidden on NO_XP) + tier chip + LEVEL block.
            THEME pill opens the tier modal; no in-app selection UI in v1
            because the applied skin is derived from level. */}
        <div className="shrink-0 flex flex-col items-end gap-2">
          {xpEnabled && (
            <button
              type="button"
              aria-label="Theme and skins"
              onClick={() => setThemeOpen(true)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full ring-1 ring-white/40 text-white/90 text-[9px] font-black uppercase tracking-widest bg-black/20 backdrop-blur-sm hover:bg-black/30 transition"
            >
              <ShirtIcon className="w-3 h-3" />
              <span>Theme</span>
            </button>
          )}
          {xpEnabled && level && currentTier !== 'STARTER' && currentTier !== 'NO_XP' && (
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest ring-1 ${tierChipClass(currentTier)}`}
              aria-label={`${currentTier} tier skin`}
            >
              {currentTier}
            </span>
          )}
          {xpEnabled && level && (
            <div className="flex flex-col items-center">
              <div className="text-[10px] font-black uppercase tracking-widest text-white/70">Level</div>
              <div className="text-4xl sm:text-5xl font-black text-brand-primary-soft leading-none tabular-nums drop-shadow-[0_2px_10px_rgba(200,32,44,0.55)]">
                {level.level}
              </div>
              {oneLevelToNext && upcomingTier && (
                <div className="mt-1 text-[9px] font-black uppercase tracking-widest text-white/70 leading-none">
                  1 to {upcomingTier.label}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Metric tiles */}
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

      {/* XP PROGRESS RAIL — within-current-level XP so it matches the
          bar fill (not cumulative season total). */}
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

      {/* LOCKER */}
      {(xpEnabled || badgeCount > 0) && (
        <div className="relative px-4 sm:px-5 pt-3 pb-4 sm:pb-5 border-t border-white/10">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
            <div className="flex items-center gap-2">
              <div className="text-[10px] font-black uppercase tracking-widest text-white/70">Locker</div>
              {!xpEnabled && (
                <span className="text-[9px] font-black uppercase tracking-widest text-white/45 bg-white/5 ring-1 ring-white/10 px-1.5 py-0.5 rounded-full">
                  XP paused
                </span>
              )}
            </div>
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
      )}
    </div>
  );

  return (
    <>
      {frameStyle ? (
        <div className="relative rounded-[28px] p-[3px]" style={frameStyle}>
          {cardBody}
        </div>
      ) : (
        cardBody
      )}

      {themeOpen && xpEnabled && (
        <ThemeModal
          currentTier={currentTier}
          currentLevel={level ? level.level : 1}
          onClose={() => setThemeOpen(false)}
        />
      )}
    </>
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

// ---------- THEME modal --------------------------------------------

interface ThemeModalProps {
  currentTier: SkinTier;
  currentLevel: number;
  onClose: () => void;
}

const ThemeModal: React.FC<ThemeModalProps> = ({ currentTier, currentLevel, onClose }) => {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Card skins"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-surface-elevated ring-1 ring-line-default/40 overflow-hidden shadow-2xl"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-line-default/30">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-brand-primary-soft">Card skins</p>
            <p className="text-sm font-black leading-none mt-0.5 text-ink-primary">Level up to unlock</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close skins"
            className="p-2 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/70 hover:text-ink-primary transition"
          >
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>
        <ul className="p-3 space-y-2">
          {TIERS.map((t) => {
            const locked = currentLevel < t.unlockLevel;
            const isCurrent = currentTier === t.tier;
            const swatchStyle = frameStyleForTier(t.tier) || {
              background: 'linear-gradient(135deg, rgba(200,32,44,0.6) 0%, rgba(200,32,44,0.35) 100%)',
            };
            return (
              <li
                key={t.tier}
                className={
                  'flex items-center gap-3 rounded-xl p-2.5 ring-1 transition ' +
                  (isCurrent
                    ? 'bg-brand-primary/10 ring-brand-primary/50'
                    : locked
                    ? 'bg-line-default/[0.04] ring-line-default/10 opacity-60'
                    : 'bg-line-default/[0.06] ring-line-default/20')
                }
              >
                <div
                  className={`w-10 h-10 rounded-lg shrink-0 ring-1 ring-black/30 ${tierChipClass(t.tier)}`}
                  style={swatchStyle}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-black text-ink-primary">{t.label}</span>
                    {isCurrent && (
                      <span className="text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-full bg-brand-primary/20 text-brand-primary-soft ring-1 ring-brand-primary/40">
                        Current
                      </span>
                    )}
                    {locked && !isCurrent && (
                      <span className="inline-flex items-center gap-0.5 text-[9px] font-black uppercase tracking-widest text-ink-primary/55">
                        <LockIcon className="w-3 h-3" />
                        Locked
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-ink-primary/60 leading-snug mt-0.5">
                    {t.copy}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="px-5 py-3 border-t border-line-default/30">
          <p className="text-[11px] text-ink-primary/55 leading-snug">
            Your skin is set automatically by your level. Keep earning XP to unlock the next one.
          </p>
        </div>
      </div>
    </div>
  );
};

export default KidHeroCard;
