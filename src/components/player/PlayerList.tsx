import React, { useState, useEffect } from 'react';
import { Player } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';
import { isCoach } from '../../utils/helpers';
import { collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import PlayerCard from './PlayerCard';
import AddPlayer from './AddPlayer';

interface PlayerListProps {
  searchTerm?: string;
  positionFilter?: string;
}

const PlayerList: React.FC<PlayerListProps> = ({ searchTerm = '', positionFilter = '' }) => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getPlayersByTeam } = useFirestore();
  const [players, setPlayers] = useState<Player[]>([]);
  const [filteredPlayers, setFilteredPlayers] = useState<Player[]>([]);
  const [isAddPlayerOpen, setIsAddPlayerOpen] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<Player | null>(null);
  const [sortBy, setSortBy] = useState<'name' | 'jerseyNumber' | 'position' | 'goals'>('jerseyNumber');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [isLoading, setIsLoading] = useState(true);

  const isUserCoach = userData ? isCoach(userData.role) : false;

  // Direct Firestore subscription — load all active players, filter by team client-side
  // This avoids composite index issues with teamIds/teamId + isActive + orderBy
  useEffect(() => {
    if (!selectedTeamId) {
      setPlayers([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    const q = query(
      collection(db, 'players'),
      where('isActive', '==', true)
    );

    const unsub = onSnapshot(q, snap => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Filter client-side: player belongs to team if teamIds includes it OR legacy teamId matches
      const teamPlayers = all.filter((p: any) => {
        if (p.teamIds && Array.isArray(p.teamIds) && p.teamIds.includes(selectedTeamId)) return true;
        if (p.teamId === selectedTeamId) return true;
        return false;
      });
      // Sort by jersey number
      teamPlayers.sort((a: any, b: any) => (a.jerseyNumber || 999) - (b.jerseyNumber || 999));

      const playersWithDates = teamPlayers.map((player: any) => ({
        ...player,
        createdAt: player.createdAt?.toDate ? player.createdAt.toDate() : new Date(player.createdAt || Date.now()),
        dateOfBirth: player.dateOfBirth?.toDate ? player.dateOfBirth.toDate() : (player.dateOfBirth ? new Date(player.dateOfBirth) : undefined),
      })) as Player[];
      setPlayers(playersWithDates);
      setIsLoading(false);
    }, err => {
      console.error('Players subscription error:', err);
      setIsLoading(false);
    });

    return () => unsub();
  }, [selectedTeamId]);

  // Filter and sort players
  useEffect(() => {
    let filtered = players.filter(player => {
      const matchesSearch = player.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                           player.jerseyNumber?.toString().includes(searchTerm);
      const matchesPosition = !positionFilter || player.position === positionFilter;
      return matchesSearch && matchesPosition;
    });

    // Sort players
    filtered.sort((a, b) => {
      let aValue: any = a[sortBy];
      let bValue: any = b[sortBy];

      // Handle potential undefined values
      if (sortBy === 'goals') {
        aValue = a.stats?.goals || 0;
        bValue = b.stats?.goals || 0;
      }

      if (sortBy === 'name') {
        aValue = aValue?.toLowerCase() || '';
        bValue = bValue?.toLowerCase() || '';
      }

      if (sortOrder === 'asc') {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
      } else {
        return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
      }
    });

    setFilteredPlayers(filtered);
  }, [players, searchTerm, positionFilter, sortBy, sortOrder]);

  const handlePlayerAdded = (newPlayer: Player) => {
    console.log('handlePlayerAdded called with:', newPlayer);
    
    if (editingPlayer) {
      // Update existing player
      console.log('Updating existing player in local state');
      setPlayers(prevPlayers =>
        prevPlayers.map(player =>
          player.id === newPlayer.id ? newPlayer : player
        )
      );
      setEditingPlayer(null);
    } else {
      // Add new player
      console.log('Adding new player to local state');
      setPlayers(prevPlayers => {
        // Check if player already exists (in case real-time update already added it)
        const exists = prevPlayers.some(p => p.id === newPlayer.id);
        if (exists) {
          console.log('Player already exists in state, updating instead');
          return prevPlayers.map(p => p.id === newPlayer.id ? newPlayer : p);
        }
        return [...prevPlayers, newPlayer];
      });
    }
    setIsAddPlayerOpen(false);

    // The onSnapshot listeners will automatically pick up changes
  };

  const handlePlayerDeleted = (playerId: string) => {
    console.log('Player deleted:', playerId);
    setPlayers(prevPlayers => prevPlayers.filter(player => player.id !== playerId));
  };

  const handleEditPlayer = (player: Player) => {
    setEditingPlayer(player);
    setIsAddPlayerOpen(true);
  };

  const handleSort = (newSortBy: typeof sortBy) => {
    if (sortBy === newSortBy) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(newSortBy);
      setSortOrder('asc');
    }
  };

  const getSortIcon = (column: typeof sortBy) => {
    if (sortBy !== column) {
      return (
        <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
      );
    }
    
    return sortOrder === 'asc' ? (
      <svg className="w-4 h-4 text-cyan-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
      </svg>
    ) : (
      <svg className="w-4 h-4 text-cyan-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
      </svg>
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center space-y-3">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-cyan-200 border-t-cyan-500" />
          <span className="text-sm text-gray-400 font-medium">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Debug info */}
      {process.env.NODE_ENV === 'development' && (
        <div className="bg-gray-100 p-2 rounded text-xs">
          <p>Players count: {players.length}</p>
          <p>Team ID: {selectedTeamId}</p>
        </div>
      )}

      {/* Header with sort options and add button */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center space-x-4">
          <h2 className="text-lg font-semibold text-white">
            Team Players ({filteredPlayers.length})
          </h2>

          {/* Sort options */}
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-300">Sort by:</span>
            <div className="flex space-x-1">
              {[
                { key: 'jerseyNumber' as const, label: '#' },
                { key: 'name' as const, label: 'Name' },
                { key: 'position' as const, label: 'Position' },
                { key: 'goals' as const, label: 'Goals' }
              ].map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => handleSort(key)}
                  className={`px-2 py-1 text-sm rounded-lg flex items-center space-x-1 transition-colors duration-200 ${
                    sortBy === key
                      ? 'bg-cyan-500/10 text-cyan-300'
                      : 'text-gray-300 hover:bg-white/10'
                  }`}
                >
                  <span>{label}</span>
                  {getSortIcon(key)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Add Player Button (Coach only) */}
        {isUserCoach && (
          <button
            onClick={() => {
              setEditingPlayer(null);
              setIsAddPlayerOpen(true);
            }}
            className="bg-cyan-600 hover:bg-cyan-700 text-white font-semibold py-2 px-4 rounded-xl transition duration-200 flex items-center space-x-2 shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>Add Player</span>
          </button>
        )}
      </div>

      {/* Players Grid */}
      {filteredPlayers.length === 0 ? (
        <div className="card-modern text-center py-12 px-6">
          <div className="text-gray-400 mb-4">
            <svg className="mx-auto h-16 w-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">No Players Found</h3>
          <p className="text-gray-300 mb-4">
            {searchTerm || positionFilter
              ? 'No players match your current filters.'
              : 'No players have been added to the team yet.'}
          </p>
          {isUserCoach && !searchTerm && !positionFilter && (
            <button
              onClick={() => {
                setEditingPlayer(null);
                setIsAddPlayerOpen(true);
              }}
              className="bg-cyan-600 hover:bg-cyan-700 text-white font-semibold py-2 px-4 rounded-xl transition duration-200"
            >
              Add Your First Player
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredPlayers.map((player) => (
            <PlayerCard
              key={player.id}
              player={player}
              onEdit={handleEditPlayer}
              onDelete={handlePlayerDeleted}
              showActions={true}
            />
          ))}
        </div>
      )}

      {/* Add/Edit Player Modal */}
      <AddPlayer
        isOpen={isAddPlayerOpen}
        onClose={() => {
          setIsAddPlayerOpen(false);
          setEditingPlayer(null);
        }}
        onPlayerAdded={handlePlayerAdded}
        editingPlayer={editingPlayer}
        existingPlayers={players}
      />
    </div>
  );
};

export default PlayerList;