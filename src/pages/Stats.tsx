import React, { useState, useEffect } from 'react';
import { Player } from '../types';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { isCoach } from '../utils/helpers';
import Header from '../components/common/Header';
import StatsTracker from '../components/stats/StatsTracker';
import StatsDisplay from '../components/stats/StatsDisplay';

const Stats: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getPlayersByTeam } = useFirestore();
  const [players, setPlayers] = useState<Player[]>([]);
  const [isStatsTrackerOpen, setIsStatsTrackerOpen] = useState(false);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'overview' | 'track'>('overview');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const isUserCoach = userData ? isCoach(userData.role) : false;

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
        const playersWithDates = teamPlayers.map((player: any) => ({
          ...player,
          createdAt: player.createdAt?.toDate ? player.createdAt.toDate() : new Date(player.createdAt),
          stats: player.stats || {
            gamesPlayed: 0,
            goals: 0,
            assists: 0,
            yellowCards: 0,
            redCards: 0,
            minutesPlayed: 0,
            saves: 0,
            cleanSheets: 0
          }
        })) as Player[];
        
        console.log('Players loaded for stats:', playersWithDates);
        setPlayers(playersWithDates);
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
  }, [selectedTeamId, getPlayersByTeam]);

  // Update players list when stats are recorded
  const handleStatsRecorded = () => {
    // Reload players to get updated stats
    if (selectedTeamId) {
      getPlayersByTeam(selectedTeamId).then((teamPlayers: any[]) => {
        const playersWithDates = teamPlayers.map((player: any) => ({
          ...player,
          createdAt: player.createdAt?.toDate ? player.createdAt.toDate() : new Date(player.createdAt),
          stats: player.stats || {
            gamesPlayed: 0,
            goals: 0,
            assists: 0,
            yellowCards: 0,
            redCards: 0,
            minutesPlayed: 0,
            saves: 0,
            cleanSheets: 0
          }
        })) as Player[];
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
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading team statistics...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header 
        title="Team Statistics" 
        subtitle={isUserCoach ? "Track and analyze player performance" : "View team and player statistics"}
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Error Message */}
        {loadError && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
            <div className="flex items-center">
              <svg className="w-5 h-5 text-yellow-400 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <div>
                <h3 className="text-sm font-medium text-yellow-800">Loading Issue</h3>
                <p className="text-sm text-yellow-700 mt-1">{loadError}</p>
              </div>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="mt-3 bg-yellow-100 hover:bg-yellow-200 text-yellow-800 px-3 py-1 rounded text-sm font-medium transition-colors duration-200"
            >
              Refresh Page
            </button>
          </div>
        )}

        {/* Tab Navigation */}
        <div className="bg-white rounded-lg shadow-md mb-6">
          <div className="border-b border-gray-200">
            <nav className="flex space-x-8 px-6">
              <button
                onClick={() => setActiveTab('overview')}
                className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors duration-200 ${
                  activeTab === 'overview'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <div className="flex items-center space-x-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                  <span>Statistics Overview</span>
                </div>
              </button>
              
              {isUserCoach && (
                <button
                  onClick={() => setActiveTab('track')}
                  className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors duration-200 ${
                    activeTab === 'track'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center space-x-2">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    <span>Track Stats</span>
                  </div>
                </button>
              )}
            </nav>
          </div>

          {/* Tab Content */}
          <div className="p-6">
            {activeTab === 'overview' ? (
              /* Statistics Overview */
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">Team Performance</h3>
                    <p className="text-sm text-gray-600">
                      View detailed statistics for all players and games
                    </p>
                  </div>
                  
                  {/* Quick Stats Button for Parents */}
                  {!isUserCoach && players.length > 0 && (
                    <select
                      value={selectedPlayerId}
                      onChange={(e) => setSelectedPlayerId(e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">View All Players</option>
                      {players.map(player => (
                        <option key={player.id} value={player.id}>
                          #{player.jerseyNumber} - {player.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {players.length === 0 && !loadError ? (
                  <div className="text-center py-12">
                    <div className="text-gray-400 mb-4">
                      <svg className="mx-auto h-16 w-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                      </svg>
                    </div>
                    <h3 className="text-lg font-medium text-gray-900 mb-2">No Players Found</h3>
                    <p className="text-gray-600 mb-4">
                      Add players to your team to start tracking statistics.
                    </p>
                    <button
                      onClick={() => window.location.href = '/players'}
                      className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200"
                    >
                      Add Players
                    </button>
                  </div>
                ) : (
                  <StatsDisplay 
                    players={players}
                    selectedPlayerId={selectedPlayerId}
                    showGameDetails={true}
                  />
                )}
              </div>
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
                    className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
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
                      className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200"
                    >
                      Add Players
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {players.map(player => (
                      <div
                        key={player.id}
                        onClick={() => {
                          setSelectedPlayerId(player.id);
                          setIsStatsTrackerOpen(true);
                        }}
                        className="bg-white border border-gray-200 rounded-lg p-4 hover:border-blue-300 hover:shadow-md transition-all duration-200 cursor-pointer"
                      >
                        <div className="flex items-center space-x-3 mb-3">
                          <div className="bg-blue-100 rounded-full w-12 h-12 flex items-center justify-center">
                            <span className="text-lg font-bold text-blue-600">#{player.jerseyNumber}</span>
                          </div>
                          <div>
                            <h4 className="font-semibold text-gray-900">{player.name}</h4>
                            <p className="text-sm text-gray-600">{player.position}</p>
                          </div>
                        </div>
                        
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div>
                            <div className="text-lg font-bold text-blue-600">{player.stats?.goals || 0}</div>
                            <div className="text-xs text-gray-600">Goals</div>
                          </div>
                          <div>
                            <div className="text-lg font-bold text-green-600">{player.stats?.assists || 0}</div>
                            <div className="text-xs text-gray-600">Assists</div>
                          </div>
                          <div>
                            <div className="text-lg font-bold text-purple-600">{player.stats?.saves || 0}</div>
                            <div className="text-xs text-gray-600">Saves</div>
                          </div>
                        </div>

                        <div className="mt-3 pt-3 border-t border-gray-200">
                          <div className="flex items-center justify-center text-blue-600 text-sm font-medium">
                            <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                            Click to record stats
                          </div>
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
      </div>
    </div>
  );
};

export default Stats;