import React, { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useActiveSeason } from '../../hooks/useActiveSeason';
import {
  computeTeamRecords,
  filterStatsBySeason,
  leaderDelta,
  STAT_LABELS,
  type LeaderStat,
  type LeaderRow,
  type SingleGameRecord,
} from '../../utils/teamRecords';
import type { GameStat, Player } from '../../types';

type ScopeMode = 'current' | 'previous' | 'all';
type RecordsTab = 'season' | 'allTime';

interface Props {
  teamId: string;
  players: Player[];
}

const scopeLabel = (mode: ScopeMode): string =>
  mode === 'current' ? 'This season' :
  mode === 'previous' ? 'Last season' : 'All-time';

/**
 * Records section: the "hall of fame" at the top of the Stats page.
 * Three blocks: Season Leaders, Team Records (This Season / All-Time
 * tabs), and a scope toggle for the leaderboards.
 *
 * Data is `stats` rows across the team, fetched once and sliced
 * client-side into scopes. Fewer than 100 rows/season on average so
 * memory footprint is negligible; the alternative (a query per
 * scope) would trip Firestore's index-limit constraints on old
 * seasons.
 */
const TeamRecordsSection: React.FC<Props> = ({ teamId, players }) => {
  const { season: activeSeason } = useActiveSeason();
  const [statsRows, setStatsRows] = useState<GameStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<ScopeMode>('current');
  const [recordsTab, setRecordsTab] = useState<RecordsTab>('season');
  const [goalkeepersOnly, setGoalkeepersOnly] = useState(false);
  const [priorSeasonId, setPriorSeasonId] = useState<string | null>(null);

  // Fetch all stats rows for this team. Small (< 1000 rows/team even
  // for multi-year clubs) so a single collection query is cheaper
  // than orchestrating scoped queries.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const snap = await getDocs(
          query(collection(db, 'stats'), where('teamId', '==', teamId)),
        );
        if (cancelled) return;
        const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as GameStat[];
        setStatsRows(rows);
      } catch (err) {
        console.warn('[TeamRecords] fetch failed:', err);
        setStatsRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [teamId]);

  // Discover the prior season by looking at seasonIds present in the
  // fetched rows and picking the newest one that ISN'T the active
  // season. Handles the "no explicit archived seasons collection"
  // case — we treat data as the source of truth for what seasons
  // exist.
  useEffect(() => {
    const activeId = activeSeason?.id || null;
    const seasonIds = new Set<string>();
    statsRows.forEach((r) => {
      const s = (r as any).seasonId;
      if (typeof s === 'string' && s && s !== activeId) seasonIds.add(s);
    });
    if (seasonIds.size === 0) { setPriorSeasonId(null); return; }
    // Sort strings desc; season IDs are typically timestamped or
    // slugged with the year so lexical order approximates recency.
    const sorted = Array.from(seasonIds).sort().reverse();
    setPriorSeasonId(sorted[0] || null);
  }, [statsRows, activeSeason?.id]);

  const scopedRows = useMemo(() => {
    const currentId = activeSeason?.id || null;
    if (scope === 'all') return filterStatsBySeason(statsRows, null);
    if (scope === 'previous') return filterStatsBySeason(statsRows, priorSeasonId);
    return filterStatsBySeason(statsRows, currentId);
  }, [statsRows, scope, activeSeason?.id, priorSeasonId]);

  const priorRows = useMemo(() => {
    if (scope !== 'current' || !priorSeasonId) return null;
    return filterStatsBySeason(statsRows, priorSeasonId);
  }, [statsRows, scope, priorSeasonId]);

  const result = useMemo(
    () => computeTeamRecords(scopedRows, players, { goalkeepersOnly }),
    [scopedRows, players, goalkeepersOnly],
  );
  const priorResult = useMemo(
    () => priorRows
      ? computeTeamRecords(priorRows, players, { goalkeepersOnly })
      : null,
    [priorRows, players, goalkeepersOnly],
  );

  // Team-Records tab pins to whichever scope is active. "All-time"
  // tab always pulls the whole row set regardless of top-level scope.
  const teamRecordsRows = useMemo(
    () => recordsTab === 'allTime'
      ? filterStatsBySeason(statsRows, null)
      : scopedRows,
    [statsRows, scopedRows, recordsTab],
  );
  const teamRecordsResult = useMemo(
    () => computeTeamRecords(teamRecordsRows, players, { goalkeepersOnly }),
    [teamRecordsRows, players, goalkeepersOnly],
  );

  if (loading) {
    return (
      <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 p-4 sm:p-6 mb-4">
        <div className="text-sm text-ink-primary/50 text-center py-6">Loading records…</div>
      </section>
    );
  }

  if (statsRows.length === 0) {
    return (
      <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 p-4 sm:p-6 mb-4">
        <div className="text-center py-6">
          <div className="text-xs font-extrabold tracking-widest uppercase text-brand-primary-soft mb-1">Records</div>
          <p className="text-sm font-bold text-ink-primary">No records yet.</p>
          <p className="text-xs text-ink-primary/60 mt-1">Play a game, hit End Game, and this fills in.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 p-4 sm:p-6 mb-4">
      {/* Header + scope toggle */}
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <div className="flex items-baseline gap-2">
          <div className="text-xs font-extrabold tracking-widest uppercase text-brand-primary-soft">Records</div>
          <div className="text-[10px] font-bold text-ink-primary/50">
            {result.gamesCounted} game{result.gamesCounted === 1 ? '' : 's'}
          </div>
        </div>
        <div className="flex items-center gap-1 bg-line-default/5 rounded-full p-0.5 ring-1 ring-line-default/10">
          {(['current', 'previous', 'all'] as ScopeMode[]).map((m) => {
            const enabled = m === 'current' || m === 'all' || priorSeasonId;
            return (
              <button
                key={m}
                type="button"
                disabled={!enabled}
                onClick={() => setScope(m)}
                className={`text-[10px] font-extrabold uppercase tracking-widest px-2.5 py-1 rounded-full transition ${
                  scope === m
                    ? 'bg-brand-primary text-white'
                    : enabled
                      ? 'text-ink-primary/65 hover:bg-line-default/10'
                      : 'text-ink-primary/25 cursor-not-allowed'
                }`}
                title={!enabled ? 'No prior season data on file' : undefined}
              >
                {scopeLabel(m)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Block 1 — Season Leaders */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-black text-ink-primary">
            {scope === 'current' ? 'Season leaders' : `${scopeLabel(scope)} leaders`}
          </h3>
          <button
            type="button"
            onClick={() => setGoalkeepersOnly((v) => !v)}
            className={`text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded-full ring-1 transition ${
              goalkeepersOnly
                ? 'bg-brand-primary text-white ring-brand-primary/60'
                : 'bg-line-default/5 text-ink-primary/60 ring-line-default/15 hover:bg-line-default/10'
            }`}
            title="Filter Saves to players whose primary position is Goalkeeper"
          >
            🧤 {goalkeepersOnly ? 'GK only' : 'GK filter'}
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <LeaderCard title="Goals" statKey="goals" rows={result.leaders.goals} deltas={priorResult ? leaderDelta(result.leaders.goals, priorResult.leaders.goals) : null} />
          <LeaderCard title="Assists" statKey="assists" rows={result.leaders.assists} deltas={priorResult ? leaderDelta(result.leaders.assists, priorResult.leaders.assists) : null} />
          <LeaderCard title={`Saves${goalkeepersOnly ? ' (GK)' : ''}`} statKey="saves" rows={result.leaders.saves} deltas={priorResult ? leaderDelta(result.leaders.saves, priorResult.leaders.saves) : null} />
          <LeaderCard title="Cards" statKey="yellowCards" rows={mergeCards(result.leaders.yellowCards, result.leaders.redCards)} deltas={null} />
        </div>
      </div>

      {/* Block 2 — Team Records with This Season / All-Time tabs */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-black text-ink-primary">Team records</h3>
          <div className="flex items-center gap-1 bg-line-default/5 rounded-full p-0.5 ring-1 ring-line-default/10">
            {(['season', 'allTime'] as RecordsTab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setRecordsTab(t)}
                className={`text-[10px] font-extrabold uppercase tracking-widest px-2.5 py-1 rounded-full transition ${
                  recordsTab === t ? 'bg-brand-primary text-white' : 'text-ink-primary/65 hover:bg-line-default/10'
                }`}
              >
                {t === 'season' ? 'This Season' : 'All-Time'}
              </button>
            ))}
          </div>
        </div>
        <div className="rounded-xl bg-line-default/[0.04] ring-1 ring-line-default/10 divide-y divide-line-default/5">
          {(['goals', 'saves', 'assists', 'yellowCards', 'redCards'] as LeaderStat[]).map((stat) => (
            <RecordRow key={stat} record={teamRecordsResult.singleGame[stat]} stat={stat} />
          ))}
        </div>
        {teamRecordsResult.gamesCounted === 0 && (
          <p className="text-xs text-ink-primary/50 mt-2 text-center">
            {recordsTab === 'allTime' ? 'No games on record.' : 'No games this season yet.'}
          </p>
        )}
      </div>
    </section>
  );
};

// ─────────────────────────────────────────────────────────────
// LeaderCard — one stat's top-N. Renders a compact ranked list.
// Deltas (when present) sit next to each player as tiny badges.
// ─────────────────────────────────────────────────────────────
const LeaderCard: React.FC<{
  title: string;
  statKey: LeaderStat;
  rows: LeaderRow[];
  deltas: Map<string, number> | null;
}> = ({ title, statKey, rows, deltas }) => {
  const icon = STAT_LABELS[statKey]?.icon;
  return (
    <div className="rounded-xl bg-line-default/[0.04] ring-1 ring-line-default/10 p-3">
      <div className="text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/60 mb-2 flex items-center gap-1">
        <span>{icon}</span>
        <span>{title}</span>
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-ink-primary/40 py-2">No entries yet.</div>
      ) : (
        <ol className="space-y-1.5">
          {rows.map((r, idx) => {
            const delta = deltas?.get(r.playerId);
            return (
              <li key={r.playerId} className="flex items-center gap-2 text-sm">
                <span className="text-[10px] font-black text-ink-primary/40 w-4 tabular-nums">{idx + 1}.</span>
                <span className="flex-1 truncate font-bold text-ink-primary">{r.playerName}</span>
                {typeof delta === 'number' && delta !== 0 && (
                  <span
                    className={`text-[9px] font-extrabold tabular-nums px-1 rounded ${
                      delta > 0 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'
                    }`}
                    title={`${delta > 0 ? '+' : ''}${delta} vs prior scope`}
                  >
                    {delta > 0 ? '▲' : '▼'}{Math.abs(delta)}
                  </span>
                )}
                <span className="font-black text-ink-primary tabular-nums">{r.total}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// RecordRow — one single-game record line. Hidden when there's
// no record yet (empty stat kind).
// ─────────────────────────────────────────────────────────────
const RecordRow: React.FC<{ record: SingleGameRecord | null; stat: LeaderStat }> = ({ record, stat }) => {
  if (!record) return null;
  const label = STAT_LABELS[stat].plural.toLowerCase();
  const date = record.gameDate ? new Date(record.gameDate) : null;
  const dateStr = date && !isNaN(date.getTime()) ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-bold text-ink-primary/55 uppercase tracking-wider">
          Most {label} in a game
        </div>
        <div className="text-sm font-bold text-ink-primary truncate">
          {record.playerName}
          <span className="text-ink-primary/50 font-medium"> vs {record.opponent}{dateStr ? ` · ${dateStr}` : ''}</span>
        </div>
      </div>
      <div className="text-2xl font-black text-brand-primary tabular-nums flex-shrink-0">
        {record.value}
      </div>
    </div>
  );
};

// Merge yellow+red into a single "Cards" leaderboard by summing per
// player. Cards are rare enough that separate leaderboards would be
// mostly empty; the combined view is more useful.
function mergeCards(yellow: LeaderRow[], red: LeaderRow[]): LeaderRow[] {
  const map = new Map<string, LeaderRow>();
  [...yellow, ...red].forEach((r) => {
    const prev = map.get(r.playerId);
    if (prev) {
      map.set(r.playerId, { ...prev, total: prev.total + r.total });
    } else {
      map.set(r.playerId, { ...r });
    }
  });
  return Array.from(map.values()).sort((a, b) => b.total - a.total).slice(0, 5);
}

export default TeamRecordsSection;
