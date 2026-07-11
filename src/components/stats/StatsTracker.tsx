import React, { useState, useEffect } from 'react';
import { Player, PlayerStats, GameStat } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';

interface StatsTrackerProps {
  isOpen: boolean;
  onClose: () => void;
  players: Player[];
  onStatsRecorded: (stats: GameStat) => void;
  gameId?: string;
  opponent?: string;
  initialPlayerId?: string;
}

const StatsTracker: React.FC<StatsTrackerProps> = ({
  isOpen,
  onClose,
  players,
  onStatsRecorded,
  gameId,
  opponent = 'Opponent',
  initialPlayerId = ''
}) => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const { addGameStat, updatePlayerStats } = useFirestore();

  const [selectedPlayer, setSelectedPlayer] = useState(initialPlayerId);
  const [statData, setStatData] = useState({
    goals: 0,
    assists: 0,
    saves: 0,
    yellowCards: 0,
    redCards: 0,
    minutesPlayed: 0
  });
  const [keyPlays, setKeyPlays] = useState<string[]>(['']);
  const [successMessage, setSuccessMessage] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedPlayerData = players.find(p => p.id === selectedPlayer);

  useEffect(() => {
    if (initialPlayerId) {
      setSelectedPlayer(initialPlayerId);
    }
  }, [initialPlayerId]);

  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(() => setSuccessMessage(''), 3000);
      return () => clearTimeout(timer);
    }
  }, [successMessage]);

  useEffect(() => {
    if (isOpen) {
      // Reset form when modal opens
      setStatData({
        goals: 0,
        assists: 0,
        saves: 0,
        yellowCards: 0,
        redCards: 0,
        minutesPlayed: 0
      });
      setKeyPlays(['']);
      setError('');
      setSuccessMessage('');
      if (!initialPlayerId) {
        setSelectedPlayer('');
      }
    }
  }, [isOpen, initialPlayerId]);

  const generateId = () => {
    return Date.now().toString() + Math.random().toString(36).substr(2, 9);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!selectedPlayer || !userData || !selectedPlayerData) {
      setError('Please select a player');
      return;
    }

    setIsSubmitting(true);
    setError('');

    try {
      const filteredKeyPlays = keyPlays.filter(play => play.trim() !== '');

      // Create game stat record
      const gameStatData: Omit<GameStat, 'id' | 'createdAt'> = {
        playerId: selectedPlayer,
        playerName: selectedPlayerData.name,
        gameId: gameId || generateId(),
        gameDate: new Date(),
        opponent: opponent,
        minutesPlayed: statData.minutesPlayed,
        teamId: selectedTeamId,
        goals: statData.goals,
        assists: statData.assists,
        yellowCards: statData.yellowCards,
        redCards: statData.redCards,
        saves: statData.saves,
        keyPlays: filteredKeyPlays,
        recordedBy: userData.uid,
        recordedByName: userData.name,
        updatedAt: new Date()
      };

      const statId = await addGameStat(gameStatData);

      // Update player's aggregate stats — guard each field individually
      // (older players may have stats missing some keys, which would produce NaN)
      const currentStats = selectedPlayerData.stats || {} as Partial<PlayerStats>;

      const updatedStats: PlayerStats = {
        goals: (currentStats.goals || 0) + statData.goals,
        assists: (currentStats.assists || 0) + statData.assists,
        saves: (currentStats.saves || 0) + statData.saves,
        yellowCards: (currentStats.yellowCards || 0) + statData.yellowCards,
        redCards: (currentStats.redCards || 0) + statData.redCards,
        minutesPlayed: (currentStats.minutesPlayed || 0) + statData.minutesPlayed,
        gamesPlayed: (currentStats.gamesPlayed || 0) + 1,
        cleanSheets: currentStats.cleanSheets || 0
      };

      await updatePlayerStats(selectedPlayer, updatedStats);
      // Fire first-stat badges on 0→N crossings. Non-fatal.
      try {
        const { maybeGrantFirstStatBadges } = await import('../../utils/badgeGrants');
        void maybeGrantFirstStatBadges(
          selectedPlayer,
          currentStats,
          updatedStats,
          {
            existingBadges: (selectedPlayerData as any).badges,
            context: opponent || 'Match',
            xpEnabled: (selectedTeam as any)?.xpConfig?.enabled === true,
          },
        );
      } catch { /* non-fatal */ }

      const newGameStat: GameStat = {
        id: statId,
        ...gameStatData,
        createdAt: new Date()
      };

      onStatsRecorded(newGameStat);
      setSuccessMessage(`Stats recorded for ${selectedPlayerData.name}!`);
      
      // Close modal after successful submission
      setTimeout(() => {
        onClose();
      }, 1500);

    } catch (error) {
      console.error('Error recording stats:', error);
      setError('Failed to record stats. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateStatValue = (field: keyof typeof statData, value: number) => {
    setStatData(prev => ({
      ...prev,
      [field]: Math.max(0, value)
    }));
  };

  const addKeyPlay = () => {
    setKeyPlays([...keyPlays, '']);
  };

  const updateKeyPlay = (index: number, value: string) => {
    const updated = [...keyPlays];
    updated[index] = value;
    setKeyPlays(updated);
  };

  const removeKeyPlay = (index: number) => {
    setKeyPlays(keyPlays.filter((_, i) => i !== index));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-screen overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-900">Record Player Stats</h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors duration-200"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="p-6">
          {successMessage && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
              <p className="text-green-600 text-sm">{successMessage}</p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
              <p className="text-red-600 text-sm">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Player Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Select Player *
              </label>
              <select
                value={selectedPlayer}
                onChange={(e) => setSelectedPlayer(e.target.value)}
                disabled={isSubmitting}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                required
              >
                <option value="">Choose a player...</option>
                {players.map(player => (
                  <option key={player.id} value={player.id}>
                    #{player.jerseyNumber} {player.name} ({player.position})
                  </option>
                ))}
              </select>
            </div>

            {/* Game Info */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Opponent
                </label>
                <input
                  type="text"
                  value={opponent}
                  disabled
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Minutes Played
                </label>
                <input
                  type="number"
                  min="0"
                  max="120"
                  value={statData.minutesPlayed}
                  onChange={(e) => updateStatValue('minutesPlayed', parseInt(e.target.value) || 0)}
                  disabled={isSubmitting}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                />
              </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Goals
                </label>
                <input
                  type="number"
                  min="0"
                  value={statData.goals}
                  onChange={(e) => updateStatValue('goals', parseInt(e.target.value) || 0)}
                  disabled={isSubmitting}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Assists
                </label>
                <input
                  type="number"
                  min="0"
                  value={statData.assists}
                  onChange={(e) => updateStatValue('assists', parseInt(e.target.value) || 0)}
                  disabled={isSubmitting}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                />
              </div>

              {/* Saves: keeper-only. We check selectedPlayerData rather
                  than the player list since this card is tied to one
                  player at a time. */}
              {(() => {
                const positions: string[] = Array.isArray((selectedPlayerData as any)?.positions) && (selectedPlayerData as any).positions.length > 0
                  ? (selectedPlayerData as any).positions
                  : (selectedPlayerData?.position ? [selectedPlayerData.position] : []);
                const isKeeper = positions.some(p => p?.toLowerCase() === 'goalkeeper');
                if (!isKeeper) return null;
                return (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Saves
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={statData.saves}
                      onChange={(e) => updateStatValue('saves', parseInt(e.target.value) || 0)}
                      disabled={isSubmitting}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                    />
                  </div>
                );
              })()}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Yellow Cards
                </label>
                <input
                  type="number"
                  min="0"
                  value={statData.yellowCards}
                  onChange={(e) => updateStatValue('yellowCards', parseInt(e.target.value) || 0)}
                  disabled={isSubmitting}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Red Cards
                </label>
                <input
                  type="number"
                  min="0"
                  value={statData.redCards}
                  onChange={(e) => updateStatValue('redCards', parseInt(e.target.value) || 0)}
                  disabled={isSubmitting}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                />
              </div>
            </div>

            {/* Key Plays */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Key Plays (Optional)
              </label>
              <div className="space-y-2">
                {keyPlays.map((play, index) => (
                  <div key={index} className="flex space-x-2">
                    <input
                      type="text"
                      value={play}
                      onChange={(e) => updateKeyPlay(index, e.target.value)}
                      placeholder="Describe a key play..."
                      disabled={isSubmitting}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                    />
                    {keyPlays.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeKeyPlay(index)}
                        disabled={isSubmitting}
                        className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors duration-200"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
              
              {keyPlays.length < 5 && (
                <button
                  type="button"
                  onClick={addKeyPlay}
                  disabled={isSubmitting}
                  className="mt-2 text-charcoal-600 hover:text-charcoal-700 text-sm font-medium"
                >
                  + Add Key Play
                </button>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex space-x-4 pt-4 border-t border-gray-200">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !selectedPlayer}
                className="flex-1 bg-surface-tint hover:bg-surface-raised text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 flex items-center justify-center"
              >
                {isSubmitting ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                ) : (
                  'Record Stats'
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default StatsTracker;