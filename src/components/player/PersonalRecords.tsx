import React, { useEffect, useMemo, useState } from 'react';
import type { Player, GameStat } from '../../types';
import { useFirestore } from '../../hooks/useFirestore';
import { debug } from '../../utils/debug';
import { toMillis, shortDate } from '../../utils/timestamps';

// Number receipts. Career + season-high records for this kid,
// computed client-side over the same stat rows GameDay writes. The
// scope toggle lives on the Season Stats card above this one — we
// mirror its seasonId prop so the two cards read as a single unit
// ("This Season" up top swaps records down here too).
//
// Deliberate silences:
//  - Loading renders null (atomic render — no skeleton).
//  - value <= 0 rows are dropped (silence beats zero-filler).
//  - Records list empty → whole card renders null.
//  - "Most minutes in a game" is skipped: GameDay currently writes
//    minutesPlayed: 0 (phase 2 fix).
//  - "Fastest goal" is deferred (teamRecords.ts:191).

// MatchVoting isn't exported from src/types — it's defined inline in
// PlayerProfile.tsx today. Duplicating the shape here keeps this
// component self-contained without cross-page coupling.
interface MatchVoting {
  id: string;
  gameTitle: string;
  gameDate: any;
  isActive: boolean;
  votes: { voterId: string; voterName: string; playerId: string; playerName: string; reason?: string; timestamp: any }[];
  winner?: { playerId: string; playerName: string; voteCount: number };
  winners?: Array<{ playerId: string; playerName: string; voteCount: number }>;
  closedAt?: any;
}

interface Props {
  playerId: string;
  player: Player;
  seasonId: string;
  votingWins: MatchVoting[];
  votingNominations: MatchVoting[];
}

interface RecordTile {
  label: string;
  value: number;
  context?: string;
}

