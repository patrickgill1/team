import React, { useState, useEffect } from 'react';
import { arrayUnion, doc, updateDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { User, Player } from '../types';
import { isCoach, isHeadCoach, isOwner } from '../utils/helpers';
import { enablePushForUser, getNotifPermission } from '../utils/push';

interface ParentDirectoryProps {}

interface DirectoryEntry {
  user: any;
  players: any[]; // Changed from Player[] to any[] to avoid type issues
  privacy: {
    showPhone: boolean;
    showEmail: boolean;
    showAddress: boolean;
  };
}

interface ProfileFormData {
  phoneNumber: string;
  address: string;
  emergencyContact: string;
  emergencyPhone: string;
  privacy: {
    showPhone: boolean;
    showEmail: boolean;
    showAddress: boolean;
  };
  emailPreferences: {
    devPlan: boolean;
    clip: boolean;
    potm: boolean;
    digest: boolean;
  };
}

const ParentDirectory: React.FC<ParentDirectoryProps> = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getDocuments, updateDocument, getDocument } = useFirestore();
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [pendingMembers, setPendingMembers] = useState<any[]>([]);
  const [allTeamPlayers, setAllTeamPlayers] = useState<any[]>([]);
  const [linkingUid, setLinkingUid] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showProfileEditor, setShowProfileEditor] = useState(false);
  const [profileForm, setProfileForm] = useState<ProfileFormData>({
    phoneNumber: '',
    address: '',
    emergencyContact: '',
    emergencyPhone: '',
    privacy: {
      showPhone: true,
      showEmail: true,
      showAddress: false
    },
    emailPreferences: {
      devPlan: true,
      clip: true,
      potm: true,
      digest: true
    }
  });
  const [isUpdating, setIsUpdating] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushPerm, setPushPerm] = useState<string>(typeof window !== 'undefined' ? getNotifPermission() : 'unsupported');
  const [pushMsg, setPushMsg] = useState<string>('');

  const isUserCoach = userData ? isCoach(userData.role) : false;
  const isUserHeadCoach = isHeadCoach(userData);
  const isUserOwner = isOwner(userData);

  useEffect(() => {
    loadDirectory();
    loadUserProfile();
  }, [selectedTeamId]);

  const loadUserProfile = async () => {
    if (userData) {
      try {
        const freshUserData = await getDocument('users', userData.uid) as any;
        if (freshUserData) {
          setProfileForm({
            phoneNumber: freshUserData.phoneNumber || '',
            address: freshUserData.address || '',
            emergencyContact: freshUserData.emergencyContact || '',
            emergencyPhone: freshUserData.emergencyPhone || '',
            privacy: freshUserData.privacy || {
              showPhone: true,
              showEmail: true,
              showAddress: false
            },
            emailPreferences: {
              devPlan: true, clip: true, potm: true, digest: true,
              ...(freshUserData.emailPreferences || {})
            }
          });
        }
      } catch (error) {
        console.error('Error loading user profile:', error);
        const userDataAny = userData as any;
        setProfileForm({
          phoneNumber: userDataAny.phoneNumber || '',
          address: userDataAny.address || '',
          emergencyContact: userDataAny.emergencyContact || '',
          emergencyPhone: userDataAny.emergencyPhone || '',
          privacy: userDataAny.privacy || {
            showPhone: true,
            showEmail: true,
            showAddress: false
          },
          emailPreferences: {
            devPlan: true, clip: true, potm: true, digest: true,
            ...(userDataAny.emailPreferences || {})
          }
        });
      }
    }
  };

  const loadDirectory = async () => {
    if (!selectedTeamId) { setLoading(false); return; }

    try {
      setLoading(true);
      
      // Get users and players in parallel
      const [users, players] = await Promise.all([
        getDocuments('users', []),
        getDocuments('players', [])
      ]);

      // Filter users properly - include both parents AND coaches, but filter by team
      const teamUsers = users.filter((user: any) => {
        const isTeamMember = user.teamId === selectedTeamId || (user.teamIds && user.teamIds.includes(selectedTeamId));
        const isActiveUser = user.isActive !== false;
        return isTeamMember && isActiveUser;
      });

      // Separate pending (unapproved parents) from approved members
      const pending = teamUsers.filter((u: any) => u.role === 'parent' && u.approved === false);
      const approvedUsers = teamUsers.filter((u: any) => u.role === 'coach' || u.approved !== false);
      setPendingMembers(pending);
      
      const teamPlayers = players.filter((player: any) => 
        (player.teamId === selectedTeamId || (player.teamIds && player.teamIds.includes(selectedTeamId))) && player.isActive !== false
      );
      setAllTeamPlayers(teamPlayers);

      // Create directory entries for approved team users only
      const directoryEntries: DirectoryEntry[] = approvedUsers.map((user: any) => {
        // Improved player matching logic
        const userPlayers = teamPlayers.filter((player: any) => {
          // Multiple ways to match players to parents
          const matchByParentIds = Array.isArray(player.parentIds) && player.parentIds.includes(user.uid);
          const matchByParentEmails = Array.isArray(player.parentEmails) && player.parentEmails.includes(user.email);
          const matchByParentId = player.parentId === user.uid;
          
          return matchByParentIds || matchByParentEmails || matchByParentId;
        });

        return {
          user: {
            ...user,
            createdAt: user.createdAt?.toDate ? user.createdAt.toDate() : new Date(user.createdAt)
          },
          players: userPlayers.map((player: any) => ({
            ...player,
            createdAt: player.createdAt?.toDate ? player.createdAt.toDate() : new Date(player.createdAt)
          })),
          privacy: user.privacy || {
            showPhone: true,
            showEmail: true,
            showAddress: false
          }
        };
      });
      
      // Sort entries: coaches first, then parents, then by name
      directoryEntries.sort((a, b) => {
        // Coaches first
        if (a.user.role === 'coach' && b.user.role !== 'coach') return -1;
        if (b.user.role === 'coach' && a.user.role !== 'coach') return 1;
        
        // Then sort by name
        return (a.user.name || '').localeCompare(b.user.name || '');
      });
      
      setDirectory(directoryEntries);
    } catch (error) {
      console.error('Error loading directory:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateProfile = async () => {
    if (!userData) return;

    setIsUpdating(true);
    try {
      const updateData = {
        phoneNumber: profileForm.phoneNumber.trim() || undefined,
        address: profileForm.address.trim() || undefined,
        emergencyContact: profileForm.emergencyContact.trim() || undefined,
        emergencyPhone: profileForm.emergencyPhone.trim() || undefined,
        privacy: profileForm.privacy,
        emailPreferences: profileForm.emailPreferences,
        updatedAt: new Date()
      };

      await updateDocument('users', userData.uid, updateData);
      
      setTimeout(async () => {
        await loadDirectory();
        await loadUserProfile();
        setShowProfileEditor(false);
        alert('Profile updated successfully!');
      }, 1000);
      
    } catch (error) {
      console.error('Error updating profile:', error);
      alert('Failed to update profile. Please try again.');
    } finally {
      setIsUpdating(false);
    }
  };

  const filteredDirectory = directory.filter(entry =>
    entry.user.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    entry.players.some(player => 
      player.name.toLowerCase().includes(searchTerm.toLowerCase())
    )
  );

  const formatPhone = (phone: string) => {
    if (!phone) return '';
    const cleaned = phone.replace(/\D/g, '');
    const match = cleaned.match(/^(\d{3})(\d{3})(\d{4})$/);
    if (match) {
      return `(${match[1]}) ${match[2]}-${match[3]}`;
    }
    return phone;
  };

  const handleRefreshDirectory = async () => {
    await loadDirectory();
    alert('Directory refreshed!');
  };

  const handleApproveMember = async (uid: string) => {
    try {
      await updateDocument('users', uid, { approved: true });
      setPendingMembers(prev => prev.filter(m => m.uid !== uid));
      await loadDirectory(); // refresh approved list
    } catch (error) {
      console.error('Error approving member:', error);
      alert('Failed to approve member.');
    }
  };

  const handleRejectMember = async (uid: string) => {
    if (!window.confirm('Reject this member? They will be removed from the team.')) return;
    try {
      await updateDocument('users', uid, { isActive: false, approved: false });
      setPendingMembers(prev => prev.filter(m => m.uid !== uid));
    } catch (error) {
      console.error('Error rejecting member:', error);
      alert('Failed to reject member.');
    }
  };

  const handleRemoveMember = async (uid: string, name: string) => {
    if (!window.confirm(`Remove ${name} from the team? They will no longer have access.`)) return;
    try {
      await updateDocument('users', uid, { isActive: false });
      setDirectory(prev => prev.filter(e => e.user.uid !== uid));
    } catch (error) {
      console.error('Error removing member:', error);
      alert('Failed to remove member.');
    }
  };

  const handleChangeRole = async (uid: string, name: string, currentRole: string) => {
    const promote = currentRole !== 'coach';
    const verb = promote ? 'promote' : 'demote';
    const target = promote ? 'a coach' : 'a parent';
    if (!window.confirm(
      promote
        ? `Promote ${name} to coach? They'll get full access to manage players, schedule, stats, and media.`
        : `Demote ${name} back to parent? They'll lose coach access.`
    )) return;
    try {
      const updates: any = {
        role: promote ? 'coach' : 'parent',
        approved: true,
      };
      if (promote) updates.coachLevel = 'assistant_coach';
      await updateDocument('users', uid, updates);
      setDirectory(prev => prev.map(e =>
        e.user.uid === uid
          ? { ...e, user: { ...e.user, role: updates.role, approved: true, coachLevel: updates.coachLevel ?? e.user.coachLevel } }
          : e
      ));
    } catch (error) {
      console.error(`Error trying to ${verb} member to ${target}:`, error);
      alert(`Failed to ${verb} ${name}.`);
    }
  };

  const handleLinkToPlayer = async (parentUid: string, parentEmail: string, playerId: string) => {
    try {
      await updateDoc(doc(db, 'players', playerId), {
        parentIds: arrayUnion(parentUid),
        parentEmails: arrayUnion(parentEmail.toLowerCase())
      });
      setLinkingUid(null);
      await loadDirectory();
    } catch (error) {
      console.error('Error linking parent to player:', error);
      alert('Failed to link parent to player.');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center space-y-3">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-cyan-200 border-t-cyan-500" />
          <span className="text-sm text-gray-400 font-medium">Loading directory...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-white">Team Directory</h1>
              <p className="text-gray-300 mt-1">Connect with team families and coaches</p>
            </div>
            <div className="flex space-x-3">
              <button
                onClick={handleRefreshDirectory}
                className="bg-gray-500 hover:bg-gray-600 text-white px-4 py-2 rounded-lg font-medium transition-colors duration-200 flex items-center space-x-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <span>Refresh</span>
              </button>
              <button
                onClick={() => setShowProfileEditor(true)}
                className="bg-cyan-600 hover:bg-cyan-700 text-white px-4 py-2 rounded-lg font-medium transition-colors duration-200 flex items-center space-x-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                <span>Edit My Profile</span>
              </button>
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="mb-6">
          <div className="relative">
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
              placeholder="Search by name or player name..."
            />
            <svg className="w-5 h-5 text-gray-400 absolute left-3 top-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>

        {/* Pending Members (coach only) */}
        {isUserCoach && pendingMembers.length > 0 && (
          <div className="mb-6 bg-amber-500/10 border border-amber-200 rounded-xl p-5">
            <div className="flex items-center mb-4">
              <svg className="w-5 h-5 text-amber-600 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 100 18 9 9 0 000-18z" />
              </svg>
              <h2 className="text-lg font-bold text-amber-200">
                Pending Approval ({pendingMembers.length})
              </h2>
            </div>
            <div className="space-y-3">
              {pendingMembers.map((member: any) => (
                <div key={member.uid} className="bg-gray-900/80 rounded-lg border border-amber-200 p-4 flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-white">{member.name || 'Unknown'}</p>
                    <p className="text-sm text-gray-400">{member.email}</p>
                    <p className="text-xs text-gray-400 mt-1">
                      Signed up {member.createdAt?.toDate ? member.createdAt.toDate().toLocaleDateString() : 'recently'}
                    </p>
                  </div>
                  <div className="flex space-x-2 ml-4 shrink-0">
                    <button
                      onClick={() => handleApproveMember(member.uid)}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleRejectMember(member.uid)}
                      className="bg-red-100 hover:bg-red-200 text-rose-300 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Directory Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredDirectory.map((entry) => (
            <div key={entry.user.uid} className="card-modern border border-white/10 overflow-hidden">
              {/* Header with User Info */}
              <div className={`px-4 py-3 text-white ${
                entry.user.role === 'coach' 
                  ? 'bg-gradient-to-r from-purple-500 to-purple-600' 
                  : 'bg-gradient-to-r from-cyan-500 to-sky-600'
              }`}>
                <div className="flex items-center space-x-3">
                  <div className="bg-white bg-opacity-20 rounded-full w-12 h-12 flex items-center justify-center shrink-0">
                    <span className="text-lg font-bold">
                      {entry.user.name?.split(' ').map((n: string) => n[0]).join('').toUpperCase() || '?'}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2">
                      <h3 className="text-lg font-semibold">{entry.user.name || 'Unknown'}</h3>
                      {entry.user.role === 'coach' && (
                        <span className="bg-white bg-opacity-20 text-xs px-2 py-1 rounded-full">
                          Coach
                        </span>
                      )}
                    </div>
                    <p className={`text-sm ${
                      entry.user.role === 'coach' ? 'text-purple-100' : 'text-cyan-100'
                    }`}>
                      {entry.user.role === 'coach' 
                        ? 'Team Coach'
                        : entry.players.length > 0 
                          ? `Parent of ${entry.players.map(p => p.name).join(', ')}`
                          : 'Team Member'
                      }
                    </p>
                    {entry.user.uid === userData?.uid && (
                      <p className="text-xs mt-1 opacity-75">★ This is you</p>
                    )}
                  </div>
                  {isUserHeadCoach && entry.user.uid !== userData?.uid && (isUserOwner || !isHeadCoach(entry.user)) && (
                    <div className="shrink-0 flex items-center gap-1.5">
                      <button
                        onClick={() => handleChangeRole(entry.user.uid, entry.user.name, entry.user.role)}
                        className="bg-white bg-opacity-20 hover:bg-opacity-40 rounded-full p-1.5 transition-colors"
                        title={entry.user.role === 'coach' ? 'Demote to parent' : 'Promote to coach'}
                      >
                        {entry.user.role === 'coach' ? (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
                          </svg>
                        )}
                      </button>
                      <button
                        onClick={() => handleRemoveMember(entry.user.uid, entry.user.name)}
                        className="bg-white bg-opacity-20 hover:bg-opacity-40 rounded-full p-1.5 transition-colors"
                        title="Remove member"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* PLAYERS SECTION - MOST PROMINENT - Show for both parents AND coaches */}
              {(entry.user.role === 'parent' || entry.user.role === 'coach') && entry.players.length > 0 && (
                <div className="p-4 bg-gradient-to-b from-cyan-50/40 to-white border-b-2 border-cyan-100">
                  <div className="flex items-center mb-3">
                    <svg className="w-5 h-5 mr-2 text-cyan-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 515.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 616 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                    </svg>
                    <h4 className="text-lg font-bold text-white">
                      {entry.user.role === 'coach' ? 'Their Players' : 'Their Players'}
                    </h4>
                  </div>
                  
                  <div className="space-y-3">
                    {entry.players.map((player: any) => (
                      <div key={player.id} className="bg-gray-900/80 rounded-xl p-4 border-2 border-cyan-100 shadow-sm hover:shadow-md transition-shadow duration-200">
                        <div className="flex items-center space-x-4">
                          {/* Jersey Number Circle */}
                          <div className="bg-gradient-to-br from-cyan-600 to-sky-700 text-white rounded-full w-14 h-14 flex items-center justify-center font-bold text-lg shadow-lg">
                            #{player.jerseyNumber || '?'}
                          </div>
                          
                          {/* Player Info */}
                          <div className="flex-1">
                            <h5 className="text-xl font-bold text-white mb-1">{player.name}</h5>
                            <div className="flex flex-wrap gap-2 text-sm text-gray-300">
                              {player.position && (
                                <span className="flex items-center space-x-1 bg-cyan-500/10 text-cyan-300 px-2 py-1 rounded-full">
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 7a2 2 0 012-2h10a2 2 0 012 2v2M7 7h10" />
                                  </svg>
                                  <span>{player.position}</span>
                                </span>
                              )}
                              {player.dateOfBirth && (
                                <span className="flex items-center space-x-1 bg-gray-100 text-gray-200 px-2 py-1 rounded-full">
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                  </svg>
                                  <span>Age {new Date().getFullYear() - new Date(player.dateOfBirth).getFullYear()}</span>
                                </span>
                              )}
                              {/* Show connection type for coaches */}
                              {entry.user.role === 'coach' && (
                                <span className="flex items-center space-x-1 bg-purple-100 text-purple-800 px-2 py-1 rounded-full">
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                  </svg>
                                  <span>Coached Player</span>
                                </span>
                              )}
                            </div>
                            
                            {/* Player Stats */}
                            {player.stats && (player.stats.goals > 0 || player.stats.assists > 0 || player.stats.saves > 0) && (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {player.stats.goals > 0 && (
                                  <span className="bg-green-100 text-green-800 text-xs px-2 py-1 rounded-full font-medium">
                                    ⚽ {player.stats.goals} goals
                                  </span>
                                )}
                                {player.stats.assists > 0 && (
                                  <span className="bg-cyan-500/10 text-cyan-300 text-xs px-2 py-1 rounded-full font-medium">
                                    🎯 {player.stats.assists} assists
                                  </span>
                                )}
                                {player.stats.saves > 0 && (
                                  <span className="bg-orange-100 text-orange-800 text-xs px-2 py-1 rounded-full font-medium">
                                    🥅 {player.stats.saves} saves
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Empty state for parents with no players */}
              {entry.user.role === 'parent' && entry.players.length === 0 && (
                <div className="p-4 bg-gradient-to-b from-cyan-50/40 to-white border-b-2 border-cyan-100">
                  <div className="flex items-center mb-3">
                    <svg className="w-5 h-5 mr-2 text-cyan-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 515.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 616 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                    </svg>
                    <h4 className="text-lg font-bold text-white">Their Players</h4>
                  </div>
                  
                  <div className="bg-gray-50 rounded-xl p-6 text-center border-2 border-dashed border-white/15">
                    <svg className="mx-auto h-12 w-12 text-gray-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 515.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 616 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                    </svg>
                    <p className="text-gray-300 font-medium mb-1">No players assigned</p>
                    <p className="text-sm text-gray-400 mb-3">This parent hasn't been linked to any players yet</p>
                    
                    {isUserCoach && (
                      <>
                        {linkingUid === entry.user.uid ? (
                          <div className="mt-2">
                            <select
                              className="w-full border border-white/15 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 mb-2"
                              defaultValue=""
                              onChange={(e) => {
                                if (e.target.value) {
                                  handleLinkToPlayer(entry.user.uid, entry.user.email, e.target.value);
                                }
                              }}
                            >
                              <option value="" disabled>Select a player...</option>
                              {allTeamPlayers.map((p: any) => (
                                <option key={p.id} value={p.id}>
                                  {p.name} {p.jerseyNumber ? `#${p.jerseyNumber}` : ''} {p.position ? `(${p.position})` : ''}
                                </option>
                              ))}
                            </select>
                            <button
                              onClick={() => setLinkingUid(null)}
                              className="text-xs text-gray-400 hover:text-gray-200"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setLinkingUid(entry.user.uid)}
                            className="bg-cyan-600 hover:bg-cyan-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                          >
                            Link to Player
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Contact Information Section */}
              <div className="p-4">
                <div className="flex items-center mb-3">
                  <svg className="w-4 h-4 mr-2 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 4.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  <h4 className="text-sm font-semibold text-white">Contact Information</h4>
                </div>

                <div className="space-y-3">
                  {/* Email */}
                  {entry.privacy.showEmail && entry.user.email && (
                    <div className="flex items-center space-x-3">
                      <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 4.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                      </svg>
                      <a 
                        href={`mailto:${entry.user.email}`}
                        className="text-cyan-600 hover:text-cyan-300 text-sm break-all"
                      >
                        {entry.user.email}
                      </a>
                    </div>
                  )}

                  {/* Phone */}
                  {entry.privacy.showPhone && entry.user.phoneNumber && (
                    <div className="flex items-center space-x-3">
                      <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                      </svg>
                      <a 
                        href={`tel:${entry.user.phoneNumber}`}
                        className="text-cyan-600 hover:text-cyan-300 text-sm"
                      >
                        {formatPhone(entry.user.phoneNumber)}
                      </a>
                    </div>
                  )}

                  {/* Address */}
                  {entry.privacy.showAddress && entry.user.address && (
                    <div className="flex items-center space-x-3">
                      <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      <span className="text-sm text-gray-300">{entry.user.address}</span>
                    </div>
                  )}

                  {/* Emergency Contact (visible to coaches only) */}
                  {isUserCoach && entry.user.emergencyContact && (
                    <div className="pt-3 mt-3 border-t border-white/10">
                      <div className="flex items-center space-x-3 mb-2">
                        <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                        </svg>
                        <span className="text-sm font-medium text-rose-300">Emergency Contact</span>
                      </div>
                      <div className="text-sm text-gray-300 ml-7">
                        <div className="font-medium">{entry.user.emergencyContact}</div>
                        {entry.user.emergencyPhone && (
                          <a 
                            href={`tel:${entry.user.emergencyPhone}`}
                            className="text-cyan-600 hover:text-cyan-300"
                          >
                            {formatPhone(entry.user.emergencyPhone)}
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Quick Actions */}
                <div className="pt-4 mt-4 border-t border-white/10">
                  <div className="flex space-x-2">
                    {entry.privacy.showEmail && entry.user.email && (
                      <button
                        onClick={() => window.open(`mailto:${entry.user.email}`)}
                        className="flex-1 bg-cyan-500/10 hover:bg-cyan-500/10 text-cyan-300 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-200 flex items-center justify-center space-x-1"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 4.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                        <span>Email</span>
                      </button>
                    )}
                    {entry.privacy.showPhone && entry.user.phoneNumber && (
                      <button
                        onClick={() => window.open(`tel:${entry.user.phoneNumber}`)}
                        className="flex-1 bg-green-50 hover:bg-green-100 text-emerald-300 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-200 flex items-center justify-center space-x-1"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                        </svg>
                        <span>Call</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Empty State */}
        {filteredDirectory.length === 0 && !loading && (
          <div className="text-center py-12">
            <div className="text-gray-400 mb-4">
              <svg className="mx-auto h-16 w-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 515.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 616 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-white mb-2">
              {searchTerm ? 'No matches found' : 'No team members found'}
            </h3>
            <p className="text-gray-300">
              {searchTerm 
                ? 'Try adjusting your search terms'
                : 'Team members will appear here once they join'}
            </p>
          </div>
        )}
      </div>

      {/* Profile Editor Modal */}
      {showProfileEditor && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900/80 rounded-lg max-w-md w-full max-h-screen overflow-y-auto">
            <div className="sticky top-0 bg-gray-900/95 backdrop-blur border-b border-white/10 px-6 py-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold text-white">Edit My Profile</h2>
                <button
                  onClick={() => setShowProfileEditor(false)}
                  className="text-gray-400 hover:text-gray-300"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="p-6 space-y-6">
              {/* Phone Number */}
              <div>
                <label className="block text-sm font-medium text-gray-200 mb-1">
                  Phone Number
                </label>
                <input
                  type="tel"
                  value={profileForm.phoneNumber}
                  onChange={(e) => setProfileForm({...profileForm, phoneNumber: e.target.value})}
                  className="w-full px-3 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="(555) 123-4567"
                />
              </div>

              {/* Address */}
              <div>
                <label className="block text-sm font-medium text-gray-200 mb-1">
                  Address
                </label>
                <textarea
                  value={profileForm.address}
                  onChange={(e) => setProfileForm({...profileForm, address: e.target.value})}
                  className="w-full px-3 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  rows={3}
                  placeholder="123 Main St, City, State 12345"
                />
              </div>

              {/* Emergency Contact */}
              <div>
                <label className="block text-sm font-medium text-gray-200 mb-1">
                  Emergency Contact Name
                </label>
                <input
                  type="text"
                  value={profileForm.emergencyContact}
                  onChange={(e) => setProfileForm({...profileForm, emergencyContact: e.target.value})}
                  className="w-full px-3 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="John Doe"
                />
              </div>

              {/* Emergency Phone */}
              <div>
                <label className="block text-sm font-medium text-gray-200 mb-1">
                  Emergency Contact Phone
                </label>
                <input
                  type="tel"
                  value={profileForm.emergencyPhone}
                  onChange={(e) => setProfileForm({...profileForm, emergencyPhone: e.target.value})}
                  className="w-full px-3 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="(555) 987-6543"
                />
              </div>

              {/* Privacy Settings */}
              <div className="border-t pt-4">
                <h3 className="text-sm font-medium text-gray-200 mb-3">Privacy Settings</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-200">Show Email Address</span>
                    <input
                      type="checkbox"
                      checked={profileForm.privacy.showEmail}
                      onChange={(e) => setProfileForm({
                        ...profileForm, 
                        privacy: {...profileForm.privacy, showEmail: e.target.checked}
                      })}
                      className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-white/15 rounded"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-200">Show Phone Number</span>
                    <input
                      type="checkbox"
                      checked={profileForm.privacy.showPhone}
                      onChange={(e) => setProfileForm({
                        ...profileForm, 
                        privacy: {...profileForm.privacy, showPhone: e.target.checked}
                      })}
                      className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-white/15 rounded"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-200">Show Address</span>
                    <input
                      type="checkbox"
                      checked={profileForm.privacy.showAddress}
                      onChange={(e) => setProfileForm({
                        ...profileForm, 
                        privacy: {...profileForm.privacy, showAddress: e.target.checked}
                      })}
                      className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-white/15 rounded"
                    />
                  </div>
                </div>
              </div>

              {/* Email Notifications */}
              <div className="border-t pt-4">
                <h3 className="text-sm font-medium text-gray-200 mb-1">Email Notifications</h3>
                <p className="text-xs text-gray-400 mb-3">Pick which Fire FC16 emails you want to receive at <b>{userData?.email}</b>.</p>
                <div className="space-y-3">
                  {([
                    { key: 'devPlan', label: 'New development plan for my player' },
                    { key: 'clip', label: 'New clip or photo of my player' },
                    { key: 'potm', label: 'My player wins Player of the Match' },
                    { key: 'digest', label: 'Weekly Sunday digest (upcoming + recap)' },
                  ] as const).map(({ key, label }) => (
                    <div key={key} className="flex items-center justify-between">
                      <span className="text-sm text-gray-200 pr-3">{label}</span>
                      <input
                        type="checkbox"
                        checked={profileForm.emailPreferences[key]}
                        onChange={(e) => setProfileForm({
                          ...profileForm,
                          emailPreferences: { ...profileForm.emailPreferences, [key]: e.target.checked }
                        })}
                        className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-white/15 rounded"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Push Notifications */}
              <div className="border-t pt-4">
                <h3 className="text-sm font-medium text-gray-200 mb-1">Push Notifications</h3>
                <p className="text-xs text-gray-400 mb-3">
                  Get instant notifications on this device when there's news, a new clip, or a chat mention.
                </p>
                {pushPerm === 'unsupported' ? (
                  <div className="text-xs text-gray-400">This browser doesn't support push notifications.</div>
                ) : pushPerm === 'granted' ? (
                  <div className="flex items-center gap-2 text-sm text-emerald-300">
                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                    Push notifications are enabled on this device.
                  </div>
                ) : pushPerm === 'denied' ? (
                  <div className="text-xs text-amber-300">
                    Notifications are blocked. Enable them in your browser site settings, then reload.
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={pushBusy || !userData?.uid}
                    onClick={async () => {
                      if (!userData?.uid) return;
                      setPushBusy(true);
                      setPushMsg('');
                      const r = await enablePushForUser(userData.uid);
                      setPushPerm(getNotifPermission());
                      setPushBusy(false);
                      if (!r.ok) setPushMsg(r.error === 'no-vapid-key'
                        ? 'Push not configured (missing VAPID key).'
                        : r.error === 'denied'
                          ? 'Permission denied.'
                          : `Could not enable push (${r.error}).`);
                    }}
                    className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
                  >
                    {pushBusy ? 'Enabling…' : 'Enable on this device'}
                  </button>
                )}
                {pushMsg && <div className="mt-2 text-xs text-rose-300">{pushMsg}</div>}
              </div>

              {/* Action Buttons */}
              <div className="flex space-x-3 pt-4">
                <button
                  onClick={() => setShowProfileEditor(false)}
                  disabled={isUpdating}
                  className="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUpdateProfile}
                  disabled={isUpdating}
                  className="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 flex items-center justify-center"
                >
                  {isUpdating ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  ) : (
                    'Save Changes'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ParentDirectory;