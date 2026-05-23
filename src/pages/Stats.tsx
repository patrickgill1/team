import React, { useState, useEffect } from 'react';
import { Player } from '../types';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { isCoach } from '../utils/helpers';
import Header from '../components/common/Header';
import StatsTracker from '../components/stats/StatsTracker';
import StatsDisplay from '../components/stats/StatsDisplay';
import { useActiveSeason } from '../hooks/useActiveSeason';
import { getPlayerStats, getPlayerLifetimeStats } from '../utils/seasons';

const Stats: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getPlayersByTeam, getTeamPlayerStatsMap, addGameStat, updatePlayerStats } = useFirestore();
  const [players, setPlayers] = useState<Player[]>([]);
  const [isStatsTrackerOpen, setIsStatsTrackerOpen] = useState(false);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'overview' | 'track'>('overview');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [adjustingPlayerId, setAdjustingPlayerId] = useState<string | null>(null);

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
        <div className="card-modern mb-6">
          <div className="border-b border-gray-200">
            <nav className="flex space-x-8 px-6">
              <button
                onClick={() => setActiveTab('overview')}
                className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors duration-200 ${
                  activeTab === 'overview'
                    ? 'border-cyan-500 text-cyan-600'
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
                      ? 'border-cyan-500 text-cyan-600'
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
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">Team Performance</h3>
                    <p className="text-sm text-gray-600">
                      View detailed statistics for all players and games
                    </p>
                  </div>
                  {/* Two-button toggle — matches PlayerProfile so the
                      app uses one vocabulary for season scope ("This
                      Season" / "Overall"). Killed the "Current · Legacy"
                      label which was the auto-named pre-seasons bucket
                      bleeding into the UI. */}
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
                  
                  {/* Quick Stats Button for Parents */}
                  {!isUserCoach && players.length > 0 && (
                    <select
                      value={selectedPlayerId}
                      onChange={(e) => setSelectedPlayerId(e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
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
                      className="bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200"
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
                                  <div className="text-lg font-bold text-purple-600">{s.saves || 0}</div>
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
                            className="flex-1 inline-flex items-center justify-center text-amber-600 text-sm font-medium hover:text-amber-700"
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

// ── Adjust Stats Modal ────────────────────────────────────────
interface AdjustStatsModalProps {
  player: Player;
  teamId: string;
  onClose: () => void;
  onSave: (next: Player['stats']) => void | Promise<void>;
}

const STAT_FIELDS: { key: keyof Player['stats']; label: string; emoji: string; color: string }[] = [
  { key: 'goals',       label: 'Goals',     emoji: '⚽', color: 'text-emerald-600' },
  { key: 'assists',     label: 'Assists',   emoji: '🎯', color: 'text-cyan-600' },
  { key: 'saves',       label: 'Saves',     emoji: '🧤', color: 'text-violet-600' },
  { key: 'gamesPlayed', label: 'Games',     emoji: '🏆', color: 'text-amber-600' },
  { key: 'yellowCards', label: 'Yellow',    emoji: '🟨', color: 'text-yellow-600' },
  { key: 'redCards',    label: 'Red',       emoji: '🟥', color: 'text-red-600' },
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
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gradient-to-r from-amber-50 to-white sticky top-0">
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
              <div className="text-2xl w-8 text-center">{f.emoji}</div>
              <div className="flex-1">
                <p className={`text-sm font-bold ${f.color}`}>{f.label}</p>
                <p className="text-[11px] text-gray-500">Currently {(cur as any)[f.key] || 0}</p>
              </div>
              <button onClick={() => set(String(f.key), values[f.key] - 1)} className="w-9 h-9 rounded-full bg-white ring-1 ring-gray-200 text-lg font-bold text-gray-600 hover:bg-gray-100">−</button>
              <input
                type="number"
                min={0}
                value={values[f.key]}
                onChange={e => set(String(f.key), parseInt(e.target.value || '0', 10))}
                className="w-16 text-center font-bold text-gray-900 border border-gray-200 rounded-lg py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-300"
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
          <button onClick={handleSave} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-bold text-white bg-amber-500 hover:bg-amber-600 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save correction'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Stats;