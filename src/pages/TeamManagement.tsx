import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { Team, Player, CoachInvite, Invite } from '../types';
import { isCoach, isCoachOfTeam } from '../utils/helpers';
import { normalizeKit } from '../utils/kitColors';
import { createStaffInvite } from '../utils/invites';
import { getShareOrigin } from '../utils/origin';
import InviteShareModal from '../components/common/InviteShareModal';
import EndSeasonModal from '../components/team/EndSeasonModal';
import NewSeasonModal from '../components/team/NewSeasonModal';
import ManageSeasonsModal from '../components/team/ManageSeasonsModal';
import MediaAccessModal from '../components/team/MediaAccessModal';
import BackfillConfirmModal from '../components/coach/BackfillConfirmModal';
import { useActiveSeason } from '../hooks/useActiveSeason';

const TeamManagement: React.FC = () => {
  const { userData } = useAuth();
  const { teams, refreshTeams, selectedTeamId, setSelectedTeamId } = useTeam();
  const { createTeam, updateTeam, updateDocument, getDocuments, getCoachInvitesByTeam, getPlayersByTeam, getUsersByTeam, deleteDocument } = useFirestore();

  const [showCreateModal, setShowCreateModal] = useState(false);
  // showInviteCoachModal + the matching modal at the bottom of
  // this file were retired with the unified invite flow that now
  // funnels through generateShareInvite() / InviteShareModal.
  // State removed v3.2.63.
  const [showSharePlayerModal, setShowSharePlayerModal] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  // Retro-XP backfill: opens the coach-facing preview + confirm
  // modal. Wired to the XP card body when xpConfig is enabled but
  // xpConfig.backfilledAt is absent (team turned XP on before the
  // backfill feature shipped, or without running the sweep).
  const [showBackfillModal, setShowBackfillModal] = useState(false);
  const [backfillTeamId, setBackfillTeamId] = useState<string | null>(null);
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
  // Practice-streak rest day — coach picks the day of week that
  // doesn't count toward or break the streak (Sunday by default for
  // religious families; coach can pick 'none' for a straight
  // 7-day/week streak or move it to another day).
  type RestDayValue = 'none' | 0 | 1 | 2 | 3 | 4 | 5 | 6;
  const [teamStreakRestDay, setTeamStreakRestDay] = useState<RestDayValue>(0);
  // Weekly EMAIL digest — coach opts in per team, picks day, picks
  // which sections appear, and can add a personal message that
  // leads the email.
  const [teamEmailEnabled, setTeamEmailEnabled] = useState<boolean>(false);
  const [teamEmailDay, setTeamEmailDay] = useState<0 | 1 | 2 | 3 | 4 | 5 | 6>(0);
  const [teamEmailSections, setTeamEmailSections] = useState({
    pastEvents: true,
    teamWall: true,
    potm: true,
    upcomingEvents: true,
  });
  const [teamEmailMessage, setTeamEmailMessage] = useState('');
  // XP + Badges opt-in. Default OFF for existing teams (undefined
  // xpConfig on the doc). New teams get true from /teams/create.
  // Coach can toggle any time; disabling preserves existing xp +
  // badges (data is not nuked, just hidden until re-enabled).
  const [teamXpEnabled, setTeamXpEnabled] = useState<boolean>(false);
  // Team Wall parent-post controls. Master toggle defaults OFF —
  // coach opts in explicitly, then dials in the six sub-toggles.
  // Sub-toggle defaults match the type-side defaults (approval on,
  // ping-coach on, delete-own on, share/email/polls off).
  const [teamWallAllowParent, setTeamWallAllowParent] = useState<boolean>(false);
  const [teamWallRequireApproval, setTeamWallRequireApproval] = useState<boolean>(true);
  const [teamWallNotifyCoach, setTeamWallNotifyCoach] = useState<boolean>(true);
  const [teamWallAllowDelete, setTeamWallAllowDelete] = useState<boolean>(true);
  const [teamWallAllowShare, setTeamWallAllowShare] = useState<boolean>(false);
  const [teamWallAllowEmail, setTeamWallAllowEmail] = useState<boolean>(false);
  const [teamWallAllowPolls, setTeamWallAllowPolls] = useState<boolean>(false);

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

  // Page manages all of the user's teams, so "coach on any of my
  // teams" is the correct page-level gate.
  const isUserCoach = userData ? teams.some(t => isCoachOfTeam(userData, t)) : false;
  const isUserClubAdmin = !!(userData as any)?.isClubAdmin;

  useEffect(() => {
    loadData();
  }, [selectedTeamId]);

  const loadData = async () => {
    if (!selectedTeamId || !userData) return;
    try {
      setLoading(true);
      // Players are team-scoped now (post-2026-07-08 rule tightening).
      // Selected team roster comes from getPlayersByTeam; the
      // "share across teams" picker fans out across the user's
      // OTHER teamIds and unions the results.
      const otherTeamIds = teams
        .map(t => t.id)
        .filter(id => id && id !== selectedTeamId);
      const [teamPlayers, otherTeamPlayerSets, invites, allUsers] = await Promise.all([
        getPlayersByTeam(selectedTeamId).catch(() => []),
        Promise.all(otherTeamIds.map(id => getPlayersByTeam(id).catch(() => []))),
        getCoachInvitesByTeam(selectedTeamId).catch(() => []),
        getUsersByTeam(selectedTeamId).catch(() => []),
      ]);
      setPlayers(teamPlayers.map((p: any) => ({
        ...p,
        createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt),
      })) as Player[]);

      const seen = new Set<string>(teamPlayers.map((p: any) => p.id));
      const allTeamPlayers: Player[] = teamPlayers.map((p: any) => ({
        ...p,
        createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt),
      })) as Player[];
      for (const set of otherTeamPlayerSets) {
        for (const p of set as any[]) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          allTeamPlayers.push({
            ...p,
            createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt),
          } as Player);
        }
      }
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
        streakConfig: {
          restDayOfWeek: teamStreakRestDay === 'none' ? null : teamStreakRestDay,
        },
        emailDigestConfig: {
          enabled: teamEmailEnabled,
          dayOfWeek: teamEmailDay,
          sections: teamEmailSections,
          message: teamEmailMessage.trim() || '',
        },
        // Preserve the enabledAt stamp across toggles so we can show
        // "since X" copy later. First-time-enable falls back to now.
        xpConfig: {
          enabled: teamXpEnabled,
          enabledAt: (editingTeam as any).xpConfig?.enabledAt
            || (teamXpEnabled ? new Date() : undefined),
        },
        // Wall parent-post config. Persist the full sub-toggle set
        // whether the master is on or off so re-enabling later
        // restores the coach's previous choices rather than
        // resetting to defaults. enabledAt is stamped the first
        // time the master flips on and preserved across cycles.
        wallConfig: {
          allowParentPosts: teamWallAllowParent,
          requireCoachApproval: teamWallRequireApproval,
          notifyCoach: teamWallNotifyCoach,
          allowParentDelete: teamWallAllowDelete,
          allowParentShare: teamWallAllowShare,
          allowParentEmail: teamWallAllowEmail,
          allowParentPolls: teamWallAllowPolls,
          enabledAt: (editingTeam as any).wallConfig?.enabledAt
            || (teamWallAllowParent ? new Date() : null),
        },
      } as any);
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
    // Streak rest day — legacy teams (undefined) get the historic
    // Sunday default; a coach who wants "no rest day" saves null.
    const raw = (team as any).streakConfig?.restDayOfWeek;
    if (raw === null) setTeamStreakRestDay('none');
    else if (typeof raw === 'number') setTeamStreakRestDay(raw as any);
    else setTeamStreakRestDay(0);
    // Email digest
    const ecfg = (team as any).emailDigestConfig;
    setTeamEmailEnabled(ecfg?.enabled === true);
    setTeamEmailDay((ecfg?.dayOfWeek ?? 0) as any);
    setTeamEmailSections({
      pastEvents: ecfg?.sections?.pastEvents ?? true,
      teamWall: ecfg?.sections?.teamWall ?? true,
      potm: ecfg?.sections?.potm ?? true,
      upcomingEvents: ecfg?.sections?.upcomingEvents ?? true,
    });
    setTeamEmailMessage(ecfg?.message || '');
    // XP + Badges opt-in. Existing teams (undefined xpConfig) default
    // to OFF; teams created after this ship default to ON via the
    // worker /teams/create endpoint.
    setTeamXpEnabled((team as any).xpConfig?.enabled === true);
    // Wall parent-post controls. Legacy teams (undefined wallConfig)
    // fall through to safe defaults: master off, approval + notify +
    // delete-own on, share/email/polls off.
    const wcfg = (team as any).wallConfig || {};
    setTeamWallAllowParent(wcfg.allowParentPosts === true);
    setTeamWallRequireApproval(wcfg.requireCoachApproval !== false);
    setTeamWallNotifyCoach(wcfg.notifyCoach !== false);
    setTeamWallAllowDelete(wcfg.allowParentDelete !== false);
    setTeamWallAllowShare(wcfg.allowParentShare === true);
    setTeamWallAllowEmail(wcfg.allowParentEmail === true);
    setTeamWallAllowPolls(wcfg.allowParentPolls === true);
  };

  const handleOpenTransfer = async (team: Team) => {
    // Load coach users for this team
    try {
      const teamUsers = await getUsersByTeam(team.id);
      // Team-scoped: a user's global role doesn't decide whether
      // they coach THIS team. team.coachIds is the source of truth.
      const coaches = teamUsers.filter((u: any) =>
        team.coachIds?.includes(u.uid || u.id)
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
    setTeamStreakRestDay(0);
    setTeamEmailEnabled(false);
    setTeamEmailDay(0);
    setTeamEmailSections({ pastEvents: true, teamWall: true, potm: true, upcomingEvents: true });
    setTeamEmailMessage('');
    setTeamXpEnabled(false);
    setTeamWallAllowParent(false);
    setTeamWallRequireApproval(true);
    setTeamWallNotifyCoach(true);
    setTeamWallAllowDelete(true);
    setTeamWallAllowShare(false);
    setTeamWallAllowEmail(false);
    setTeamWallAllowPolls(false);
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

        {/* Club nudge — appears when a solo coach has 3+ active teams.
            Gentle prompt, not a forced upgrade. Only for solo-coach
            wrappers (isDefaultSoloClub); real club admins already
            have Club Pro tooling and don't need the nag. */}
        {teams.filter(t => (t as any).isActive !== false).length >= 3 && !isUserClubAdmin && (
          <div className="mb-6 rounded-2xl bg-gradient-to-br from-brand-primary/10 via-surface-elevated to-surface-base ring-1 ring-brand-primary/20 p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-brand-primary/20 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-black tracking-widest uppercase text-brand-primary-soft mb-1">Nice, {teams.filter(t => (t as any).isActive !== false).length} teams</p>
                <h3 className="text-base font-bold text-ink-primary leading-tight">
                  Ready to organize them as a club?
                </h3>
                <p className="text-xs text-ink-primary/60 mt-1 leading-snug">
                  You've grown past a single team. Club tier gets you cross-team registrations, shared coach roster, tryouts, financial routing, and one place to run everything.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Link
                    to="/club/products"
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-brand-primary text-white text-xs font-black uppercase tracking-widest hover:bg-brand-primary/90 transition"
                  >
                    See what Club adds
                  </Link>
                  <span className="text-[10px] text-ink-primary/45">Not now? No pressure — your teams stay as they are.</span>
                </div>
              </div>
            </div>
          </div>
        )}

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
                      {player.jerseyNumber || (player.name || '?').charAt(0)}
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
                            {getShareOrigin() + '/f/' + editingTeam.id}
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
                        <p className="mt-2 text-[10px] text-ink-primary/45">Fires around 9am team-local time.</p>
                      </div>
                    )}
                  </div>
                  <div className="rounded-xl bg-line-default/[0.04] ring-1 ring-line-default/10 p-3">
                    <p className="text-sm font-bold text-ink-primary mb-1">Practice-streak rest day</p>
                    <p className="text-[11px] text-ink-primary/60 leading-snug mb-2">
                      Pick the day of the week that shouldn't count toward or break a player's streak. Kids who observe a rest day can keep their streak alive by practicing the other six.
                    </p>
                    <div className="inline-flex flex-wrap items-center bg-line-default/[0.08] ring-1 ring-line-default/10 rounded-full p-0.5 gap-0.5">
                      {([
                        { d: 'none' as const, label: 'None' },
                        { d: 0 as const, label: 'Sun' },
                        { d: 1 as const, label: 'Mon' },
                        { d: 2 as const, label: 'Tue' },
                        { d: 3 as const, label: 'Wed' },
                        { d: 4 as const, label: 'Thu' },
                        { d: 5 as const, label: 'Fri' },
                        { d: 6 as const, label: 'Sat' },
                      ]).map(({ d, label }) => (
                        <button
                          type="button"
                          key={String(d)}
                          onClick={() => setTeamStreakRestDay(d as any)}
                          className={`px-3 py-1 text-[11px] font-bold uppercase tracking-wider rounded-full transition ${
                            teamStreakRestDay === d
                              ? 'bg-brand-primary text-white shadow-sm'
                              : 'text-ink-primary/65 hover:text-ink-primary'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl bg-line-default/[0.04] ring-1 ring-line-default/10 p-3">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={teamXpEnabled}
                        onChange={(e) => setTeamXpEnabled(e.target.checked)}
                        className="mt-0.5 w-4 h-4 accent-brand-primary flex-shrink-0"
                      />
                      <span className="flex-1">
                        <span className="block text-sm font-bold text-ink-primary">XP + Badges</span>
                        <span className="block text-[11px] text-ink-primary/60 mt-0.5 leading-snug">
                          Private XP that builds over the season and career badges the kid keeps forever. You can award recognition tokens for effort, attitude, or a defensive stand you loved. Every kid sees only their own XP; nobody sees rankings.
                        </span>
                        {teamXpEnabled && (
                          <span className="block text-[10px] text-ink-primary/45 mt-1 leading-snug">
                            Turn off any time. Existing XP + badges are preserved, just hidden until you re-enable.
                          </span>
                        )}
                      </span>
                    </label>
                    {/* Retro-credit affordance — only shown when the
                        team has XP enabled but the backfill sweep has
                        NOT been run (either XP was turned on before
                        the feature shipped, or the coach chose to
                        skip retro credit and later reconsidered).
                        Hides itself once xpConfig.backfilledAt is
                        stamped by the worker. */}
                    {teamXpEnabled
                      && (editingTeam as any)?.xpConfig?.enabled === true
                      && !(editingTeam as any)?.xpConfig?.backfilledAt
                      && (
                      <div className="mt-3 pt-3 border-t border-line-default/10 flex items-center justify-between gap-3">
                        <span className="text-[12px] text-ink-primary/70 leading-snug">
                          Grant retro credit for pre-XP achievements.
                        </span>
                        <button
                          type="button"
                          onClick={() => { setBackfillTeamId(editingTeam!.id); setShowBackfillModal(true); }}
                          className="text-[12px] font-black text-cyan-500 hover:text-cyan-400 transition"
                        >
                          Preview
                        </button>
                      </div>
                    )}
                  </div>
                  {/* Wall — Circle-post controls. Master toggle plus
                      six sub-toggles that only render when the master
                      is on. Copy uses Circle-first terminology
                      (grandparents, aunts, uncles — anyone linked to a
                      kid on the team, not just parents). Persistent
                      reassurance footer sits at the bottom of the card
                      so a coach reading the master toggle can see the
                      "turn off any time" line without having to enable
                      first. */}
                  <div className="rounded-xl bg-line-default/[0.04] ring-1 ring-line-default/10 p-3">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={teamWallAllowParent}
                        onChange={(e) => setTeamWallAllowParent(e.target.checked)}
                        className="mt-0.5 w-4 h-4 accent-brand-primary flex-shrink-0"
                      />
                      <span className="flex-1">
                        <span className="block text-sm font-bold text-ink-primary">Circle can post to the wall</span>
                        <span className="block text-[11px] text-ink-primary/60 mt-0.5 leading-snug">
                          Let the Circle share moments to your Team Wall themselves. Grandparents, aunts, uncles, anyone linked to a kid on the team.
                        </span>
                      </span>
                    </label>
                    {teamWallAllowParent && (
                      <div className="mt-4 pl-7 space-y-4">
                        <label className="flex items-start gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={teamWallRequireApproval}
                            onChange={(e) => setTeamWallRequireApproval(e.target.checked)}
                            className="mt-0.5 w-4 h-4 accent-brand-primary flex-shrink-0"
                          />
                          <span className="flex-1">
                            <span className="block text-sm font-bold text-ink-primary">Coach approves before it goes live</span>
                            <span className="block text-[11px] text-ink-primary/60 mt-0.5 leading-snug">
                              Circle posts land in your queue first. You tap Approve to publish, or Decline to keep it off the wall. Recommended.
                            </span>
                          </span>
                        </label>
                        <label className="flex items-start gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={teamWallNotifyCoach}
                            onChange={(e) => setTeamWallNotifyCoach(e.target.checked)}
                            className="mt-0.5 w-4 h-4 accent-brand-primary flex-shrink-0"
                          />
                          <span className="flex-1">
                            <span className="block text-sm font-bold text-ink-primary">Ping me when they post</span>
                            <span className="block text-[11px] text-ink-primary/60 mt-0.5 leading-snug">
                              Push and email when someone in the Circle posts, so nothing sits in the queue for long.
                            </span>
                          </span>
                        </label>
                        <label className="flex items-start gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={teamWallAllowDelete}
                            onChange={(e) => setTeamWallAllowDelete(e.target.checked)}
                            className="mt-0.5 w-4 h-4 accent-brand-primary flex-shrink-0"
                          />
                          <span className="flex-1">
                            <span className="block text-sm font-bold text-ink-primary">Let them delete their own post</span>
                            <span className="block text-[11px] text-ink-primary/60 mt-0.5 leading-snug">
                              Someone in the Circle can take their own post down. You can still delete anything on the wall regardless.
                            </span>
                          </span>
                        </label>
                        <label className="flex items-start gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={teamWallAllowShare}
                            onChange={(e) => setTeamWallAllowShare(e.target.checked)}
                            className="mt-0.5 w-4 h-4 accent-brand-primary flex-shrink-0"
                          />
                          <span className="flex-1">
                            <span className="block text-sm font-bold text-ink-primary">Let them share their post outside the app</span>
                            <span className="block text-[11px] text-ink-primary/60 mt-0.5 leading-snug">
                              Turns on the Share action so their post can be sent to family or friends who don't have the app.
                            </span>
                          </span>
                        </label>
                        <label className="flex items-start gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={teamWallAllowEmail}
                            onChange={(e) => setTeamWallAllowEmail(e.target.checked)}
                            className="mt-0.5 w-4 h-4 accent-brand-primary flex-shrink-0"
                          />
                          <span className="flex-1">
                            <span className="block text-sm font-bold text-ink-primary">Email their posts to the team</span>
                            <span className="block text-[11px] text-ink-primary/60 mt-0.5 leading-snug">
                              Their post fans out to every family on this team. Off by default so the team inbox stays quiet.
                            </span>
                          </span>
                        </label>
                        <label className="flex items-start gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={teamWallAllowPolls}
                            onChange={(e) => setTeamWallAllowPolls(e.target.checked)}
                            className="mt-0.5 w-4 h-4 accent-brand-primary flex-shrink-0"
                          />
                          <span className="flex-1">
                            <span className="block text-sm font-bold text-ink-primary">Let them create polls</span>
                            <span className="block text-[11px] text-ink-primary/60 mt-0.5 leading-snug">
                              Poll editor shows up in their composer. Handy for ride shares and post-game dinner spots.
                            </span>
                          </span>
                        </label>
                      </div>
                    )}
                    <p className="mt-3 pt-3 border-t border-line-default/10 text-[10px] text-ink-primary/45 leading-snug">
                      You can flip this off at any time. Existing posts stay on the wall.
                    </p>
                  </div>
                  <div className="rounded-xl bg-line-default/[0.04] ring-1 ring-line-default/10 p-3">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={teamEmailEnabled}
                        onChange={(e) => setTeamEmailEnabled(e.target.checked)}
                        className="mt-0.5 w-4 h-4 accent-brand-primary flex-shrink-0"
                      />
                      <span className="flex-1">
                        <span className="block text-sm font-bold text-ink-primary">Weekly email to parents</span>
                        <span className="block text-[11px] text-ink-primary/60 mt-0.5 leading-snug">
                          A recap email to every parent on this team. You pick the day, what sections it includes, and can add a personal note that leads the email.
                        </span>
                      </span>
                    </label>
                    {teamEmailEnabled && (
                      <div className="mt-3 pl-7 space-y-3">
                        <div>
                          <p className="text-[10px] font-black tracking-widest uppercase text-ink-primary/55 mb-1.5">Send on</p>
                          <div className="inline-flex flex-wrap items-center bg-line-default/[0.08] ring-1 ring-line-default/10 rounded-full p-0.5 gap-0.5">
                            {([
                              { d: 0, label: 'Sun' },
                              { d: 1, label: 'Mon' },
                              { d: 2, label: 'Tue' },
                              { d: 3, label: 'Wed' },
                              { d: 4, label: 'Thu' },
                              { d: 5, label: 'Fri' },
                              { d: 6, label: 'Sat' },
                            ] as const).map(({ d, label }) => (
                              <button
                                type="button"
                                key={d}
                                onClick={() => setTeamEmailDay(d as any)}
                                className={`px-3 py-1 text-[11px] font-bold uppercase tracking-wider rounded-full transition ${
                                  teamEmailDay === d
                                    ? 'bg-brand-primary text-white shadow-sm'
                                    : 'text-ink-primary/65 hover:text-ink-primary'
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <p className="text-[10px] font-black tracking-widest uppercase text-ink-primary/55 mb-1.5">What to include</p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {([
                              { key: 'pastEvents' as const, label: 'Past week\'s events' },
                              { key: 'teamWall' as const, label: 'Team Wall highlights' },
                              { key: 'potm' as const, label: 'Player of the Match' },
                              { key: 'upcomingEvents' as const, label: 'Coming up next week' },
                            ]).map(({ key, label }) => (
                              <label key={key} className="flex items-center gap-2 cursor-pointer text-sm text-ink-primary/85">
                                <input
                                  type="checkbox"
                                  checked={teamEmailSections[key]}
                                  onChange={(e) => setTeamEmailSections(prev => ({ ...prev, [key]: e.target.checked }))}
                                  className="w-4 h-4 accent-brand-primary"
                                />
                                {label}
                              </label>
                            ))}
                          </div>
                        </div>
                        <div>
                          <p className="text-[10px] font-black tracking-widest uppercase text-ink-primary/55 mb-1.5">Your note (optional)</p>
                          <textarea
                            value={teamEmailMessage}
                            onChange={(e) => setTeamEmailMessage(e.target.value.slice(0, 500))}
                            placeholder="Great effort this week, team. Big game Saturday."
                            className="w-full px-3 py-2 bg-surface-base text-ink-primary border border-line-default/10 rounded-lg text-sm resize-none"
                            rows={3}
                          />
                          <p className="text-[10px] text-ink-primary/45 mt-1">Leads the email so parents know the recap came from you.</p>
                        </div>
                        <p className="text-[10px] text-ink-primary/45">Sends around 4pm team-local time on the day you pick.</p>
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    {/* Native color picker so coaches don't type free-text
                        that then has to be mapped to a hex. Legacy text
                        values (like "Black" or "Red") still resolve via
                        normalizeKit() on read — the picker just starts
                        with whatever normalized value we can get. Tap
                        the swatch to open the OS color wheel; hex string
                        saves as the source of truth. */}
                    <div>
                      <label className="block text-sm font-medium text-ink-primary/85 mb-1">Home kit color</label>
                      <div className="flex items-center gap-3">
                        <input
                          type="color"
                          value={normalizeKit(teamHomeKit) || '#0f172a'}
                          onChange={e => setTeamHomeKit(e.target.value)}
                          className="h-11 w-14 rounded-lg cursor-pointer bg-transparent ring-1 ring-line-default/15 p-1"
                          aria-label="Home kit color"
                        />
                        <div className="flex-1 min-w-0">
                          <div
                            className="h-6 rounded-md ring-1 ring-line-default/15"
                            style={{ backgroundColor: normalizeKit(teamHomeKit) || '#0f172a' }}
                            aria-hidden
                          />
                          <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-ink-primary/50 tabular-nums">
                            {(normalizeKit(teamHomeKit) || '').toUpperCase()}
                          </p>
                        </div>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-ink-primary/85 mb-1">Away kit color</label>
                      <div className="flex items-center gap-3">
                        <input
                          type="color"
                          value={normalizeKit(teamAwayKit) || '#f8fafc'}
                          onChange={e => setTeamAwayKit(e.target.value)}
                          className="h-11 w-14 rounded-lg cursor-pointer bg-transparent ring-1 ring-line-default/15 p-1"
                          aria-label="Away kit color"
                        />
                        <div className="flex-1 min-w-0">
                          <div
                            className="h-6 rounded-md ring-1 ring-line-default/15"
                            style={{ backgroundColor: normalizeKit(teamAwayKit) || '#f8fafc' }}
                            aria-hidden
                          />
                          <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-ink-primary/50 tabular-nums">
                            {(normalizeKit(teamAwayKit) || '').toUpperCase()}
                          </p>
                        </div>
                      </div>
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

        {backfillTeamId && (
          <BackfillConfirmModal
            teamId={backfillTeamId}
            isOpen={showBackfillModal}
            triggerSource="post_enable"
            onClose={() => setShowBackfillModal(false)}
            onCommitted={() => {
              // Refresh the team list so the "Preview" link hides
              // (its visibility depends on xpConfig.backfilledAt
              // which the worker just stamped).
              void refreshTeams();
            }}
          />
        )}

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