const PersonalRecords: React.FC<Props> = ({ playerId, player, seasonId, votingWins, votingNominations }) => {
  // null = still loading. Empty array = loaded, no rows. Downstream
  // memo relies on the null sentinel to hide the whole card during
  // the atomic-render window.
  const [gameStats, setGameStats] = useState<GameStat[] | null>(null);
  const { getStatsByPlayer } = useFirestore();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await getStatsByPlayer(playerId);
        // Synthetic rows we do NOT want in "most goals in a match":
        //  - clip_*  written by video clips (goal credit, not a match)
        //  - adjust_* written by coach stat corrections
        const clean = (rows as any[]).filter((r) => {
          const gid = String(r?.gameId || '');
          return !gid.startsWith('clip_') && !gid.startsWith('adjust_');
        }) as GameStat[];
        if (!cancelled) setGameStats(clean);
      } catch (err) {
        debug('PersonalRecords: failed to load stats', err);
        if (!cancelled) setGameStats([]);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [playerId, getStatsByPlayer]);

  const records = useMemo<RecordTile[]>(() => {
    if (!gameStats) return [];

    // Season scope: reuse the parent card's seasonId. 'lifetime' or
    // empty means no filter. For legacy rows without seasonId we
    // include them as best-effort (task spec) so the card still shows
    // records for a coach mid-migration.
    const isScoped = !!seasonId && seasonId !== 'lifetime';
    const scoped = isScoped
      ? gameStats.filter((r: any) => {
          if (r?.seasonId) return r.seasonId === seasonId;
          return true;
        })
      : gameStats;

    const contextFor = (row: any): string => {
      const opp = (row?.opponent || '').trim();
      const when = shortDate(toMillis(row?.gameDate));
      if (opp && when) return `vs ${opp} · ${when}`;
      if (opp) return `vs ${opp}`;
      return when;
    };

    // --- Match-high records over the scoped stat rows.
    const rowsWithGoals = scoped.filter((r) => (r.goals || 0) > 0);
    const bestGoalsRow = rowsWithGoals.length
      ? rowsWithGoals.reduce((best, r) => (r.goals > best.goals ? r : best))
      : null;

    const rowsWithAssists = scoped.filter((r) => (r.assists || 0) > 0);
    const bestAssistsRow = rowsWithAssists.length
      ? rowsWithAssists.reduce((best, r) => (r.assists > best.assists ? r : best))
      : null;

    // Only surface the saves record if the kid has ever recorded a
    // save. Field players sitting at 0 across every match should
    // never see a "Most saves" tile at all.
    const rowsWithSaves = scoped.filter((r) => (r.saves || 0) > 0);
    const bestSavesRow = rowsWithSaves.length
      ? rowsWithSaves.reduce((best, r) => ((r.saves || 0) > (best.saves || 0) ? r : best))
      : null;

    // --- Most POTM votes in a single match.
    let bestVotesCount = 0;
    let bestVotesTitle: string | undefined;
    for (const v of votingNominations || []) {
      const count = (v.votes || []).filter((x) => x?.playerId === playerId).length;
      if (count > bestVotesCount) {
        bestVotesCount = count;
        bestVotesTitle = v.gameTitle;
      }
    }

    // --- Longest scoring streak: consecutive matches with goals > 0.
    // Sort ascending so the running counter walks chronologically.
    let longestStreak = 0;
    if (scoped.length) {
      const chronological = [...scoped].sort(
        (a, b) => toMillis(a.gameDate) - toMillis(b.gameDate),
      );
      let running = 0;
      for (const r of chronological) {
        if ((r.goals || 0) > 0) {
          running += 1;
          if (running > longestStreak) longestStreak = running;
        } else {
          running = 0;
        }
      }
    }

    // --- Denormed on the player doc — no computation needed.
    const juggleBest = player?.juggles?.best ?? 0;
    const juggleBestAtMs = toMillis(player?.juggles?.bestAt);
    const streakDays = player?.currentStreakDays ?? 0;

    const tiles: RecordTile[] = [
      { label: 'Most goals in a match', value: bestGoalsRow?.goals ?? 0, context: bestGoalsRow ? contextFor(bestGoalsRow) : undefined },
      { label: 'Most assists in a match', value: bestAssistsRow?.assists ?? 0, context: bestAssistsRow ? contextFor(bestAssistsRow) : undefined },
    ];

    // Only push saves when there's real data (already guarded by the
    // rowsWithSaves check — bestSavesRow is null for field players).
    if (bestSavesRow) {
      tiles.push({ label: 'Most saves in a match', value: bestSavesRow.saves || 0, context: contextFor(bestSavesRow) });
    }

    tiles.push(
      { label: 'Most POTM votes', value: bestVotesCount, context: bestVotesTitle },
      { label: 'Career POTM wins', value: (votingWins || []).length },
      { label: 'Longest scoring streak', value: longestStreak },
      { label: 'Practice streak', value: streakDays, context: 'days' },
      { label: 'Juggles PB', value: juggleBest, context: juggleBestAtMs ? shortDate(juggleBestAtMs) : undefined },
    );

    // Silence beats zero-filler: drop any tile with no signal.
    return tiles.filter((t) => typeof t.value === 'number' && t.value > 0);
  }, [gameStats, votingWins, votingNominations, player, seasonId, playerId]);

  // Atomic render: nothing during load, fade the card in only once
  // we've decided there's something worth showing.
  if (gameStats === null) return null;
  if (records.length === 0) return null;

  return (
    <section className="relative overflow-hidden rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 animate-in fade-in duration-300">
      <div className="px-4 py-4 sm:px-5 sm:py-5">
        <div className="text-[10px] font-black tracking-[0.3em] uppercase text-ink-primary/60 mb-3">
          PERSONAL RECORDS
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
          {records.map((r) => (
            <div key={r.label} className="rounded-xl bg-surface-input px-3 py-3 flex flex-col">
              <div className="text-[10px] font-black tracking-[0.2em] uppercase text-ink-primary/55 truncate">
                {r.label}
              </div>
              <div className="text-2xl font-black text-ink-primary leading-none mt-1">
                {r.value}
              </div>
              {r.context && (
                <div className="text-[11px] text-ink-primary/55 mt-1 truncate">
                  {r.context}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default PersonalRecords;
