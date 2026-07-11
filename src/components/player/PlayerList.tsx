import React, { useState, useEffect } from 'react';
import { Player } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';
import { isCoachOfTeam } from '../../utils/helpers';
import { collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import PlayerCard from './PlayerCard';
import AddPlayer from './AddPlayer';
import { computeTeamAttendancePercents } from '../../utils/attendance';

interface PlayerListProps {
  searchTerm?: string;
  positionFilter?: string;
}

const PlayerList: React.FC<PlayerListProps> = ({ searchTerm = '', positionFilter = '' }) => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const { getPlayersByTeam } = useFirestore();
  const [players, setPlayers] = useState<Player[]>([]);
  const [filteredPlayers, setFilteredPlayers] = useState<Player[]>([]);
  const [isAddPlayerOpen, setIsAddPlayerOpen] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<Player | null>(null);
  const [sortBy, setSortBy] = useState<'name' | 'jerseyNumber' | 'position' | 'goals'>('jerseyNumber');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [isLoading, setIsLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [inactivePlayers, setInactivePlayers] = useState<Player[]>([]);
  // Attendance % per player, batched from a single team-events fetch
  // so N cards don't do N identical queries. Recomputed when the roster
  // changes; null until first compute lands (card just skips the chip).
  const [attendanceByPlayerId, setAttendanceByPlayerId] = useState<Record<string, number | null>>({});

  const isUserCoach = isCoachOfTeam(userData, selectedTeam);

  // Direct Firestore subscription — load all active players, filter by team client-side
  // This avoids composite index issues with teamIds/teamId + isActive + orderBy
  // Map playerId → team-scoped stats from player_memberships (most
  // recent active membership for the selected team). Used to overlay
  // the all-team player.stats aggregate with the right team's numbers
  // so PlayerCard tiles read clean for shared players.
  const [teamStatsByPlayerId, setTeamStatsByPlayerId] = useState<Record<string, any>>({});

  // Subscribe to memberships scoped to the selected team. Updates the
  // stats overlay live as game stats land.
  useEffect(() => {
    if (!selectedTeamId) { setTeamStatsByPlayerId({}); return; }
    const mq = query(
      collection(db, 'player_memberships'),
      where('teamId', '==', selectedTeamId),
    );
    const unsub = onSnapshot(mq, snap => {
      const map: Record<string, any> = {};
      for (const d of snap.docs) {
        const data = d.data() as any;
        if (!data.stats) continue;
        // Prefer the most-recent active membership for this player.
        const existing = map[data.playerId];
        const candidateActive = data.isActive !== false;
        const existingActive = existing && existing.__isActive !== false;
        if (!existing || (candidateActive && !existingActive)) {
          map[data.playerId] = { ...data.stats, __isActive: candidateActive };
        }
      }
      setTeamStatsByPlayerId(map);
    }, () => { /* non-fatal */ });
    return () => unsub();
  }, [selectedTeamId]);

  useEffect(() => {
    if (!selectedTeamId) {
      setPlayers([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    // Scope to team roster. Was dumping every active player in the
    // database and filtering client-side — same PII-leak class as
    // Sports Connect's cross-club exposure. isActive is filtered
    // client-side to keep the query on a single non-composite index.
    const q = query(
      collection(db, 'players'),
      where('teamIds', 'array-contains', selectedTeamId)
    );

    const unsub = onSnapshot(q, snap => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const teamPlayers = all.filter((p: any) => p.isActive !== false);
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

  // Batched attendance % for the whole Squad grid — pulls team events
  // once (up to 30-team `in` chunk) and derives per-player % from the
  // shared list. Fires whenever the active roster identity changes.
  useEffect(() => {
    if (!selectedTeamId || players.length === 0) {
      setAttendanceByPlayerId({});
      return;
    }
    let cancelled = false;
    const ids = players.map(p => p.id);
    computeTeamAttendancePercents(ids, [selectedTeamId], { lookback: 10 })
      .then(map => { if (!cancelled) setAttendanceByPlayerId(map); })
      .catch(() => { /* non-fatal; card just hides the chip */ });
    return () => { cancelled = true; };
  }, [selectedTeamId, players]);

  // Optionally subscribe to inactive players when the toggle is on.
  useEffect(() => {
    if (!selectedTeamId || !showInactive) {
      setInactivePlayers([]);
      return;
    }
    // Same team-scope fix as the active-players query above.
    const q = query(collection(db, 'players'), where('teamIds', 'array-contains', selectedTeamId));
    const unsub = onSnapshot(q, (snap) => {
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data() } as any));
      const teamPlayers = all.filter((p: any) => p.isActive === false);
      teamPlayers.sort((a: any, b: any) => (a.jerseyNumber || 999) - (b.jerseyNumber || 999));
      setInactivePlayers(teamPlayers.map((p: any) => ({
        ...p,
        createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt || Date.now()),
        dateOfBirth: p.dateOfBirth?.toDate ? p.dateOfBirth.toDate() : (p.dateOfBirth ? new Date(p.dateOfBirth) : undefined),
      })));
    });
    return () => unsub();
  }, [selectedTeamId, showInactive]);

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
      <svg className="w-4 h-4 text-brand-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
      </svg>
    ) : (
      <svg className="w-4 h-4 text-brand-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
      </svg>
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center space-y-3">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-brand-primary-soft border-t-cyan-500" />
          <span className="text-sm text-gray-400 font-medium">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header — count, sort pills, action buttons */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xs font-extrabold tracking-widest uppercase text-slate-600">
            Roster <span className="text-slate-400 ml-0.5">{filteredPlayers.length}</span>
          </h2>
          <div className="flex gap-1">
            {[
              { key: 'jerseyNumber' as const, label: '#' },
              { key: 'name' as const, label: 'NAME' },
              { key: 'position' as const, label: 'POS' },
              { key: 'goals' as const, label: 'GOALS' },
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => handleSort(key)}
                className={`px-2 py-1 text-[10px] font-extrabold tracking-widest uppercase rounded-md border ${
                  sortBy === key
                    ? 'bg-brand-primary-soft text-brand-primary border-brand-primary-soft'
                    : 'bg-white text-slate-500 border-slate-200 hover:text-slate-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {isUserCoach && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowInactive((v) => !v)}
              className={`px-2.5 py-1 text-[10px] font-extrabold tracking-widest uppercase rounded-md border ${
                showInactive
                  ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                  : 'bg-white text-slate-500 border-slate-200 hover:text-slate-800'
              }`}
              title="Show inactive (returning) players"
            >
              {showInactive ? `Inactive ${inactivePlayers.length}` : 'Past'}
            </button>
            <button
              onClick={() => { setEditingPlayer(null); setIsAddPlayerOpen(true); }}
              className="bg-gradient-to-br from-brand-primary to-surface-tint text-white text-xs font-extrabold tracking-widest uppercase py-1.5 px-3 rounded-md shadow-sm hover:from-brand-primary-soft hover:to-brand-primary flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Add
            </button>
          </div>
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
          <h3 className="text-lg font-semibold text-charcoal-950 mb-2">No Players Found</h3>
          <p className="text-gray-600 mb-4">
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
              className="bg-brand-primary hover:bg-brand-primary text-white font-semibold py-2 px-4 rounded-xl transition duration-200"
            >
              Add Your First Player
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-5 sm:gap-6">
          {filteredPlayers.map((player) => {
            // Overlay this team's membership stats so shared players
            // (rostered on multiple teams) show clean numbers here
            // instead of the all-team aggregate baked into player.stats.
            const teamStats = teamStatsByPlayerId[player.id];
            // Team-scoped roster: ONLY show this team's stats. If no
            // membership row exists for this team yet, force zeros —
            // the global player.stats aggregate carries history from
            // other teams the player has been on and shouldn't leak
            // into a new team's view. Per-team history still lives on
            // the player profile's "career" toggle.
            const zeroStats = { goals: 0, assists: 0, saves: 0, gamesPlayed: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0, cleanSheets: 0 };
            const scoped = {
              ...(player as any),
              stats: teamStats
                ? { ...teamStats, __isActive: undefined }
                : zeroStats,
            };
            return (
              <PlayerCard
                key={player.id}
                player={scoped as Player}
                onEdit={handleEditPlayer}
                onDelete={handlePlayerDeleted}
                showActions={true}
                selectedTeamId={selectedTeamId}
                attendancePct={attendanceByPlayerId[player.id] ?? null}
              />
            );
          })}
        </div>
      )}

      {/* Inactive players (toggle, coach-only) */}
      {showInactive && inactivePlayers.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 mt-4">
            <h3 className="text-base font-bold text-gray-700">Past Players ({inactivePlayers.length})</h3>
            <span className="text-xs text-gray-500">Click "Bring Back" to add a returning player to the current season</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 opacity-80">
            {inactivePlayers.map((player) => (
              <PlayerCard
                key={player.id}
                player={player}
                onEdit={handleEditPlayer}
                onDelete={handlePlayerDeleted}
                showActions={true}
              />
            ))}
          </div>
        </div>
      )}
      {showInactive && inactivePlayers.length === 0 && (
        <div className="text-center py-8 text-sm text-gray-500">No inactive players for this team.</div>
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