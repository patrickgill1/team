import React, { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { Team, Player, CoachInvite } from '../types';
import { isCoach } from '../utils/helpers';

const TeamManagement: React.FC = () => {
  const { userData } = useAuth();
  const { teams, refreshTeams, selectedTeamId } = useTeam();
  const { createTeam, updateTeam, updateDocument, getDocuments, addCoachInvite, getCoachInvitesByTeam, getPlayersByTeam, deleteDocument } = useFirestore();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showInviteCoachModal, setShowInviteCoachModal] = useState(false);
  const [showSharePlayerModal, setShowSharePlayerModal] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [allPlayers, setAllPlayers] = useState<Player[]>([]);
  const [coachInvites, setCoachInvites] = useState<CoachInvite[]>([]);
  const [loading, setLoading] = useState(true);

  // Form states
  const [teamName, setTeamName] = useState('');
  const [teamDescription, setTeamDescription] = useState('');
  const [teamSeason, setTeamSeason] = useState('');
  const [teamAgeGroup, setTeamAgeGroup] = useState('');
  const [teamLeague, setTeamLeague] = useState('');
  const [teamHomeField, setTeamHomeField] = useState('');

  // Coach invite form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLevel, setInviteLevel] = useState<'head_coach' | 'assistant_coach'>('assistant_coach');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  // Share player form
  const [selectedPlayerId, setSelectedPlayerId] = useState('');
  const [targetTeamId, setTargetTeamId] = useState('');

  // Transfer head coach
  const [showTransferModal, setShowTransferModal] = useState<Team | null>(null);
  const [teamCoaches, setTeamCoaches] = useState<any[]>([]);
  const [transferTargetId, setTransferTargetId] = useState('');

  // Add coach to another team
  const [showAddCoachToTeamModal, setShowAddCoachToTeamModal] = useState(false);
  const [addCoachUserId, setAddCoachUserId] = useState('');
  const [addCoachTargetTeamId, setAddCoachTargetTeamId] = useState('');
  const [allCoaches, setAllCoaches] = useState<any[]>([]);

  const isUserCoach = userData ? isCoach(userData.role) : false;

  useEffect(() => {
    loadData();
  }, [selectedTeamId]);

  const loadData = async () => {
    if (!selectedTeamId || !userData) return;
    try {
      setLoading(true);
      // Load players, invites, and coaches in parallel
      const [teamPlayersData, invites, allUsers] = await Promise.all([
        getDocuments('players', []),
        getCoachInvitesByTeam(selectedTeamId).catch(() => []),
        getDocuments('users', []).catch(() => [])
      ]);

      const teamPlayers = teamPlayersData
        .filter((p: any) => (p.teamId === selectedTeamId || p.teamIds?.includes(selectedTeamId)) && p.isActive)
        .map((p: any) => ({
          ...p,
          createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt)
        })) as Player[];
      setPlayers(teamPlayers);

      // Load ALL active players across all teams for sharing
      const allTeamPlayers = teamPlayersData
        .filter((p: any) => p.isActive)
        .map((p: any) => ({
          ...p,
          createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt)
        })) as Player[];
      setAllPlayers(allTeamPlayers);

      setCoachInvites(invites as any[]);

      const coaches = (allUsers as any[]).filter((u: any) => u.role === 'coach');
      setAllCoaches(coaches);
    } catch (error) {
      console.error('Error loading team data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateTeam = async () => {
    if (!userData || !teamName.trim()) return;
    try {
      const newTeamId = await createTeam({
        name: teamName.trim(),
        description: teamDescription.trim(),
        coachIds: [userData.uid],
        headCoachId: userData.uid,
        assistantCoachIds: [],
        playerIds: [],
        parentIds: [],
        season: teamSeason.trim(),
        ageGroup: teamAgeGroup.trim(),
        league: teamLeague.trim() || undefined,
        homeField: teamHomeField.trim() || undefined,
        updatedAt: new Date(),
      });

      // Add the new team to the user's teamIds
      const currentTeamIds = userData.teamIds || [userData.teamId];
      if (newTeamId && !currentTeamIds.includes(newTeamId)) {
        await updateDocument('users', userData.uid, {
          teamIds: [...currentTeamIds, newTeamId],
          updatedAt: new Date()
        });
      }

      resetForm();
      setShowCreateModal(false);
      await refreshTeams();
      // Reload the page data to reflect changes
      window.location.reload();
    } catch (error) {
      console.error('Error creating team:', error);
      alert('Failed to create team. Please try again.');
    }
  };

  const handleUpdateTeam = async () => {
    if (!editingTeam || !teamName.trim()) return;
    try {
      await updateTeam(editingTeam.id, {
        name: teamName.trim(),
        description: teamDescription.trim(),
        season: teamSeason.trim(),
        ageGroup: teamAgeGroup.trim(),
        league: teamLeague.trim() || undefined,
        homeField: teamHomeField.trim() || undefined,
      });
      resetForm();
      setEditingTeam(null);
      await refreshTeams();
    } catch (error) {
      console.error('Error updating team:', error);
      alert('Failed to update team. Please try again.');
    }
  };

  const generateInviteCode = () =>
    Math.random().toString(36).substring(2, 8).toUpperCase() +
    Math.random().toString(36).substring(2, 6).toUpperCase();

  const handleInviteCoach = async () => {
    if (!userData || !selectedTeamId) return;
    const selectedTeam = teams.find(t => t.id === selectedTeamId);
    if (!selectedTeam) return;

    try {
      const code = generateInviteCode();
      await addCoachInvite({
        teamId: selectedTeamId,
        teamName: selectedTeam.name,
        email: inviteEmail.trim().toLowerCase() || undefined,
        inviteCode: code,
        coachLevel: inviteLevel,
        invitedBy: userData.uid,
        invitedByName: userData.name,
        status: 'pending',
      });

      const link = `${window.location.origin}/coach-join?code=${code}`;
      setInviteLink(link);
      setLinkCopied(false);
      loadData();
    } catch (error) {
      console.error('Error inviting coach:', error);
      alert('Failed to send invite. Please try again.');
    }
  };

  const copyInviteLink = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 3000);
    } catch {
      // Fallback
      const input = document.createElement('input');
      input.value = inviteLink;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 3000);
    }
  };

  const handleSharePlayer = async () => {
    if (!selectedPlayerId || !targetTeamId) return;

    try {
      const player = allPlayers.find(p => p.id === selectedPlayerId);
      if (!player) return;

      // Add target team to player's teamIds
      const currentTeamIds = player.teamIds || [player.teamId];
      if (!currentTeamIds.includes(targetTeamId)) {
        await updateDocument('players', selectedPlayerId, {
          teamIds: [...currentTeamIds, targetTeamId],
          updatedAt: new Date()
        });
      }

      // Give parent(s) access to the target team
      if (player.parentIds?.length) {
        for (const parentId of player.parentIds) {
          try {
            const parentDoc = await getDocuments('users', []);
            const parent = parentDoc.find((u: any) => u.uid === parentId || u.id === parentId);
            if (parent) {
              const parentTeamIds = (parent as any).teamIds || [(parent as any).teamId];
              if (!parentTeamIds.includes(targetTeamId)) {
                await updateDocument('users', parentId, {
                  teamIds: [...parentTeamIds, targetTeamId],
                  updatedAt: new Date()
                });
              }
            }
          } catch (err) {
            console.error(`Error updating parent ${parentId}:`, err);
          }
        }
      }

      setSelectedPlayerId('');
      setTargetTeamId('');
      setShowSharePlayerModal(false);
      loadData();
      alert(`${player.name} has been shared with the selected team. Their parents can now access both teams.`);
    } catch (error) {
      console.error('Error sharing player:', error);
      alert('Failed to share player. Please try again.');
    }
  };

  const startEditTeam = (team: Team) => {
    setEditingTeam(team);
    setTeamName(team.name);
    setTeamDescription(team.description || '');
    setTeamSeason(team.season);
    setTeamAgeGroup(team.ageGroup);
    setTeamLeague(team.league || '');
    setTeamHomeField(team.homeField || '');
  };

  const handleOpenTransfer = async (team: Team) => {
    // Load coach users for this team
    try {
      const allUsers = await getDocuments('users', []);
      const coaches = allUsers.filter((u: any) =>
        u.role === 'coach' && team.coachIds?.includes(u.uid || u.id)
      );
      setTeamCoaches(coaches);
      setTransferTargetId('');
      setShowTransferModal(team);
    } catch (err) {
      console.error('Error loading coaches:', err);
      alert('Failed to load coach list.');
    }
  };

  const handleTransferHeadCoach = async () => {
    if (!showTransferModal || !transferTargetId || !userData) return;
    const team = showTransferModal;
    try {
      // Update team doc: set new head coach, move old one to assistants
      const newAssistants = (team.assistantCoachIds || [])
        .filter((id: string) => id !== transferTargetId);
      // Add current head coach to assistants (if they're not the same)
      if (team.headCoachId && team.headCoachId !== transferTargetId) {
        newAssistants.push(team.headCoachId);
      }

      await updateDocument('teams', team.id, {
        headCoachId: transferTargetId,
        assistantCoachIds: newAssistants,
        updatedAt: new Date(),
      });

      // Update new head coach's coachLevel
      await updateDocument('users', transferTargetId, {
        coachLevel: 'head_coach',
        updatedAt: new Date(),
      });

      // Demote old head coach to assistant (on user doc)
      if (team.headCoachId && team.headCoachId !== transferTargetId) {
        await updateDocument('users', team.headCoachId, {
          coachLevel: 'assistant_coach',
          updatedAt: new Date(),
        });
      }

      setShowTransferModal(null);
      setTransferTargetId('');
      await refreshTeams();
      alert('Head coach transferred successfully.');
    } catch (error) {
      console.error('Error transferring head coach:', error);
      alert('Failed to transfer head coach. Please try again.');
    }
  };

  const handleAddCoachToTeam = async () => {
    if (!addCoachUserId || !addCoachTargetTeamId) return;
    try {
      const coach = allCoaches.find((c: any) => (c.uid || c.id) === addCoachUserId);
      const team = teams.find(t => t.id === addCoachTargetTeamId);
      if (!coach || !team) return;

      // Add coach to team's coachIds and assistantCoachIds
      const currentCoachIds = team.coachIds || [];
      const currentAssistants = team.assistantCoachIds || [];
      const coachId = coach.uid || coach.id;

      if (!currentCoachIds.includes(coachId)) {
        await updateDocument('teams', team.id, {
          coachIds: [...currentCoachIds, coachId],
          assistantCoachIds: [...currentAssistants, coachId],
          updatedAt: new Date(),
        });
      }

      // Add team to coach's teamIds
      const coachTeamIds = coach.teamIds || [coach.teamId];
      if (!coachTeamIds.includes(team.id)) {
        await updateDocument('users', coachId, {
          teamIds: [...coachTeamIds, team.id],
          updatedAt: new Date(),
        });
      }

      setAddCoachUserId('');
      setAddCoachTargetTeamId('');
      setShowAddCoachToTeamModal(false);
      await refreshTeams();
      loadData();
      alert(`${coach.name} has been added to ${team.name} as an assistant coach.`);
    } catch (error) {
      console.error('Error adding coach to team:', error);
      alert('Failed to add coach to team. Please try again.');
    }
  };

  const resetForm = () => {
    setTeamName('');
    setTeamDescription('');
    setTeamSeason('');
    setTeamAgeGroup('');
    setTeamLeague('');
    setTeamHomeField('');
    setEditingTeam(null);
  };

  if (!isUserCoach) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-gray-900">Coach Access Required</h2>
          <p className="text-gray-600 mt-2">Only coaches can manage teams.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Team Management</h1>
              <p className="text-gray-600 mt-1">Create teams, invite coaches, and share players</p>
            </div>
            <div className="flex space-x-3">
              <button
                onClick={() => setShowAddCoachToTeamModal(true)}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center space-x-2"
              >
                <span>👨‍🏫</span>
                <span>Add Coach to Team</span>
              </button>
              <button
                onClick={() => setShowSharePlayerModal(true)}
                className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center space-x-2"
              >
                <span>🔄</span>
                <span>Share Player</span>
              </button>
              <button
                onClick={() => setShowInviteCoachModal(true)}
                className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center space-x-2"
              >
                <span>👨‍🏫</span>
                <span>Invite Coach</span>
              </button>
              <button
                onClick={() => { resetForm(); setShowCreateModal(true); }}
                className="bg-cyan-600 hover:bg-cyan-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center space-x-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
                <span>New Team</span>
              </button>
            </div>
          </div>
        </div>

        {/* Teams Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          {teams.map(team => (
            <div key={team.id} className={`bg-white rounded-xl shadow-sm border-2 p-6 transition-all ${
              team.id === selectedTeamId ? 'border-cyan-500 ring-2 ring-blue-100' : 'border-gray-200 hover:border-gray-300'
            }`}>
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">{team.name}</h3>
                  {team.description && (
                    <p className="text-sm text-gray-500 mt-1">{team.description}</p>
                  )}
                </div>
                {team.id === selectedTeamId && (
                  <span className="bg-cyan-50 text-cyan-700 text-xs font-medium px-2 py-1 rounded-full">Active</span>
                )}
              </div>

              <div className="space-y-2 text-sm text-gray-600">
                {team.ageGroup && <div>👶 Age Group: <span className="font-medium">{team.ageGroup}</span></div>}
                {team.season && <div>📅 Season: <span className="font-medium">{team.season}</span></div>}
                {team.league && <div>🏟️ League: <span className="font-medium">{team.league}</span></div>}
                <div>👥 Players: <span className="font-medium">
                  {allPlayers.filter(p => p.teamId === team.id || p.teamIds?.includes(team.id)).length}
                </span></div>
                <div>👨‍🏫 Coaches: <span className="font-medium">{team.coachIds?.length || 1}</span></div>
              </div>

              <div className="mt-4 flex space-x-2">
                <button
                  onClick={() => startEditTeam(team)}
                  className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  Edit
                </button>
                {(team.coachIds?.length || 0) > 1 && (
                  <button
                    onClick={() => handleOpenTransfer(team)}
                    className="flex-1 bg-amber-50 hover:bg-amber-100 text-amber-700 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    Transfer Head Coach
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Current Team Players */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-8">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            Players on {teams.find(t => t.id === selectedTeamId)?.name || 'Current Team'}
          </h2>
          {players.length === 0 ? (
            <p className="text-gray-500">No players on this team yet. Add players from the Players page.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {players.map(player => (
                <div key={player.id} className="flex items-center space-x-3 p-3 bg-gray-50 rounded-lg">
                  {player.profilePhotoUrl ? (
                    <div className="relative w-10 h-10 flex-shrink-0">
                      <img src={player.profilePhotoUrl} alt={player.name} className="w-10 h-10 rounded-full object-cover" />
                      {player.jerseyNumber != null && (
                        <span className="absolute -bottom-1 -right-1 bg-cyan-600 text-white rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center text-[10px] font-black shadow ring-2 ring-white">
                          {player.jerseyNumber}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="w-10 h-10 bg-cyan-50 rounded-full flex items-center justify-center text-cyan-600 font-bold text-sm flex-shrink-0">
                      {player.jerseyNumber || player.name.charAt(0)}
                    </div>
                  )}
                  <div>
                    <div className="font-medium text-gray-900">{player.name}</div>
                    <div className="text-xs text-gray-500">
                      {player.position || 'No position'} {player.jerseyNumber ? `• #${player.jerseyNumber}` : ''}
                    </div>
                    {(player.teamIds?.length || 0) > 1 && (
                      <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">Shared</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Coach Invites */}
        {coachInvites.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Coach Invitations</h2>
            <div className="space-y-3">
              {coachInvites.map((invite: any) => (
                <div key={invite.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <div className="font-medium text-gray-900">{invite.email}</div>
                    <div className="text-xs text-gray-500">
                      {invite.coachLevel === 'head_coach' ? 'Head Coach' : 'Assistant Coach'} • 
                      Invited by {invite.invitedByName}
                    </div>
                  </div>
                  <span className={`text-xs font-medium px-2 py-1 rounded-full ${
                    invite.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                    invite.status === 'accepted' ? 'bg-green-100 text-emerald-700' :
                    'bg-red-100 text-red-700'
                  }`}>
                    {invite.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Create/Edit Team Modal */}
        {(showCreateModal || editingTeam) && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
              <div className="p-6">
                <h2 className="text-xl font-bold text-gray-900 mb-4">
                  {editingTeam ? 'Edit Team' : 'Create New Team'}
                </h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Team Name *</label>
                    <input
                      type="text"
                      value={teamName}
                      onChange={e => setTeamName(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                      placeholder="e.g. U12 Lightning"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                    <textarea
                      value={teamDescription}
                      onChange={e => setTeamDescription(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                      rows={2}
                      placeholder="Brief description of this team"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Age Group</label>
                      <input
                        type="text"
                        value={teamAgeGroup}
                        onChange={e => setTeamAgeGroup(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                        placeholder="e.g. U12"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Season</label>
                      <input
                        type="text"
                        value={teamSeason}
                        onChange={e => setTeamSeason(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                        placeholder="e.g. Spring 2026"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">League</label>
                      <input
                        type="text"
                        value={teamLeague}
                        onChange={e => setTeamLeague(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                        placeholder="e.g. AYSO"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Home Field</label>
                      <input
                        type="text"
                        value={teamHomeField}
                        onChange={e => setTeamHomeField(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                        placeholder="e.g. River Park Field 3"
                      />
                    </div>
                  </div>
                </div>
                <div className="flex justify-end space-x-3 mt-6">
                  <button
                    onClick={() => { resetForm(); setShowCreateModal(false); setEditingTeam(null); }}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={editingTeam ? handleUpdateTeam : handleCreateTeam}
                    disabled={!teamName.trim()}
                    className="px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {editingTeam ? 'Save Changes' : 'Create Team'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Invite Coach Modal */}
        {showInviteCoachModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full">
              <div className="p-6">
                <h2 className="text-xl font-bold text-gray-900 mb-4">Invite a Coach</h2>
                <p className="text-sm text-gray-600 mb-4">
                  Generate an invite link to share with another coach. They'll use it to join {teams.find(t => t.id === selectedTeamId)?.name || 'this team'}.
                </p>

                {inviteLink ? (
                  <div className="space-y-4">
                    <div className="bg-emerald-50 border border-emerald-100 rounded-lg p-4">
                      <div className="flex items-center space-x-2 mb-2">
                        <span className="text-emerald-600 text-lg">✅</span>
                        <span className="font-medium text-green-800">Invite Created!</span>
                      </div>
                      <p className="text-sm text-emerald-700 mb-3">Share this link with the coach:</p>
                      <div className="flex items-center space-x-2">
                        <input
                          type="text"
                          readOnly
                          value={inviteLink}
                          className="flex-1 px-3 py-2 bg-white border border-green-300 rounded-lg text-sm font-mono"
                        />
                        <button
                          onClick={copyInviteLink}
                          className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                            linkCopied
                              ? 'bg-emerald-600 text-white'
                              : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                          }`}
                        >
                          {linkCopied ? '✓ Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                    <button
                      onClick={() => { setInviteLink(null); setInviteEmail(''); setShowInviteCoachModal(false); }}
                      className="w-full px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium"
                    >
                      Done
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Coach Email (optional)</label>
                        <input
                          type="email"
                          value={inviteEmail}
                          onChange={e => setInviteEmail(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                          placeholder="coach@example.com (optional)"
                        />
                        <p className="text-xs text-gray-500 mt-1">Leave blank if you don't have their email — just share the link</p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Coach Role</label>
                        <select
                          value={inviteLevel}
                          onChange={e => setInviteLevel(e.target.value as 'head_coach' | 'assistant_coach')}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                        >
                          <option value="assistant_coach">Assistant Coach — Can manage votes & view backend</option>
                          <option value="head_coach">Head Coach — Full admin access</option>
                        </select>
                      </div>
                    </div>
                    <div className="flex justify-end space-x-3 mt-6">
                      <button
                        onClick={() => { setInviteEmail(''); setInviteLink(null); setShowInviteCoachModal(false); }}
                        className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleInviteCoach}
                        className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700"
                      >
                        Generate Invite Link
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Transfer Head Coach Modal */}
        {showTransferModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full">
              <div className="p-6">
                <h2 className="text-xl font-bold text-gray-900 mb-2">Transfer Head Coach</h2>
                <p className="text-sm text-gray-600 mb-4">
                  Transfer the head coach role on <strong>{showTransferModal.name}</strong> to another coach. You will become an assistant coach.
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">New Head Coach *</label>
                    <select
                      value={transferTargetId}
                      onChange={e => setTransferTargetId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    >
                      <option value="">Choose a coach...</option>
                      {teamCoaches
                        .filter((c: any) => (c.uid || c.id) !== showTransferModal.headCoachId)
                        .map((c: any) => (
                          <option key={c.uid || c.id} value={c.uid || c.id}>
                            {c.name} ({c.email})
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
                <div className="flex justify-end space-x-3 mt-6">
                  <button
                    onClick={() => { setShowTransferModal(null); setTransferTargetId(''); }}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleTransferHeadCoach}
                    disabled={!transferTargetId}
                    className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
                  >
                    Transfer Role
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Share Player Modal */}
        {showSharePlayerModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full">
              <div className="p-6">
                <h2 className="text-xl font-bold text-gray-900 mb-2">Share Player Across Teams</h2>
                <p className="text-sm text-gray-600 mb-4">
                  Move or share a player to another team. Their parent(s) will automatically get access to the new team.
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Select Player *</label>
                    <select
                      value={selectedPlayerId}
                      onChange={e => setSelectedPlayerId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    >
                      <option value="">Choose a player...</option>
                      {allPlayers.map(player => (
                        <option key={player.id} value={player.id}>
                          {player.name} {player.jerseyNumber ? `(#${player.jerseyNumber})` : ''} — {teams.find(t => t.id === player.teamId)?.name || 'Unknown Team'}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Share To Team *</label>
                    <select
                      value={targetTeamId}
                      onChange={e => setTargetTeamId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    >
                      <option value="">Choose target team...</option>
                      {teams
                        .filter(t => {
                          const player = allPlayers.find(p => p.id === selectedPlayerId);
                          if (!player) return true;
                          const playerTeams = player.teamIds || [player.teamId];
                          return !playerTeams.includes(t.id);
                        })
                        .map(team => (
                          <option key={team.id} value={team.id}>{team.name}</option>
                        ))}
                    </select>
                  </div>
                </div>
                <div className="flex justify-end space-x-3 mt-6">
                  <button
                    onClick={() => { setSelectedPlayerId(''); setTargetTeamId(''); setShowSharePlayerModal(false); }}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSharePlayer}
                    disabled={!selectedPlayerId || !targetTeamId}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
                  >
                    Share Player
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Add Coach to Team Modal */}
        {showAddCoachToTeamModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full">
              <div className="p-6">
                <h2 className="text-xl font-bold text-gray-900 mb-2">Add Coach to Another Team</h2>
                <p className="text-sm text-gray-600 mb-4">
                  Give an existing coach access to an additional team. They'll be added as an assistant coach.
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Select Coach *</label>
                    <select
                      value={addCoachUserId}
                      onChange={e => setAddCoachUserId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    >
                      <option value="">Choose a coach...</option>
                      {allCoaches.map((c: any) => (
                        <option key={c.uid || c.id} value={c.uid || c.id}>
                          {c.name} ({c.email})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Add to Team *</label>
                    <select
                      value={addCoachTargetTeamId}
                      onChange={e => setAddCoachTargetTeamId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    >
                      <option value="">Choose target team...</option>
                      {teams
                        .filter(t => {
                          if (!addCoachUserId) return true;
                          // Only show teams this coach is NOT already on
                          return !t.coachIds?.includes(addCoachUserId);
                        })
                        .map(team => (
                          <option key={team.id} value={team.id}>{team.name}</option>
                        ))}
                    </select>
                  </div>
                </div>
                <div className="flex justify-end space-x-3 mt-6">
                  <button
                    onClick={() => { setAddCoachUserId(''); setAddCoachTargetTeamId(''); setShowAddCoachToTeamModal(false); }}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddCoachToTeam}
                    disabled={!addCoachUserId || !addCoachTargetTeamId}
                    className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                  >
                    Add to Team
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TeamManagement;
