// AdultMyStatsCard — the adult-team Dashboard replacement for
// MyPlayerCard. Where the youth card is a hero of streaks, XP, badges,
// and juggle PRs (things kids and their parents care about), the adult
// card is a boxscore: name + jersey + position header on top, then a
// grid of season stats (games, goals, assists, and — for keepers /
// defenders — saves and clean sheets). No XP bar, no level chip, no
// juggle counter, no favorite-player chrome. The point is "how am I
// doing this season?" rendered honestly and calmly, matching the
// men's-league tone Patrick asked for after joining Crushers.
//
// Guards live at the parent (Dashboard.tsx): this card only renders
// when currentTeam.audienceType === 'adult' AND the viewing user has
// a linked selfPlayer on the current team's roster. When either is
// false, the youth MyPlayerCard shape stays. When true but the
// viewer isn't on the roster (spectator / coach-only), Dashboard
// simply skips the block — silent, no empty state, matching the
// "atomic render" rule.
//
// Stats source: reuses the player doc already loaded on Dashboard,
// where `stats` is season-scoped via getTeamPlayerStatsMap
// (Dashboard.tsx load effect). No new Firestore reads.

import React from 'react';
import { Link } from 'react-router-dom';
import type { Player } from '../../types';

interface Props {
  player: Player;
  teamName?: string;
  /** Optional team result text (e.g. "8W-3L-1T") if the parent has
   *  computed one for the active season. Rendered as the 6th stat cell
   *  when present; skipped otherwise so we don't fake a value. */
  seasonRecord?: string;
}

// Case-insensitive position match so "goalkeeper" / "Goalkeeper" /
// "GK" all resolve. Position strings are user-editable text in a lot
// of legacy data, so we normalize once and match against a set.
function isKeeper(position: string | undefined | null): boolean {
  if (!position) return false;
  const p = String(position).trim().toLowerCase();
  return p === 'goalkeeper' || p === 'keeper' || p === 'gk';
}

function isDefender(position: string | undefined | null): boolean {
  if (!position) return false;
  const p = String(position).trim().toLowerCase();
  return p === 'defender' || p === 'defence' || p === 'defense' || p === 'centre-back' || p === 'center-back' || p === 'cb' || p === 'fullback' || p === 'full-back' || p === 'lb' || p === 'rb';
}

// Small stat cell. Uses theme tokens so light + dark both look
// correct. Big tabular number, tiny uppercase label under it.
const StatCell: React.FC<{ label: string; value: string | number }> = ({ label, value }) => (
  <div className="flex flex-col items-center justify-center rounded-xl bg-surface-base/60 dark:bg-charcoal-900/40 ring-1 ring-line-default/40 dark:ring-white/5 px-2 py-3 min-h-[68px]">
    <div className="text-[22px] leading-none font-black tabular-nums text-ink-primary">{value}</div>
    <div className="mt-1.5 text-[9px] font-black uppercase tracking-[0.2em] text-ink-primary/55 text-center">{label}</div>
  </div>
);

const AdultMyStatsCard: React.FC<Props> = ({ player, teamName, seasonRecord }) => {
  const p = player as unknown as {
    id: string;
    name: string;
    jerseyNumber?: number;
    position?: string;
    positions?: string[];
    profilePhotoUrl?: string | null;
    stats?: {
      gamesPlayed?: number;
      goals?: number;
      assists?: number;
      saves?: number;
      cleanSheets?: number;
    };
  };

  const primaryPosition = (p.positions && p.positions[0]) || p.position || 'Player';
  const keeper = isKeeper(primaryPosition) || (p.positions || []).some(isKeeper);
  const defender = isDefender(primaryPosition) || (p.positions || []).some(isDefender);

  const stats = p.stats || {};
  const gamesPlayed = Number(stats.gamesPlayed) || 0;
  const goals = Number(stats.goals) || 0;
  const assists = Number(stats.assists) || 0;
  const saves = Number(stats.saves) || 0;
  const cleanSheets = Number(stats.cleanSheets) || 0;

  // Subtitle: POSITION · #JERSEY · TEAM NAME. Elements collapse when
  // missing so we never render stray dots.
  const subtitleParts: string[] = [];
  if (primaryPosition) subtitleParts.push(String(primaryPosition).toUpperCase());
  if (typeof p.jerseyNumber === 'number') subtitleParts.push(`#${p.jerseyNumber}`);
  if (teamName) subtitleParts.push(teamName.toUpperCase());
  const subtitle = subtitleParts.join(' · ');

  return (
    <Link
      to={`/player/${p.id}`}
      className="relative block overflow-hidden rounded-2xl bg-surface-elevated ring-1 ring-line-default/40 dark:ring-brand-primary/25 shadow-lg shadow-black/5 active:scale-[0.995] transition text-ink-primary"
    >
      <div className="p-4 flex flex-col gap-4">
        {/* Header row: photo + name column. */}
        <div className="flex items-center gap-3">
          <div className="relative flex-shrink-0 w-[64px] h-[64px]">
            {p.profilePhotoUrl ? (
              <img
                src={p.profilePhotoUrl}
                alt={p.name}
                className="w-16 h-16 rounded-full object-cover ring-2 ring-brand-primary/60"
                loading="lazy"
              />
            ) : (
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-brand-primary/70 to-brand-primary-soft flex items-center justify-center text-white text-lg font-black ring-2 ring-brand-primary/60">
                {typeof p.jerseyNumber === 'number' ? `#${p.jerseyNumber}` : (p.name || '?').charAt(0)}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-black uppercase tracking-[0.24em] text-brand-primary">This Season</div>
            <div className="mt-0.5 text-[20px] leading-tight font-black truncate">{p.name}</div>
            {subtitle && (
              <div className="mt-0.5 text-[10.5px] font-bold uppercase tracking-[0.14em] text-ink-primary/55 truncate">
                {subtitle}
              </div>
            )}
          </div>
        </div>

        {/* Stats grid. Field players get a 2x2 (games / goals / assists
            plus optional season record). Keepers get a 3x2 with saves +
            clean sheets. Defenders get clean sheets but not saves. The
            grid always fills its row count so the card doesn't feel
            lopsided when the record cell is missing. */}
        <div className="grid grid-cols-3 gap-2">
          <StatCell label="Games" value={gamesPlayed} />
          <StatCell label="Goals" value={goals} />
          <StatCell label="Assists" value={assists} />
          {keeper && <StatCell label="Saves" value={saves} />}
          {(keeper || defender) && <StatCell label="Clean Sheets" value={cleanSheets} />}
          {seasonRecord && <StatCell label="Team Record" value={seasonRecord} />}
        </div>
      </div>
    </Link>
  );
};

export default AdultMyStatsCard;
