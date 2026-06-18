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
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-crimson-200 border-t-cyan-500" />
          <span className="text-sm text-gray-400 font-medium">Loading directory...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Team Directory</h1>
              <p className="text-gray-600 mt-1">Connect with team families and coaches</p>
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
                className="bg-crimson-600 hover:bg-crimson-700 text-white px-4 py-2 rounded-lg font-medium transition-colors duration-200 flex items-center space-x-2"
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
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crimson-500"
              placeholder="Search by name or player name..."
            />
            <svg className="w-5 h-5 text-gray-400 absolute left-3 top-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>

        {/* Pending Members (coach only) */}
        {isUserCoach && pendingMembers.length > 0 && (
          <div className="mb-6 bg-amber-50 border border-amber-200 rounded-xl p-5">
            <div className="flex items-center mb-4">
              <svg className="w-5 h-5 text-amber-600 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 100 18 9 9 0 000-18z" />
              </svg>
              <h2 className="text-lg font-bold text-amber-900">
                Pending Approval ({pendingMembers.length})
              </h2>
            </div>
            <div className="space-y-3">
              {pendingMembers.map((member: any) => (
                <div key={member.uid} className="bg-white rounded-lg border border-amber-200 p-4 flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-gray-900">{member.name || 'Unknown'}</p>
                    <p className="text-sm text-gray-500">{member.email}</p>
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
                      className="bg-red-100 hover:bg-red-200 text-red-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
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
          {filteredDirectory.map((entry) => {
            const isCoachRole = entry.user.role === 'coach';
            const dotColor = isCoachRole ? 'bg-violet-400' : 'bg-emerald-400';
            const roleLabel = isCoachRole ? 'Coach' : 'Parent';
            const initials = entry.user.name?.split(' ').map((n: string) => n[0]).join('').toUpperCase() || '?';
            return (
              <div
                key={entry.user.uid}
                className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-charcoal-700 via-charcoal-800 to-charcoal-900 p-5 sm:p-6 text-white shadow-2xl ring-1 ring-white/10"
              >
                {/* decorative blobs */}
                <div className={`absolute -top-16 -right-16 w-56 h-56 rounded-full blur-3xl pointer-events-none ${isCoachRole ? 'bg-violet-500/20' : 'bg-crimson-500/20'}`} />
                <div className="absolute -bottom-16 -left-10 w-56 h-56 bg-rose-500/20 rounded-full blur-3xl pointer-events-none" />

                {/* Head coach controls (top-right) */}
                {isUserHeadCoach && entry.user.uid !== userData?.uid && (isUserOwner || !isHeadCoach(entry.user)) && (
                  <div className="absolute top-3 right-3 z-10 flex space-x-1">
                    <button
                      onClick={() => handleChangeRole(entry.user.uid, entry.user.name, entry.user.role)}
                      className="p-2 bg-white/10 hover:bg-white/20 ring-1 ring-white/15 rounded-full text-white backdrop-blur transition-colors"
                      title={isCoachRole ? 'Demote to parent' : 'Promote to coach'}
                    >
                      {isCoachRole ? (
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                        </svg>
                      ) : (
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
                        </svg>
                      )}
                    </button>
                    <button
                      onClick={() => handleRemoveMember(entry.user.uid, entry.user.name)}
                      className="p-2 bg-white/10 hover:bg-rose-500/40 ring-1 ring-white/15 rounded-full text-white backdrop-blur transition-colors"
                      title="Remove member"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                )}

                <div className="relative">
                  {/* Role pill */}
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 ring-1 ring-white/20 text-[10px] font-bold uppercase tracking-wider mb-4 backdrop-blur">
                    <span className={`w-2 h-2 rounded-full ${dotColor} ${entry.user.uid === userData?.uid ? 'animate-pulse' : ''}`} />
                    {roleLabel}{entry.user.uid === userData?.uid ? ' · You' : ''}
                  </div>

                  {/* Avatar + name */}
                  <div className="flex items-center gap-4 mb-5">
                    {(entry.user as any).photoURL || (entry.user as any).profilePhotoUrl ? (
                      <img
                        src={(entry.user as any).photoURL || (entry.user as any).profilePhotoUrl}
                        alt={entry.user.name || ''}
                        className="w-14 h-14 sm:w-16 sm:h-16 rounded-full object-cover ring-2 ring-white/25 shadow-lg flex-shrink-0"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-white/10 ring-2 ring-white/25 shadow-lg flex items-center justify-center backdrop-blur flex-shrink-0">
                        <span className="text-lg sm:text-xl font-black text-white">{initials}</span>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <h3 className="text-xl sm:text-2xl font-black tracking-tight leading-tight truncate">{entry.user.name || 'Unknown'}</h3>
                      <p className="text-white/70 text-sm font-medium mt-0.5 truncate">
                        {isCoachRole
                          ? 'Team Coach'
                          : entry.players.length > 0
                            ? `Parent of ${entry.players.map(p => p.name.split(' ')[0]).join(', ')}`
                            : 'Team Member'}
                      </p>
                    </div>
                  </div>

                  {/* Players section */}
                  {entry.players.length > 0 && (
                    <div className="mb-4">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-white/60 mb-2">Their Players</p>
                      <div className="space-y-2">
                        {entry.players.map((player: any) => {
                          const playerAge = player.dateOfBirth ? new Date().getFullYear() - new Date(player.dateOfBirth).getFullYear() : null;
                          return (
                            <div key={player.id} className="rounded-2xl bg-white/10 ring-1 ring-white/15 backdrop-blur p-3 flex items-center gap-3">
                              {player.profilePhotoUrl ? (
                                <img
                                  src={player.profilePhotoUrl}
                                  alt={player.name}
                                  className="w-10 h-10 rounded-full object-cover ring-1 ring-white/30 flex-shrink-0"
                                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                                />
                              ) : (
                                <div className="w-10 h-10 rounded-full bg-white/15 ring-1 ring-white/20 flex items-center justify-center flex-shrink-0 font-black text-sm">
                                  {player.jerseyNumber ? `#${player.jerseyNumber}` : player.name.charAt(0).toUpperCase()}
                                </div>
                              )}
                              <div className="flex-1 min-w-0">
                                <p className="font-bold text-white text-sm truncate">{player.name}</p>
                                <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-white/70">
                                  {player.position && <span>{player.position}</span>}
                                  {playerAge && <span>· Age {playerAge}</span>}
                                  {player.stats?.goals > 0 && <span className="text-emerald-300">· {player.stats.goals}G</span>}
                                  {player.stats?.assists > 0 && <span className="text-crimson-300">· {player.stats.assists}A</span>}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Empty state for parents with no players */}
                  {entry.user.role === 'parent' && entry.players.length === 0 && (
                    <div className="mb-4 rounded-2xl bg-white/5 ring-1 ring-dashed ring-white/20 p-4 text-center backdrop-blur">
                      <p className="text-white/85 text-sm font-medium mb-1">No players linked yet</p>
                      <p className="text-white/55 text-xs mb-3">Coach can link this parent to a player</p>
                      {isUserCoach && (
                        linkingUid === entry.user.uid ? (
                          <div className="space-y-2">
                            <select
                              className="w-full bg-white/10 ring-1 ring-white/20 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-crimson-400 backdrop-blur"
                              defaultValue=""
                              onChange={(e) => {
                                if (e.target.value) {
                                  handleLinkToPlayer(entry.user.uid, entry.user.email, e.target.value);
                                }
                              }}
                            >
                              <option value="" disabled className="bg-charcoal-900">Select a player…</option>
                              {allTeamPlayers.map((p: any) => (
                                <option key={p.id} value={p.id} className="bg-charcoal-900">
                                  {p.name} {p.jerseyNumber ? `#${p.jerseyNumber}` : ''} {p.position ? `(${p.position})` : ''}
                                </option>
                              ))}
                            </select>
                            <button
                              onClick={() => setLinkingUid(null)}
                              className="text-xs text-white/60 hover:text-white"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setLinkingUid(entry.user.uid)}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white text-charcoal-800 font-bold text-sm shadow hover:scale-105 transition"
                          >
                            Link to Player
                          </button>
                        )
                      )}
                    </div>
                  )}

                  {/* Contact rows */}
                  {((entry.privacy.showEmail && entry.user.email) || (entry.privacy.showPhone && entry.user.phoneNumber) || (entry.privacy.showAddress && entry.user.address)) && (
                    <div className="space-y-1.5 mb-4">
                      {entry.privacy.showEmail && entry.user.email && (
                        <a
                          href={`mailto:${entry.user.email}`}
                          className="flex items-center gap-2 text-sm text-crimson-200 hover:text-crimson-100 break-all"
                        >
                          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 4.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                          </svg>
                          <span className="truncate">{entry.user.email}</span>
                        </a>
                      )}
                      {entry.privacy.showPhone && entry.user.phoneNumber && (
                        <a
                          href={`tel:${entry.user.phoneNumber}`}
                          className="flex items-center gap-2 text-sm text-crimson-200 hover:text-crimson-100"
                        >
                          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                          </svg>
                          <span>{formatPhone(entry.user.phoneNumber)}</span>
                        </a>
                      )}
                      {entry.privacy.showAddress && entry.user.address && (
                        <div className="flex items-center gap-2 text-sm text-white/75">
                          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                          <span className="truncate">{entry.user.address}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Emergency contact (coach only) */}
                  {isUserCoach && entry.user.emergencyContact && (
                    <div className="rounded-xl bg-rose-500/15 ring-1 ring-rose-300/30 p-3 backdrop-blur mb-4">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-rose-200 mb-1">Emergency Contact</p>
                      <p className="text-sm text-white font-semibold">{entry.user.emergencyContact}</p>
                      {entry.user.emergencyPhone && (
                        <a
                          href={`tel:${entry.user.emergencyPhone}`}
                          className="text-sm text-rose-200 hover:text-rose-100 underline-offset-2 hover:underline"
                        >
                          {formatPhone(entry.user.emergencyPhone)}
                        </a>
                      )}
                    </div>
                  )}

                  {/* Action pills */}
                  <div className="flex flex-wrap gap-2">
                    {entry.privacy.showEmail && entry.user.email && (
                      <button
                        onClick={() => window.open(`mailto:${entry.user.email}`)}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white text-charcoal-800 font-bold text-sm shadow hover:scale-105 transition"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 4.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                        Email
                      </button>
                    )}
                    {entry.privacy.showPhone && entry.user.phoneNumber && (
                      <button
                        onClick={() => window.open(`tel:${entry.user.phoneNumber}`)}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/15 ring-1 ring-white/20 text-white font-semibold text-sm hover:bg-white/25 transition backdrop-blur"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                        </svg>
                        Call
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Empty State */}
        {filteredDirectory.length === 0 && !loading && (
          <div className="text-center py-12">
            <div className="text-gray-400 mb-4">
              <svg className="mx-auto h-16 w-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 515.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 616 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              {searchTerm ? 'No matches found' : 'No team members found'}
            </h3>
            <p className="text-gray-600">
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
          <div className="bg-white rounded-lg max-w-md w-full max-h-screen overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold text-gray-900">Edit My Profile</h2>
                <button
                  onClick={() => setShowProfileEditor(false)}
                  className="text-gray-400 hover:text-gray-600"
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
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Phone Number
                </label>
                <input
                  type="tel"
                  value={profileForm.phoneNumber}
                  onChange={(e) => setProfileForm({...profileForm, phoneNumber: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crimson-500"
                  placeholder="(555) 123-4567"
                />
              </div>

              {/* Address */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Address
                </label>
                <textarea
                  value={profileForm.address}
                  onChange={(e) => setProfileForm({...profileForm, address: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crimson-500"
                  rows={3}
                  placeholder="123 Main St, City, State 12345"
                />
              </div>

              {/* Emergency Contact */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Emergency Contact Name
                </label>
                <input
                  type="text"
                  value={profileForm.emergencyContact}
                  onChange={(e) => setProfileForm({...profileForm, emergencyContact: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crimson-500"
                  placeholder="John Doe"
                />
              </div>

              {/* Emergency Phone */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Emergency Contact Phone
                </label>
                <input
                  type="tel"
                  value={profileForm.emergencyPhone}
                  onChange={(e) => setProfileForm({...profileForm, emergencyPhone: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crimson-500"
                  placeholder="(555) 987-6543"
                />
              </div>

              {/* Privacy Settings */}
              <div className="border-t pt-4">
                <h3 className="text-sm font-medium text-gray-700 mb-3">Privacy Settings</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-700">Show Email Address</span>
                    <input
                      type="checkbox"
                      checked={profileForm.privacy.showEmail}
                      onChange={(e) => setProfileForm({
                        ...profileForm, 
                        privacy: {...profileForm.privacy, showEmail: e.target.checked}
                      })}
                      className="h-4 w-4 text-crimson-600 focus:ring-crimson-500 border-gray-300 rounded"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-700">Show Phone Number</span>
                    <input
                      type="checkbox"
                      checked={profileForm.privacy.showPhone}
                      onChange={(e) => setProfileForm({
                        ...profileForm, 
                        privacy: {...profileForm.privacy, showPhone: e.target.checked}
                      })}
                      className="h-4 w-4 text-crimson-600 focus:ring-crimson-500 border-gray-300 rounded"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-700">Show Address</span>
                    <input
                      type="checkbox"
                      checked={profileForm.privacy.showAddress}
                      onChange={(e) => setProfileForm({
                        ...profileForm, 
                        privacy: {...profileForm.privacy, showAddress: e.target.checked}
                      })}
                      className="h-4 w-4 text-crimson-600 focus:ring-crimson-500 border-gray-300 rounded"
                    />
                  </div>
                </div>
              </div>

              {/* Email Notifications */}
              <div className="border-t pt-4">
                <h3 className="text-sm font-medium text-gray-700 mb-1">Email Notifications</h3>
                <p className="text-xs text-gray-500 mb-3">Pick which GoalKickr emails you want to receive at <b>{userData?.email}</b>.</p>
                <div className="space-y-3">
                  {([
                    { key: 'devPlan', label: 'New development plan for my player' },
                    { key: 'clip', label: 'New clip or photo of my player' },
                    { key: 'potm', label: 'My player wins Player of the Match' },
                    { key: 'digest', label: 'Weekly Sunday digest (upcoming + recap)' },
                  ] as const).map(({ key, label }) => (
                    <div key={key} className="flex items-center justify-between">
                      <span className="text-sm text-gray-700 pr-3">{label}</span>
                      <input
                        type="checkbox"
                        checked={profileForm.emailPreferences[key]}
                        onChange={(e) => setProfileForm({
                          ...profileForm,
                          emailPreferences: { ...profileForm.emailPreferences, [key]: e.target.checked }
                        })}
                        className="h-4 w-4 text-crimson-600 focus:ring-crimson-500 border-gray-300 rounded"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Push Notifications */}
              <div className="border-t pt-4">
                <h3 className="text-sm font-medium text-gray-700 mb-1">Push Notifications</h3>
                <p className="text-xs text-gray-500 mb-3">
                  Get instant notifications on this device when there's news, a new clip, or a chat mention.
                </p>
                {pushPerm === 'unsupported' ? (
                  <div className="text-xs text-gray-500">This browser doesn't support push notifications.</div>
                ) : pushPerm === 'granted' ? (
                  <div className="flex items-center gap-2 text-sm text-emerald-700">
                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                    Push notifications are enabled on this device.
                  </div>
                ) : pushPerm === 'denied' ? (
                  <div className="text-xs text-amber-700">
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
                    className="px-4 py-2 bg-crimson-600 hover:bg-crimson-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
                  >
                    {pushBusy ? 'Enabling…' : 'Enable on this device'}
                  </button>
                )}
                {pushMsg && <div className="mt-2 text-xs text-red-600">{pushMsg}</div>}
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
                  className="flex-1 bg-crimson-600 hover:bg-crimson-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 flex items-center justify-center"
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