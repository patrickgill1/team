import React, { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { Player, CalendarEvent } from '../types';
import { formatDate, isCoach } from '../utils/helpers';
import { doc, updateDoc, arrayUnion } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { getShareOrigin } from '../utils/origin';
import Header from '../components/common/Header';
import { Link } from 'react-router-dom';
import AppIcon from '../components/common/AppIcon';

interface MatchVoting {
  id: string;
  gameId: string;
  gameTitle: string;
  gameDate: Date;
  calendarEventId?: string; // Link to calendar event
  isActive: boolean;
  votes: Vote[];
  winner?: {
    playerId: string;
    playerName: string;
    voteCount: number;
  };
  winners?: Array<{
    playerId: string;
    playerName: string;
    voteCount: number;
  }>; // All players tied for top vote count (co-Players-of-the-Match)
  teamId: string;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  closedAt?: Date;
  location?: string;
  opponent?: string;
  homeAway?: 'home' | 'away';
  eligiblePlayerIds?: string[]; // Players present at the match — only their parents can vote
}

interface Vote {
  voterId: string;
  voterName: string;
  playerId: string;
  playerName: string;
  reason?: string;
  timestamp: Date;
  isPublicVote?: boolean;
  isCoach?: boolean;
}

const PlayerOfMatch: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getDocuments, addDocument, updateDocument, deleteDocument } = useFirestore();
  const [players, setPlayers] = useState<Player[]>([]);
  const [votings, setVotings] = useState<MatchVoting[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [activeVoting, setActiveVoting] = useState<MatchVoting | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedPlayer, setSelectedPlayer] = useState('');
  const [voteReason, setVoteReason] = useState('');
  const [selectedCalendarEvent, setSelectedCalendarEvent] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  const [newVotingId, setNewVotingId] = useState<string | null>(null);
  const [expandedVoters, setExpandedVoters] = useState<Set<string>>(new Set());

  // Attendance tracking
  const [showAttendanceStep, setShowAttendanceStep] = useState(false);
  const [attendancePlayerIds, setAttendancePlayerIds] = useState<Set<string>>(new Set());
  const [pendingVotingData, setPendingVotingData] = useState<Omit<MatchVoting, 'id' | 'eligiblePlayerIds'> | null>(null);
  const [editingVotingId, setEditingVotingId] = useState<string | null>(null);

  const getVoteLink = (votingId: string) =>
    `${getShareOrigin()}/vote/${votingId}`;

  const copyVoteLink = async (votingId: string) => {
    try {
      await navigator.clipboard.writeText(getVoteLink(votingId));
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 3000);
    } catch {
      // Fallback
      const input = document.createElement('input');
      input.value = getVoteLink(votingId);
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 3000);
    }
  };

  const isUserCoach = userData ? isCoach(userData.role) : false;

  useEffect(() => {
    loadData();
  }, [selectedTeamId]);

  const loadData = async () => {
    if (!selectedTeamId) { setLoading(false); return; }

    try {
      setLoading(true);
      
      // Load players, events, and votings in parallel
      const [playersData, eventsData, votingsData] = await Promise.all([
        getDocuments('players', []),
        getDocuments('events', []),
        getDocuments('match_votings', [])
      ]);

      const teamPlayers = playersData
        .filter((p: any) => (p.teamId === selectedTeamId || p.teamIds?.includes(selectedTeamId)) && p.isActive)
        .map((p: any) => ({
          ...p,
          createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt)
        }));
      setPlayers(teamPlayers);

      const teamGameEvents = eventsData
        .filter((e: any) => e.teamId === selectedTeamId && e.type === 'game')
        .map((e: any) => ({
          ...e,
          date: e.date?.toDate ? e.date.toDate() : new Date(e.date),
          createdAt: e.createdAt?.toDate ? e.createdAt.toDate() : new Date(e.createdAt || Date.now())
        }))
        .sort((a: any, b: any) => b.date.getTime() - a.date.getTime());
      setCalendarEvents(teamGameEvents);

      const teamVotings = votingsData
        .filter((v: any) => v.teamId === selectedTeamId)
        .map((v: any) => ({
          ...v,
          gameDate: v.gameDate?.toDate ? v.gameDate.toDate() : new Date(v.gameDate),
          createdAt: v.createdAt?.toDate ? v.createdAt.toDate() : new Date(v.createdAt),
          closedAt: v.closedAt?.toDate ? v.closedAt.toDate() : null,
          votes: v.votes || []
        }))
        .sort((a: any, b: any) => b.gameDate.getTime() - a.gameDate.getTime());
      
      setVotings(teamVotings);
      
      // Set active voting
      const active = teamVotings.find((v: any) => v.isActive);
      setActiveVoting(active || null);
    } catch (error) {
      console.error('Error loading voting data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Start attendance step instead of immediately creating voting
  const handleCreateVotingFromCalendarEvent = async (eventId?: string) => {
    if (!userData) return;
    const resolvedId = eventId ?? selectedCalendarEvent;
    if (!resolvedId) return;

    const calendarEvent = calendarEvents.find(e => e.id === resolvedId);
    if (!calendarEvent) return;

    // Check if voting already exists for this calendar event
    const existingVoting = votings.find(v => v.calendarEventId === resolvedId);
    if (existingVoting) {
      alert('A Player of the Match voting already exists for this game.');
      return;
    }

    const votingData: Omit<MatchVoting, 'id' | 'eligiblePlayerIds'> = {
      gameId: calendarEvent.id,
      gameTitle: calendarEvent.title,
      gameDate: calendarEvent.date,
      calendarEventId: calendarEvent.id,
      isActive: true,
      votes: [],
      teamId: selectedTeamId,
      createdBy: userData.uid,
      createdByName: userData.name,
      createdAt: new Date(),
      location: calendarEvent.location || undefined,
      opponent: calendarEvent.opponent || undefined,
      homeAway: calendarEvent.homeAway || undefined,
    };

    // Start with nobody selected — coach checks who was present
    setAttendancePlayerIds(new Set());
    setPendingVotingData(votingData);
    setShowCreateModal(false);
    setShowAttendanceStep(true);
  };

  const handleCreateCustomVoting = async (gameTitle: string, gameDate: Date, location?: string, opponent?: string, homeAway?: 'home' | 'away') => {
    if (!userData || !gameTitle) return;

    const votingData: Omit<MatchVoting, 'id' | 'eligiblePlayerIds'> = {
      gameId: `custom_game_${Date.now()}`,
      gameTitle: gameTitle,
      gameDate: gameDate,
      isActive: true,
      votes: [],
      teamId: selectedTeamId,
      createdBy: userData.uid,
      createdByName: userData.name,
      createdAt: new Date(),
      location: location || undefined,
      opponent: opponent || undefined,
      homeAway: homeAway || undefined,
    };

    setAttendancePlayerIds(new Set());
    setPendingVotingData(votingData);
    setShowCreateModal(false);
    setShowAttendanceStep(true);
  };

  const toggleAttendance = (playerId: string) => {
    setAttendancePlayerIds(prev => {
      const next = new Set(prev);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  };

  const handleConfirmAttendanceAndCreate = async () => {
    if (attendancePlayerIds.size === 0) {
      alert('Please mark at least one player as present.');
      return;
    }

    // Editing existing voting
    if (editingVotingId) {
      try {
        const newEligible = Array.from(attendancePlayerIds);
        await updateDocument('match_votings', editingVotingId, {
          eligiblePlayerIds: newEligible,
        });
        // Immediately update activeVoting state so the player filter takes effect
        setActiveVoting(prev => prev ? { ...prev, eligiblePlayerIds: newEligible } : null);
        // Also update in the votings list
        setVotings(prev => prev.map(v => v.id === editingVotingId ? { ...v, eligiblePlayerIds: newEligible } : v));
        setShowAttendanceStep(false);
        setEditingVotingId(null);
        await loadData();
      } catch (error) {
        console.error('Error updating attendance:', error);
        alert('Failed to update attendance. Please try again.');
      }
      return;
    }

    // Creating new voting
    if (!pendingVotingData) return;
    try {
      const { withSeasonId } = await import('../utils/seasons');
      const voting = await withSeasonId({
        ...pendingVotingData,
        eligiblePlayerIds: Array.from(attendancePlayerIds),
      });
      const newId = await addDocument('match_votings', voting);
      setShowAttendanceStep(false);
      setPendingVotingData(null);
      setSelectedCalendarEvent('');
      setNewVotingId(newId || null);
      loadData();
    } catch (error) {
      console.error('Error creating voting session:', error);
      alert('Failed to create voting session. Please try again.');
    }
  };

  const handleEditAttendance = () => {
    if (!activeVoting) return;
    setEditingVotingId(activeVoting.id);
    setAttendancePlayerIds(new Set(activeVoting.eligiblePlayerIds || []));
    setPendingVotingData(null);
    setShowAttendanceStep(true);
  };

  const handleVote = async () => {
    if (!userData || !activeVoting || !selectedPlayer) return;

    const player = players.find(p => p.id === selectedPlayer);
    if (!player) return;

    // Prevent parents from voting for their own children
    if (!isUserCoach && player.parentIds?.includes(userData.uid)) {
      alert("You cannot vote for your own child. Please select another player.");
      return;
    }

    // Check if user already voted
    const existingVote = activeVoting.votes.find(v => v.voterId === userData.uid);
    if (existingVote) {
      alert("You have already voted in this session.");
      return;
    }

    try {
      const vote: Vote = {
        voterId: userData.uid,
        voterName: userData.name,
        playerId: selectedPlayer,
        playerName: player.name,
        reason: voteReason.trim(),
        timestamp: new Date()
      };

      await updateDoc(doc(db, 'match_votings', activeVoting.id), {
        votes: arrayUnion(vote)
      });

      setSelectedPlayer('');
      setVoteReason('');
      loadData();
    } catch (error) {
      console.error('Error submitting vote:', error);
      alert('Failed to submit your vote. Please check your connection and try again.');
    }
  };

  const handleDeleteVoting = async () => {
    if (!activeVoting || !isUserCoach) return;
    const confirmed = window.confirm(
      `Are you sure you want to DELETE this voting session?\n\n"${activeVoting.gameTitle}" — ${activeVoting.votes.length} vote(s) will be permanently lost.\n\nThis cannot be undone.`
    );
    if (!confirmed) return;
    try {
      await deleteDocument('match_votings', activeVoting.id);
      setActiveVoting(null);
      setNewVotingId(null);
      loadData();
    } catch (error) {
      console.error('Error deleting voting session:', error);
      alert('Failed to delete the voting session. Please try again.');
    }
  };

  const handleCloseVoting = async () => {
    if (!activeVoting || !isUserCoach) return;

    try {
      // Calculate winner(s) — ties give credit to ALL tied players
      const voteCounts: {[playerId: string]: {count: number, name: string}} = {};

      activeVoting.votes.forEach(vote => {
        if (!voteCounts[vote.playerId]) {
          voteCounts[vote.playerId] = {count: 0, name: vote.playerName};
        }
        voteCounts[vote.playerId].count++;
      });

      const entries = Object.entries(voteCounts);
      const topCount = entries.reduce((max, [, data]) => Math.max(max, data.count), 0);
      const winners = topCount > 0
        ? entries
            .filter(([, data]) => data.count === topCount)
            .map(([playerId, data]) => ({ playerId, playerName: data.name, voteCount: data.count }))
        : [];

      await updateDocument('match_votings', activeVoting.id, {
        isActive: false,
        closedAt: new Date(),
        winners: winners.length > 0 ? winners : undefined,
        // Keep legacy 'winner' field set to first tied player for backward compatibility
        winner: winners.length > 0 ? winners[0] : undefined,
      });

      // Flip the "current POTM" flag on player docs so every avatar in
      // the app picks up the gold ring without subscribing to a separate
      // signal. Clear the previous winner(s) first, then mark the new
      // one(s). Co-winners both get the ring. A coach can manually clear
      // via the "Clear POTM" button on this page.
      try {
        if (winners.length > 0 && selectedTeamId) {
          const { collection, getDocs, query, where, doc: fsDoc, updateDoc: fsUpdate } = await import('firebase/firestore');
          const { db } = await import('../utils/firebase');
          const prev = await getDocs(query(
            collection(db, 'players'),
            where('teamIds', 'array-contains', selectedTeamId),
            where('isCurrentPotm', '==', true),
          ));
          const winnerIds = new Set(winners.map(w => w.playerId));
          // Clear previous winners that aren't also new winners.
          await Promise.all(prev.docs
            .filter(d => !winnerIds.has(d.id))
            .map(d => fsUpdate(fsDoc(db, 'players', d.id), { isCurrentPotm: false, potmAt: null })));
          // Mark new winners.
          await Promise.all(winners.map(w =>
            fsUpdate(fsDoc(db, 'players', w.playerId), { isCurrentPotm: true, potmAt: new Date() })
          ));
        }
      } catch (e) { console.warn('POTM flag update failed', e); }

      // Auto-post each winner to the team wall.
      try {
        if (winners.length > 0 && selectedTeamId && userData) {
          const { autoPostPotmToWall } = await import('../utils/autoPostToWall');
          const actor = { uid: userData.uid, name: userData.name || 'Coach', role: 'coach' };
          for (const w of winners) {
            void autoPostPotmToWall(
              { id: w.playerId, name: w.playerName, teamId: selectedTeamId },
              activeVoting.gameTitle,
              actor,
            );
          }
        }
      } catch (e) { console.warn('POTM wall post failed', e); }

      // Email + push each winner's parents
      try {
        if (winners.length > 0) {
          const { getParentEmailsForPlayer, tplPotmWin, sendEmailBatch, sendPushToPlayerParents } = await import('../utils/notify');
          const isCoWin = winners.length > 1;
          const messages: any[] = [];
          for (const w of winners) {
            const parents = await getParentEmailsForPlayer(w.playerId, 'potm');
            const { subject, html } = tplPotmWin({
              playerName: w.playerName,
              voteCount: w.voteCount,
              gameTitle: activeVoting.gameTitle,
              isCoWin,
            });
            for (const p of parents) messages.push({ to: p.email, subject, html });

            // Native push to parents who have the app installed.
            sendPushToPlayerParents(w.playerId, {
              title: isCoWin ? `${w.playerName} is co-Player of the Match!` : `${w.playerName} is Player of the Match!`,
              body: `${w.voteCount} vote${w.voteCount === 1 ? '' : 's'} · ${activeVoting.gameTitle}`,
              path: `/player/${w.playerId}`,
            }, 'potm');
          }
          if (messages.length > 0) sendEmailBatch(messages);
        }
      } catch (e) { console.warn('POTM notify failed', e); }

      loadData();
    } catch (error) {
      console.error('Error closing voting:', error);
    }
  };

  const getVoteResults = (voting: MatchVoting) => {
    const voteCounts: {[playerId: string]: {count: number, name: string, votes: Vote[]}} = {};
    
    voting.votes.forEach(vote => {
      if (!voteCounts[vote.playerId]) {
        voteCounts[vote.playerId] = {count: 0, name: vote.playerName, votes: []};
      }
      voteCounts[vote.playerId].count++;
      voteCounts[vote.playerId].votes.push(vote);
    });

    return Object.entries(voteCounts)
      .map(([playerId, data]) => ({playerId, ...data}))
      .sort((a, b) => b.count - a.count);
  };

  const canUserVote = () => {
    if (!activeVoting || !userData) return false;
    // Already voted?
    if (activeVoting.votes.some(v => v.voterId === userData.uid)) return false;
    // Coaches can always vote
    if (isUserCoach) return true;
    // If attendance was tracked, only parents of present players can vote
    if (activeVoting.eligiblePlayerIds && activeVoting.eligiblePlayerIds.length > 0) {
      const userPlayerIds = players
        .filter(p => p.parentIds?.includes(userData.uid))
        .map(p => p.id);
      return userPlayerIds.some(pid => activeVoting.eligiblePlayerIds!.includes(pid));
    }
    return true;
  };

  const getUsersVote = () => {
    if (!activeVoting || !userData) return null;
    return activeVoting.votes.find(v => v.voterId === userData.uid);
  };

  const getPlayersThatCanBeVotedFor = () => {
    // Only show players marked as present (eligible)
    let eligible = players;
    if (activeVoting?.eligiblePlayerIds && activeVoting.eligiblePlayerIds.length > 0) {
      eligible = players.filter(p => activeVoting.eligiblePlayerIds!.includes(p.id));
    }

    if (isUserCoach) return eligible;
    
    return eligible.filter(player => 
      !player.parentIds?.includes(userData?.uid || '')
    );
  };

  // Get upcoming games that don't have voting yet
  const getAvailableGamesForVoting = () => {
    const now = new Date();
    const recentGames = calendarEvents.filter(event => {
      const daysDiff = (now.getTime() - event.date.getTime()) / (1000 * 60 * 60 * 24);
      return daysDiff >= -1 && daysDiff <= 7; // Games from yesterday to 7 days ago
    });

    return recentGames.filter(game => 
      !votings.some(voting => voting.calendarEventId === game.id)
    );
  };

  const usersVote = getUsersVote();
  const votableePlayers = getPlayersThatCanBeVotedFor();
  const availableGames = getAvailableGamesForVoting();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center space-y-3">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-crimson-400/30 border-t-cyan-500" />
          <span className="text-sm text-bone/40 font-medium">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-charcoal-950">
      <Header title="Player of the Match" subtitle="Vote for outstanding performances" />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {isUserCoach && (
          <div className="mb-6 flex justify-end">
            <button
              onClick={() => setShowCreateModal(true)}
              className="bg-crimson-600 hover:bg-crimson-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2"
            >
              <AppIcon name="plus" className="w-4 h-4" strokeWidth={2.5} />
              <span>Create Voting</span>
            </button>
          </div>
        )}

        {/* Available Games for Voting (Coach only) */}
        {isUserCoach && (
          <div className="mb-6">
            {availableGames.length > 0 ? (
              <div className="bg-crimson-500/15 border border-crimson-400/20 rounded-lg p-4">
                <div className="flex items-start space-x-3">
                  <svg className="w-5 h-5 text-crimson-600 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div className="flex-1">
                    <h3 className="text-sm font-medium text-crimson-900 mb-2">
                      Games available for Player of the Match voting
                    </h3>
                    <p className="text-sm text-crimson-300 mb-3">
                      Create voting sessions for recent or upcoming games
                    </p>
                    <div className="space-y-2">
                      {availableGames.map(game => (
                        <div key={game.id} className="flex items-center justify-between bg-charcoal-900 rounded-lg p-3 border border-crimson-400/20">
                          <div>
                            <p className="font-medium text-bone">{game.title}</p>
                            <p className="text-sm text-bone/65">
                              {formatDate(game.date)} at {game.location}
                              {game.opponent && ` - vs ${game.opponent}`}
                            </p>
                          </div>
                          <button
                            onClick={() => handleCreateVotingFromCalendarEvent(game.id)}
                            className="bg-crimson-600 hover:bg-crimson-700 text-white px-3 py-1 rounded text-sm font-medium transition-colors duration-200 flex items-center space-x-1"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                            </svg>
                            <span>Start Voting</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : !activeVoting && calendarEvents.filter(e => e.type === 'game').length === 0 ? (
              <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-5 shadow-sm">
                <div className="flex items-start gap-3">
                  <span className="flex-shrink-0 w-10 h-10 rounded-full bg-crimson-500/15 ring-1 ring-crimson-100 flex items-center justify-center text-crimson-600">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <rect x="3" y="4" width="18" height="18" rx="2"/>
                      <line x1="16" y1="2" x2="16" y2="6"/>
                      <line x1="8" y1="2" x2="8" y2="6"/>
                      <line x1="3" y1="10" x2="21" y2="10"/>
                    </svg>
                  </span>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-bone mb-1">No games scheduled yet</h3>
                    <p className="text-sm text-bone/65 mb-3">
                      Add a game to your calendar to start a Player of the Match vote — or hit <span className="font-semibold text-bone/90">Create Voting</span> above to build a custom vote for any game.
                    </p>
                    <Link
                      to="/calendar"
                      className="inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-widest text-crimson-300 hover:text-crimson-900"
                    >
                      Open calendar
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                    </Link>
                  </div>
                </div>
              </div>
            ) : !activeVoting && (
              <div className="bg-white/[0.04] border border-white/10 rounded-lg p-4">
                <div className="flex items-start space-x-3">
                  <svg className="w-5 h-5 text-bone/50 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div>
                    <h3 className="text-sm font-medium text-bone/85 mb-1">All Recent Games Have Voting</h3>
                    <p className="text-sm text-bone/65">
                      All your recent and upcoming games already have Player of the Match voting sessions. 
                      You can create a custom voting session if needed.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}



        {/* Active Voting */}
        {activeVoting && (
          <div className="card-modern mb-6 overflow-hidden">
            <div className="px-6 py-4 border-b border-crimson-400/20 bg-gradient-to-r from-crimson-50 to-white">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <span className="w-10 h-10 rounded-xl bg-crimson-500/20 text-crimson-300 flex items-center justify-center shrink-0">
                    <AppIcon name="trophy" className="w-5 h-5" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold text-bone">Active voting</h2>
                    <p className="text-bone/85 truncate">{activeVoting.gameTitle} — {formatDate(activeVoting.gameDate)}</p>
                    {activeVoting.calendarEventId && (
                      <p className="text-xs text-bone/50 mt-0.5">Linked to a calendar event</p>
                    )}
                    {activeVoting.eligiblePlayerIds && activeVoting.eligiblePlayerIds.length > 0 && (
                      <p className="text-xs text-bone/50">
                        Attendance: {activeVoting.eligiblePlayerIds.length}/{players.length} players present
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => copyVoteLink(activeVoting.id)}
                    className={`flex items-center space-x-2 px-4 py-2 rounded-xl font-medium transition-all duration-200 border ${
                      linkCopied
                        ? 'bg-emerald-500/15 border-emerald-400/30 text-emerald-300'
                        : 'bg-charcoal-900 border-crimson-400/30 text-crimson-200 hover:bg-crimson-500/15'
                    }`}
                    title="Copy vote link to share with parents"
                  >
                    {linkCopied ? (
                      <>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        <span>Link copied!</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                        </svg>
                        <span>Share Vote Link</span>
                      </>
                    )}
                  </button>
                  {isUserCoach && (
                    <>
                      <button
                        onClick={handleEditAttendance}
                        className="bg-crimson-600 hover:bg-crimson-700 text-white px-4 py-2 rounded-xl font-medium transition-colors duration-200 flex items-center gap-1.5"
                        title="Edit which players were present"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                        Edit Attendance
                      </button>
                      <button
                        onClick={handleCloseVoting}
                        className="bg-amber-500/150 hover:bg-amber-600 text-white px-4 py-2 rounded-xl font-medium transition-colors duration-200"
                      >
                        Close Voting
                      </button>
                      <button
                        onClick={handleDeleteVoting}
                        className="bg-rose-500/150 hover:bg-rose-600 text-white px-4 py-2 rounded-xl font-medium transition-colors duration-200 flex items-center gap-1.5"
                        title="Permanently delete this voting session"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
              {/* Share link banner */}
              {newVotingId === activeVoting.id && (
                <div className="mt-3 p-3 bg-emerald-500/15 border border-emerald-400/30 rounded-lg flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-green-800 text-sm min-w-0">
                    <svg className="w-4 h-4 shrink-0 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="font-medium">Voting created!</span>
                    <span className="text-emerald-600 truncate hidden sm:block">{getVoteLink(activeVoting.id)}</span>
                  </div>
                  <button
                    onClick={() => copyVoteLink(activeVoting.id)}
                    className="shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3 py-1.5 rounded-lg font-medium transition-colors"
                  >
                    {linkCopied ? '✓ Copied' : 'Copy Link'}
                  </button>
                </div>
              )}

            </div>

            <div className="p-6">
              {usersVote ? (
                <div className="bg-emerald-500/15 border border-emerald-400/20 rounded-lg p-4">
                  <div className="flex items-center space-x-2">
                    <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <p className="font-medium text-emerald-100">You voted for {usersVote.playerName}</p>
                      {usersVote.reason && (
                        <p className="text-sm text-emerald-300">"{usersVote.reason}"</p>
                      )}
                    </div>
                  </div>
                </div>
              ) : canUserVote() ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-bone/85 mb-2">
                      Choose Player of the Match
                    </label>
                    <select
                      value={selectedPlayer}
                      onChange={(e) => setSelectedPlayer(e.target.value)}
                      className="w-full px-3 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-crimson-500"
                    >
                      <option value="">Select a player...</option>
                      {votableePlayers.map(player => (
                        <option key={player.id} value={player.id}>
                          #{player.jerseyNumber} {player.name} ({player.position})
                        </option>
                      ))}
                    </select>
                    {!isUserCoach && (
                      <p className="text-xs text-bone/50 mt-1">
                        Note: You cannot vote for your own child
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-bone/85 mb-2">
                      Reason (Optional)
                    </label>
                    <textarea
                      value={voteReason}
                      onChange={(e) => setVoteReason(e.target.value)}
                      rows={3}
                      className="w-full px-3 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-crimson-500"
                      placeholder="Why does this player deserve to be Player of the Match?"
                    />
                  </div>

                  <button
                    onClick={handleVote}
                    disabled={!selectedPlayer}
                    className="w-full bg-crimson-600 hover:bg-crimson-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Submit Vote
                  </button>
                </div>
              ) : (
                <div className="text-center text-bone/65">
                  <p>Voting is closed or you are not eligible to vote.</p>
                  {activeVoting.eligiblePlayerIds && activeVoting.eligiblePlayerIds.length > 0 && !isUserCoach && (
                    <p className="text-sm text-bone/50 mt-1">Only parents of players who were present at the match can vote.</p>
                  )}
                </div>
              )}

              {/* Current Results — coaches see live breakdown, others only see after voting closes */}
              {activeVoting.votes.length > 0 && isUserCoach && (
                <div className="mt-6 pt-6 border-t border-white/10">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-bone/85">
                      Vote Breakdown ({activeVoting.votes.length} vote{activeVoting.votes.length !== 1 ? 's' : ''})
                    </h3>
                    {isUserCoach && (
                      <button
                        onClick={() => setExpandedVoters(prev => {
                          const next = new Set(prev);
                          if (next.has(activeVoting.id)) next.delete(activeVoting.id);
                          else next.add(activeVoting.id);
                          return next;
                        })}
                        className="text-xs text-crimson-600 hover:underline font-medium"
                      >
                        {expandedVoters.has(activeVoting.id) ? 'Hide voter details' : 'Show voter details'}
                      </button>
                    )}
                  </div>

                  <div className="space-y-2">
                    {getVoteResults(activeVoting).map((result, index) => {
                      const pct = Math.round((result.count / activeVoting.votes.length) * 100);
                      const player = players.find(p => p.id === result.playerId);
                      return (
                        <div key={result.playerId}>
                          <div className="flex items-center gap-2">
                            <PlaceBadge index={index} />
                            <ResultAvatar player={player} name={result.name} />
                            <span className="font-medium text-bone w-28 sm:w-36 truncate">{result.name}</span>
                            <div className="flex-1 bg-white/[0.08] rounded-full h-2">
                              <div
                                className="h-2 rounded-full bg-crimson-500/150 transition-all duration-500"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-sm text-bone/50 w-16 text-right">{result.count} · {pct}%</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Per-vote table visible to coach only */}
                  {isUserCoach && expandedVoters.has(activeVoting.id) && (
                    <div className="mt-4 rounded-lg border border-white/10 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-white/[0.04] border-b border-white/10">
                          <tr>
                            <th className="text-left px-3 py-2 text-xs font-semibold text-bone/50 uppercase tracking-wide">Voter</th>
                            <th className="text-left px-3 py-2 text-xs font-semibold text-bone/50 uppercase tracking-wide">Voted for</th>
                            <th className="text-left px-3 py-2 text-xs font-semibold text-bone/50 uppercase tracking-wide">Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                          {activeVoting.votes.map((v, i) => (
                            <tr key={i} className="hover:bg-white/[0.05]">
                              <td className="px-3 py-2 font-medium text-bone">
                                <span className="inline-flex items-center gap-1.5 flex-wrap">
                                  <span>{v.voterName || '—'}</span>
                                  {v.isCoach && (
                                    <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-crimson-500/15 text-crimson-300 border border-crimson-400/30" title="Voted as coach">
                                      coach
                                    </span>
                                  )}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-bone/85">{v.playerName}</td>
                              <td className="px-3 py-2 text-bone/50 italic">{v.reason || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Non-coaches see a "results hidden" notice while voting is active */}
              {activeVoting.votes.length > 0 && !isUserCoach && (
                <div className="mt-6 pt-6 border-t border-white/10">
                  <div className="bg-white/[0.04] border border-white/10 rounded-lg p-4 text-center">
                    <svg className="w-8 h-8 text-bone/40 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
                    </svg>
                    <p className="text-sm font-medium text-bone/85">Results are hidden while voting is open</p>
                    <p className="text-xs text-bone/50 mt-1">Results will be visible once the coach closes voting</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Current POTM banner — shows whoever has the gold ring right
            now, with a Clear button so a coach can retire the badge
            mid-season without finalizing a new vote. */}
        {players.some(p => (p as any).isCurrentPotm) && (
          <div className="card-modern bg-gradient-to-br from-amber-50 to-amber-100 ring-1 ring-amber-300 mb-6">
            <div className="px-5 py-3 flex items-center gap-3">
              <span className="flex-shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full bg-amber-400 text-amber-950">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z"/></svg>
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-widest text-amber-300">Current Player of the Match</div>
                <div className="text-sm font-bold text-amber-950 truncate">
                  {players.filter(p => (p as any).isCurrentPotm).map(p => p.name).join(' · ')}
                </div>
              </div>
              <button
                type="button"
                onClick={async () => {
                  if (!window.confirm('Clear the gold ring from this player? It stays cleared until the next POTM is voted in.')) return;
                  try {
                    const { collection, getDocs, query, where, doc: fsDoc, updateDoc: fsUpdate } = await import('firebase/firestore');
                    const { db } = await import('../utils/firebase');
                    const snap = await getDocs(query(
                      collection(db, 'players'),
                      where('teamIds', 'array-contains', selectedTeamId || ''),
                      where('isCurrentPotm', '==', true),
                    ));
                    await Promise.all(snap.docs.map(d => fsUpdate(fsDoc(db, 'players', d.id), { isCurrentPotm: false, potmAt: null })));
                    loadData();
                  } catch (err) {
                    console.error('clear POTM failed', err);
                    alert('Clear failed — try again.');
                  }
                }}
                className="flex-shrink-0 px-3 py-1.5 rounded-lg bg-amber-900/10 hover:bg-amber-900/20 text-amber-900 text-[11px] font-bold tracking-widest uppercase"
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {/* Previous Votings */}
        <div className="card-modern">
          <div className="px-6 py-4 border-b border-white/10">
            <h2 className="text-lg font-semibold text-bone">Previous Results</h2>
          </div>
          <div className="p-6">
            {votings.filter(v => !v.isActive).length === 0 ? (
              <div className="text-center py-8">
                <div className="text-bone/40 mb-4">
                  <svg className="mx-auto h-16 w-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h3 className="text-lg font-medium text-bone mb-2">No completed votings</h3>
                <p className="text-bone/65">Previous Player of the Match results will appear here</p>
              </div>
            ) : (
              <div className="space-y-6">
                {votings.filter(v => !v.isActive).map(voting => {
                  const results = getVoteResults(voting);
                  const linkedEvent = voting.calendarEventId 
                    ? calendarEvents.find(e => e.id === voting.calendarEventId)
                    : null;
                  
                  return (
                    <div key={voting.id} className="border border-white/10 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <h3 className="font-semibold text-bone">{voting.gameTitle}</h3>
                          <div className="flex items-center space-x-4 text-sm text-bone/65">
                            <span>{formatDate(voting.gameDate)}</span>
                            {linkedEvent && (
                              <span className="flex items-center space-x-1">
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                                </svg>
                                <span>Linked to calendar</span>
                              </span>
                            )}
                          </div>
                        </div>
                        {(voting.winners && voting.winners.length > 0) || voting.winner ? (
                          <div className="text-right">
                            <div className="flex items-center gap-2">
                              <span className="w-9 h-9 rounded-xl bg-crimson-500/20 text-crimson-300 flex items-center justify-center shrink-0">
                                <AppIcon name="trophy" className="w-5 h-5" />
                              </span>
                              <div>
                                {voting.winners && voting.winners.length > 1 ? (
                                  <>
                                    <p className="font-semibold text-crimson-300 text-sm">Co-Players of the Match ({voting.winners.length})</p>
                                    <p className="text-xs text-bone/65">{voting.winners.map(w => w.playerName).join(', ')}</p>
                                    <p className="text-xs text-bone/50 mt-0.5">{voting.winners[0].voteCount} votes each</p>
                                  </>
                                ) : (
                                  <>
                                    <p className="font-semibold text-crimson-300">{(voting.winners?.[0] || voting.winner)!.playerName}</p>
                                    <p className="text-sm text-bone/65">{(voting.winners?.[0] || voting.winner)!.voteCount} votes</p>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>

                      {results.length > 0 && (
                        <div className="space-y-2">
                          {results.map((result, index) => {
                            const pct = voting.votes.length > 0 ? Math.round((result.count / voting.votes.length) * 100) : 0;
                            const player = players.find(p => p.id === result.playerId);
                            return (
                              <div key={result.playerId}>
                                <div className="flex items-center gap-2 py-1.5">
                                  <PlaceBadge index={index} />
                                  <ResultAvatar player={player} name={result.name} />
                                  <span className="font-medium text-bone w-28 sm:w-36 truncate">{result.name}</span>
                                  <div className="flex-1 bg-white/[0.08] rounded-full h-2">
                                    <div
                                      className="h-2 rounded-full bg-crimson-500/150"
                                      style={{ width: `${pct}%` }}
                                    />
                                  </div>
                                  <span className="text-sm text-bone/50 w-16 text-right">{result.count} · {pct}%</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Coach-only voter breakdown for past sessions */}
                      {isUserCoach && voting.votes.length > 0 && (
                        <div className="mt-3">
                          <button
                            onClick={() => setExpandedVoters(prev => {
                              const next = new Set(prev);
                              if (next.has(voting.id)) next.delete(voting.id);
                              else next.add(voting.id);
                              return next;
                            })}
                            className="text-xs text-crimson-600 hover:underline font-medium"
                          >
                            {expandedVoters.has(voting.id)
                              ? '▲ Hide voter details'
                              : `▼ Show all ${voting.votes.length} voter${voting.votes.length !== 1 ? 's' : ''}`}
                          </button>
                          {expandedVoters.has(voting.id) && (
                            <div className="mt-2 rounded-lg border border-white/10 overflow-hidden">
                              <table className="w-full text-sm">
                                <thead className="bg-white/[0.04] border-b border-white/10">
                                  <tr>
                                    <th className="text-left px-3 py-2 text-xs font-semibold text-bone/50 uppercase tracking-wide">Voter</th>
                                    <th className="text-left px-3 py-2 text-xs font-semibold text-bone/50 uppercase tracking-wide">Voted for</th>
                                    <th className="text-left px-3 py-2 text-xs font-semibold text-bone/50 uppercase tracking-wide">Reason</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5">
                                  {voting.votes.map((v, i) => (
                                    <tr key={i} className="hover:bg-white/[0.05]">
                                      <td className="px-3 py-2 font-medium text-bone">
                                        <span className="inline-flex items-center gap-1.5 flex-wrap">
                                          <span>{v.voterName || '—'}</span>
                                          {v.isCoach && (
                                            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-crimson-500/15 text-crimson-300 border border-crimson-400/30" title="Voted as coach">
                                              coach
                                            </span>
                                          )}
                                        </span>
                                      </td>
                                      <td className="px-3 py-2 text-bone/85">{v.playerName}</td>
                                      <td className="px-3 py-2 text-bone/50 italic">{v.reason || '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Attendance Step Modal */}
      {showAttendanceStep && (pendingVotingData || editingVotingId) && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-charcoal-900 rounded-2xl shadow-xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-semibold text-bone mb-2">{editingVotingId ? 'Edit Attendance' : 'Mark Attendance'}</h2>
            {pendingVotingData && (
            <p className="text-sm text-bone/65 mb-1">
              <strong>{pendingVotingData.gameTitle}</strong> — {formatDate(pendingVotingData.gameDate)}
            </p>
            )}
            <p className="text-sm text-bone/50 mb-4">
              Check the players who were <strong>present</strong> at this match. Only their parents will be able to vote.
            </p>

            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-bone/85">
                {attendancePlayerIds.size}/{players.length} present
              </span>
              <div className="space-x-2">
                <button
                  onClick={() => setAttendancePlayerIds(new Set(players.map(p => p.id)))}
                  className="text-xs text-crimson-600 hover:underline"
                >
                  Select all
                </button>
                <button
                  onClick={() => setAttendancePlayerIds(new Set())}
                  className="text-xs text-rose-300 hover:underline"
                >
                  Clear all
                </button>
              </div>
            </div>

            <div className="space-y-1 mb-6">
              {players
                .sort((a, b) => (a.jerseyNumber || 0) - (b.jerseyNumber || 0))
                .map(player => (
                <label
                  key={player.id}
                  className={`flex items-center space-x-3 p-2 rounded-lg cursor-pointer transition-colors ${
                    attendancePlayerIds.has(player.id) ? 'bg-green-50 hover:bg-green-100' : 'bg-rose-500/15 hover:bg-red-100'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={attendancePlayerIds.has(player.id)}
                    onChange={() => toggleAttendance(player.id)}
                    className="w-4 h-4 rounded border-white/15 text-emerald-600 focus:ring-green-500"
                  />
                  <span className="text-sm font-medium text-bone">
                    {player.jerseyNumber ? `#${player.jerseyNumber} ` : ''}{player.name}
                  </span>
                  <span className="text-xs text-bone/50">{player.position}</span>
                  {!attendancePlayerIds.has(player.id) && (
                    <span className="text-xs text-rose-300 font-medium ml-auto">Absent</span>
                  )}
                </label>
              ))}
            </div>

            {attendancePlayerIds.size === 0 && (
              <p className="text-sm text-rose-300 mb-3">At least one player must be present to create voting.</p>
            )}

            <div className="flex justify-end space-x-3">
              <button
                onClick={() => { setShowAttendanceStep(false); setPendingVotingData(null); setEditingVotingId(null); }}
                className="px-4 py-2 border border-white/15 rounded-lg text-bone/85 hover:bg-white/[0.05]"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmAttendanceAndCreate}
                disabled={attendancePlayerIds.size === 0}
                className="px-4 py-2 bg-crimson-600 text-white rounded-lg hover:bg-crimson-700 disabled:opacity-50 font-medium"
              >
                {editingVotingId ? `Update Attendance (${attendancePlayerIds.size} eligible)` : `Create Voting (${attendancePlayerIds.size} eligible)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Voting Modal — dark navy header chrome + light body
          to match the rest of the app's modal pattern (Wall composer,
          message-action sheet, emoji picker). overflow-x-hidden on
          the body kills the horizontal scroll Patrick reported. */}
      {showCreateModal && (
        <div
          className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center sm:p-4 z-50 animate-fade-in"
          onClick={() => setShowCreateModal(false)}
        >
          <div
            className="bg-charcoal-900 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[88vh] overflow-hidden animate-sheet-up sm:animate-pop-in"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-gradient-to-b from-charcoal-950 to-charcoal-900 px-4 py-3 flex items-center justify-between flex-shrink-0">
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-[11px] font-extrabold tracking-widest uppercase text-bone/40 hover:text-white"
              >
                Cancel
              </button>
              <div className="text-xs font-extrabold tracking-widest uppercase text-crimson-400">New vote</div>
              <span className="w-12" aria-hidden />
            </div>

            <div className="flex-1 overflow-y-auto overflow-x-hidden p-5 space-y-5">
              {/* Option 1: Link to Calendar Game */}
              {availableGames.length > 0 && (
                <div>
                  <h3 className="text-[11px] font-extrabold uppercase tracking-widest text-bone/50 mb-2">
                    Pick a scheduled game
                  </h3>
                  <div className="space-y-1.5">
                    {availableGames.map(game => (
                      <button
                        key={game.id}
                        onClick={() => handleCreateVotingFromCalendarEvent(game.id)}
                        className="w-full text-left p-3 rounded-xl bg-white/[0.04] ring-1 ring-white/10 hover:bg-crimson-500/15 hover:ring-crimson-300 transition"
                      >
                        <div className="flex items-center justify-between gap-2 min-w-0">
                          <div className="flex-1 min-w-0">
                            <div className="font-bold text-bone text-sm truncate">{game.title}</div>
                            <div className="text-xs text-bone/65 truncate">
                              {formatDate(game.date)}{game.location ? ` · ${game.location}` : ''}{game.opponent ? ` · vs ${game.opponent}` : ''}
                            </div>
                          </div>
                          <svg className="w-4 h-4 text-bone/40 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/></svg>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* No-calendar-games hint — cyan, not yellow, matches
                  the rest of the app's empty-state design. Compact:
                  one line + a calendar link. The 5-step instructions
                  were overkill for a coach. */}
              {availableGames.length === 0 && calendarEvents.filter(e => e.type === 'game').length === 0 && (
                <div className="rounded-xl bg-crimson-500/15 ring-1 ring-crimson-100 px-3 py-2.5 text-[12.5px] text-crimson-900">
                  <span className="font-semibold">No games scheduled yet.</span>{' '}
                  <Link to="/calendar" onClick={() => setShowCreateModal(false)} className="text-crimson-300 font-bold hover:text-crimson-900 underline underline-offset-2">
                    Add a game on the calendar
                  </Link>{' '}
                  to link voting to it — or fill out a custom vote below.
                </div>
              )}

              {/* Option 2: Custom Game */}
              <div>
                <h3 className="text-[11px] font-extrabold uppercase tracking-widest text-bone/50 mb-2">
                  {availableGames.length > 0 ? 'Or create a custom vote' : 'Create a custom vote'}
                </h3>
                <CustomGameForm onSubmit={handleCreateCustomVoting} />
              </div>
            </div>

            <div className="flex-shrink-0 border-t border-white/5 bg-white/[0.04]/60 px-5 py-3 flex justify-end">
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-[12px] font-extrabold tracking-widest uppercase px-4 py-2 rounded-lg text-bone/65 hover:bg-white/[0.08]"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Custom Game Form Component
interface CustomGameFormProps {
  onSubmit: (gameTitle: string, gameDate: Date, location?: string, opponent?: string, homeAway?: 'home' | 'away') => void;
}

const CustomGameForm: React.FC<CustomGameFormProps> = ({ onSubmit }) => {
  const [gameTitle, setGameTitle] = useState('');
  const [gameDate, setGameDate] = useState('');
  const [gameTime, setGameTime] = useState('15:00');
  const [location, setLocation] = useState('');
  const [opponent, setOpponent] = useState('');
  const [homeAway, setHomeAway] = useState<'home' | 'away' | ''>('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!gameTitle.trim() || !gameDate) return;
    const dateTime = new Date(`${gameDate}T${gameTime}`);
    onSubmit(
      gameTitle.trim(),
      dateTime,
      location.trim() || undefined,
      opponent.trim() || undefined,
      homeAway || undefined,
    );
    setGameTitle(''); setGameDate(''); setGameTime('15:00');
    setLocation(''); setOpponent(''); setHomeAway('');
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-bone/85 mb-1">Game Title</label>
        <input
          type="text"
          value={gameTitle}
          onChange={(e) => setGameTitle(e.target.value)}
          className="w-full px-3 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-crimson-500"
          placeholder="e.g., vs Eagles, Championship Final"
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-bone/85 mb-1">Game Date</label>
          <input
            type="date"
            value={gameDate}
            onChange={(e) => setGameDate(e.target.value)}
            className="w-full px-3 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-crimson-500"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-bone/85 mb-1">Game Time</label>
          <input
            type="time"
            value={gameTime}
            onChange={(e) => setGameTime(e.target.value)}
            className="w-full px-3 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-crimson-500"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-bone/85 mb-1">Opponent <span className="text-bone/40 font-normal">(optional)</span></label>
          <input
            type="text"
            value={opponent}
            onChange={(e) => setOpponent(e.target.value)}
            className="w-full px-3 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-crimson-500"
            placeholder="e.g. Eagles FC"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-bone/85 mb-1">Home / Away <span className="text-bone/40 font-normal">(optional)</span></label>
          <select
            value={homeAway}
            onChange={(e) => setHomeAway(e.target.value as 'home' | 'away' | '')}
            className="w-full px-3 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-crimson-500"
          >
            <option value="">—</option>
            <option value="home">Home</option>
            <option value="away">Away</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-bone/85 mb-1">Venue / Location <span className="text-bone/40 font-normal">(optional)</span></label>
        <input
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          className="w-full px-3 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-crimson-500"
          placeholder="e.g. Town Park, Pitch 3"
        />
      </div>

      <p className="text-[12px] text-bone/50">
        <span className="font-bold text-bone/85">Note:</span> Parents cannot vote for their own children to ensure fair voting.
      </p>

      <button
        type="submit"
        disabled={!gameTitle.trim() || !gameDate}
        className="w-full bg-crimson-600 hover:bg-crimson-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50"
      >
        Create Custom Voting
      </button>
    </form>
  );
};

/** Small result-row avatar — shows the player's photo if we have it,
 *  falls back to a brand-tinted initial circle. Used next to the
 *  player name in vote results so the leaderboard reads at a glance. */
const ResultAvatar: React.FC<{ player: Player | undefined; name: string }> = ({ player, name }) => {
  const photo = (player as any)?.profilePhotoUrl;
  if (photo) {
    return (
      <img
        src={photo}
        alt={name}
        className="w-7 h-7 rounded-full object-cover ring-2 ring-white shrink-0"
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
      />
    );
  }
  return (
    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-crimson-400 to-crimson-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
      {(name || '?').charAt(0).toUpperCase()}
    </div>
  );
};

/** Place badge — 1st gets a brand-colored trophy chip, 2nd/3rd get
 *  numbered chips in lighter tones. Replaces the medal emojis with
 *  shapes that match the rest of the app's icon language. */
const PlaceBadge: React.FC<{ index: number }> = ({ index }) => {
  if (index === 0) {
    return (
      <span className="w-6 h-6 rounded-full bg-crimson-600 text-white flex items-center justify-center flex-shrink-0" title="1st">
        <AppIcon name="trophy" className="w-3.5 h-3.5" strokeWidth={2.25} />
      </span>
    );
  }
  if (index === 1) {
    return (
      <span className="w-6 h-6 rounded-full bg-crimson-500/20 text-crimson-200 flex items-center justify-center text-[11px] font-bold flex-shrink-0" title="2nd">2</span>
    );
  }
  if (index === 2) {
    return (
      <span className="w-6 h-6 rounded-full bg-crimson-500/15 text-crimson-300 flex items-center justify-center text-[11px] font-bold flex-shrink-0" title="3rd">3</span>
    );
  }
  return (
    <span className="w-6 h-6 rounded-full bg-white/[0.08] text-bone/65 flex items-center justify-center text-[11px] font-semibold flex-shrink-0">{index + 1}</span>
  );
};

export default PlayerOfMatch;