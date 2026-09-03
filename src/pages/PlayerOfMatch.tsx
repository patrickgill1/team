import React, { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { Player, CalendarEvent } from '../types';
import { formatDate, isCoachOfTeam } from '../utils/helpers';
import { useTeamAudience } from '../hooks/useTeamAudience';
import { isXpSourceEnabled } from '../utils/xpSource';
import { doc, updateDoc, arrayUnion, where, orderBy, limit } from 'firebase/firestore';
import { db } from '../utils/firebase';
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
  const { selectedTeamId, selectedTeam } = useTeam();
  const { getDocuments, addDocument, updateDocument, deleteDocument, getPlayersByTeam, getEventsByTeam } = useFirestore();
  const [players, setPlayers] = useState<Player[]>([]);
  const [votings, setVotings] = useState<MatchVoting[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [activeVoting, setActiveVoting] = useState<MatchVoting | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedPlayer, setSelectedPlayer] = useState('');
  const [voteReason, setVoteReason] = useState('');
  const [selectedCalendarEvent, setSelectedCalendarEvent] = useState('');
  const [newVotingId, setNewVotingId] = useState<string | null>(null);
  const [expandedVoters, setExpandedVoters] = useState<Set<string>>(new Set());
  // Diagnostic surface for POTM badge grant failures. Shown inline on
  // the page after a Close Voting so Patrick can see WHY a badge
  // didn't stamp instead of the failure disappearing into console.warn.
  const [badgeGrantNotice, setBadgeGrantNotice] = useState<
    | null
    | { kind: 'skipped' | 'granted' | 'failed'; playerName: string; reason?: string }[]
  >(null);

  // Attendance tracking
  const [showAttendanceStep, setShowAttendanceStep] = useState(false);
  const [attendancePlayerIds, setAttendancePlayerIds] = useState<Set<string>>(new Set());
  const [pendingVotingData, setPendingVotingData] = useState<Omit<MatchVoting, 'id' | 'eligiblePlayerIds'> | null>(null);
  const [editingVotingId, setEditingVotingId] = useState<string | null>(null);

  const isUserCoach = isCoachOfTeam(userData, selectedTeam);
  const { isAdult: isAdultTeam, copy: teamCopy } = useTeamAudience(selectedTeam as any);
  // Adult teams use "MVP" / "Vote for MVP"; youth stays "Player of the
  // Match". Both use the same underlying voting model — this is a copy
  // swap only, no separate ballot page.
  const potmTitle = teamCopy.potmTitle;
  const potmVoteVerb = teamCopy.potmVoteVerb;
  const potmReasonPlaceholder = teamCopy.potmReasonPlaceholder;

  useEffect(() => {
    loadData();
  }, [selectedTeamId]);

  const loadData = async () => {
    if (!selectedTeamId) { setLoading(false); return; }

    try {
      setLoading(true);
      
      // Load players (team-scoped), events, and votings in parallel.
      // Events + votings now scope by teamId server-side (getEventsByTeam
      // for events; explicit where('teamId') for match_votings) so we
      // don't scan every club's events and drop 99% client-side.
      const [teamPlayersRaw, eventsData, votingsData] = await Promise.all([
        getPlayersByTeam(selectedTeamId).catch(() => []),
        getEventsByTeam(selectedTeamId),
        getDocuments('match_votings', [
          where('teamId', '==', selectedTeamId),
          orderBy('gameDate', 'desc'),
          limit(50),
        ]),
      ]);
      setPlayers(teamPlayersRaw.map((p: any) => ({
        ...p,
        createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt),
      })));

      const teamGameEvents = eventsData
        .filter((e: any) => e.type === 'game')
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

      // Set active voting. 2026-07-14: honor ?voting=<id> deep-link
      // from the Wall's Vote-now button (PotmVotingCard) — the
      // wall card jumps here with the voting id in the query, so
      // parents land on the exact ballot instead of the coach's
      // history list. Falls back to isActive if no query param.
      let targetVoting: any = null;
      try {
        const q = new URLSearchParams(window.location.search).get('voting');
        if (q) targetVoting = teamVotings.find((v: any) => v.id === q) || null;
      } catch { /* SSR-safe noop */ }
      if (!targetVoting) targetVoting = teamVotings.find((v: any) => v.isActive) || null;
      setActiveVoting(targetVoting);
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
      alert(`A ${potmTitle} voting already exists for this game.`);
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
      // Culture engine: post the voting-open CTA to the Wall so
      // parents don't need a coach to hand them a link. Fire-and-
      // forget; wall write failure never blocks the voting create.
      if (newId && userData && (voting as any).teamId) {
        void (async () => {
          try {
            const { autoPostPotmVotingOpenToWall } = await import('../utils/autoPostToWall');
            await autoPostPotmVotingOpenToWall(
              (voting as any).teamId as string,
              newId,
              (voting as any).gameTitle || 'Match',
              { uid: userData.uid, name: userData.name || 'Coach', role: userData.role || 'coach' },
              {
                audience: (selectedTeam as any)?.audienceType === 'adult' ? 'adult' : 'youth',
                eligibleCount: Array.from(attendancePlayerIds).length,
              },
            );
          } catch (e) {
            console.warn('POTM auto-post to wall failed', e);
          }
        })();
      }
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

    // Prevent voters from voting for their own children. Applies to
    // parents AND coach-parents (a coach whose own kid is on the
    // roster still can't cast for them — same rule as parents so the
    // ballot stays clean). For adult teams the guard reads as "can't
    // vote for yourself" since adult self-players sit in their own
    // parentIds.
    if (player.parentIds?.includes(userData.uid)) {
      const isAdultTeam = (selectedTeam as any)?.audienceType === 'adult';
      alert(isAdultTeam
        ? "You can't vote for yourself. Pick another player."
        : "You cannot vote for your own child. Please select another player.");
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
          const { maybeGrantFirstPotm } = await import('../utils/badgeGrants');
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
          // Mark new winners. The isCurrentPotm/potmAt flip is a client
          // write (fields the rules already allow the coach to mutate).
          // The first_potm badge + XP grant is fire-and-forget through
          // the worker (maybeGrantFirstPotm → awardMicroXp) so the
          // badge stamp + player_xp_events audit row + player.xp
          // increment land as one atomic service-account commit.
          // Retroactive-safe: existing badges gate the grant, so a kid
          // with 3 pre-ship POTMs but no badge entry gets first_potm
          // on this POTM (the FIRST from this ship forward).
          // 2026-08-24 diagnostic: was `void maybeGrantFirstPotm(...)`
          // — fire-and-forget swallowed every failure to console.warn,
          // and audit found ZERO first_potm events across 20 closed
          // POTMs on XP-enabled teams. Await + log the actual result
          // so the next Vercel deploy surfaces the real failure mode
          // (worker rejection code, network error, or "grant skipped
          // because ..."). Kept in a try/catch so a bad grant never
          // blocks the isCurrentPotm flip.
          const notices: { kind: 'skipped' | 'granted' | 'failed'; playerName: string; reason?: string }[] = [];
          await Promise.all(winners.map(async w => {
            const player = players.find(p => p.id === w.playerId);
            try {
              const result = await maybeGrantFirstPotm(w.playerId, {
                existingBadges: (player as any)?.badges,
                gameTitle: activeVoting.gameTitle,
                seasonId: (activeVoting as any).seasonId,
                team: selectedTeam as any,
                teamId: selectedTeamId,
              });
              if (result.ok) {
                if (result.outcome === 'skipped' || result.outcome === 'already_exists') {
                  notices.push({ kind: 'skipped', playerName: w.playerName, reason: result.reason || result.outcome });
                } else {
                  notices.push({ kind: 'granted', playerName: w.playerName });
                }
              } else {
                console.error('[POTM] first_potm grant failed for', w.playerId, result.reason);
                notices.push({ kind: 'failed', playerName: w.playerName, reason: result.reason });
              }
            } catch (err) {
              console.error('[POTM] first_potm grant threw for', w.playerId, err);
              notices.push({ kind: 'failed', playerName: w.playerName, reason: String((err as any)?.message || err) });
            }
            return fsUpdate(fsDoc(db, 'players', w.playerId), { isCurrentPotm: true, potmAt: new Date() });
          }));
          // Only render the notice card when something failed or was
          // skipped — a clean "granted for everyone" run stays quiet.
          const hasSignal = notices.some(n => n.kind !== 'granted');
          setBadgeGrantNotice(hasSignal ? notices : null);
        }
      } catch (e) { console.warn('POTM flag update failed', e); }

      // Auto-post each winner to the team wall as a crown celebration
      // (structured potmResult payload → PotmWinnerCard).
      try {
        if (winners.length > 0 && selectedTeamId && userData) {
          const { autoPostPotmToWall } = await import('../utils/autoPostToWall');
          const actor = { uid: userData.uid, name: userData.name || 'Coach', role: 'coach' };
          const isCoWin = winners.length > 1;
          for (const w of winners) {
            const player = players.find(p => p.id === w.playerId);
            void autoPostPotmToWall(
              {
                id: w.playerId,
                name: w.playerName,
                teamId: selectedTeamId,
                photoUrl: player?.profilePhotoUrl || null,
              },
              activeVoting.gameTitle,
              actor,
              w.voteCount,
              { isCoWin, gameDate: activeVoting.gameDate },
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
              title: isCoWin
                ? (isAdultTeam ? `${w.playerName} is co-${potmTitle}!` : `${w.playerName} is co-Player of the Match!`)
                : `${w.playerName} is ${potmTitle}!`,
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

    // Every voter (parent or coach) gets filtered by "not your kid" —
    // a coach-parent still can't vote for their own child, matching
    // the handleVote guard above.
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
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-brand-primary-soft/30 border-t-cyan-500" />
          <span className="text-sm text-ink-primary/40 font-medium">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-base">
      <Header title={potmTitle} subtitle={isAdultTeam ? 'Vote up the best player from every match.' : 'Vote up the standout from every match.'} />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {isUserCoach && (
          <div className="mb-6 flex justify-end">
            <button
              onClick={() => setShowCreateModal(true)}
              className="bg-brand-primary hover:bg-brand-primary text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2"
            >
              <AppIcon name="plus" className="w-4 h-4" strokeWidth={2.5} />
              <span>Create Voting</span>
            </button>
          </div>
        )}

        {/* Active Voting */}
        {activeVoting && (
          <div className="card-modern mb-6 overflow-hidden">
            <div className="px-6 py-4 border-b border-brand-primary-soft/20 bg-surface-elevated">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <span className="w-10 h-10 rounded-xl bg-brand-primary/20 text-brand-primary-soft flex items-center justify-center shrink-0">
                    <AppIcon name="trophy" className="w-5 h-5" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold text-ink-primary">Active voting</h2>
                    <p className="text-ink-primary/85 truncate">{activeVoting.gameTitle} — {formatDate(activeVoting.gameDate)}</p>
                    {activeVoting.calendarEventId && (
                      <p className="text-xs text-ink-primary/50 mt-0.5">Linked to a calendar event</p>
                    )}
                    {activeVoting.eligiblePlayerIds && activeVoting.eligiblePlayerIds.length > 0 && (
                      <p className="text-xs text-ink-primary/50">
                        Attendance: {activeVoting.eligiblePlayerIds.length}/{players.length} players present
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {/* 2026-07-14: "Share Vote Link" removed — voting is
                      app-only now (see [[project_sideline_shouts]] +
                      Patrick's kill-public-share ask). Wall post
                      renders the interactive ballot inline; no need
                      for a shareable URL. */}
                  {isUserCoach && (
                    <>
                      <button
                        onClick={handleEditAttendance}
                        className="bg-brand-primary hover:bg-brand-primary text-white px-4 py-2 rounded-xl font-medium transition-colors duration-200 flex items-center gap-1.5"
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
              {/* "Voting created" banner — 2026-07-14 pointed at the
                  Wall now that the ballot lives there. Copy-link
                  affordance removed (public /vote/:id sunset). */}
              {newVotingId === activeVoting.id && (
                <div className="mt-3 p-3 bg-emerald-500/15 border border-emerald-400/30 rounded-lg flex items-center gap-3">
                  <svg className="w-4 h-4 shrink-0 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-sm text-emerald-800 font-medium">
                    Voting created! Parents will see the ballot on the Team Wall.
                  </span>
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
                    <label className="block text-sm font-medium text-ink-primary/85 mb-2">
                      Choose {potmTitle}
                    </label>
                    <select
                      value={selectedPlayer}
                      onChange={(e) => setSelectedPlayer(e.target.value)}
                      className="w-full px-3 py-2 bg-surface-base text-ink-primary [color-scheme:dark] border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                    >
                      <option value="">Select a player...</option>
                      {votableePlayers.map(player => (
                        <option key={player.id} value={player.id}>
                          #{player.jerseyNumber} {player.name} ({player.position})
                        </option>
                      ))}
                    </select>
                    {players.some(p => p.parentIds?.includes(userData?.uid || '')) && (
                      <p className="text-xs text-ink-primary/50 mt-1">
                        Note: You cannot vote for your own child
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-2">
                      Reason (Optional)
                    </label>
                    <textarea
                      value={voteReason}
                      onChange={(e) => setVoteReason(e.target.value)}
                      rows={3}
                      className="w-full px-3 py-2 bg-surface-input text-ink-primary placeholder:text-ink-primary/45 border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                      placeholder={potmReasonPlaceholder}
                    />
                  </div>

                  <button
                    onClick={handleVote}
                    disabled={!selectedPlayer}
                    className="w-full bg-brand-primary hover:bg-brand-primary text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Submit Vote
                  </button>
                </div>
              ) : (
                <div className="text-center text-ink-primary/65">
                  <p>Voting is closed or you are not eligible to vote.</p>
                  {activeVoting.eligiblePlayerIds && activeVoting.eligiblePlayerIds.length > 0 && !isUserCoach && (
                    <p className="text-sm text-ink-primary/50 mt-1">Only parents of players who were present at the match can vote.</p>
                  )}
                </div>
              )}

              {/* Current Results — coaches see live breakdown, others only see after voting closes */}
              {activeVoting.votes.length > 0 && isUserCoach && (
                <div className="mt-6 pt-6 border-t border-line-default/10">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-ink-primary/85">
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
                        className="text-xs text-brand-primary hover:underline font-medium"
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
                            <span className="font-medium text-ink-primary w-28 sm:w-36 truncate">{result.name}</span>
                            <div className="flex-1 bg-line-default/[0.08] rounded-full h-2">
                              <div
                                className="h-2 rounded-full bg-brand-primary/150 transition-all duration-500"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-sm text-ink-primary/50 w-16 text-right">{result.count} · {pct}%</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Per-vote table visible to coach only */}
                  {isUserCoach && expandedVoters.has(activeVoting.id) && (
                    <div className="mt-4 rounded-lg border border-line-default/10 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-line-default/[0.04] border-b border-line-default/10">
                          <tr>
                            <th className="text-left px-3 py-2 text-xs font-semibold text-ink-primary/50 uppercase tracking-wide">Voter</th>
                            <th className="text-left px-3 py-2 text-xs font-semibold text-ink-primary/50 uppercase tracking-wide">Voted for</th>
                            <th className="text-left px-3 py-2 text-xs font-semibold text-ink-primary/50 uppercase tracking-wide">Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line-default/5">
                          {activeVoting.votes.map((v, i) => (
                            <tr key={i} className="hover:bg-line-default/[0.05]">
                              <td className="px-3 py-2 font-medium text-ink-primary">
                                <span className="inline-flex items-center gap-1.5 flex-wrap">
                                  <span>{v.voterName || '—'}</span>
                                  {v.isCoach && (
                                    <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-brand-primary/15 text-brand-primary-soft border border-brand-primary-soft/30" title="Voted as coach">
                                      coach
                                    </span>
                                  )}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-ink-primary/85">{v.playerName}</td>
                              <td className="px-3 py-2 text-ink-primary/50 italic">{v.reason || '—'}</td>
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
                <div className="mt-6 pt-6 border-t border-line-default/10">
                  <div className="bg-line-default/[0.04] border border-line-default/10 rounded-lg p-4 text-center">
                    <svg className="w-8 h-8 text-ink-primary/40 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
                    </svg>
                    <p className="text-sm font-medium text-ink-primary/85">Results are hidden while voting is open</p>
                    <p className="text-xs text-ink-primary/50 mt-1">Results will be visible once the coach closes voting</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Available Games for Voting (Coach only) */}
        {isUserCoach && (
          <div className="mb-6">
            {availableGames.length > 0 ? (
              // Neutral informational panel — red-tinted chrome (2026-07-31
              // "red on red is harsh") replaced with the same surface/ring
              // tokens the empty state below uses. Red stays reserved for
              // the Start Voting CTA button, which is where a coach's eye
              // should actually land.
              <div className="bg-surface-elevated ring-1 ring-line-default/10 rounded-2xl p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <svg className="w-5 h-5 text-ink-primary/55 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-ink-primary mb-1">
                      Games available for {potmTitle} voting
                    </h3>
                    <p className="text-[13px] text-ink-primary/60 mb-3">
                      Create voting sessions for recent or upcoming games
                    </p>
                    <div className="space-y-2">
                      {availableGames.map(game => (
                        <div key={game.id} className="flex items-center justify-between bg-surface-input rounded-lg p-3 ring-1 ring-line-default/10">
                          <div className="min-w-0 flex-1 pr-3">
                            <p className="font-semibold text-ink-primary truncate">{game.title}</p>
                            <p className="text-sm text-ink-primary/60 truncate">
                              {formatDate(game.date)} at {game.location}
                              {game.opponent && ` - vs ${game.opponent}`}
                            </p>
                          </div>
                          <button
                            onClick={() => handleCreateVotingFromCalendarEvent(game.id)}
                            className="bg-brand-primary hover:brightness-110 text-white px-3 py-1.5 rounded text-sm font-semibold transition flex items-center gap-1 flex-shrink-0"
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
              <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 p-5 shadow-sm">
                <div className="flex items-start gap-3">
                  <span className="flex-shrink-0 w-10 h-10 rounded-full bg-brand-primary/15 ring-1 ring-brand-primary-soft flex items-center justify-center text-brand-primary">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <rect x="3" y="4" width="18" height="18" rx="2"/>
                      <line x1="16" y1="2" x2="16" y2="6"/>
                      <line x1="8" y1="2" x2="8" y2="6"/>
                      <line x1="3" y1="10" x2="21" y2="10"/>
                    </svg>
                  </span>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-ink-primary mb-1">No games scheduled yet</h3>
                    <p className="text-sm text-ink-primary/65 mb-3">
                      Add a game to your calendar to start a {potmTitle} vote, or hit <span className="font-semibold text-ink-primary/90">Create Voting</span> above to build a custom vote for any game.
                    </p>
                    <Link
                      to="/calendar"
                      className="inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary-dim"
                    >
                      Open calendar
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                    </Link>
                  </div>
                </div>
              </div>
            ) : !activeVoting && (
              <div className="bg-line-default/[0.04] border border-line-default/10 rounded-lg p-4">
                <div className="flex items-start space-x-3">
                  <svg className="w-5 h-5 text-ink-primary/50 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div>
                    <h3 className="text-sm font-medium text-ink-primary/85 mb-1">All Recent Games Have Voting</h3>
                    <p className="text-sm text-ink-primary/65">
                      All your recent and upcoming games already have {potmTitle} voting sessions.
                      You can create a custom voting session if needed.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}



        {/* Badge-grant diagnostic — surfaces the outcome of the
            maybeGrantFirstPotm call from the most recent Close Voting.
            Silent on happy path (fully granted); renders a card only
            when a grant was skipped or failed, so Patrick can see the
            reason (xp-disabled-on-team, first-potm-source-disabled,
            worker-rejected) instead of the failure going to console. */}
        {badgeGrantNotice && badgeGrantNotice.length > 0 && (
          <div className="rounded-2xl bg-line-default/[0.04] ring-1 ring-line-default/15 mb-6 p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex items-center justify-center w-8 h-8 rounded-full bg-brand-primary/15 text-brand-primary ring-1 ring-brand-primary-soft/40 shrink-0">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v4M12 16h.01" />
                </svg>
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-widest text-ink-primary/55 mb-1">POTM badge stamp</div>
                <ul className="space-y-1 text-sm text-ink-primary/85">
                  {badgeGrantNotice.map((n, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className={
                        n.kind === 'granted' ? 'text-emerald-400 font-bold'
                        : n.kind === 'skipped' ? 'text-ink-primary/60'
                        : 'text-brand-primary font-bold'
                      }>
                        {n.kind === 'granted' ? 'Stamped' : n.kind === 'skipped' ? 'Skipped' : 'Failed'}
                      </span>
                      <span className="truncate">{n.playerName}</span>
                      {n.reason && (
                        <span className="text-xs text-ink-primary/50 truncate">
                          — {n.reason === 'xp-disabled-on-team'
                              ? 'XP is off for this team (Coach settings → XP)'
                              : n.reason === 'first-potm-source-disabled'
                              ? 'First POTM source is off (Coach settings → XP → sources)'
                              : n.reason === 'already-earned'
                              ? 'already has the badge'
                              : n.reason}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => setBadgeGrantNotice(null)}
                  className="mt-2 text-[11px] font-bold uppercase tracking-widest text-ink-primary/45 hover:text-ink-primary"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Current POTM banner — shows whoever has the gold ring right
            now, with a Clear button so a coach can retire the badge
            mid-season without finalizing a new vote. */}
        {players.some(p => (p as any).isCurrentPotm) && (
          <div className="rounded-2xl bg-gradient-to-br from-amber-500/15 to-amber-700/10 ring-1 ring-amber-400/30 mb-6">
            <div className="px-5 py-3 flex items-center gap-3">
              <span className="flex-shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full bg-amber-400 text-charcoal-950 ring-1 ring-amber-300/60">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z"/></svg>
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-widest text-amber-300">Current {potmTitle}</div>
                <div className="text-sm font-bold text-ink-primary truncate">
                  {players.filter(p => (p as any).isCurrentPotm).map(p => p.name).join(' · ')}
                </div>
              </div>
              <button
                type="button"
                onClick={async () => {
                  if (!window.confirm(`Clear the gold ring from this player? It stays cleared until the next ${potmTitle} is voted in.`)) return;
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
                className="flex-shrink-0 px-3 py-1.5 rounded-lg bg-line-default/5 hover:bg-line-default/10 ring-1 ring-line-default/10 text-ink-primary/80 text-[11px] font-bold tracking-widest uppercase"
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {/* Previous Votings */}
        <div className="card-modern">
          <div className="px-6 py-4 border-b border-line-default/10">
            <h2 className="text-lg font-semibold text-ink-primary">Previous Results</h2>
          </div>
          <div className="p-6">
            {votings.filter(v => !v.isActive).length === 0 ? (
              <div className="text-center py-8">
                <div className="text-ink-primary/40 mb-4">
                  <svg className="mx-auto h-16 w-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h3 className="text-lg font-medium text-ink-primary mb-2">No completed votings</h3>
                <p className="text-ink-primary/65">Previous {potmTitle} results will appear here</p>
              </div>
            ) : (
              <div className="space-y-6">
                {votings.filter(v => !v.isActive).map(voting => {
                  const results = getVoteResults(voting);
                  const linkedEvent = voting.calendarEventId 
                    ? calendarEvents.find(e => e.id === voting.calendarEventId)
                    : null;
                  
                  return (
                    <div key={voting.id} className="border border-line-default/10 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <h3 className="font-semibold text-ink-primary">{voting.gameTitle}</h3>
                          <div className="flex items-center space-x-4 text-sm text-ink-primary/65">
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
                              <span className="w-9 h-9 rounded-xl bg-brand-primary/20 text-brand-primary-soft flex items-center justify-center shrink-0">
                                <AppIcon name="trophy" className="w-5 h-5" />
                              </span>
                              <div>
                                {voting.winners && voting.winners.length > 1 ? (
                                  <>
                                    <p className="font-semibold text-brand-primary-soft text-sm">Co-Players of the Match ({voting.winners.length})</p>
                                    <p className="text-xs text-ink-primary/65">{voting.winners.map(w => w.playerName).join(', ')}</p>
                                    {/* Vote-count sub-headline is coach-only
                                        (Patrick 2026-07-17 privacy pass):
                                        parents see the crown, not the tally. */}
                                    {isUserCoach && (
                                      <p className="text-xs text-ink-primary/50 mt-0.5">{voting.winners[0].voteCount} votes each</p>
                                    )}
                                  </>
                                ) : (
                                  <>
                                    <p className="font-semibold text-brand-primary-soft">{(voting.winners?.[0] || voting.winner)!.playerName}</p>
                                    {isUserCoach && (
                                      <p className="text-sm text-ink-primary/65">{(voting.winners?.[0] || voting.winner)!.voteCount} votes</p>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>

                      {/* Per-player breakdown bars — COACH-ONLY on past
                          votings (Patrick 2026-07-17 parent-privacy
                          pass: "show WINNER only. Hide per-player vote
                          counts + percentages + bar chart from
                          parents."). Coaches still see the full
                          ranking so they can spot patterns; parents
                          only see the crowned winner up above. */}
                      {isUserCoach && results.length > 0 && (
                        <div className="space-y-2">
                          {results.map((result, index) => {
                            const pct = voting.votes.length > 0 ? Math.round((result.count / voting.votes.length) * 100) : 0;
                            const player = players.find(p => p.id === result.playerId);
                            return (
                              <div key={result.playerId}>
                                <div className="flex items-center gap-2 py-1.5">
                                  <PlaceBadge index={index} />
                                  <ResultAvatar player={player} name={result.name} />
                                  <span className="font-medium text-ink-primary w-28 sm:w-36 truncate">{result.name}</span>
                                  <div className="flex-1 bg-line-default/[0.08] rounded-full h-2">
                                    <div
                                      className="h-2 rounded-full bg-brand-primary/150"
                                      style={{ width: `${pct}%` }}
                                    />
                                  </div>
                                  <span className="text-sm text-ink-primary/50 w-16 text-right">{result.count} · {pct}%</span>
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
                            className="text-xs text-brand-primary hover:underline font-medium"
                          >
                            {expandedVoters.has(voting.id)
                              ? '▲ Hide voter details'
                              : `▼ Show all ${voting.votes.length} voter${voting.votes.length !== 1 ? 's' : ''}`}
                          </button>
                          {expandedVoters.has(voting.id) && (
                            <div className="mt-2 rounded-lg border border-line-default/10 overflow-hidden">
                              <table className="w-full text-sm">
                                <thead className="bg-line-default/[0.04] border-b border-line-default/10">
                                  <tr>
                                    <th className="text-left px-3 py-2 text-xs font-semibold text-ink-primary/50 uppercase tracking-wide">Voter</th>
                                    <th className="text-left px-3 py-2 text-xs font-semibold text-ink-primary/50 uppercase tracking-wide">Voted for</th>
                                    <th className="text-left px-3 py-2 text-xs font-semibold text-ink-primary/50 uppercase tracking-wide">Reason</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-line-default/5">
                                  {voting.votes.map((v, i) => (
                                    <tr key={i} className="hover:bg-line-default/[0.05]">
                                      <td className="px-3 py-2 font-medium text-ink-primary">
                                        <span className="inline-flex items-center gap-1.5 flex-wrap">
                                          <span>{v.voterName || '—'}</span>
                                          {v.isCoach && (
                                            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-brand-primary/15 text-brand-primary-soft border border-brand-primary-soft/30" title="Voted as coach">
                                              coach
                                            </span>
                                          )}
                                        </span>
                                      </td>
                                      <td className="px-3 py-2 text-ink-primary/85">{v.playerName}</td>
                                      <td className="px-3 py-2 text-ink-primary/50 italic">{v.reason || '—'}</td>
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
          <div className="bg-surface-elevated rounded-2xl shadow-xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-semibold text-ink-primary mb-2">{editingVotingId ? 'Edit Attendance' : 'Mark Attendance'}</h2>
            {pendingVotingData && (
            <p className="text-sm text-ink-primary/65 mb-1">
              <strong>{pendingVotingData.gameTitle}</strong> — {formatDate(pendingVotingData.gameDate)}
            </p>
            )}
            <p className="text-sm text-ink-primary/50 mb-4">
              Check the players who were <strong>present</strong> at this match. Only their parents will be able to vote.
            </p>

            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-ink-primary/85">
                {attendancePlayerIds.size}/{players.length} present
              </span>
              <div className="space-x-2">
                <button
                  onClick={() => setAttendancePlayerIds(new Set(players.map(p => p.id)))}
                  className="text-xs text-brand-primary hover:underline"
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
                    className="w-4 h-4 rounded border-line-default/15 text-emerald-600 focus:ring-green-500"
                  />
                  <span className="text-sm font-medium text-ink-primary">
                    {player.jerseyNumber ? `#${player.jerseyNumber} ` : ''}{player.name}
                  </span>
                  <span className="text-xs text-ink-primary/50">{player.position}</span>
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
                className="px-4 py-2 border border-line-default/15 rounded-lg text-ink-primary/85 hover:bg-line-default/[0.05]"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmAttendanceAndCreate}
                disabled={attendancePlayerIds.size === 0}
                className="px-4 py-2 bg-brand-primary text-white rounded-lg hover:bg-brand-primary disabled:opacity-50 font-medium"
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
            className="bg-surface-elevated w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[88vh] overflow-hidden animate-sheet-up sm:animate-pop-in"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 py-3 flex items-center justify-between flex-shrink-0">
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/40 hover:text-white"
              >
                Cancel
              </button>
              <div className="text-xs font-extrabold tracking-widest uppercase text-brand-primary-soft">New vote</div>
              <span className="w-12" aria-hidden />
            </div>

            <div className="flex-1 overflow-y-auto overflow-x-hidden p-5 space-y-5">
              {/* Option 1: Link to Calendar Game */}
              {availableGames.length > 0 && (
                <div>
                  <h3 className="text-[11px] font-extrabold uppercase tracking-widest text-ink-primary/50 mb-2">
                    Pick a scheduled game
                  </h3>
                  <div className="space-y-1.5">
                    {availableGames.map(game => (
                      <button
                        key={game.id}
                        onClick={() => handleCreateVotingFromCalendarEvent(game.id)}
                        className="w-full text-left p-3 rounded-xl bg-line-default/[0.04] ring-1 ring-line-default/10 hover:bg-brand-primary/15 hover:ring-brand-primary-soft transition"
                      >
                        <div className="flex items-center justify-between gap-2 min-w-0">
                          <div className="flex-1 min-w-0">
                            <div className="font-bold text-ink-primary text-sm truncate">{game.title}</div>
                            <div className="text-xs text-ink-primary/65 truncate">
                              {formatDate(game.date)}{game.location ? ` · ${game.location}` : ''}{game.opponent ? ` · vs ${game.opponent}` : ''}
                            </div>
                          </div>
                          <svg className="w-4 h-4 text-ink-primary/40 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/></svg>
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
                <div className="rounded-xl bg-brand-primary/10 ring-1 ring-brand-primary-soft/30 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-primary/90 not-italic">
                  <span className="font-semibold text-ink-primary">No games scheduled yet.</span>{' '}
                  <Link to="/calendar" onClick={() => setShowCreateModal(false)} className="text-brand-primary-soft font-bold hover:text-brand-primary-soft underline underline-offset-2 decoration-brand-primary-soft/60">
                    Add a game on the calendar
                  </Link>{' '}
                  to link voting to it, or fill out a custom vote below.
                </div>
              )}

              {/* Option 2: Custom Game */}
              <div>
                <h3 className="text-[11px] font-extrabold uppercase tracking-widest text-ink-primary/50 mb-2">
                  {availableGames.length > 0 ? 'Or create a custom vote' : 'Create a custom vote'}
                </h3>
                <CustomGameForm onSubmit={handleCreateCustomVoting} isAdultTeam={isAdultTeam} />
              </div>
            </div>

            <div className="flex-shrink-0 border-t border-line-default/5 bg-line-default/[0.04]/60 px-5 py-3 flex justify-end">
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-[12px] font-extrabold tracking-widest uppercase px-4 py-2 rounded-lg text-ink-primary/65 hover:bg-line-default/[0.08]"
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
  isAdultTeam?: boolean;
}

const CustomGameForm: React.FC<CustomGameFormProps> = ({ onSubmit, isAdultTeam }) => {
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
        <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">Match Title</label>
        <input
          type="text"
          value={gameTitle}
          onChange={(e) => setGameTitle(e.target.value)}
          className="w-full px-3 py-2 bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
          placeholder="e.g., vs Eagles, Championship Final"
          required
        />
      </div>

      {/* Date / time pair with a vertical divider so the eye can tell
          one field from the next (mirrors the EventForm pattern). */}
      <div>
        <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
          <div>
            <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">Match Date</label>
            <input
              type="date"
              value={gameDate}
              onChange={(e) => setGameDate(e.target.value)}
              className="w-full px-3 py-2 bg-surface-base text-ink-primary [color-scheme:dark] border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
              required
            />
          </div>
          <div className="w-px h-9 bg-line-default/15 self-center" aria-hidden />
          <div>
            <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">Match Time</label>
            <input
              type="time"
              value={gameTime}
              onChange={(e) => setGameTime(e.target.value)}
              className="w-full px-3 py-2 bg-surface-base text-ink-primary [color-scheme:dark] border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">Opponent <span className="text-ink-primary/40 font-normal normal-case tracking-normal">(optional)</span></label>
          <input
            type="text"
            value={opponent}
            onChange={(e) => setOpponent(e.target.value)}
            className="w-full px-3 py-2 bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
            placeholder="e.g. Eagles FC"
          />
        </div>
        <div>
          <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">Home or Away <span className="text-ink-primary/40 font-normal normal-case tracking-normal">(optional)</span></label>
          <select
            value={homeAway}
            onChange={(e) => setHomeAway(e.target.value as 'home' | 'away' | '')}
            className="w-full px-3 py-2 bg-surface-base text-ink-primary [color-scheme:dark] border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
          >
            <option value="">—</option>
            <option value="home">Home</option>
            <option value="away">Away</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">Venue <span className="text-ink-primary/40 font-normal normal-case tracking-normal">(optional)</span></label>
        <input
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          className="w-full px-3 py-2 bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
          placeholder="e.g. Town Park, Pitch 3"
        />
      </div>

      {!isAdultTeam && (
        <p className="text-[12px] text-ink-primary/50">
          <span className="font-bold text-ink-primary/85">Note:</span> Parents cannot vote for their own children to keep the vote clean.
        </p>
      )}

      <button
        type="submit"
        disabled={!gameTitle.trim() || !gameDate}
        className="w-full bg-brand-primary hover:bg-brand-primary/90 text-white text-xs font-extrabold tracking-widest uppercase py-3 px-4 rounded-xl transition duration-200 disabled:opacity-50"
      >
        Open Custom Vote
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
    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-brand-primary-soft to-brand-primary flex items-center justify-center text-white text-xs font-bold shrink-0">
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
      <span className="w-6 h-6 rounded-full bg-brand-primary text-white flex items-center justify-center flex-shrink-0" title="1st">
        <AppIcon name="trophy" className="w-3.5 h-3.5" strokeWidth={2.25} />
      </span>
    );
  }
  if (index === 1) {
    return (
      <span className="w-6 h-6 rounded-full bg-brand-primary/20 text-brand-primary-soft flex items-center justify-center text-[11px] font-bold flex-shrink-0" title="2nd">2</span>
    );
  }
  if (index === 2) {
    return (
      <span className="w-6 h-6 rounded-full bg-brand-primary/15 text-brand-primary-soft flex items-center justify-center text-[11px] font-bold flex-shrink-0" title="3rd">3</span>
    );
  }
  return (
    <span className="w-6 h-6 rounded-full bg-line-default/[0.08] text-ink-primary/65 flex items-center justify-center text-[11px] font-semibold flex-shrink-0">{index + 1}</span>
  );
};

export default PlayerOfMatch;