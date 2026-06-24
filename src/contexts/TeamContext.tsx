import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { Team } from '../types';
import { useAuth } from '../hooks/useAuth';

interface TeamContextType {
  teams: Team[];
  selectedTeamId: string;
  selectedTeam: Team | null;
  setSelectedTeamId: (teamId: string) => void;
  refreshTeams: () => Promise<void>;
  loading: boolean;
}

const TeamContext = createContext<TeamContextType | undefined>(undefined);

export const useTeam = () => {
  const context = useContext(TeamContext);
  if (!context) {
    throw new Error('useTeam must be used within a TeamProvider');
  }
  return context;
};

export const TeamProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { userData } = useAuth();
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeamId, setSelectedTeamIdState] = useState<string>('');
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [loading, setLoading] = useState(true);

  const loadTeams = useCallback(async () => {
    if (!userData) {
      setTeams([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);

      const teamDocs: Team[] = [];
      const userTeamIds = userData.teamIds?.length ? userData.teamIds : [userData.teamId];

      // Multi-tenancy fix (2026-06-23): the previous isClubAdmin
      // branch fetched EVERY team doc in the database with no
      // clubId filter. Patrick: "I created a team under a different
      // email for testing... that team is now in my dropdown list."
      // For SaaS multi-tenant, a club admin should only see teams
      // in clubs they're an admin of — never cross-club.
      //
      // If the user's doc has a clubIds[] array, fan out one query
      // per club (where clubId == X) and union the results. With no
      // clubIds set on the user, fall back to the user's own
      // teamIds[] only (the non-admin path below).
      const userClubIds: string[] = Array.isArray((userData as any).clubIds)
        ? (userData as any).clubIds
        : (userData as any).clubId ? [(userData as any).clubId] : [];
      const isAdmin = !!(userData as any).isClubAdmin;

      if (isAdmin && userClubIds.length > 0) {
        try {
          // Firestore in-query supports up to 30 values, plenty for
          // any one user's club admin scope.
          const clubSnaps = await getDocs(query(
            collection(db, 'teams'),
            where('clubId', 'in', userClubIds.slice(0, 30)),
          ));
          clubSnaps.forEach((docSnap) => {
            const data = docSnap.data();
            teamDocs.push({
              id: docSnap.id,
              name: data.name || 'My Team',
              description: data.description || '',
              logoUrl: data.logoUrl,
              coachIds: data.coachIds || [],
              headCoachId: data.headCoachId,
              assistantCoachIds: data.assistantCoachIds || [],
              playerIds: data.playerIds || [],
              parentIds: data.parentIds || [],
              season: data.season || '',
              ageGroup: data.ageGroup || '',
              league: data.league,
              homeField: data.homeField,
              isActive: data.isActive !== false,
              archivedAt: data.archivedAt?.toDate?.() || undefined,
              createdAt: data.createdAt?.toDate?.() || new Date(),
              updatedAt: data.updatedAt?.toDate?.() || undefined,
            });
          });
        } catch (err) {
          console.error('Error loading club teams for admin:', err);
        }
        teamDocs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        const active = teamDocs.filter(t => t.isActive !== false);
        setTeams(active);
        const validIds = active.map((t) => t.id);
        if (!selectedTeamId || !validIds.includes(selectedTeamId)) {
          const stored = localStorage.getItem('selectedTeamId');
          if (stored && validIds.includes(stored)) {
            setSelectedTeamIdState(stored);
          } else {
            const own = userTeamIds.find((id) => validIds.includes(id));
            setSelectedTeamIdState(own || validIds[0] || '');
          }
        }
        return;
      }
      // If isClubAdmin but no clubIds on the user doc, fall through
      // to the personal teamIds path below. Better to show too few
      // teams than too many across clubs.

      // Non-admin: original behavior — fetch one team doc per teamId.
      for (const teamId of userTeamIds) {
        if (!teamId) continue;
        try {
          const teamDoc = await getDoc(doc(db, 'teams', teamId));
          if (teamDoc.exists()) {
            const data = teamDoc.data();
            teamDocs.push({
              id: teamDoc.id,
              name: data.name || 'My Team',
              description: data.description || '',
              logoUrl: data.logoUrl,
              coachIds: data.coachIds || [],
              headCoachId: data.headCoachId,
              assistantCoachIds: data.assistantCoachIds || [],
              playerIds: data.playerIds || [],
              parentIds: data.parentIds || [],
              season: data.season || '',
              ageGroup: data.ageGroup || '',
              league: data.league,
              homeField: data.homeField,
              isActive: data.isActive !== false,
              archivedAt: data.archivedAt?.toDate?.() || undefined,
              createdAt: data.createdAt?.toDate?.() || new Date(),
              updatedAt: data.updatedAt?.toDate?.() || undefined,
            });
          } else {
            // Team doc doesn't exist yet — create a placeholder entry
            teamDocs.push({
              id: teamId,
              name: 'My Team',
              description: '',
              coachIds: userData.role === 'coach' ? [userData.uid] : [],
              playerIds: [],
              parentIds: userData.role === 'parent' ? [userData.uid] : [],
              season: '',
              ageGroup: '',
              createdAt: new Date(),
            });
          }
        } catch (err) {
          console.error(`Error loading team ${teamId}:`, err);
        }
      }

      // Hide archived teams from the selector. They stay in Firestore
      // (and on the user's teamIds[]) for historical lookups but
      // shouldn't appear as a switchable active team.
      const active = teamDocs.filter(t => t.isActive !== false);
      setTeams(active);
      const activeIds = active.map(t => t.id);

      // Auto-select first ACTIVE team if nothing selected, or the
      // current selection is invalid / archived.
      if (!selectedTeamId || !activeIds.includes(selectedTeamId)) {
        const stored = localStorage.getItem('selectedTeamId');
        if (stored && activeIds.includes(stored)) {
          setSelectedTeamIdState(stored);
        } else if (activeIds.length > 0) {
          setSelectedTeamIdState(activeIds[0]);
        }
      }
    } catch (error) {
      console.error('Error loading teams:', error);
    } finally {
      setLoading(false);
    }
  }, [userData, selectedTeamId]);

  useEffect(() => {
    loadTeams();
    // Include isClubAdmin so the team list reloads (now all-teams or
    // just-my-teams) the moment the flag flips, not just on next sign-in.
  }, [userData?.uid, userData?.teamId, userData?.teamIds?.length, (userData as any)?.isClubAdmin]);

  // Update selected team when selectedTeamId changes
  useEffect(() => {
    if (selectedTeamId) {
      const team = teams.find(t => t.id === selectedTeamId) || null;
      setSelectedTeam(team);
    } else {
      setSelectedTeam(null);
    }
  }, [selectedTeamId, teams]);

  const setSelectedTeamId = (teamId: string) => {
    setSelectedTeamIdState(teamId);
    localStorage.setItem('selectedTeamId', teamId);
  };

  const value: TeamContextType = {
    teams,
    selectedTeamId,
    selectedTeam,
    setSelectedTeamId,
    refreshTeams: loadTeams,
    loading,
  };

  return (
    <TeamContext.Provider value={value}>
      {children}
    </TeamContext.Provider>
  );
};
