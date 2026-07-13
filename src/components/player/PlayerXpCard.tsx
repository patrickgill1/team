// PlayerXpCard — collectible "player card" surface on PlayerProfile.
// Trading-card treatment: rarity-tiered gradient border (Rookie /
// Elite / Legend), oversized center-top LEVEL power number, player
// name as card title, XP + collection stats, an animated progress
// rail with a pulsing cyan-soft energy tip at the leading edge, a
// quest-style "NEXT MILESTONE" callout under the bar, and a badge
// collection grid that renders every earnable slug as a slot so a
// kid can SEE the empty holes waiting to be filled.
//
// Renders NOTHING when team.xpConfig.enabled !== true, so coaches
// who haven't opted in never see it. Coach surfaces still get the
// "Give XP" pill so a moment can be captured on the spot (opens
// CoachGrantXpModal pre-selected to this player).
// Parent-facing = read-only celebration card. See goalkickr-xp
// memo (Phase 1) + xp-card-video-game-redesign judge grafts (B
// winner + C quest line + A pulsing tip).

import React from 'react';
import { Player, Team } from '../../types';
import { computeXpLevel } from '../../utils/xpLevel';
import { badgeImageSrc, badgeSrcSet, badgeLabel, filterVisibleBadgeSlots } from '../../utils/badgeMeta';

interface Props {
  player: Player;
  team: Team | null | undefined;
  isCoach: boolean;
  onGiveXp: () => void;
}

// Fixed slot order for the collection grid. Kept explicit so the
// visual "hole in the collection" is stable across renders. If the
// badge economy grows in badgeMeta, extend this list too — the grid
// draws only what's here, not everything on the doc.
const BADGE_SLOTS: string[] = [
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
];

type RarityTier = 'rookie' | 'elite' | 'legend';

function rarityForLevel(level: number): RarityTier {
  if (level >= 21) return 'legend';
  if (level >= 11) return 'elite';
  return 'rookie';
}

interface RarityStyle {
  label: string;
  /** Outer wrapper — the metallic card stroke. */
  frame: string;
  /** Ambient drop-shadow glow behind the card. Empty string for
   *  Rookie so day-one kids don't get a shouty presentation. */
  glow: string;
  /** Rarity chip pill in the header. */
  chip: string;
  /** Power number color. */
  levelText: string;
  /** Progress bar fill direction. */
  bar: string;
}

const RARITY_STYLES: Record<RarityTier, RarityStyle> = {
  rookie: {
    // Rookie sits quiet on purpose — a Lv 1 kid shouldn't get a
    // foil-stamp card, they should have room to grow into one.
    label: 'Rookie',
    frame: 'bg-brand-primary/40',
    glow: '',
    chip: 'bg-brand-primary/15 text-brand-primary ring-brand-primary/30',
    levelText: 'text-brand-primary',
    bar: 'bg-brand-primary',
  },
  elite: {
    label: 'Elite',
    frame: 'bg-gradient-to-br from-brand-primary via-brand-primary/70 to-brand-primary-soft',
    glow: 'shadow-[0_10px_50px_-10px_rgba(200,32,44,0.5)]',
    chip: 'bg-brand-primary-soft/15 text-brand-primary-soft ring-brand-primary-soft/40',
    levelText: 'text-brand-primary',
    bar: 'bg-gradient-to-r from-brand-primary to-brand-primary-soft',
  },
  legend: {
    label: 'Legend',
    // Metallic crimson foil — alternating stops in the crimson
    // family fake the shimmer without breaking palette.
    frame: 'bg-gradient-to-br from-brand-primary via-brand-primary-soft to-brand-primary',
    glow: 'shadow-[0_12px_60px_-8px_rgba(200,32,44,0.7)]',
    chip: 'bg-brand-primary text-white ring-brand-primary-soft/60',
    levelText: 'text-brand-primary',
    bar: 'bg-gradient-to-r from-brand-primary via-brand-primary-soft to-brand-primary',
  },
};

const StarIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="currentColor" stroke="none" viewBox="0 0 24 24" aria-hidden>
    <path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" />
  </svg>
);

const LockIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 018 0v3" />
  </svg>
);

const ChevronIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    <polyline points="9 6 15 12 9 18" />
  </svg>
);

const PlusIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const PlayerXpCard: React.FC<Props> = ({ player, team, isCoach, onGiveXp }) => {
  const xpConfig = (team as any)?.xpConfig;
  const xpEnabled = xpConfig?.enabled === true;

  const xp = typeof (player as any).xp === 'number' ? (player as any).xp : 0;
  const xpCareer = typeof (player as any).xpCareer === 'number' ? (player as any).xpCareer : xp;
  const badges: Record<string, any> = ((player as any).badges && typeof (player as any).badges === 'object')
    ? (player as any).badges
    : {};
  const ownedCount = Object.keys(badges).length;

  // Team never opted into XP AND the player has no history yet.
  // Nothing to show — return null so the profile stays clean. If they
  // later earn badges (worker-only paths still fire) OR the coach
  // flips XP on, the card comes back.
  if (!team || (!xpEnabled && ownedCount === 0 && xpCareer === 0)) return null;

  // "Paused" state: coach turned XP off (or never turned it on) BUT
  // the player has history worth keeping. Card renders as a keepsake
  // trophy cabinet — no level, no progression rail, no coach
  // Give XP button. Just the badges they've earned + career XP
  // total + a soft chip that explains the pause without making the
  // kid feel like they're at zero.
  const paused = !xpEnabled;
  const level = computeXpLevel(xp);

  // Position-relevant collection. Union of "eligible for this player's
  // position(s)" + "already earned" so a keeper's grid drops
  // first_goal and a striker's drops first_save — no dead locks kids
  // can't realistically fill. A rare cross-position earn still shows.
  const positions: string[] = [
    ...((player as any).positions || []),
    ...((player as any).position ? [(player as any).position] : []),
  ];
  const visibleSlots = filterVisibleBadgeSlots(BADGE_SLOTS, positions, badges);
  const totalSlots = visibleSlots.length;
  // Position-scoped owned count so the "N of M" ratio stays fair —
  // a keeper's first_goal (if earned via a rare set-piece) counts
  // because filterVisibleBadgeSlots includes earned badges regardless.
  const visibleOwnedCount = visibleSlots.reduce((acc, slug) => acc + (badges[slug] ? 1 : 0), 0);
  // Legacy count from the old Recognize flow (deleted 2026-07-13).
  // Present only on players who received recognitions before the
  // switch; new grants no longer bump this. Kept for backward-compat
  // display on players who have it.
  const coachPickCount = typeof badges?.coach_pick?.count === 'number' ? badges.coach_pick.count : 0;
  const coachPickEarned = !!badges?.coach_pick?.earnedAt;

  const rarity = paused ? 'rookie' : rarityForLevel(level.level);
  const rarityStyle = RARITY_STYLES[rarity];
  const displayName = ((player as any).name || 'Player').toString();

  // Clamp defensively so a bad xp value can't blow the rail out.
  const pct = Math.max(0, Math.min(100, level.progressPercent));
  // Only render the pulsing energy tip once the fill has real
  // width. At 0% it would float at the left edge and look broken.
  const showTip = pct > 2 && pct < 100;

  return (
    <section className="px-4 sm:px-6 pt-2">
      <div className="max-w-3xl mx-auto">
        {/* Outer stroke = the collectible-card border. Gradient
            padding gives us a metallic 2px edge that survives both
            themes without hardcoding gray/black. */}
        <div className={`relative rounded-[22px] p-[2px] ${rarityStyle.frame} ${rarityStyle.glow}`}>
          {rarity === 'legend' && (
            <div
              className="pointer-events-none absolute -inset-1 rounded-[26px] bg-brand-primary-soft/10 blur-md"
              aria-hidden
            />
          )}

          <div className="relative rounded-[20px] bg-surface-elevated overflow-hidden">
            {/* Backdrop wash: soft crimson diagonal so the card
                doesn't read flat, but stays subtle so the power
                number is the eye anchor. */}
            <div
              className="pointer-events-none absolute inset-0 bg-gradient-to-br from-brand-primary/10 via-transparent to-brand-primary-soft/5"
              aria-hidden
            />

            {/* HEADER: chip left (rarity when live, "TROPHY CABINET"
                when paused), Give XP right (coach-only + XP-on).
                Opens CoachGrantXpModal pre-selected to this player. */}
            <div className="relative px-4 sm:px-5 pt-3 flex items-center justify-between gap-2">
              {paused ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-[0.18em] ring-1 bg-line-default/10 text-ink-primary/75 ring-line-default/25">
                  <StarIcon className="w-2.5 h-2.5" />
                  Trophy Cabinet
                </span>
              ) : (
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-[0.18em] ring-1 ${rarityStyle.chip}`}
                >
                  <StarIcon className="w-2.5 h-2.5" />
                  {rarityStyle.label}
                </span>
              )}
              {isCoach && !paused && (
                <button
                  type="button"
                  onClick={onGiveXp}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-brand-primary text-white text-[11px] font-black uppercase tracking-wider ring-1 ring-brand-primary/60 shadow-md hover:brightness-110 active:scale-[0.98] transition"
                  aria-label={`Give XP to ${displayName}`}
                >
                  <PlusIcon className="w-3.5 h-3.5" />
                  Give XP
                </button>
              )}
            </div>

            {/* POWER NUMBER + name. When XP is paused we skip the big
                level number (kid doesn't have a current level to
                celebrate) and keep just the name + kicker. */}
            <div className="relative px-4 sm:px-5 pt-1 pb-3 text-center">
              {!paused && (
                <>
                  <p className="text-[10px] font-extrabold uppercase tracking-[0.32em] text-ink-primary/50">
                    Level
                  </p>
                  <div
                    className={`mt-0.5 text-6xl sm:text-7xl font-black leading-none tabular-nums ${rarityStyle.levelText}`}
                    style={{ textShadow: '0 2px 0 rgba(200,32,44,0.15)' }}
                  >
                    {level.level}
                  </div>
                </>
              )}
              <h3 className={`${paused ? '' : 'mt-2'} text-base sm:text-lg font-black text-ink-primary tracking-wide uppercase truncate`}>
                {displayName}
              </h3>
              <p className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.22em] text-ink-primary/45">
                {paused ? 'Career Keepsake' : 'Season Card'}
              </p>
            </div>

            {/* PROGRESS RAIL: always renders even at 0% when XP is
                on so a fresh kid sees the shape. Skipped entirely
                when paused — no half-full bar implying they should
                be grinding. */}
            {!paused && (
            <div className="relative px-4 sm:px-5 pb-2">
              <div className="relative h-2.5 w-full rounded-full bg-surface-input ring-1 ring-line-default/30 overflow-visible">
                <div
                  className={`absolute inset-y-0 left-0 rounded-full ${rarityStyle.bar} transition-all duration-700 ease-out`}
                  style={{
                    width: `${pct}%`,
                    boxShadow: '0 0 10px rgba(200,32,44,0.5)',
                  }}
                  aria-hidden
                />
                {pct > 0 && (
                  <div
                    className="pointer-events-none absolute inset-y-0 left-0 rounded-full"
                    style={{
                      width: `${pct}%`,
                      background: 'linear-gradient(180deg, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0) 55%)',
                    }}
                    aria-hidden
                  />
                )}
                {showTip && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-brand-primary-soft animate-pulse"
                    style={{
                      left: `${pct}%`,
                      boxShadow: '0 0 10px 2px rgba(241,114,130,0.7)',
                    }}
                    aria-hidden
                  />
                )}
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-primary/60 font-semibold tabular-nums">
                <span>
                  {level.xpIntoLevel} / {level.nextLevelThreshold - level.currentLevelThreshold} into Lv {level.level}
                </span>
                <span>{level.xpToNextLevel} to Lv {level.level + 1}</span>
              </div>

              {/* NEXT MILESTONE quest line (grafted from Direction C).
                  Reads like a game HUD objective — the single strongest
                  grind driver in the design bake-off. */}
              <div className="mt-3 flex items-start gap-2 rounded-lg bg-surface-input/60 ring-1 ring-line-default/20 px-3 py-2">
                <ChevronIcon className="w-3.5 h-3.5 mt-0.5 text-brand-primary-soft flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-black uppercase tracking-[0.22em] text-ink-primary/50">
                    Next Milestone
                  </p>
                  <p className="mt-0.5 text-[13px] font-bold text-ink-primary tabular-nums">
                    Reach <span className="text-brand-primary">Lv {level.level + 1}</span>
                    <span className="text-ink-primary/55 font-semibold"> in </span>
                    <span className="text-brand-primary-soft">{level.xpToNextLevel.toLocaleString()} XP</span>
                  </p>
                </div>
              </div>
            </div>
            )}

            {/* STAT ROW: Season XP + Collection count as headline
                numbers. Two-panel divided plate feels like a card's
                stat block. */}
            <div className="relative mx-4 sm:mx-5 mt-2 mb-3 rounded-xl bg-surface-input/70 ring-1 ring-line-default/25 overflow-hidden">
              <div className="grid grid-cols-2 divide-x divide-line-default/25">
                <div className="px-3 py-2">
                  <p className="text-[9px] font-black uppercase tracking-[0.22em] text-ink-primary/50">
                    {paused ? 'Career XP' : 'Season XP'}
                  </p>
                  <p className="mt-0.5 text-lg font-black text-ink-primary leading-none tabular-nums">
                    {(paused ? xpCareer : xp).toLocaleString()}
                  </p>
                </div>
                <div className="px-3 py-2">
                  <p className="text-[9px] font-black uppercase tracking-[0.22em] text-ink-primary/50">
                    Collection
                  </p>
                  <p className="mt-0.5 text-lg font-black text-ink-primary leading-none tabular-nums">
                    {visibleOwnedCount}
                    <span className="text-ink-primary/40 text-sm font-bold"> / {totalSlots}</span>
                  </p>
                </div>
              </div>
            </div>

            {/* BADGE COLLECTION GRID: every earnable slug has a slot.
                Owned = badge art + subtle glow ring. Locked = dashed
                border with lock icon so the kid sees the visible hole
                waiting for them. Coach's Pick shows repeat count as a
                corner chip since it's the only repeatable slug. */}
            <div className="relative px-4 sm:px-5 pb-4">
              <div className="grid grid-cols-6 sm:grid-cols-11 gap-1.5 sm:gap-2">
                {visibleSlots.map((slug) => {
                  const owned = Object.prototype.hasOwnProperty.call(badges, slug);
                  const meta = badges[slug];
                  const label = badgeLabel(slug);
                  const count = slug === 'coach_pick' && typeof meta?.count === 'number' ? meta.count : 0;
                  const src = badgeImageSrc(slug, 72);
                  const srcSet = badgeSrcSet(slug, 40);
                  const title = owned ? (meta?.context || label) : `${label} (locked)`;
                  return (
                    <div
                      key={slug}
                      className={
                        'relative aspect-square rounded-lg flex items-center justify-center ring-1 ' +
                        (owned
                          ? 'bg-brand-primary/10 ring-brand-primary/40 shadow-[inset_0_0_12px_rgba(200,32,44,0.15)]'
                          : 'bg-surface-input/50 ring-line-default/30 border border-dashed border-line-default/40')
                      }
                      title={title}
                      aria-label={title}
                    >
                      {owned ? (
                        <>
                          <img
                            src={src}
                            srcSet={srcSet}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="w-[78%] h-[78%] object-contain"
                          />
                          {count > 1 && (
                            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-brand-primary text-white text-[9px] font-black leading-none flex items-center justify-center ring-2 ring-surface-elevated tabular-nums">
                              {count}
                            </span>
                          )}
                        </>
                      ) : (
                        <LockIcon className="w-3.5 h-3.5 text-ink-primary/30" />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Contextual footnote. Paused state: gentle "XP is
                  paused, badges stay yours" note so the kid doesn't
                  read the locked slots as failure. Active state:
                  coach nudge or Coach's Pick tally. */}
              {paused ? (
                <p className="mt-3 text-[11px] text-ink-primary/60 leading-snug text-center">
                  XP program is paused by the coach. The badges you've earned stay right here.
                </p>
              ) : ownedCount === 0 ? (
                <p className="mt-3 text-[11px] text-ink-primary/60 leading-snug text-center">
                  {isCoach
                    ? "Empty card. Tap Give XP up top to award the first points."
                    : "Slots fill in as badges are earned. Coach's Pick, POTM, streaks, and season milestones all count."}
                </p>
              ) : coachPickCount >= 5 ? (
                /* Legacy multi-count from the old Recognize flow.
                   New players just show the Coach's Pick earned pill
                   when the derived-threshold badge lands. */
                <p className="mt-3 text-center text-[10px] font-black uppercase tracking-[0.22em] text-brand-primary">
                  {coachPickCount} Coach Recognitions
                </p>
              ) : coachPickEarned ? (
                <p className="mt-3 text-center text-[10px] font-black uppercase tracking-[0.22em] text-brand-primary">
                  Coach's Pick
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default PlayerXpCard;
