import React, { useState, useEffect } from 'react';
import { Player, GameStat } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useFirestore } from '../../hooks/useFirestore';
import { formatDateTime, isCoach } from '../../utils/helpers';
import StatsTrends from './StatsTrends';

interface StatsDisplayProps {
  players: Player[];
  selectedPlayerId?: string;
  showGameDetails?: boolean;
}

const StatsDisplay: React.FC<StatsDisplayProps> = ({
  players,
  selectedPlayerId,
  showGameDetails = false
}) => {
  const { userData } = useAuth();
  const { getStatsByPlayer } = useFirestore();
  const [selectedPlayer, setSelectedPlayer] = useState<string>(selectedPlayerId || '');
  const [playerStats, setPlayerStats] = useState<GameStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'overview' | 'detailed'>('overview');

  const isUserCoach = userData ? isCoach(userData.role) : false;

  useEffect(() => {
    if (selectedPlayerId) {
      setSelectedPlayer(selectedPlayerId);
    }
  }, [selectedPlayerId]);

  useEffect(() => {
    const loadPlayerStats = async () => {
      if (!selectedPlayer) {
        setPlayerStats([]);
        return;
      }

      try {
        setLoading(true);
        console.log('Loading stats for player:', selectedPlayer);
        const stats = await getStatsByPlayer(selectedPlayer);
        const statsWithDates = stats.map((stat: any) => ({
          ...stat,
          createdAt: stat.createdAt?.toDate ? stat.createdAt.toDate() : new Date(stat.createdAt)
        })) as GameStat[];
        
        // Sort by date (newest first)
        statsWithDates.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        setPlayerStats(statsWithDates);
        console.log('Player stats loaded:', statsWithDates);
      } catch (error: any) {
        console.error('Error loading player stats:', error);
        
        // If it's an index error, just set empty array and continue
        if (error.message?.includes('index') || error.code === 'failed-precondition') {
          console.log('Index not ready for stats query, showing empty stats');
          setPlayerStats([]);
        } else {
          // For other errors, still set empty array to prevent crashes
          setPlayerStats([]);
        }
      } finally {
        setLoading(false);
      }
    };

    loadPlayerStats();
  }, [selectedPlayer, getStatsByPlayer]);
  const getSelectedPlayerData = () => {
    return players.find(p => p.id === selectedPlayer);
  };

  const calculateAverages = (stats: GameStat[]) => {
    if (stats.length === 0) return { goals: 0, assists: 0, saves: 0 };

    const totals = stats.reduce(
      (acc, stat) => ({
        goals: acc.goals + stat.goals,
        assists: acc.assists + stat.assists,
        saves: acc.saves + stat.saves
      }),
      { goals: 0, assists: 0, saves: 0 }
    );

    return {
      goals: Number((totals.goals / stats.length).toFixed(1)),
      assists: Number((totals.assists / stats.length).toFixed(1)),
      saves: Number((totals.saves / stats.length).toFixed(1))
    };
  };

  const getTopPerformers = () => {
    const playerTotals = players.map(player => ({
      ...player,
      totalGoals: player.stats.goals,
      totalAssists: player.stats.assists,
      totalSaves: player.stats.saves
    }));

    return {
      topScorer: playerTotals.reduce((prev, current) => 
        current.totalGoals > prev.totalGoals ? current : prev
      ),
      topAssister: playerTotals.reduce((prev, current) => 
        current.totalAssists > prev.totalAssists ? current : prev
      ),
      topSaver: playerTotals.reduce((prev, current) => 
        current.totalSaves > prev.totalSaves ? current : prev
      )
    };
  };

  const selectedPlayerData = getSelectedPlayerData();
  const averages = calculateAverages(playerStats);
  const topPerformers = getTopPerformers();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center space-x-4">
          <select
            value={selectedPlayer}
            onChange={(e) => setSelectedPlayer(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Players Overview</option>
            {players.map(player => (
              <option key={player.id} value={player.id}>
                #{player.jerseyNumber} - {player.name}
              </option>
            ))}
          </select>

          {selectedPlayer && (
            <div className="flex bg-gray-100 rounded-lg p-1">
              <button
                onClick={() => setViewMode('overview')}
                className={`px-3 py-1 rounded-md text-sm font-medium transition-colors duration-200 ${
                  viewMode === 'overview'
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Overview
              </button>
              <button
                onClick={() => setViewMode('detailed')}
                className={`px-3 py-1 rounded-md text-sm font-medium transition-colors duration-200 ${
                  viewMode === 'detailed'
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Game by Game
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      {!selectedPlayer ? (
        /* Team Overview */
        <div className="space-y-6">
          {/* Top Performers */}
          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Top Performers</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="text-center p-4 bg-yellow-50 rounded-lg">
                <div className="text-2xl mb-2">🥇</div>
                <div className="font-semibold text-gray-900">{topPerformers.topScorer.name}</div>
                <div className="text-sm text-gray-600">Top Scorer</div>
                <div className="text-xl font-bold text-blue-600">{topPerformers.topScorer.totalGoals} goals</div>
              </div>
              <div className="text-center p-4 bg-green-50 rounded-lg">
                <div className="text-2xl mb-2">🎯</div>
                <div className="font-semibold text-gray-900">{topPerformers.topAssister.name}</div>
                <div className="text-sm text-gray-600">Top Assister</div>
                <div className="text-xl font-bold text-green-600">{topPerformers.topAssister.totalAssists} assists</div>
              </div>
              <div className="text-center p-4 bg-purple-50 rounded-lg">
                <div className="text-2xl mb-2">🧤</div>
                <div className="font-semibold text-gray-900">{topPerformers.topSaver.name}</div>
                <div className="text-sm text-gray-600">Top Saver</div>
                <div className="text-xl font-bold text-purple-600">{topPerformers.topSaver.totalSaves} saves</div>
              </div>
            </div>
          </div>

          {/* Team Stats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {players.map(player => (
              <div key={player.id} className="bg-white rounded-lg shadow-md p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h4 className="font-semibold text-gray-900">{player.name}</h4>
                    <p className="text-sm text-gray-600">#{player.jerseyNumber} • {player.position}</p>
                  </div>
                  <button
                    onClick={() => setSelectedPlayer(player.id)}
                    className="text-blue-600 hover:text-blue-700 text-sm font-medium"
                  >
                    View Details
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-lg font-bold text-blue-600">{player.stats.goals}</div>
                    <div className="text-xs text-gray-600">Goals</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-green-600">{player.stats.assists}</div>
                    <div className="text-xs text-gray-600">Assists</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-purple-600">{player.stats.saves}</div>
                    <div className="text-xs text-gray-600">Saves</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : selectedPlayerData ? (
        /* Individual Player Stats */
        <div className="space-y-6">
          {/* Player Header */}
          <div className="bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg p-6 text-white">
            <div className="flex items-center space-x-4">
              <div className="bg-white bg-opacity-20 rounded-full w-16 h-16 flex items-center justify-center">
                <span className="text-2xl font-bold">#{selectedPlayerData.jerseyNumber}</span>
              </div>
              <div>
                <h2 className="text-2xl font-bold">{selectedPlayerData.name}</h2>
                <p className="text-blue-100">{selectedPlayerData.position}</p>
              </div>
            </div>
          </div>

          {/* Trends & streaks */}
          <StatsTrends
            stats={playerStats}
            isKeeper={(selectedPlayerData.position || '').toLowerCase().includes('keeper') || (selectedPlayerData.position || '').toLowerCase().includes('gk')}
          />

          {viewMode === 'overview' ? (
            /* Overview Mode */
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Season Totals */}
              <div className="bg-white rounded-lg shadow-md p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Season Totals</h3>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-gray-600">Goals</span>
                    <span className="text-2xl font-bold text-blue-600">{selectedPlayerData.stats.goals}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-600">Assists</span>
                    <span className="text-2xl font-bold text-green-600">{selectedPlayerData.stats.assists}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-600">Saves</span>
                    <span className="text-2xl font-bold text-purple-600">{selectedPlayerData.stats.saves}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-600">Games Played</span>
                    <span className="text-2xl font-bold text-gray-700">{selectedPlayerData.stats.gamesPlayed}</span>
                  </div>
                </div>
              </div>

              {/* Averages */}
              <div className="bg-white rounded-lg shadow-md p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Per Game Averages</h3>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-gray-600">Goals/Game</span>
                    <span className="text-2xl font-bold text-blue-600">{averages.goals}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-600">Assists/Game</span>
                    <span className="text-2xl font-bold text-green-600">{averages.assists}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-600">Saves/Game</span>
                    <span className="text-2xl font-bold text-purple-600">{averages.saves}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-600">Games Recorded</span>
                    <span className="text-2xl font-bold text-gray-700">{playerStats.length}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Detailed Game-by-Game */
            <div className="bg-white rounded-lg shadow-md">
              <div className="px-6 py-4 border-b border-gray-200">
                <h3 className="text-lg font-semibold text-gray-900">Game-by-Game Performance</h3>
              </div>
              <div className="p-6">
                {playerStats.length === 0 ? (
                  <div className="text-center py-8">
                    <div className="text-gray-400 mb-2">
                      <svg className="mx-auto h-12 w-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                      </svg>
                    </div>
                    <p className="text-gray-600">No game stats recorded yet for this player.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {playerStats.map((stat, index) => (
                      <div key={stat.id} className="border border-gray-200 rounded-lg p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center space-x-2">
                            <span className="bg-blue-100 text-blue-800 text-xs font-medium px-2 py-1 rounded-full">
                              Game {playerStats.length - index}
                            </span>
                            <span className="text-sm text-gray-600">
                              {formatDateTime(stat.createdAt)}
                            </span>
                          </div>
                          {isUserCoach && stat.recordedByName && (
                            <span className="text-sm text-gray-500">
                              Recorded by {stat.recordedByName}
                            </span>
                          )}
                        </div>
                        
                        <div className="grid grid-cols-3 gap-4 mb-3">
                          <div className="text-center">
                            <div className="text-lg font-bold text-blue-600">{stat.goals}</div>
                            <div className="text-sm text-gray-600">Goals</div>
                          </div>
                          <div className="text-center">
                            <div className="text-lg font-bold text-green-600">{stat.assists}</div>
                            <div className="text-sm text-gray-600">Assists</div>
                          </div>
                          <div className="text-center">
                            <div className="text-lg font-bold text-purple-600">{stat.saves}</div>
                            <div className="text-sm text-gray-600">Saves</div>
                          </div>
                        </div>

                        {stat.keyPlays.length > 0 && (
                          <div>
                            <h5 className="font-medium text-gray-900 mb-2">Key Plays:</h5>
                            <ul className="list-disc list-inside space-y-1">
                              {stat.keyPlays.map((play, playIndex) => (
                                <li key={playIndex} className="text-sm text-gray-600">{play}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-8">
          <p className="text-gray-600">Player not found.</p>
        </div>
      )}
    </div>
  );
};

export default StatsDisplay;