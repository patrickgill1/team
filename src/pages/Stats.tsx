import React, { useState, useEffect } from 'react';
import { Player } from '../types';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { isCoach } from '../utils/helpers';
import Header from '../components/common/Header';
import AppIcon from '../components/common/AppIcon';
import StatsTracker from '../components/stats/StatsTracker';
import StatsDisplay from '../components/stats/StatsDisplay';
import { useActiveSeason } from '../hooks/useActiveSeason';
import { getPlayerStats, getPlayerLifetimeStats } from '../utils/seasons';

type SortKey = 'goals' | 'assists' | 'saves' | 'gamesPlayed';

const Stats: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getPlayersByTeam, getTeamPlayerStatsMap, getPlayerMediaByTeam, addGameStat, updatePlayerStats } = useFirestore();
  const [players, setPlayers] = useState<Player[]>([]);
  const [mediaCount, setMediaCount] = useState(0);
  const [isStatsTrackerOpen, setIsStatsTrackerOpen] = useState(false);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'overview' | 'track'>('overview');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [adjustingPlayerId, setAdjustingPlayerId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>('goals');

  const isUserCoach = userData ? isCoach(userData.role) : false;
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
        console.log('Loading players for stats page...');
        
        const teamPlayers = await getPlayersByTeam(selectedTeamId);
        const statsMap = await getTeamPlayerStatsMap(selectedTeamId).catch(() => ({} as any));
        const playersWithDates = teamPlayers.map((player: any) => {
          const empty = { gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0, saves: 0, cleanSheets: 0 };
          const isShared = Array.isArray(player.teamIds) && player.teamIds.length > 1;
          const stats = (statsMap as any)[player.id] || (isShared ? empty : (player.stats || empty));
          return {
            ...player,
            createdAt: player.createdAt?.toDate ? player.createdAt.toDate() : new Date(player.createdAt),
            stats,
          };
        }) as Player[];
        
        console.log('Players loaded for stats:', playersWithDates);
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
  }, [selectedTeamId, getPlayersByTeam, getTeamPlayerStatsMap]);

  // Update players list when stats are recorded
  const handleStatsRecorded = () => {
    // Reload players to get updated stats
    if (selectedTeamId) {
      Promise.all([
        getPlayersByTeam(selectedTeamId),
        getTeamPlayerStatsMap(selectedTeamId).catch(() => ({} as any)),
      ]).then(([teamPlayers, statsMap]: any) => {
        const playersWithDates = (teamPlayers as any[]).map((player: any) => {
          const empty = { gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0, saves: 0, cleanSheets: 0 };
          const isShared = Array.isArray(player.teamIds) && player.teamIds.length > 1;
          const stats = (statsMap as any)[player.id] || (isShared ? empty : (player.stats || empty));
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
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading team statistics...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <Header title="Stats" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 space-y-3">
        {loadError && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2.5">
            <svg className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <div className="flex-1">
              <p className="text-sm font-bold text-amber-900">Loading issue</p>
              <p className="text-xs text-amber-800 mt-0.5">{loadError}</p>
              <button
                onClick={() => window.location.reload()}
                className="mt-2 text-[11px] font-extrabold tracking-widest uppercase px-2 py-1 rounded bg-amber-100 text-amber-900 hover:bg-amber-200"
              >Refresh</button>
            </div>
          </div>
        )}

        {/* Tab Navigation */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="border-b border-slate-100">
            <nav className="flex gap-1 px-3 pt-2">
              <button
                onClick={() => setActiveTab('overview')}
                className={`px-3 py-2 rounded-t-md text-[11px] font-extrabold tracking-widest uppercase border-b-2 transition-colors ${
                  activeTab === 'overview'
                    ? 'border-cyan-500 text-cyan-700'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                Overview
              </button>

              {isUserCoach && (
                <button
                  onClick={() => setActiveTab('track')}
                  className={`px-3 py-2 rounded-t-md text-[11px] font-extrabold tracking-widest uppercase border-b-2 transition-colors ${
                    activeTab === 'track'
                      ? 'border-cyan-500 text-cyan-700'
                      : 'border-transparent text-slate-500 hover:text-slate-800'
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
                    <h3 className="text-lg font-semibold text-gray-900">Record Player Statistics</h3>
                    <p className="text-sm text-gray-600">
                      Track goals, assists, saves, and key plays during games
                    </p>
                  </div>
                  
                  <button
                    onClick={() => setIsStatsTrackerOpen(true)}
                    disabled={players.length === 0}
                    className="bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    <span>Record Stats</span>
                  </button>
                </div>

                {players.length === 0 ? (
                  <div className="text-center py-12">
                    <div className="text-gray-400 mb-4">
                      <svg className="mx-auto h-16 w-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                      </svg>
                    </div>
                    <h3 className="text-lg font-medium text-gray-900 mb-2">No Players Added</h3>
                    <p className="text-gray-600 mb-4">
                      You need to add players to your team before you can track statistics.
                    </p>
                    <button
                      onClick={() => window.location.href = '/players'}
                      className="bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200"
                    >
                      Add Players
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {players.map(player => (
                      <div
                        key={player.id}
                        className="bg-white border border-gray-200 rounded-lg p-4 hover:border-cyan-300 hover:shadow-md transition-all duration-200"
                      >
                        <div
                          onClick={() => {
                            setSelectedPlayerId(player.id);
                            setIsStatsTrackerOpen(true);
                          }}
                          className="cursor-pointer"
                        >
                          <div className="flex items-center space-x-3 mb-3">
                            <div className="bg-cyan-50 rounded-full w-12 h-12 flex items-center justify-center">
                              <span className="text-lg font-bold text-cyan-600">#{player.jerseyNumber}</span>
                            </div>
                            <div>
                              <h4 className="font-semibold text-gray-900">{player.name}</h4>
                              <p className="text-sm text-gray-600">{player.position}</p>
                            </div>
                          </div>

                          {(() => {
                            const s = statsScope === 'lifetime'
                              ? getPlayerLifetimeStats(player as any)
                              : getPlayerStats(player as any, activeSeason?.id);
                            return (
                              <div className="grid grid-cols-3 gap-2 text-center">
                                <div>
                                  <div className="text-lg font-bold text-cyan-600">{s.goals || 0}</div>
                                  <div className="text-xs text-gray-600">Goals</div>
                                </div>
                                <div>
                                  <div className="text-lg font-bold text-emerald-600">{s.assists || 0}</div>
                                  <div className="text-xs text-gray-600">Assists</div>
                                </div>
                                <div>
                                  <div className="text-lg font-bold text-navy-700">{s.saves || 0}</div>
                                  <div className="text-xs text-gray-600">Saves</div>
                                </div>
                              </div>
                            );
                          })()}
                        </div>

                        <div className="mt-3 pt-3 border-t border-gray-200 flex items-center justify-between gap-2">
                          <button
                            onClick={() => {
                              setSelectedPlayerId(player.id);
                              setIsStatsTrackerOpen(true);
                            }}
                            className="flex-1 inline-flex items-center justify-center text-cyan-600 text-sm font-medium hover:text-cyan-700"
                          >
                            <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                            Record
                          </button>
                          <button
                            onClick={() => setAdjustingPlayerId(player.id)}
                            className="flex-1 inline-flex items-center justify-center text-fire-700 text-sm font-medium hover:text-fire-800"
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
              if (!hasChange) { setAdjustingPlayerId(null); return; }
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
  sortBy: SortKey;
  setSortBy: (s: SortKey) => void;
  loadError: string | null;
  selectedPlayerId: string;
  setSelectedPlayerId: (id: string) => void;
}

const StatsOverview: React.FC<StatsOverviewProps> = ({
  players, mediaCount, activeSeason, statsScope, setStatsScope, sortBy, setSortBy, loadError, selectedPlayerId, setSelectedPlayerId,
}) => {
  // Resolve stats per player given the current scope toggle.
  const statsFor = (p: Player) =>
    statsScope === 'lifetime'
      ? getPlayerLifetimeStats(p as any)
      : getPlayerStats(p as any, activeSeason?.id);

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
          <h3 className="text-lg font-semibold text-gray-900">Team Performance</h3>
          <p className="text-sm text-gray-600">Players, goals, games, and clips at a glance.</p>
        </div>
        <div className="flex items-center gap-2">
          {activeSeason && (
            <div className="inline-flex items-center rounded-full bg-gray-100 ring-1 ring-gray-200 p-0.5">
              <button
                onClick={() => setStatsScope('current')}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider transition ${
                  statsScope === 'current' ? 'bg-cyan-600 text-white shadow-sm' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                This Season
              </button>
              <button
                onClick={() => setStatsScope('lifetime')}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider transition ${
                  statsScope === 'lifetime' ? 'bg-cyan-600 text-white shadow-sm' : 'text-gray-600 hover:text-gray-900'
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
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
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
        <div className="bg-white rounded-2xl ring-1 ring-gray-200 text-center py-12">
          <div className="text-gray-400 mb-3 flex justify-center">
            <AppIcon name="players" className="w-12 h-12" />
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-1">No players yet</h3>
          <p className="text-gray-600 mb-4">Add players to your team to start tracking stats.</p>
          <button
            onClick={() => window.location.href = '/players'}
            className="bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 px-4 rounded-lg transition"
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
          <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-3 sm:p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <QuickStat icon="players" tint="cyan" value={players.length} label="Players" />
              <QuickStat icon="soccer" tint="emerald" value={totalGoals} label="Goals" />
              <QuickStat icon="trophy" tint="navy" value={totalGames} label="Games" />
              <QuickStat icon="film" tint="fire" value={mediaCount} label="Clips" />
            </div>
          </div>

          {/* Top Performers */}
          <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-4 sm:p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base sm:text-lg font-bold text-gray-900">Top Performers</h3>
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
              <p className="text-sm text-gray-500 text-center py-6">No stats recorded yet — record some goals and assists to populate this.</p>
            )}
          </div>

          {/* All Players Stats — sortable */}
          <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
            <div className="px-4 sm:px-5 py-4 flex items-center justify-between gap-3">
              <h3 className="text-base sm:text-lg font-bold text-gray-900">All Players Stats</h3>
              <label className="inline-flex items-center gap-2 text-xs text-gray-500">
                <span className="font-semibold uppercase tracking-wide">Sort by</span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortKey)}
                  className="px-2 py-1 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
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
                <thead className="bg-gray-50 border-y border-gray-200">
                  <tr className="text-[11px] uppercase tracking-wider text-gray-500">
                    <th className="text-left font-semibold py-2.5 pl-4 sm:pl-5 pr-2 w-8">#</th>
                    <th className="text-left font-semibold py-2.5 pr-2">Player</th>
                    <th className={`text-center font-semibold py-2.5 px-2 w-12 ${sortBy==='goals' ? 'text-emerald-700' : ''}`}>G</th>
                    <th className={`text-center font-semibold py-2.5 px-2 w-12 ${sortBy==='assists' ? 'text-cyan-700' : ''}`}>A</th>
                    <th className={`text-center font-semibold py-2.5 px-2 w-16 ${sortBy==='saves' ? 'text-navy-700' : ''}`}>Saves</th>
                    <th className={`text-center font-semibold py-2.5 px-2 w-12 ${sortBy==='gamesPlayed' ? 'text-fire-700' : ''}`}>Apps</th>
                    <th className="py-2.5 w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sortedRows.map((row, idx) => (
                    <tr key={row.p.id} className="hover:bg-gray-50 transition">
                      <td className="py-3 pl-4 sm:pl-5 pr-2 text-gray-400 text-xs font-semibold">{idx + 1}</td>
                      <td className="py-3 pr-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <PlayerAvatar player={row.p} />
                          <div className="min-w-0">
                            <p className="font-semibold text-gray-900 truncate">{row.p.name}</p>
                            <p className="text-xs text-gray-500 truncate">
                              {row.p.jerseyNumber != null ? `#${row.p.jerseyNumber} · ` : ''}{row.p.position || 'Player'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <StatCell value={row.goals} max={maxGoals} color="emerald" />
                      <StatCell value={row.assists} max={maxAssists} color="cyan" />
                      <StatCell value={row.saves} max={maxSaves} color="navy" />
                      <td className="py-3 px-2 text-center text-gray-700 font-semibold">{row.gamesPlayed}</td>
                      <td className="py-3 pr-3 text-right">
                        <a href={`/player/${row.p.id}`} className="text-gray-300 hover:text-cyan-600">
                          <AppIcon name="arrow-right" className="w-4 h-4 inline" />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 sm:px-5 py-3 border-t border-gray-100 bg-gray-50 flex items-center justify-between text-sm">
              <span className="inline-flex items-center gap-2 text-gray-600">
                <AppIcon name="stats" className="w-4 h-4 text-cyan-700" />
                <span>View full breakdown for any player</span>
              </span>
              <button
                onClick={() => setSelectedPlayerId(players[0]?.id || '')}
                disabled={players.length === 0}
                className="inline-flex items-center gap-1 text-cyan-700 hover:text-cyan-800 font-semibold disabled:opacity-50"
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
  cyan:    { box: 'bg-cyan-50',           icon: 'text-cyan-700',    value: 'text-cyan-700'    },
  emerald: { box: 'bg-emerald-50',        icon: 'text-emerald-700', value: 'text-emerald-700' },
  navy:    { box: 'bg-navy-700/10',       icon: 'text-navy-700',    value: 'text-navy-700'    },
  fire:    { box: 'bg-fire-50',           icon: 'text-fire-700',    value: 'text-fire-700'    },
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
        <p className="text-2xl font-bold text-gray-900 leading-tight">{value}</p>
        <p className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold">{label}</p>
      </div>
    </div>
  );
};

const RANK_STYLES: Record<number, { card: string; ribbon: string; pill: string; stat: string }> = {
  1: { card: 'bg-fire-50 ring-fire-200',         ribbon: 'bg-amber-400 text-amber-950',   pill: 'bg-amber-400 text-amber-950',   stat: 'text-emerald-700' },
  2: { card: 'bg-emerald-50 ring-emerald-200',   ribbon: 'bg-gray-300 text-gray-800',     pill: 'bg-emerald-500 text-white',     stat: 'text-emerald-700' },
  3: { card: 'bg-cyan-50 ring-cyan-200',         ribbon: 'bg-orange-300 text-orange-950', pill: 'bg-cyan-600 text-white',        stat: 'text-cyan-800'    },
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
        <p className="mt-2 font-bold text-gray-900 truncate w-full">{player.name}</p>
        <p className="text-xs text-gray-600">{statLabel}</p>
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
    <div className={`${size} rounded-full bg-gradient-to-br from-fire-400 to-cyan-500 ring-white shadow-sm shrink-0 flex items-center justify-center text-white font-bold`}>
      {(player.name || '?').charAt(0).toUpperCase()}
    </div>
  );
};

const StatCell: React.FC<{ value: number; max: number; color: 'emerald' | 'cyan' | 'navy' | 'fire' }> = ({ value, max, color }) => {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const text = {
    emerald: 'text-emerald-700',
    cyan: 'text-cyan-700',
    navy: 'text-navy-700',
    fire: 'text-fire-700',
  }[color];
  const bar = {
    emerald: 'bg-emerald-500',
    cyan: 'bg-cyan-500',
    navy: 'bg-navy-700',
    fire: 'bg-fire-500',
  }[color];
  return (
    <td className="py-3 px-2">
      <div className="flex flex-col items-center gap-1 min-w-[2.5rem]">
        <span className={`text-base font-bold tabular-nums ${value > 0 ? text : 'text-gray-300'}`}>{value}</span>
        <div className="h-[3px] w-full rounded-full bg-gray-100 overflow-hidden">
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
  { key: 'goals',       label: 'Goals',     icon: 'soccer',    tint: 'text-emerald-700' },
  { key: 'assists',     label: 'Assists',   icon: 'highlight', tint: 'text-cyan-700' },
  { key: 'saves',       label: 'Saves',     icon: 'check',     tint: 'text-navy-700' },
  { key: 'gamesPlayed', label: 'Games',     icon: 'trophy',    tint: 'text-fire-700' },
  { key: 'yellowCards', label: 'Yellow',    icon: 'flag',      tint: 'text-yellow-700' },
  { key: 'redCards',    label: 'Red',       icon: 'shield',    tint: 'text-rose-700' },
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
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gradient-to-r from-cyan-50 to-white sticky top-0">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Fix Stats</h3>
            <p className="text-xs text-gray-500">{player.name}{player.jerseyNumber != null ? ` · #${player.jerseyNumber}` : ''}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-3">
          <p className="text-xs text-gray-500 mb-2">
            Set the correct totals for this player. Adjustments are saved as a correction record so per-team stats stay accurate (including for players on multiple teams).
          </p>
          {STAT_FIELDS.map(f => (
            <div key={String(f.key)} className="flex items-center gap-3 p-3 rounded-xl bg-gray-50">
              <div className={`w-9 h-9 rounded-lg bg-white ring-1 ring-gray-200 flex items-center justify-center ${f.tint}`}>
                <AppIcon name={f.icon} className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <p className={`text-sm font-bold ${f.tint}`}>{f.label}</p>
                <p className="text-[11px] text-gray-500">Currently {(cur as any)[f.key] || 0}</p>
              </div>
              <button onClick={() => set(String(f.key), values[f.key] - 1)} className="w-9 h-9 rounded-full bg-white ring-1 ring-gray-200 text-lg font-bold text-gray-600 hover:bg-gray-100">−</button>
              <input
                type="number"
                min={0}
                value={values[f.key]}
                onChange={e => set(String(f.key), parseInt(e.target.value || '0', 10))}
                className="w-16 text-center font-bold text-gray-900 border border-gray-200 rounded-lg py-1.5 focus:outline-none focus:ring-2 focus:ring-cyan-300"
              />
              <button onClick={() => set(String(f.key), values[f.key] + 1)} className="w-9 h-9 rounded-full bg-white ring-1 ring-gray-200 text-lg font-bold text-gray-600 hover:bg-gray-100">+</button>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2 bg-gray-50 sticky bottom-0">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-200" disabled={saving}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-bold text-white bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save correction'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Stats;