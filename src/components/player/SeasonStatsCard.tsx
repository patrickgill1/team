import React from 'react';
import type { Player } from '../../types';
import { isGoalkeeper } from '../../utils/helpers';
import ProfileCard from './ProfileCard';

// SeasonStatsCard — a scoped 4-up of games/goals/assists/(saves|G+A)
// with a 3-way toggle: this team / this season, this team / career,
// all-time across every team this player's been on. Reads from
// player_memberships (per-team-season stat rows) so a shared player
// shows clean splits instead of one polluted aggregate.
//
// Extracted from PlayerProfile in the 2026-07-15 Direction B refactor
// to keep the tab-body JSX from ballooning further. Renders inside a
// ProfileCard shell.

export type StatsScope = 'team_season' | 'team_career' | 'all_time';

interface Props {
  player: Player;
  memberships: any[];
  selectedTeamId: string;
  scope: StatsScope;
  onScopeChange: (s: StatsScope) => void;
}

const EMPTY = { gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0, saves: 0, cleanSheets: 0 };

function sumStats(rows: any[]): typeof EMPTY {
  return rows.reduce((acc, m) => {
    const s = m.stats || {};
    acc.gamesPlayed += s.gamesPlayed || 0;
    acc.goals += s.goals || 0;
    acc.assists += s.assists || 0;
    acc.saves += s.saves || 0;
    acc.yellowCards += s.yellowCards || 0;
    acc.redCards += s.redCards || 0;
    acc.minutesPlayed += s.minutesPlayed || 0;
    acc.cleanSheets += s.cleanSheets || 0;
    return acc;
  }, { ...EMPTY });
}

const SeasonStatsCard: React.FC<Props> = ({ player, memberships, selectedTeamId, scope, onScopeChange }) => {
  const teamMems = memberships.filter((m: any) => m.teamId === selectedTeamId);
  const activeSeasonMem = teamMems.find((m: any) => m.isActive !== false);

  let scoped: any;
  if (scope === 'all_time') {
    scoped = memberships.length ? sumStats(memberships) : (player.stats || EMPTY);
  } else if (scope === 'team_career') {
    scoped = teamMems.length ? sumStats(teamMems) : (player.stats || EMPTY);
  } else {
    scoped = (activeSeasonMem?.stats) || (teamMems.length ? sumStats(teamMems) : (player.stats || EMPTY));
  }

  const scopeLabel =
    scope === 'all_time' ? 'ALL-TIME'
    : scope === 'team_career' ? 'THIS TEAM · CAREER'
    : 'THIS TEAM · SEASON';

  return (
    <ProfileCard
      eyebrow="Season Stats"
      title={scopeLabel}
    >
      {/* Scope toggle */}
      <div className="flex gap-1 rounded-xl bg-surface-input/70 ring-1 ring-line-default/15 p-1">
        {([
          { k: 'team_season', label: 'Season' },
          { k: 'team_career', label: 'Career here' },
          { k: 'all_time', label: 'All-time' },
        ] as const).map(({ k, label }) => (
          <button
            key={k}
            type="button"
            onClick={() => onScopeChange(k)}
            className={`flex-1 px-2 py-1 rounded-lg text-[10px] font-extrabold tracking-widest uppercase transition ${
              scope === k
                ? 'bg-brand-primary/20 text-ink-primary ring-1 ring-brand-primary-soft/40'
                : 'text-ink-primary/60 hover:text-ink-primary'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-2">
        <div className="rounded-xl bg-surface-input/70 ring-1 ring-line-default/15 p-2.5 text-center">
          <div className="text-2xl sm:text-3xl font-black text-brand-primary-soft tabular-nums">{scoped.gamesPlayed || 0}</div>
          <div className="text-[9px] uppercase tracking-widest text-ink-primary/60 font-bold mt-0.5">Games</div>
        </div>
        <div className="rounded-xl bg-surface-input/70 ring-1 ring-line-default/15 p-2.5 text-center">
          <div className="text-2xl sm:text-3xl font-black text-emerald-500 tabular-nums">{scoped.goals || 0}</div>
          <div className="text-[9px] uppercase tracking-widest text-ink-primary/60 font-bold mt-0.5">Goals</div>
        </div>
        <div className="rounded-xl bg-surface-input/70 ring-1 ring-line-default/15 p-2.5 text-center">
          <div className="text-2xl sm:text-3xl font-black text-brand-primary-soft tabular-nums">{scoped.assists || 0}</div>
          <div className="text-[9px] uppercase tracking-widest text-ink-primary/60 font-bold mt-0.5">Assists</div>
        </div>
        {isGoalkeeper(player) ? (
          <div className="rounded-xl bg-surface-input/70 ring-1 ring-line-default/15 p-2.5 text-center">
            <div className="text-2xl sm:text-3xl font-black text-amber-500 tabular-nums">{scoped.saves || 0}</div>
            <div className="text-[9px] uppercase tracking-widest text-ink-primary/60 font-bold mt-0.5">Saves</div>
          </div>
        ) : (
          <div className="rounded-xl bg-surface-input/70 ring-1 ring-line-default/15 p-2.5 text-center">
            <div className="text-2xl sm:text-3xl font-black text-amber-500 tabular-nums">{(scoped.goals || 0) + (scoped.assists || 0)}</div>
            <div className="text-[9px] uppercase tracking-widest text-ink-primary/60 font-bold mt-0.5">G+A</div>
          </div>
        )}
      </div>
      {scope === 'all_time' && memberships.length > 1 && (
        <p className="text-[10px] text-ink-primary/50 tracking-wide">Combined across {memberships.length} team-season{memberships.length === 1 ? '' : 's'}.</p>
      )}
    </ProfileCard>
  );
};

export default SeasonStatsCard;
