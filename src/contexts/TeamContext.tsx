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

      // Get all team IDs the user belongs to
      const userTeamIds = userData.teamIds?.length ? userData.teamIds : [userData.teamId];

      // Fetch each team document
      const teamDocs: Team[] = [];
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

      setTeams(teamDocs);

      // Auto-select first team if nothing selected or current selection invalid
      if (!selectedTeamId || !userTeamIds.includes(selectedTeamId)) {
        const stored = localStorage.getItem('selectedTeamId');
        if (stored && userTeamIds.includes(stored)) {
          setSelectedTeamIdState(stored);
        } else if (userTeamIds.length > 0) {
          setSelectedTeamIdState(userTeamIds[0]);
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
  }, [userData?.uid, userData?.teamId, userData?.teamIds?.length]);

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
