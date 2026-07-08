import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { Team, Player, CoachInvite, Invite } from '../types';
import { isCoach } from '../utils/helpers';
import { createStaffInvite } from '../utils/invites';
import { getShareOrigin } from '../utils/origin';
import InviteShareModal from '../components/common/InviteShareModal';
import EndSeasonModal from '../components/team/EndSeasonModal';
import NewSeasonModal from '../components/team/NewSeasonModal';
import ManageSeasonsModal from '../components/team/ManageSeasonsModal';
import MediaAccessModal from '../components/team/MediaAccessModal';
import { useActiveSeason } from '../hooks/useActiveSeason';

const TeamManagement: React.FC = () => {
  const { userData } = useAuth();
  const { teams, refreshTeams, selectedTeamId, setSelectedTeamId } = useTeam();
  const { createTeam, updateTeam, updateDocument, getDocuments, getCoachInvitesByTeam, getPlayersByTeam, deleteDocument } = useFirestore();

  const [showCreateModal, setShowCreateModal] = useState(false);
  // showInviteCoachModal + the matching modal at the bottom of
  // this file were retired with the unified invite flow that now
  // funnels through generateShareInvite() / InviteShareModal.
  // State removed v3.2.63.
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
  const [teamFormat, setTeamFormat] = useState<'7v7' | '9v9' | '11v11'>('7v7');
  const [teamHomeKit, setTeamHomeKit] = useState('');
  const [teamAwayKit, setTeamAwayKit] = useState('');
  // Adult vs youth switch — drives Player Circle / Whispers /
  // Development Pathway visibility on this team's surfaces + swaps
  // the roster field set (adult adds position/foot/past clubs).
  const [teamAudience, setTeamAudience] = useState<'youth' | 'adult'>('youth');
  const [teamPublicFixtures, setTeamPublicFixtures] = useState<boolean>(false);
  // Weekly Team Wall summary — coach opts in per team, picks the
  // day. Default OFF so quiet teams stay quiet and Sunday-observing
  // families never get a surprise post on the Sabbath.
  const [teamDigestEnabled, setTeamDigestEnabled] = useState<boolean>(false);
  const [teamDigestDay, setTeamDigestDay] = useState<0 | 1 | 2 | 3 | 4 | 5 | 6>(1);

  // Coach invite form
  // inviteEmail / inviteLevel / inviteLink / linkCopied state
  // removed v3.2.63 with the dead Invite Coach modal.

  // Share player form
  const [selectedPlayerId, setSelectedPlayerId] = useState('');
  const [targetTeamId, setTargetTeamId] = useState('');

  // Transfer head coach
  const [showTransferModal, setShowTransferModal] = useState<Team | null>(null);
  const [teamCoaches, setTeamCoaches] = useState<any[]>([]);
  const [transferTargetId, setTransferTargetId] = useState('');

  // New share-link invite (Phase 3 invites redesign)
  const [activeShareInvite, setActiveShareInvite] = useState<Invite | null>(null);
  const [generatingShareInvite, setGeneratingShareInvite] = useState(false);

  // End-of-season flow
  const [endSeasonOpen, setEndSeasonOpen] = useState(false);
  const [newSeasonOpen, setNewSeasonOpen] = useState(false);
  const [manageSeasonsOpen, setManageSeasonsOpen] = useState(false);
  const [mediaAccessOpen, setMediaAccessOpen] = useState(false);
  const { season: activeSeasonForSelected } = useActiveSeason();

  const generateShareInvite = async (role: 'assistant_coach' | 'team_manager') => {
    if (!userData || !selectedTeamId) return;
    setGeneratingShareInvite(true);
    try {
      const inv = await createStaffInvite({
        teamId: selectedTeamId,
        role,
        createdBy: userData.uid,
      });
      setActiveShareInvite(inv);
    } catch (err) {
      console.error('createStaffInvite failed', err);
      alert('Could not generate invite link.');
    } finally {
      setGeneratingShareInvite(false);
    }
  };

  // Add coach to another team
  const [showAddCoachToTeamModal, setShowAddCoachToTeamModal] = useState(false);
  const [addCoachUserId, setAddCoachUserId] = useState('');
  const [addCoachTargetTeamId, setAddCoachTargetTeamId] = useState('');
  const [allCoaches, setAllCoaches] = useState<any[]>([]);

  const isUserCoach = userData ? isCoach(userData.role) : false;
  const isUserClubAdmin = !!(userData as any)?.isClubAdmin;

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
      // Worker creates the team + patches the user in one call.
      // withDefaultClub:false because this is coach-side team-mgmt,
      // not solo-coach onboarding — the club (if any) already exists.
      const { workerFetch } = await import('../utils/workerFetch');
      const res = await workerFetch('/teams/create', {
        method: 'POST',
        body: JSON.stringify({
          name: teamName.trim(),
          season: teamSeason.trim(),
          ageGroup: teamAgeGroup.trim(),
          format: teamFormat,
          audienceType: teamAudience,
        }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error || `create-${res.status}`);
      const newTeamId = data.teamId as string;
      // Patch non-critical extras client-side (description, league,
      // homeField, kit colors) — the /teams/create endpoint only
      // knows the security-critical fields.
      const extras: Record<string, any> = { updatedAt: new Date() };
      if (teamDescription.trim()) extras.description = teamDescription.trim();
      if (teamLeague.trim()) extras.league = teamLeague.trim();
      if (teamHomeField.trim()) extras.homeField = teamHomeField.trim();
      if (teamHomeKit.trim()) extras.homeKitColor = teamHomeKit.trim();
      if (teamAwayKit.trim()) extras.awayKitColor = teamAwayKit.trim();
      if (teamAudience === 'adult') extras.audienceType = 'adult';
      if (Object.keys(extras).length > 1) {
        await updateDocument('teams', newTeamId, extras).catch(() => undefined);
      }

      resetForm();
      setShowCreateModal(false);
      await refreshTeams();
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
        format: teamFormat,
        homeKitColor: teamHomeKit.trim() || undefined,
        awayKitColor: teamAwayKit.trim() || undefined,
        audienceType: teamAudience,
        publicFixturesEnabled: teamPublicFixtures,
        wallDigestConfig: teamDigestEnabled
          ? { enabled: true, dayOfWeek: teamDigestDay }
          : { enabled: false, dayOfWeek: teamDigestDay },
      });
      resetForm();
      setEditingTeam(null);
      await refreshTeams();
    } catch (error) {
      console.error('Error updating team:', error);
      alert('Failed to update team. Please try again.');
    }
  };

  // handleInviteCoach + copyInviteLink retired v3.2.63 together
  // with the dead Invite Coach modal — invite flow now goes
  // through generateShareInvite() (lines 66-82) +
  // InviteShareModal.

  const handleSharePlayer = async () => {
    if (!selectedPlayerId || !targetTeamId || !selectedTeamId) return;
    try {
      const player = allPlayers.find(p => p.id === selectedPlayerId);
      if (!player) return;
      // Worker verifies caller coaches BOTH source and target teams,
      // atomically updates player.teamIds, team.playerIds, and fans
      // out user.teamIds to every parent.
      const { workerFetch } = await import('../utils/workerFetch');
      const res = await workerFetch('/teams/share-player', {
        method: 'POST',
        body: JSON.stringify({
          fromTeamId: selectedTeamId,
          toTeamId: targetTeamId,
          playerId: selectedPlayerId,
        }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error || `share-${res.status}`);
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

  // Remove a player from a team they were previously shared into. Reverses the
  // sharePlayer flow: trims the team from the player's teamIds, and for each
  // parent of this player, drops that team from THEIR teamIds *unless* the
  // parent still has another player on the same team (so we don't accidentally
  // lock them out of a team they're legitimately tied to via another child).
  const handleUnsharePlayer = async (playerId: string, teamIdToRemove: string) => {
    const player = allPlayers.find(p => p.id === playerId);
    if (!player) return;

    const team = teams.find(t => t.id === teamIdToRemove);
    const teamName = team?.name || 'this team';

    const currentTeamIds = player.teamIds || (player.teamId ? [player.teamId] : []);
    if (!currentTeamIds.includes(teamIdToRemove)) {
      alert(`${player.name} is not on ${teamName}.`);
      return;
    }
    if (currentTeamIds.length <= 1) {
      alert(`${player.name} is only on ${teamName}. Move them to a different team first if you want to remove them from this one.`);
      return;
    }

    if (!window.confirm(`Remove ${player.name} from ${teamName}? Their parents will lose access to this team unless another of their kids is also on it.`)) {
      return;
    }

    try {
      // Worker handles the player.teamIds trim + parent fan-out
      // (with the "another player still ties them to this team"
      // guard) atomically.
      const { workerFetch } = await import('../utils/workerFetch');
      const res = await workerFetch('/teams/unshare-player', {
        method: 'POST',
        body: JSON.stringify({ teamId: teamIdToRemove, playerId }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error || `unshare-${res.status}`);
      loadData();
      alert(`${player.name} removed from ${teamName}.`);
    } catch (err) {
      console.error('Error unsharing player:', err);
      alert('Failed to remove player from team. Please try again.');
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
    setTeamFormat((team as any).format || '7v7');
    setTeamHomeKit(team.homeKitColor || '');
    setTeamAwayKit(team.awayKitColor || '');
    setTeamAudience(team.audienceType === 'adult' ? 'adult' : 'youth');
    setTeamPublicFixtures(team.publicFixturesEnabled === true);
    setTeamDigestEnabled((team as any).wallDigestConfig?.enabled === true);
    setTeamDigestDay(((team as any).wallDigestConfig?.dayOfWeek ?? 1) as any);
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
      const { workerFetch } = await import('../utils/workerFetch');
      const res = await workerFetch('/teams/transfer-head', {
        method: 'POST',
        body: JSON.stringify({ teamId: team.id, newHeadCoachUid: transferTargetId }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error || `transfer-${res.status}`);
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
      const coachId = coach.uid || coach.id;

      // Worker verifies caller is a coach on the target team, then
      // atomically writes team.coachIds + user.teamIds. assistantCoachIds
      // still lives client-side (non-security-critical labeling).
      const { workerFetch } = await import('../utils/workerFetch');
      const res = await workerFetch('/teams/add-coach', {
        method: 'POST',
        body: JSON.stringify({ teamId: team.id, coachUid: coachId, coachLevel: 'assistant' }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error || `add-coach-${res.status}`);
      // Also maintain the legacy assistantCoachIds label array
      // client-side. This is a UI-scoped field; the worker only
      // owns the security-critical coachIds.
      const currentAssistants = team.assistantCoachIds || [];
      if (!currentAssistants.includes(coachId)) {
        await updateDocument('teams', team.id, {
          assistantCoachIds: [...currentAssistants, coachId],
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
    setTeamFormat('7v7');
    setTeamHomeKit('');
    setTeamAwayKit('');
    setTeamAudience('youth');
    setTeamPublicFixtures(false);
    setTeamDigestEnabled(false);
    setTeamDigestDay(1);
    setEditingTeam(null);
  };

  if (!isUserCoach) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-ink-primary">Coach Access Required</h2>
          <p className="text-ink-primary/65 mt-2">Only coaches can manage teams.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-primary"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-base">
      {/* Navy page header to match the rest of the new chrome. The
          "+ New team" primary action sits in the header's action slot
          (the small button on the right) — same pattern as Events. */}
      <header className="bg-gradient-to-b from-surface-base to-surface-elevated border-b border-brand-primary/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight">Your Teams</h1>
            <p className="mt-0.5 text-xs text-ink-primary/40">
              Spin up, edit, retire. Squad and families live in <Link to="/people" className="text-ink-primary/65 hover:text-ink-primary underline">People</Link>
              {isUserClubAdmin && (
                <>
                  {' · '}
                  <Link to="/club" className="text-ink-primary/65 hover:text-ink-primary underline">Club view</Link>
                </>
              )}.
            </p>
          </div>
          <button
            onClick={() => { resetForm(); setShowCreateModal(true); }}
            aria-label="Add team"
            className="w-9 h-9 rounded-full bg-gradient-to-br from-brand-primary to-surface-tint text-white flex items-center justify-center shadow-lg shadow-brand-primary/30 hover:from-brand-primary-soft hover:to-brand-primary flex-shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 space-y-3">
        {/* Per-team config actions — only the truly team-level stuff
            stays here. Adding players, sharing players, inviting
            coaches all live in the People directory now. */}
        <div className="bg-surface-elevated rounded-xl border border-line-default/10 shadow-sm p-3 flex flex-wrap gap-2">
          <SecondaryAction emoji="" label="New season" onClick={() => setNewSeasonOpen(true)} />
          <SecondaryAction emoji="" label="Manage seasons" onClick={() => setManageSeasonsOpen(true)} />
          <SecondaryAction emoji="" label="Media access" onClick={() => setMediaAccessOpen(true)} />
          {activeSeasonForSelected && (
            <button
              onClick={() => setEndSeasonOpen(true)}
              className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md border bg-rose-500/15 text-rose-300 border-rose-400/30 hover:bg-rose-500/20"
              title={`Archive "${activeSeasonForSelected.name}" and pick which players carry over`}
            >
              End {activeSeasonForSelected.name}
            </button>
          )}
        </div>

        {/* Teams Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          {teams.map(team => {
            const isActive = team.id === selectedTeamId;
            return (
              <div
                key={team.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedTeamId(team.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedTeamId(team.id); }}
                className={`bg-surface-elevated rounded-xl shadow-sm border-2 p-6 transition-all cursor-pointer hover:shadow-md active:scale-[0.99] ${
                  isActive ? 'border-brand-primary ring-2 ring-brand-primary-soft' : 'border-line-default/10 hover:border-brand-primary-soft/40'
                }`}
              >
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-bold text-ink-primary">{team.name}</h3>
                    {team.description && (
                      <p className="text-sm text-ink-primary/50 mt-1">{team.description}</p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    {(team as any).isActive === false && (
                      <span className="bg-line-default/[0.08] text-ink-primary/65 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full ring-1 ring-line-default/15">
                        Archived
                      </span>
                    )}
                    {isActive ? (
                      <span className="bg-brand-primary/15 text-brand-primary-soft text-xs font-medium px-2 py-1 rounded-full">Active</span>
                    ) : (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-ink-primary/40">Tap to select</span>
                    )}
                  </div>
                </div>

                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                  {team.ageGroup && (<>
                    <dt className="text-ink-primary/50 uppercase tracking-wider font-bold">Age</dt>
                    <dd className="text-ink-primary font-semibold text-right truncate">{team.ageGroup}</dd>
                  </>)}
                  {team.season && (<>
                    <dt className="text-ink-primary/50 uppercase tracking-wider font-bold">Season</dt>
                    <dd className="text-ink-primary font-semibold text-right truncate">{team.season}</dd>
                  </>)}
                  {team.league && (<>
                    <dt className="text-ink-primary/50 uppercase tracking-wider font-bold">League</dt>
                    <dd className="text-ink-primary font-semibold text-right truncate">{team.league}</dd>
                  </>)}
                  <dt className="text-ink-primary/50 uppercase tracking-wider font-bold">Squad</dt>
                  <dd className="text-ink-primary font-semibold text-right">
                    {allPlayers.filter(p => p.teamId === team.id || p.teamIds?.includes(team.id)).length}
                  </dd>
                  <dt className="text-ink-primary/50 uppercase tracking-wider font-bold">Staff</dt>
                  <dd className="text-ink-primary font-semibold text-right">{team.coachIds?.length || 1}</dd>
                </dl>

                {/* Action buttons — stopPropagation so they don't also fire
                    the card's "select team" click handler. */}
                <div className="mt-4 flex space-x-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); startEditTeam(team); }}
                    className="flex-1 bg-line-default/[0.08] hover:bg-line-default/[0.08] text-ink-primary/85 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    Edit
                  </button>
                  {(team.coachIds?.length || 0) > 1 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleOpenTransfer(team); }}
                      className="flex-1 bg-brand-primary/15 hover:bg-brand-primary/20 text-charcoal-800 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                    >
                      Transfer Head Coach
                    </button>
                  )}
                  {(team as any).isActive !== false && (
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        const playerCount = allPlayers.filter(p => p.teamId === team.id || p.teamIds?.includes(team.id)).length;
                        const msg = `Archive "${team.name}"?\n\n• It'll be hidden from the active team selector and dashboards.\n• All ${playerCount} players' stats, clips, chats, and events stay accessible.\n• Parents and players can still view their historical content.\n• You can restore the team later.`;
                        if (!window.confirm(msg)) return;
                        try {
                          const { workerFetch } = await import('../utils/workerFetch');
                          const res = await workerFetch('/teams/archive', {
                            method: 'POST',
                            body: JSON.stringify({ teamId: team.id }),
                          });
                          const data: any = await res.json().catch(() => ({}));
                          if (!res.ok || !data?.ok) throw new Error(data?.error || `archive-${res.status}`);
                          await refreshTeams();
                        } catch (err) {
                          console.error('Archive team failed:', err);
                          alert('Could not archive the team. Please try again.');
                        }
                      }}
                      className="flex-1 bg-rose-500/15 hover:bg-rose-500/20 text-rose-300 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                      title="Hide team from active rosters; history is preserved"
                    >
                      Archive
                    </button>
                  )}
                  {(team as any).isActive === false && (
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!window.confirm(`Restore "${team.name}" to the active team list?`)) return;
                        try {
                          const { workerFetch } = await import('../utils/workerFetch');
                          const res = await workerFetch('/teams/restore', {
                            method: 'POST',
                            body: JSON.stringify({ teamId: team.id }),
                          });
                          const data: any = await res.json().catch(() => ({}));
                          if (!res.ok || !data?.ok) throw new Error(data?.error || `restore-${res.status}`);
                          await refreshTeams();
                        } catch (err) {
                          console.error('Restore team failed:', err);
                          alert('Could not restore the team. Please try again.');
                        }
                      }}
                      className="flex-1 bg-emerald-500/15 hover:bg-emerald-500/20 text-emerald-300 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                    >
                      Restore
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Current Team Players */}
        <div className="bg-surface-elevated rounded-xl shadow-sm border border-line-default/10 p-6 mb-8">
          <h2 className="text-xl font-bold text-ink-primary mb-4">
            Players on {teams.find(t => t.id === selectedTeamId)?.name || 'Current Team'}
          </h2>
          {players.length === 0 ? (
            <p className="text-ink-primary/50">Squad's empty. Build it from the Squad page.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {players.map(player => (
                <div key={player.id} className="flex items-center space-x-3 p-3 bg-line-default/[0.04] rounded-lg">
                  {player.profilePhotoUrl ? (
                    <div className="relative w-10 h-10 flex-shrink-0">
                      <img src={player.profilePhotoUrl} alt={player.name} className="w-10 h-10 rounded-full object-cover" />
                      {player.jerseyNumber != null && (
                        <span className="absolute -bottom-1 -right-1 bg-brand-primary text-white rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center text-[10px] font-black shadow ring-2 ring-white">
                          {player.jerseyNumber}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="w-10 h-10 bg-brand-primary/15 rounded-full flex items-center justify-center text-brand-primary font-bold text-sm flex-shrink-0">
                      {player.jerseyNumber || player.name.charAt(0)}
                    </div>
                  )}
                  <div>
                    <div className="font-medium text-ink-primary">{player.name}</div>
                    <div className="text-xs text-ink-primary/50">
                      {player.position || 'No position'} {player.jerseyNumber ? `• #${player.jerseyNumber}` : ''}
                    </div>
                    {(player.teamIds?.length || 0) > 1 && (
                      <div className="inline-flex items-center gap-1.5 mt-0.5">
                        <span className="text-xs bg-brand-primary/20 text-brand-primary-soft px-1.5 py-0.5 rounded">Shared</span>
                        <button
                          onClick={() => handleUnsharePlayer(player.id, selectedTeamId!)}
                          className="text-xs bg-rose-500/15 hover:bg-rose-500/20 text-rose-300 px-1.5 py-0.5 rounded font-medium transition-colors"
                          title={`Remove ${player.name} from this team (keeps them on their other team(s))`}
                        >
                          Unshare
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Coach Invites */}
        {coachInvites.length > 0 && (
          <div className="bg-surface-elevated rounded-xl shadow-sm border border-line-default/10 p-6">
            <h2 className="text-xl font-bold text-ink-primary mb-4">Coach Invitations</h2>
            <div className="space-y-3">
              {coachInvites.map((invite: any) => (
                <div key={invite.id} className="flex items-center justify-between p-3 bg-line-default/[0.04] rounded-lg">
                  <div>
                    <div className="font-medium text-ink-primary">{invite.email}</div>
                    <div className="text-xs text-ink-primary/50">
                      {invite.coachLevel === 'head_coach' ? 'Head Coach' : 'Assistant Coach'} • 
                      Invited by {invite.invitedByName}
                    </div>
                  </div>
                  <span className={`text-xs font-medium px-2 py-1 rounded-full ${
                    invite.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                    invite.status === 'accepted' ? 'bg-green-100 text-emerald-300' :
                    'bg-red-100 text-rose-300'
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
            <div className="bg-surface-elevated rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
              <div className="p-6">
                <h2 className="text-xl font-bold text-ink-primary mb-4">
                  {editingTeam ? 'Edit Team' : 'Create New Team'}
                </h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">Team Name *</label>
                    <input
                      type="text"
                      value={teamName}
                      onChange={e => setTeamName(e.target.value)}
                      className="w-full px-3 py-2 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
                      placeholder="e.g. U12 Lightning"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">Description</label>
                    <textarea
                      value={teamDescription}
                      onChange={e => setTeamDescription(e.target.value)}
                      className="w-full px-3 py-2 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
                      rows={2}
                      placeholder="Brief description of this team"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-ink-primary/85 mb-1">Age Group</label>
                      <input
                        type="text"
                        value={teamAgeGroup}
                        onChange={e => setTeamAgeGroup(e.target.value)}
                        className="w-full px-3 py-2 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
                        placeholder="e.g. U12"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-ink-primary/85 mb-1">Season</label>
                      <input
                        type="text"
                        value={teamSeason}
                        onChange={e => setTeamSeason(e.target.value)}
                        className="w-full px-3 py-2 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
                        placeholder="e.g. Spring 2026"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-ink-primary/85 mb-1">League</label>
                      <input
                        type="text"
                        value={teamLeague}
                        onChange={e => setTeamLeague(e.target.value)}
                        className="w-full px-3 py-2 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
                        placeholder="e.g. AYSO"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-ink-primary/85 mb-1">Home Field</label>
                      <input
                        type="text"
                        value={teamHomeField}
                        onChange={e => setTeamHomeField(e.target.value)}
                        className="w-full px-3 py-2 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
                        placeholder="e.g. River Park Field 3"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">Match Format</label>
                    <div className="inline-flex items-center bg-line-default/[0.08] ring-1 ring-line-default/10 rounded-full p-0.5">
                      {(['7v7', '9v9', '11v11'] as const).map((f) => (
                        <button
                          type="button"
                          key={f}
                          onClick={() => setTeamFormat(f)}
                          className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-full transition ${
                            teamFormat === f ? 'bg-brand-primary text-white shadow-sm' : 'text-ink-primary/65 hover:text-ink-primary'
                          }`}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-ink-primary/50 mt-1">Drives the formation field size + default player positions in the live tracker.</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">Who plays on this team?</label>
                    <div className="inline-flex items-center bg-line-default/[0.08] ring-1 ring-line-default/10 rounded-full p-0.5">
                      {(['youth', 'adult'] as const).map((a) => (
                        <button
                          type="button"
                          key={a}
                          onClick={() => setTeamAudience(a)}
                          className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-full transition ${
                            teamAudience === a ? 'bg-brand-primary text-white shadow-sm' : 'text-ink-primary/65 hover:text-ink-primary'
                          }`}
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-ink-primary/50 mt-1">
                      {teamAudience === 'adult'
                        ? 'Adult roster: players self-manage, no parent layer. Hides Player Circle, Whispers, and Development Pathway. Shows position/foot/past clubs on the roster.'
                        : 'Kids and families. Full family features: Player Circle for guardians, Whispers, Development Pathway, age-band awareness.'}
                    </p>
                  </div>
                  <div className="rounded-xl bg-line-default/[0.04] ring-1 ring-line-default/10 p-3">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={teamPublicFixtures}
                        onChange={(e) => setTeamPublicFixtures(e.target.checked)}
                        className="mt-0.5 w-4 h-4 accent-brand-primary flex-shrink-0"
                      />
                      <span className="flex-1">
                        <span className="block text-sm font-bold text-ink-primary">Public fixtures page</span>
                        <span className="block text-[11px] text-ink-primary/60 mt-0.5 leading-snug">
                          Anyone with the link can see upcoming games, recent results, and the roster of players who've opted in. Off by default. Youth teams: leave off unless you're comfortable with venues + times being world-readable.
                        </span>
                        {teamPublicFixtures && editingTeam && (
                          <span className="block mt-2 text-[11px] font-mono text-brand-primary-soft break-all">
                            {(window.location.origin || 'https://app.goalkickr.com') + '/f/' + editingTeam.id}
                          </span>
                        )}
                      </span>
                    </label>
                  </div>
                  <div className="rounded-xl bg-line-default/[0.04] ring-1 ring-line-default/10 p-3">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={teamDigestEnabled}
                        onChange={(e) => setTeamDigestEnabled(e.target.checked)}
                        className="mt-0.5 w-4 h-4 accent-brand-primary flex-shrink-0"
                      />
                      <span className="flex-1">
                        <span className="block text-sm font-bold text-ink-primary">Weekly Team Wall summary</span>
                        <span className="block text-[11px] text-ink-primary/60 mt-0.5 leading-snug">
                          A single 'This Week' post auto-writes to your Team Wall on the day you pick, summarizing games (W/L/D), Player of the Match winners, new clips, and milestones. Quiet weeks skip themselves.
                        </span>
                      </span>
                    </label>
                    {teamDigestEnabled && (
                      <div className="mt-3 pl-7">
                        <p className="text-[10px] font-black tracking-widest uppercase text-ink-primary/55 mb-1.5">Post it on</p>
                        <div className="inline-flex flex-wrap items-center bg-line-default/[0.08] ring-1 ring-line-default/10 rounded-full p-0.5 gap-0.5">
                          {([
                            { d: 1, label: 'Mon' },
                            { d: 2, label: 'Tue' },
                            { d: 3, label: 'Wed' },
                            { d: 4, label: 'Thu' },
                            { d: 5, label: 'Fri' },
                            { d: 6, label: 'Sat' },
                            { d: 0, label: 'Sun' },
                          ] as const).map(({ d, label }) => (
                            <button
                              type="button"
                              key={d}
                              onClick={() => setTeamDigestDay(d as any)}
                              className={`px-3 py-1 text-[11px] font-bold uppercase tracking-wider rounded-full transition ${
                                teamDigestDay === d
                                  ? 'bg-brand-primary text-white shadow-sm'
                                  : 'text-ink-primary/65 hover:text-ink-primary'
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        {teamDigestDay === 0 && (
                          <p className="mt-2 text-[11px] text-amber-300/85">
                            Heads up: Sunday can be a quiet day for families who keep the Sabbath. Consider Monday or Friday.
                          </p>
                        )}
                        <p className="mt-2 text-[10px] text-ink-primary/45">Fires around 9am team-local time.</p>
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-ink-primary/85 mb-1">Home Kit</label>
                      <input
                        type="text"
                        value={teamHomeKit}
                        onChange={e => setTeamHomeKit(e.target.value)}
                        className="w-full px-3 py-2 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
                        placeholder="e.g. Black"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-ink-primary/85 mb-1">Away Kit</label>
                      <input
                        type="text"
                        value={teamAwayKit}
                        onChange={e => setTeamAwayKit(e.target.value)}
                        className="w-full px-3 py-2 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
                        placeholder="e.g. White"
                      />
                    </div>
                  </div>
                </div>
                <div className="flex justify-end space-x-3 mt-6">
                  <button
                    onClick={() => { resetForm(); setShowCreateModal(false); setEditingTeam(null); }}
                    className="px-4 py-2 border border-line-default/15 rounded-lg text-ink-primary/85 hover:bg-line-default/[0.05]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={editingTeam ? handleUpdateTeam : handleCreateTeam}
                    disabled={!teamName.trim()}
                    className="px-4 py-2 bg-brand-primary text-white rounded-lg hover:bg-brand-primary disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {editingTeam ? 'Save Changes' : 'Create Team'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <InviteShareModal
          invite={activeShareInvite}
          open={!!activeShareInvite}
          onClose={() => setActiveShareInvite(null)}
        />

        <EndSeasonModal
          isOpen={endSeasonOpen}
          onClose={() => setEndSeasonOpen(false)}
          teamId={selectedTeamId}
          onComplete={() => { /* roster refresh happens via real-time listeners */ }}
        />

        <NewSeasonModal
          isOpen={newSeasonOpen}
          onClose={() => setNewSeasonOpen(false)}
          teamId={selectedTeamId}
        />

        <ManageSeasonsModal
          isOpen={manageSeasonsOpen}
          onClose={() => setManageSeasonsOpen(false)}
          teamId={selectedTeamId}
        />

        <MediaAccessModal
          isOpen={mediaAccessOpen}
          onClose={() => setMediaAccessOpen(false)}
          teamId={selectedTeamId}
        />

        {/* Invite Coach Modal removed v3.2.63 — dead since the
            unified generateShareInvite() flow replaced it. */}

        {/* Transfer Head Coach Modal */}
        {showTransferModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-surface-elevated rounded-xl shadow-xl max-w-md w-full">
              <div className="p-6">
                <h2 className="text-xl font-bold text-ink-primary mb-2">Transfer Head Coach</h2>
                <p className="text-sm text-ink-primary/65 mb-4">
                  Transfer the head coach role on <strong>{showTransferModal.name}</strong> to another coach. You will become an assistant coach.
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">New Head Coach *</label>
                    <select
                      value={transferTargetId}
                      onChange={e => setTransferTargetId(e.target.value)}
                      className="w-full px-3 py-2 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
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
                    className="px-4 py-2 border border-line-default/15 rounded-lg text-ink-primary/85 hover:bg-line-default/[0.05]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleTransferHeadCoach}
                    disabled={!transferTargetId}
                    className="px-4 py-2 bg-brand-primary text-white rounded-lg hover:bg-brand-primary disabled:opacity-50"
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
            <div className="bg-surface-elevated rounded-xl shadow-xl max-w-md w-full">
              <div className="p-6">
                <h2 className="text-xl font-bold text-ink-primary mb-2">Share Player Across Teams</h2>
                <p className="text-sm text-ink-primary/65 mb-4">
                  Move or share a player to another team. Their parent(s) will automatically get access to the new team.
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">Select Player *</label>
                    <select
                      value={selectedPlayerId}
                      onChange={e => setSelectedPlayerId(e.target.value)}
                      className="w-full px-3 py-2 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
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
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">Share To Team *</label>
                    <select
                      value={targetTeamId}
                      onChange={e => setTargetTeamId(e.target.value)}
                      className="w-full px-3 py-2 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
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
                    className="px-4 py-2 border border-line-default/15 rounded-lg text-ink-primary/85 hover:bg-line-default/[0.05]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSharePlayer}
                    disabled={!selectedPlayerId || !targetTeamId}
                    className="px-4 py-2 bg-brand-primary text-white rounded-lg hover:bg-brand-primary disabled:opacity-50"
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
            <div className="bg-surface-elevated rounded-xl shadow-xl max-w-md w-full">
              <div className="p-6">
                <h2 className="text-xl font-bold text-ink-primary mb-2">Add Coach to Another Team</h2>
                <p className="text-sm text-ink-primary/65 mb-4">
                  Give an existing coach access to an additional team. They'll be added as an assistant coach.
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">Select Coach *</label>
                    <select
                      value={addCoachUserId}
                      onChange={e => setAddCoachUserId(e.target.value)}
                      className="w-full px-3 py-2 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
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
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">Add to Team *</label>
                    <select
                      value={addCoachTargetTeamId}
                      onChange={e => setAddCoachTargetTeamId(e.target.value)}
                      className="w-full px-3 py-2 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
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
                    className="px-4 py-2 border border-line-default/15 rounded-lg text-ink-primary/85 hover:bg-line-default/[0.05]"
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

const SecondaryAction: React.FC<{
  emoji?: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}> = ({ label, onClick, disabled }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md border bg-surface-elevated text-ink-primary/65 border-line-default/10 hover:text-ink-primary hover:border-line-default/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
  >
    {label}
  </button>
);

export default TeamManagement;
