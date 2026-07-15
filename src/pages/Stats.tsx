import React, { useState, useEffect } from 'react';
import { Player } from '../types';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { isCoachOfTeam } from '../utils/helpers';
import Header from '../components/common/Header';
import AppIcon from '../components/common/AppIcon';
import { VOCAB } from '../vocab';
import StatsTracker from '../components/stats/StatsTracker';
import StatsDisplay from '../components/stats/StatsDisplay';
import TeamRecordsSection from '../components/stats/TeamRecordsSection';
import { useActiveSeason } from '../hooks/useActiveSeason';
import { getPlayerStats, getPlayerLifetimeStats } from '../utils/seasons';
import { debug } from '../utils/debug';

type SortKey = 'goals' | 'assists' | 'saves' | 'gamesPlayed';

const Stats: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const { getPlayersByTeam, getTeamPlayerStatsMap, getPlayerMediaByTeam, addGameStat, updatePlayerStats } = useFirestore();
  const [players, setPlayers] = useState<Player[]>([]);
  // 2026-07-14: keep BOTH scopes' aggregates around so the
  // This Season / Overall toggle actually shows different numbers.
  // Prior to this change, the toggle silently rendered the same
  // team-lifetime numbers because getPlayerStats(player, seasonId)
  // fell back to player.stats (statsBySeasonId is unwritten in prod).
  const [seasonStatsMap, setSeasonStatsMap] = useState<Record<string, Player['stats']>>({});
  const [lifetimeStatsMap, setLifetimeStatsMap] = useState<Record<string, Player['stats']>>({});
  const [mediaCount, setMediaCount] = useState(0);
  const [isStatsTrackerOpen, setIsStatsTrackerOpen] = useState(false);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'overview' | 'track'>('overview');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [adjustingPlayerId, setAdjustingPlayerId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>('goals');

  const isUserCoach = isCoachOfTeam(userData, selectedTeam);
  const { season: activeSeason } = useActiveSeason();
  const [statsScope, setStatsScope] = useState<'current' | 'lifetime'>('current');

  useEffect(() => {
    const loadPlayers = async () => {
      if (!selectedTeamId) {
        setIsLoading(false);
        return;
      }
      
      try {
        setIsLoading(true);
        setLoadError(null);
        debug('Loading players for stats page...');
        
        // Fetch player list + BOTH stat aggregates. The season-scoped
        // map drives "This Season" (statsScope === 'current') and the
        // team-lifetime map drives "Overall". Both are cheap client-
        // side filters of the same underlying stats/ collection query
        // (see getTeamPlayerStatsMap).
        const [teamPlayers, seasonMap, lifetimeMap] = await Promise.all([
          getPlayersByTeam(selectedTeamId),
          getTeamPlayerStatsMap(selectedTeamId, activeSeason?.id || null).catch(() => ({} as any)),
          getTeamPlayerStatsMap(selectedTeamId).catch(() => ({} as any)),
        ]);
        setSeasonStatsMap(seasonMap as any);
        setLifetimeStatsMap(lifetimeMap as any);
        const playersWithDates = teamPlayers.map((player: any) => {
          const empty = { gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0, saves: 0, cleanSheets: 0 };
          const isShared = Array.isArray(player.teamIds) && player.teamIds.length > 1;
          // Keep player.stats as team-lifetime for backwards compat
          // with any consumers of `players` that read .stats directly
          // (e.g. TeamRecordsSection card summaries). Scope-specific
          // reads go through statsFor() which selects from the two
          // maps above.
          const stats = (lifetimeMap as any)[player.id] || (isShared ? empty : (player.stats || empty));
          return {
            ...player,
            createdAt: player.createdAt?.toDate ? player.createdAt.toDate() : new Date(player.createdAt),
            stats,
          };
        }) as Player[];
        
        debug('Players loaded for stats:', playersWithDates);
        setPlayers(playersWithDates);
        // Background-fetch media count for the "Clips" tile — silent
        // failure if the user can't read it, the tile just shows 0.
        getPlayerMediaByTeam(selectedTeamId)
          .then((media: any[]) => setMediaCount(Array.isArray(media) ? media.length : 0))
          .catch(() => setMediaCount(0));
      } catch (error: any) {
        console.error('Error loading players for stats:', error);
        
        if (error.message?.includes('index')) {
          setLoadError('Database indexes are being created. This may take a few minutes. Please try refreshing the page.');
        } else {
          setLoadError('Unable to load player data. Please try again.');
        }
        
        // Set empty array so the page doesn't crash
        setPlayers([]);
      } finally {
        setIsLoading(false);
      }
    };

    loadPlayers();
  }, [selectedTeamId, activeSeason?.id, getPlayersByTeam, getTeamPlayerStatsMap]);

  // Update players list when stats are recorded
  const handleStatsRecorded = () => {
    // Reload players AND both stat scopes so the toggle stays accurate.
    if (selectedTeamId) {
      Promise.all([
        getPlayersByTeam(selectedTeamId),
        getTeamPlayerStatsMap(selectedTeamId, activeSeason?.id || null).catch(() => ({} as any)),
        getTeamPlayerStatsMap(selectedTeamId).catch(() => ({} as any)),
      ]).then(([teamPlayers, seasonMap, lifetimeMap]: any) => {
        setSeasonStatsMap(seasonMap as any);
        setLifetimeStatsMap(lifetimeMap as any);
        const playersWithDates = (teamPlayers as any[]).map((player: any) => {
          const empty = { gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0, saves: 0, cleanSheets: 0 };
          const isShared = Array.isArray(player.teamIds) && player.teamIds.length > 1;
          const stats = (lifetimeMap as any)[player.id] || (isShared ? empty : (player.stats || empty));
          return {
            ...player,
            createdAt: player.createdAt?.toDate ? player.createdAt.toDate() : new Date(player.createdAt),
            stats,
          };
        }) as Player[];
        setPlayers(playersWithDates);
      }).catch(error => {
        console.error('Error reloading players:', error);
      });
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-primary mx-auto mb-4"></div>
          <p className="text-ink-primary/65">Loading team statistics...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-base">
      <Header title={VOCAB.teamPulse} subtitle="Who's playing, scoring, and showing up." />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 space-y-3">
        {loadError && (
          <div className="bg-amber-500/15 border border-amber-400/30 rounded-xl p-3 flex items-start gap-2.5">
            <svg className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <div className="flex-1">
              <p className="text-sm font-bold text-amber-100">Loading issue</p>
              <p className="text-xs text-amber-200 mt-0.5">{loadError}</p>
              <button
                onClick={() => window.location.reload()}
                className="mt-2 text-[11px] font-extrabold tracking-widest uppercase px-2 py-1 rounded bg-amber-500/20 text-amber-100 hover:bg-amber-200"
              >Refresh</button>
            </div>
          </div>
        )}

        {/* Records section — top of Stats page. Season leaders + team
            single-game records with This Season / All-Time tabs. */}
        {selectedTeamId && <TeamRecordsSection teamId={selectedTeamId} players={players} />}

        {/* Tab Navigation */}
        <div className="bg-surface-elevated rounded-xl border border-line-default/10 shadow-sm">
          <div className="border-b border-line-default/5">
            <nav className="flex gap-1 px-3 pt-2">
              <button
                onClick={() => setActiveTab('overview')}
                className={`px-3 py-2 rounded-t-md text-[11px] font-extrabold tracking-widest uppercase border-b-2 transition-colors ${
                  activeTab === 'overview'
                    ? 'border-brand-primary text-brand-primary-soft'
                    : 'border-transparent text-ink-primary/50 hover:text-ink-primary/90'
                }`}
              >
                Overview
              </button>

              {isUserCoach && (
                <button
                  onClick={() => setActiveTab('track')}
                  className={`px-3 py-2 rounded-t-md text-[11px] font-extrabold tracking-widest uppercase border-b-2 transition-colors ${
                    activeTab === 'track'
                      ? 'border-brand-primary text-brand-primary-soft'
                      : 'border-transparent text-ink-primary/50 hover:text-ink-primary/90'
                  }`}
                >
                  Track
                </button>
              )}
            </nav>
          </div>

          {/* Tab Content */}
          <div className="p-4">
            {activeTab === 'overview' ? (
              <StatsOverview
                players={players}
                mediaCount={mediaCount}
                activeSeason={activeSeason}
                statsScope={statsScope}
                setStatsScope={setStatsScope}
                seasonStatsMap={seasonStatsMap}
                lifetimeStatsMap={lifetimeStatsMap}
                sortBy={sortBy}
                setSortBy={setSortBy}
                loadError={loadError}
                selectedPlayerId={selectedPlayerId}
                setSelectedPlayerId={setSelectedPlayerId}
              />
            ) : (
              /* Track Stats (Coach Only) */
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-ink-primary">Record Player Statistics</h3>
                    <p className="text-sm text-ink-primary/65">
                      Track goals, assists, saves, and key plays during games
                    </p>
                  </div>
                  
                  <button
                    onClick={() => setIsStatsTrackerOpen(true)}
                    disabled={players.length === 0}
                    className="bg-brand-primary hover:bg-brand-primary text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    <span>Record Stats</span>
                  </button>
                </div>

                {players.length === 0 ? (
                  <div className="text-center py-12">
                    <div className="text-ink-primary/40 mb-4">
                      <svg className="mx-auto h-16 w-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                      </svg>
                    </div>
                    <h3 className="text-lg font-medium text-ink-primary mb-2">No squad yet</h3>
                    <p className="text-ink-primary/65 mb-4">
                      Build your squad first. Stats follow once players are in.
                    </p>
                    <button
                      onClick={() => window.location.href = '/players'}
                      className="bg-brand-primary hover:bg-brand-primary text-white font-medium py-2 px-4 rounded-lg transition duration-200"
                    >
                      Build Your Squad
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {players.map(player => (
                      <div
                        key={player.id}
                        className="bg-surface-elevated border border-line-default/10 rounded-lg p-4 hover:border-brand-primary-soft/40 hover:shadow-md transition-all duration-200"
                      >
                        <div
                          onClick={() => {
                            setSelectedPlayerId(player.id);
                            setIsStatsTrackerOpen(true);
                          }}
                          className="cursor-pointer"
                        >
                          <div className="flex items-center space-x-3 mb-3">
                            <div className="bg-brand-primary/15 rounded-full w-12 h-12 flex items-center justify-center">
                              <span className="text-lg font-bold text-brand-primary">#{player.jerseyNumber}</span>
                            </div>
                            <div>
                              <h4 className="font-semibold text-ink-primary">{player.name}</h4>
                              <p className="text-sm text-ink-primary/65">{player.position}</p>
                            </div>
                          </div>

                          {(() => {
                            // 2026-07-14: read from the pre-computed
                            // scoped maps instead of getPlayerStats/
                            // getPlayerLifetimeStats. The old helpers
                            // fell back to player.stats (unwritten
                            // statsBySeasonId), so both toggle states
                            // rendered identical numbers.
                            const empty = { gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0, saves: 0, cleanSheets: 0 };
                            const s = statsScope === 'lifetime'
                              ? (lifetimeStatsMap[player.id] || empty)
                              : (seasonStatsMap[player.id] || empty);
                            return (
                              <div className="grid grid-cols-3 gap-2 text-center">
                                <div>
                                  <div className="text-lg font-bold text-brand-primary">{s.goals || 0}</div>
                                  <div className="text-xs text-ink-primary/65">Goals</div>
                                </div>
                                <div>
                                  <div className="text-lg font-bold text-emerald-600">{s.assists || 0}</div>
                                  <div className="text-xs text-ink-primary/65">Assists</div>
                                </div>
                                <div>
                                  <div className="text-lg font-bold text-ink-primary/85">{s.saves || 0}</div>
                                  <div className="text-xs text-ink-primary/65">Saves</div>
                                </div>
                              </div>
                            );
                          })()}
                        </div>

                        <div className="mt-3 pt-3 border-t border-line-default/10 flex items-center justify-between gap-2">
                          <button
                            onClick={() => {
                              setSelectedPlayerId(player.id);
                              setIsStatsTrackerOpen(true);
                            }}
                            className="flex-1 inline-flex items-center justify-center text-brand-primary text-sm font-medium hover:text-brand-primary-soft"
                          >
                            <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                            Record
                          </button>
                          <button
                            onClick={() => setAdjustingPlayerId(player.id)}
                            className="flex-1 inline-flex items-center justify-center text-ink-primary/85 text-sm font-medium hover:text-charcoal-800"
                            title="Fix a stat mistake"
                          >
                            <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                            Fix
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Stats Tracker Modal */}
        {players.length > 0 && (
          <StatsTracker
            isOpen={isStatsTrackerOpen}
            onClose={() => {
              setIsStatsTrackerOpen(false);
              setSelectedPlayerId('');
              handleStatsRecorded();
            }}
            players={players}
            initialPlayerId={selectedPlayerId}
            onStatsRecorded={(stats) => {
              console.log('Stats recorded:', stats);
              handleStatsRecorded();
            }}
          />
        )}

        {/* Adjust (fix) stats modal */}
        {adjustingPlayerId && (
          <AdjustStatsModal
            player={players.find(p => p.id === adjustingPlayerId)!}
            teamId={selectedTeamId}
            onClose={() => setAdjustingPlayerId(null)}
            onSave={async (next) => {
              const player = players.find(p => p.id === adjustingPlayerId);
              if (!player || !selectedTeamId) return;
              const cur = player.stats || { gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0, saves: 0, cleanSheets: 0 };
              const delta = {
                gamesPlayed: (next.gamesPlayed || 0) - (cur.gamesPlayed || 0),
                goals:       (next.goals       || 0) - (cur.goals       || 0),
                assists:     (next.assists     || 0) - (cur.assists     || 0),
                saves:       (next.saves       || 0) - (cur.saves       || 0),
                yellowCards: (next.yellowCards || 0) - (cur.yellowCards || 0),
                redCards:    (next.redCards    || 0) - (cur.redCards    || 0),
              };
              const hasChange = Object.values(delta).some(v => v !== 0);
              if (!hasChange) {
                // 2026-07-14: was silently closing. If the coach hit
                // Save but the numbers matched what's already stored
                // (visual bug on the input meant they thought they
                // had changed values but hadn't), the modal just
                // closed and looked broken. Now tells them.
                alert('No changes to save — the numbers match what\'s already on this player.');
                return;
              }
              try {
                // Write a correction record so the per-team aggregator picks
                // up the change for shared players. The 'adjust_' gameId
                // prefix tells the aggregator to apply gamesPlayed as a
                // delta rather than +1.
                const { withSeasonId } = await import('../utils/seasons');
                const adjustPayload = await withSeasonId({
                  playerId: player.id,
                  playerName: player.name,
                  gameId: `adjust_${Date.now()}_${player.id}`,
                  gameDate: new Date(),
                  opponent: 'Manual correction',
                  minutesPlayed: 0,
                  goals: delta.goals,
                  assists: delta.assists,
                  yellowCards: delta.yellowCards,
                  redCards: delta.redCards,
                  saves: delta.saves,
                  gamesPlayed: delta.gamesPlayed,
                  recordedBy: userData?.uid,
                  recordedByName: userData?.name || 'Coach',
                  teamId: selectedTeamId,
                  isCorrection: true,
                });
                await addGameStat(adjustPayload as any);
                // Also update the global aggregate for non-shared players /
                // legacy displays. For shared players this is a best-effort
                // mirror; team-scoped views will use the correction record.
                const isShared = Array.isArray((player as any).teamIds) && (player as any).teamIds.length > 1;
                if (!isShared) {
                  await updatePlayerStats(player.id, next as any);
                }
              } catch (err) {
                console.error('Failed to save stat correction:', err);
                alert('Failed to save correction. Check console.');
              } finally {
                setAdjustingPlayerId(null);
                handleStatsRecorded();
              }
            }}
          />
        )}
      </div>
    </div>
  );
};

// ── Stats Overview (Players / Goals / Games / Clips + Top
//     Performers + sortable table) ──────────────────────────────
interface StatsOverviewProps {
  players: Player[];
  mediaCount: number;
  activeSeason: any;
  statsScope: 'current' | 'lifetime';
  setStatsScope: (s: 'current' | 'lifetime') => void;
  seasonStatsMap: Record<string, Player['stats']>;
  lifetimeStatsMap: Record<string, Player['stats']>;
  sortBy: SortKey;
  setSortBy: (s: SortKey) => void;
  loadError: string | null;
  selectedPlayerId: string;
  setSelectedPlayerId: (id: string) => void;
}

const StatsOverview: React.FC<StatsOverviewProps> = ({
  players, mediaCount, activeSeason, statsScope, setStatsScope, seasonStatsMap, lifetimeStatsMap, sortBy, setSortBy, loadError, selectedPlayerId, setSelectedPlayerId,
}) => {
  // Resolve stats per player given the current scope toggle.
  // 2026-07-14: switched off the getPlayerStats/getLifetimeStats
  // helpers because both fall back to player.stats (statsBySeasonId
  // is unwritten in prod). The parent now hands us pre-computed
  // per-scope maps, and the toggle actually differs across scopes.
  const empty = { gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0, saves: 0, cleanSheets: 0 };
  const statsFor = (p: Player) =>
    statsScope === 'lifetime'
      ? (lifetimeStatsMap[p.id] || empty)
      : (seasonStatsMap[p.id] || empty);

  // Aggregate counts for the quick-stat tiles.
  const totalGoals = players.reduce((sum, p) => sum + (statsFor(p).goals || 0), 0);
  const totalGames = players.reduce((max, p) => Math.max(max, statsFor(p).gamesPlayed || 0), 0);

  // Top performer per category. Ties are broken alphabetically so the
  // card doesn't flicker between names with the same value.
  const topBy = (key: SortKey) => {
    const ranked = [...players]
      .map(p => ({ p, v: (statsFor(p) as any)[key] || 0 }))
      .filter(x => x.v > 0)
      .sort((a, b) => b.v - a.v || a.p.name.localeCompare(b.p.name));
    return ranked[0] || null;
  };
  const topScorer = topBy('goals');
  const topAssister = topBy('assists');
  const topSaver = topBy('saves');

  // Sorted table rows. Always include all players (even with 0s) so
  // parents can find their kid and so the count under PLAYER feels
  // honest. Stable-sorted alphabetically as the tiebreaker.
  const sortedRows = [...players]
    .map(p => {
      const s = statsFor(p);
      return {
        p,
        goals: s.goals || 0,
        assists: s.assists || 0,
        saves: s.saves || 0,
        gamesPlayed: s.gamesPlayed || 0,
      };
    })
    .sort((a, b) => (b as any)[sortBy] - (a as any)[sortBy] || a.p.name.localeCompare(b.p.name));

  const maxFor = (k: SortKey) => Math.max(1, ...sortedRows.map(r => (r as any)[k] || 0));
  const maxGoals = maxFor('goals');
  const maxAssists = maxFor('assists');
  const maxSaves = maxFor('saves');

  return (
    <div className="space-y-6">
      {/* Scope + per-player filter (for parents) */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-ink-primary">Team Performance</h3>
          <p className="text-sm text-ink-primary/65">Players, goals, games, and clips at a glance.</p>
        </div>
        <div className="flex items-center gap-2">
          {activeSeason && (
            <div className="inline-flex items-center rounded-full bg-line-default/[0.08] ring-1 ring-line-default/10 p-0.5">
              <button
                onClick={() => setStatsScope('current')}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider transition ${
                  statsScope === 'current' ? 'bg-brand-primary text-white shadow-sm' : 'text-ink-primary/65 hover:text-ink-primary'
                }`}
              >
                This Season
              </button>
              <button
                onClick={() => setStatsScope('lifetime')}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider transition ${
                  statsScope === 'lifetime' ? 'bg-brand-primary text-white shadow-sm' : 'text-ink-primary/65 hover:text-ink-primary'
                }`}
              >
                Overall
              </button>
            </div>
          )}
          {players.length > 0 && (
            <select
              value={selectedPlayerId}
              onChange={(e) => setSelectedPlayerId(e.target.value)}
              className="px-3 py-2 border border-line-default/15 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
              style={{ fontSize: '16px' }}
              title="Drill into one player's full breakdown"
            >
              <option value="">All players</option>
              {players.map(player => (
                <option key={player.id} value={player.id}>
                  #{player.jerseyNumber} — {player.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {players.length === 0 && !loadError ? (
        <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 text-center py-12">
          <div className="text-ink-primary/40 mb-3 flex justify-center">
            <AppIcon name="players" className="w-12 h-12" />
          </div>
          <h3 className="text-lg font-medium text-ink-primary mb-1">Squad's empty</h3>
          <p className="text-ink-primary/65 mb-4">Build the squad first. Stats come once players are in.</p>
          <button
            onClick={() => window.location.href = '/players'}
            className="bg-brand-primary hover:bg-brand-primary text-white font-medium py-2 px-4 rounded-lg transition"
          >
            Add Players
          </button>
        </div>
      ) : selectedPlayerId ? (
        /* Drill-down: show the existing detailed StatsDisplay for one
           kid. Parents land here when they pick their own player. */
        <StatsDisplay
          players={players}
          selectedPlayerId={selectedPlayerId}
          showGameDetails={true}
        />
      ) : (
        <>
          {/* Quick stats row — 4 tiles. Brand-tinted (no purple/orange) */}
          <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 p-3 sm:p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <QuickStat icon="players" tint="cyan" value={players.length} label="Players" />
              <QuickStat icon="soccer" tint="emerald" value={totalGoals} label="Goals" />
              <QuickStat icon="trophy" tint="navy" value={totalGames} label="Games" />
              <QuickStat icon="film" tint="fire" value={mediaCount} label="Clips" />
            </div>
          </div>

          {/* Top Performers */}
          <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 p-4 sm:p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base sm:text-lg font-bold text-ink-primary">Top Performers</h3>
            </div>
            {topScorer || topAssister || topSaver ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {topScorer && (
                  <PerformerCard rank={1} player={topScorer.p} value={topScorer.v} statLabel="Top Scorer" statName="goals" />
                )}
                {topAssister && (
                  <PerformerCard rank={2} player={topAssister.p} value={topAssister.v} statLabel="Top Assister" statName="assists" />
                )}
                {topSaver && (
                  <PerformerCard rank={3} player={topSaver.p} value={topSaver.v} statLabel="Top Saver" statName="saves" />
                )}
              </div>
            ) : (
              <p className="text-sm text-ink-primary/50 text-center py-6">No stats recorded yet — record some goals and assists to populate this.</p>
            )}
          </div>

          {/* All Players Stats — sortable */}
          <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 overflow-hidden">
            <div className="px-4 sm:px-5 py-4 flex items-center justify-between gap-3">
              <h3 className="text-base sm:text-lg font-bold text-ink-primary">All Players Stats</h3>
              <label className="inline-flex items-center gap-2 text-xs text-ink-primary/50">
                <span className="font-semibold uppercase tracking-wide">Sort by</span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortKey)}
                  className="px-2 py-1 bg-surface-input text-ink-primary border border-line-default/20 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                  style={{ fontSize: '16px' }}
                >
                  <option value="goals">Goals</option>
                  <option value="assists">Assists</option>
                  <option value="saves">Saves</option>
                  <option value="gamesPlayed">Apps</option>
                </select>
              </label>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-line-default/[0.04] border-y border-line-default/10">
                  <tr className="text-[11px] uppercase tracking-wider text-ink-primary/50">
                    <th className="text-left font-semibold py-2.5 pl-4 sm:pl-5 pr-2 w-8">#</th>
                    <th className="text-left font-semibold py-2.5 pr-2">Player</th>
                    <th className={`text-center font-semibold py-2.5 px-2 w-12 ${sortBy==='goals' ? 'text-emerald-300' : ''}`}>G</th>
                    <th className={`text-center font-semibold py-2.5 px-2 w-12 ${sortBy==='assists' ? 'text-brand-primary-soft' : ''}`}>A</th>
                    <th className={`text-center font-semibold py-2.5 px-2 w-16 ${sortBy==='saves' ? 'text-ink-primary/85' : ''}`}>Saves</th>
                    <th className={`text-center font-semibold py-2.5 px-2 w-12 ${sortBy==='gamesPlayed' ? 'text-ink-primary/85' : ''}`}>Apps</th>
                    <th className="py-2.5 w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-default/5">
                  {sortedRows.map((row, idx) => (
                    <tr key={row.p.id} className="hover:bg-line-default/[0.05] transition">
                      <td className="py-3 pl-4 sm:pl-5 pr-2 text-ink-primary/40 text-xs font-semibold">{idx + 1}</td>
                      <td className="py-3 pr-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <PlayerAvatar player={row.p} />
                          <div className="min-w-0">
                            <p className="font-semibold text-ink-primary truncate">{row.p.name}</p>
                            <p className="text-xs text-ink-primary/50 truncate">
                              {row.p.jerseyNumber != null ? `#${row.p.jerseyNumber} · ` : ''}{row.p.position || 'Player'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <StatCell value={row.goals} max={maxGoals} color="emerald" />
                      <StatCell value={row.assists} max={maxAssists} color="cyan" />
                      <StatCell value={row.saves} max={maxSaves} color="navy" />
                      <td className="py-3 px-2 text-center text-ink-primary/85 font-semibold">{row.gamesPlayed}</td>
                      <td className="py-3 pr-3 text-right">
                        <a href={`/player/${row.p.id}`} className="text-ink-primary/35 hover:text-brand-primary">
                          <AppIcon name="arrow-right" className="w-4 h-4 inline" />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 sm:px-5 py-3 border-t border-line-default/5 bg-line-default/[0.04] flex items-center justify-between text-sm">
              <span className="inline-flex items-center gap-2 text-ink-primary/65">
                <AppIcon name="stats" className="w-4 h-4 text-brand-primary-soft" />
                <span>View full breakdown for any player</span>
              </span>
              <button
                onClick={() => setSelectedPlayerId(players[0]?.id || '')}
                disabled={players.length === 0}
                className="inline-flex items-center gap-1 text-brand-primary-soft hover:text-brand-primary-soft font-semibold disabled:opacity-50"
              >
                <span>Detailed Stats</span>
                <AppIcon name="arrow-right" className="w-4 h-4" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const TINT: Record<string, { box: string; icon: string; value: string }> = {
  cyan:    { box: 'bg-brand-primary/15',           icon: 'text-brand-primary-soft',    value: 'text-brand-primary-soft'    },
  emerald: { box: 'bg-emerald-500/15',        icon: 'text-emerald-300', value: 'text-emerald-300' },
  navy:    { box: 'bg-surface-raised/10',       icon: 'text-ink-primary/85',    value: 'text-ink-primary/85'    },
  fire:    { box: 'bg-brand-primary/15',           icon: 'text-ink-primary/85',    value: 'text-ink-primary/85'    },
};

const QuickStat: React.FC<{ icon: any; tint: 'cyan' | 'emerald' | 'navy' | 'fire'; value: number; label: string }> = ({
  icon, tint, value, label,
}) => {
  const t = TINT[tint];
  return (
    <div className="flex items-center gap-3 px-2 py-1.5">
      <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${t.box} ${t.icon}`}>
        <AppIcon name={icon} className="w-5 h-5" />
      </span>
      <div className="min-w-0">
        <p className="text-2xl font-bold text-ink-primary leading-tight">{value}</p>
        <p className="text-[11px] uppercase tracking-wide text-ink-primary/50 font-semibold">{label}</p>
      </div>
    </div>
  );
};

const RANK_STYLES: Record<number, { card: string; ribbon: string; pill: string; stat: string }> = {
  1: { card: 'bg-brand-primary/15 ring-brand-primary-soft/30',         ribbon: 'bg-amber-400 text-amber-950',   pill: 'bg-amber-400 text-amber-950',   stat: 'text-emerald-300' },
  2: { card: 'bg-emerald-500/15 ring-emerald-400/30',   ribbon: 'bg-gray-300 text-ink-primary/90',     pill: 'bg-emerald-500/150 text-white',     stat: 'text-emerald-300' },
  3: { card: 'bg-brand-primary/15 ring-brand-primary-soft/30',         ribbon: 'bg-orange-300 text-orange-950', pill: 'bg-brand-primary text-white',        stat: 'text-brand-primary-soft'    },
};

const PerformerCard: React.FC<{
  rank: 1 | 2 | 3;
  player: Player;
  value: number;
  statLabel: string;
  statName: string;
}> = ({ rank, player, value, statLabel, statName }) => {
  const styles = RANK_STYLES[rank];
  return (
    <a
      href={`/player/${player.id}`}
      className={`relative block rounded-2xl ring-1 ${styles.card} p-4 transition hover:shadow-md`}
    >
      <div className="flex flex-col items-center text-center">
        <div className="relative">
          {/* Rank ribbon */}
          <span className={`absolute -left-2 -top-1 w-7 h-7 rounded-full flex items-center justify-center text-xs font-black shadow ${styles.ribbon}`}>
            {rank}
          </span>
          {/* Stat count pill on the opposite corner */}
          <span className={`absolute -right-2 -bottom-1 w-7 h-7 rounded-full flex items-center justify-center text-xs font-black shadow ${styles.pill}`}>
            {value}
          </span>
          <PlayerAvatar player={player} large />
        </div>
        <p className="mt-2 font-bold text-ink-primary truncate w-full">{player.name}</p>
        <p className="text-xs text-ink-primary/65">{statLabel}</p>
        <p className={`mt-0.5 text-sm font-bold ${styles.stat}`}>
          {value} {statName}
        </p>
      </div>
    </a>
  );
};

const PlayerAvatar: React.FC<{ player: Player; large?: boolean }> = ({ player, large }) => {
  const photo = (player as any).profilePhotoUrl;
  const size = large ? 'w-16 h-16 text-lg ring-4' : 'w-9 h-9 text-xs ring-2';
  if (photo) {
    return <img src={photo} alt={player.name} className={`${size} rounded-full object-cover ring-white shadow-sm shrink-0`} />;
  }
  return (
    <div className={`${size} rounded-full bg-gradient-to-br from-brand-primary-soft to-brand-primary ring-white shadow-sm shrink-0 flex items-center justify-center text-white font-bold`}>
      {(player.name || '?').charAt(0).toUpperCase()}
    </div>
  );
};

const StatCell: React.FC<{ value: number; max: number; color: 'emerald' | 'cyan' | 'navy' | 'fire' }> = ({ value, max, color }) => {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const text = {
    emerald: 'text-emerald-300',
    cyan: 'text-brand-primary-soft',
    navy: 'text-ink-primary/85',
    fire: 'text-ink-primary/85',
  }[color];
  const bar = {
    emerald: 'bg-emerald-500/150',
    cyan: 'bg-brand-primary/150',
    navy: 'bg-surface-raised',
    fire: 'bg-brand-primary/150',
  }[color];
  return (
    <td className="py-3 px-2">
      <div className="flex flex-col items-center gap-1 min-w-[2.5rem]">
        <span className={`text-base font-bold tabular-nums ${value > 0 ? text : 'text-ink-primary/35'}`}>{value}</span>
        <div className="h-[3px] w-full rounded-full bg-line-default/[0.08] overflow-hidden">
          <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    </td>
  );
};

// ── Adjust Stats Modal ────────────────────────────────────────
interface AdjustStatsModalProps {
  player: Player;
  teamId: string;
  onClose: () => void;
  onSave: (next: Player['stats']) => void | Promise<void>;
}

// Stat editor rows — brand-aligned tints (fire/cyan/navy/emerald),
// no emoji. Yellow/red cards keep their semantic colors since those
// match the actual referee cards they represent.
const STAT_FIELDS: { key: keyof Player['stats']; label: string; icon: 'soccer' | 'highlight' | 'check' | 'trophy' | 'flag' | 'shield'; tint: string }[] = [
  { key: 'goals',       label: 'Goals',     icon: 'soccer',    tint: 'text-emerald-300' },
  { key: 'assists',     label: 'Assists',   icon: 'highlight', tint: 'text-brand-primary-soft' },
  { key: 'saves',       label: 'Saves',     icon: 'check',     tint: 'text-ink-primary/85' },
  { key: 'gamesPlayed', label: 'Games',     icon: 'trophy',    tint: 'text-ink-primary/85' },
  { key: 'yellowCards', label: 'Yellow',    icon: 'flag',      tint: 'text-yellow-700' },
  { key: 'redCards',    label: 'Red',       icon: 'shield',    tint: 'text-rose-300' },
];

const AdjustStatsModal: React.FC<AdjustStatsModalProps> = ({ player, onClose, onSave }) => {
  const cur = player.stats || { gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0, saves: 0, cleanSheets: 0 };
  const [values, setValues] = useState<any>({
    goals: cur.goals || 0,
    assists: cur.assists || 0,
    saves: cur.saves || 0,
    gamesPlayed: cur.gamesPlayed || 0,
    yellowCards: cur.yellowCards || 0,
    redCards: cur.redCards || 0,
  });
  const [saving, setSaving] = useState(false);

  const set = (k: string, v: number) => setValues((s: any) => ({ ...s, [k]: Math.max(0, v | 0) }));

  const handleSave = async () => {
    setSaving(true);
    await onSave({
      ...cur,
      goals: values.goals,
      assists: values.assists,
      saves: values.saves,
      gamesPlayed: values.gamesPlayed,
      yellowCards: values.yellowCards,
      redCards: values.redCards,
    } as Player['stats']);
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-surface-elevated rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-line-default/5 flex items-center justify-between bg-surface-elevated sticky top-0">
          <div>
            <h3 className="text-lg font-bold text-ink-primary">Fix Stats</h3>
            <p className="text-xs text-ink-primary/50">{player.name}{player.jerseyNumber != null ? ` · #${player.jerseyNumber}` : ''}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-line-default/[0.08] text-ink-primary/50" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-3">
          <p className="text-xs text-ink-primary/50 mb-2">
            Set the correct totals for this player. Adjustments are saved as a correction record so per-team stats stay accurate (including for players on multiple teams).
          </p>
          {STAT_FIELDS.map(f => (
            <div key={String(f.key)} className="flex items-center gap-3 p-3 rounded-xl bg-line-default/[0.04]">
              <div className={`w-9 h-9 rounded-lg bg-surface-elevated ring-1 ring-line-default/10 flex items-center justify-center ${f.tint}`}>
                <AppIcon name={f.icon} className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <p className={`text-sm font-bold ${f.tint}`}>{f.label}</p>
                <p className="text-[11px] text-ink-primary/50">Currently {(cur as any)[f.key] || 0}</p>
              </div>
              <button onClick={() => set(String(f.key), values[f.key] - 1)} className="w-9 h-9 rounded-full bg-surface-elevated ring-1 ring-line-default/10 text-lg font-bold text-ink-primary/65 hover:bg-line-default/[0.08]">−</button>
              <input
                type="number"
                min={0}
                value={values[f.key]}
                onChange={e => set(String(f.key), parseInt(e.target.value || '0', 10))}
                /* 2026-07-14: input needed an explicit bg + strong
                   text color. Prior className had no bg-*, so iOS
                   Safari + browsers default to white. In dark mode
                   text-ink-primary is light → light text on white
                   input = invisible ("2" barely readable in Patrick's
                   screenshot). Explicit surface-input bg + strong
                   text-ink-primary reads clean in both themes. */
                className="w-16 text-center font-bold text-ink-primary tabular-nums bg-surface-input ring-1 ring-line-default/20 rounded-lg py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-primary"
              />
              <button onClick={() => set(String(f.key), values[f.key] + 1)} className="w-9 h-9 rounded-full bg-surface-elevated ring-1 ring-line-default/10 text-lg font-bold text-ink-primary/65 hover:bg-line-default/[0.08]">+</button>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-line-default/5 flex justify-end gap-2 bg-line-default/[0.04] sticky bottom-0">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-semibold text-ink-primary/85 hover:bg-line-default/[0.08]" disabled={saving}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-bold text-white bg-brand-primary hover:bg-brand-primary disabled:opacity-50">
            {saving ? 'Saving…' : 'Save correction'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Stats;