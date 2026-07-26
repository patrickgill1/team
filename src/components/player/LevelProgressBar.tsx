import React from 'react';
import type { Player, Team } from '../../types';
import { computeXpLevel } from '../../utils/xpLevel';
import { playerTier } from '../../utils/playerTier';
import ProfileCard from './ProfileCard';

// LevelProgressBar — compact "Level N · X XP · Y XP to Lv N+1"
// mini-card that lives at the top of the Story tab so a parent
// landing on the profile SEES progression without having to
// discover the Stats tab first.
//
// Renders inside the Card Contract shell like every other Story
// card. Gated on team.xpConfig.enabled === true — non-XP teams
// (or teams that paused XP with history intact) don't render this
// widget; PlayerXpCard already handles the paused-with-history
// keepsake case in the Stats tab.
//
// Tap → onSeeDetails() which the parent wires to a jump-to-Stats-tab
// + scroll-to-PlayerXpCard sequence. Doesn't duplicate the tier
// chip, quest line, or badge grid from PlayerXpCard — just the
// headline progress + a link to the deeper card.
//
// See project_xp_badges memory for the "career, not a leaderboard"
// philosophy that shapes the copy here.

interface Props {
  player: Player;
  team: Team | null | undefined;
  /** Callback invoked when the user taps the mini-card OR the "View
   *  season card" affordance. Parent switches to Stats tab and
   *  scrolls to PlayerXpCard. */
  onSeeDetails: () => void;
}

const LevelProgressBar: React.FC<Props> = ({ player, team, onSeeDetails }) => {
  const xpConfig = (team as any)?.xpConfig;
  const xpEnabled = xpConfig?.enabled === true;
  // Adult teams always hide the XP progress mini-card. Even if a
  // coach flipped xpConfig.enabled = true, the player-facing tier /
  // level chrome reads as kid-flavored on an adult roster (see
  // feedback_no_currency_mechanics + adult-mode intent).
  const isAdult = (team as any)?.audienceType === 'adult';
  if (!xpEnabled || isAdult) return null;

  const xp = typeof (player as any).xp === 'number' ? (player as any).xp : 0;
  const level = computeXpLevel(xp);
  const pct = Math.max(0, Math.min(100, level.progressPercent));
  const tier = playerTier(level.level);

  return (
    <ProfileCard eyebrow="Season progress" title={`Level ${level.level} · ${tier}`}>
      <button
        type="button"
        onClick={onSeeDetails}
        aria-label={`View season card — Level ${level.level}, ${level.xpToNextLevel} XP to Level ${level.level + 1}`}
        className="group w-full text-left flex flex-col gap-2 rounded-lg -m-1 p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/50"
      >
        <div className="flex items-baseline justify-between gap-2 text-[12px] font-bold text-ink-primary/70 tabular-nums">
          <span>
            <span className="text-ink-primary font-black">{xp.toLocaleString()}</span>
            <span className="text-ink-primary/50"> XP this season</span>
          </span>
          <span className="text-ink-primary/60">
            <span className="text-brand-primary font-black">{level.xpToNextLevel.toLocaleString()}</span>
            <span> to Lv {level.level + 1}</span>
          </span>
        </div>
        <div className="relative h-2.5 w-full rounded-full bg-surface-input ring-1 ring-line-default/25 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-brand-primary transition-all duration-700 ease-out"
            style={{
              width: `${pct}%`,
              boxShadow: '0 0 8px rgba(200,32,44,0.4)',
            }}
            aria-hidden
          />
        </div>
        <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-ink-primary/45">
          <span>Lv {level.level}</span>
          <span className="text-brand-primary-soft group-hover:text-brand-primary transition-colors inline-flex items-center gap-0.5">
            View season card
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </span>
          <span>Lv {level.level + 1}</span>
        </div>
      </button>
    </ProfileCard>
  );
};

export default LevelProgressBar;
