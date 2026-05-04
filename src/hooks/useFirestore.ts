import { useState, useEffect, useCallback } from 'react';
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  setDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  Timestamp,
  DocumentData,
  QueryConstraint,
  limit
} from 'firebase/firestore';
import { db } from '../utils/firebase';
import { Player, GameStat, News, CalendarEvent, GalleryPhoto, User, ChatThread, ChatMessage, DevelopmentPlan, PlayerMedia, CoachInvite, Team } from '../types';
import { cleanFirestoreData } from '../utils/helpers';

export const useFirestore = () => {
  const [error, setError] = useState<string | null>(null);

  const handleError = (err: any) => {
    console.error('Firestore error:', err);
    setError(err.message || 'An error occurred');
  };

  // Generic add document function
  const addDocument = async (collectionName: string, data: any) => {
    try {
      const cleanedData = cleanFirestoreData(data);
      const docRef = await addDoc(collection(db, collectionName), cleanedData);
      return docRef.id;
    } catch (error) {
      handleError(error);
      throw error;
    }
  };

  const updateDocument = async (collectionName: string, id: string, data: any) => {
    try {
      const cleanedData = cleanFirestoreData(data);
      await updateDoc(doc(db, collectionName, id), cleanedData);
    } catch (error) {
      handleError(error);
      throw error;
    }
  };

  // Generic delete document function
  const deleteDocument = useCallback(async (collectionName: string, docId: string) => {
    setError(null);
    try {
      await deleteDoc(doc(db, collectionName, docId));
    } catch (err) {
      handleError(err);
      throw err;
    }
  }, []);

  // Get single document
  const getDocument = useCallback(async (collectionName: string, docId: string) => {
    setError(null);
    try {
      const docSnap = await getDoc(doc(db, collectionName, docId));
      if (docSnap.exists()) {
        return { id: docSnap.id, ...docSnap.data() };
      }
      return null;
    } catch (err) {
      handleError(err);
      throw err;
    }
  }, []);

  // Get documents with query
  const getDocuments = useCallback(async (collectionName: string, constraints: QueryConstraint[] = []) => {
    setError(null);
    try {
      const q = query(collection(db, collectionName), ...constraints);
      const querySnapshot = await getDocs(q);
      const documents = querySnapshot.docs.map(doc => {
        const data = doc.data();
        // Convert Firestore Timestamps to Dates
        const convertedData = { ...data };
        if (data.createdAt && data.createdAt.toDate) {
          convertedData.createdAt = data.createdAt.toDate();
        }
        if (data.updatedAt && data.updatedAt.toDate) {
          convertedData.updatedAt = data.updatedAt.toDate();
        }
        if (data.date && data.date.toDate) {
          convertedData.date = data.date.toDate();
        }
        if (data.timestamp && data.timestamp.toDate) {
          convertedData.timestamp = data.timestamp.toDate();
        }
        if (data.lastActivity && data.lastActivity.toDate) {
          convertedData.lastActivity = data.lastActivity.toDate();
        }
        return {
          id: doc.id,
          ...convertedData
        };
      });
      return documents;
    } catch (err) {
      handleError(err);
      throw err;
    }
  }, []);

  // User-specific functions
const getUserData = useCallback(async (uid: string) => {
  try {
    setError(null);
    
    console.log('Attempting to fetch user data for UID:', uid);
    
    const userDoc = await getDoc(doc(db, 'users', uid));
    
    if (userDoc.exists()) {
      const data = userDoc.data();
      console.log('Raw user data from Firestore:', data);
      
      // Return the full document data with proper structure
      const userData = {
        id: userDoc.id,
        uid: data.uid || userDoc.id,
        email: data.email,
        name: data.name,
        role: data.role,
        teamId: data.teamId,
        isActive: data.isActive,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        // Include Google-specific properties
        profilePhotoUrl: data.profilePhotoUrl || null,
        authProvider: data.authProvider || 'email',
        // Include contact properties
        phoneNumber: data.phoneNumber,
        address: data.address,
        emergencyContact: data.emergencyContact,
        emergencyPhone: data.emergencyPhone,
        privacy: data.privacy || {
          showPhone: true,
          showEmail: true,
          showAddress: false
        },
        ...data // Spread any additional properties
      };
      
      // Convert Firestore Timestamps to Dates if they exist
      if (data.createdAt && typeof data.createdAt.toDate === 'function') {
        userData.createdAt = data.createdAt.toDate();
      }
      if (data.updatedAt && typeof data.updatedAt.toDate === 'function') {
        userData.updatedAt = data.updatedAt.toDate();
      }
      
      
      console.log('Successfully processed user data:', userData);
      return userData;
    } else {
      console.log('User document does not exist for UID:', uid);
      return null;
    }
  } catch (err: any) {
    console.error('Error in getUserData:', err);
    console.error('Error code:', err.code);
    console.error('Error message:', err.message);
    
    if (err.code === 'permission-denied') {
      console.log('Permission denied. Check your Firestore security rules.');
      console.log('Make sure authenticated users can read /users/{userId} where userId matches their UID');
    }
    
    setError(err.message || 'Failed to fetch user data');
    throw err;
  }
}, []);

  const createUser = useCallback(async (userData: any) => {
    try {
      setError(null);
      
      const userToAdd = {
        ...userData,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      
      const cleanedData = cleanFirestoreData(userToAdd);
      await setDoc(doc(db, 'users', userData.uid), cleanedData);
      
      return userData.uid;
    } catch (err: any) {
      handleError(err);
      throw err;
    }
  }, []);

  // Player-specific functions
  const addPlayer = useCallback(async (playerData: Omit<Player, 'id' | 'createdAt'>) => {
    const playerToAdd = {
      ...playerData,
      createdAt: new Date(),
      updatedAt: new Date(),
      isActive: true,
      stats: playerData.stats || {
        gamesPlayed: 0,
        goals: 0,
        assists: 0,
        yellowCards: 0,
        redCards: 0,
        minutesPlayed: 0,
        saves: 0,
        cleanSheets: 0
      }
    };
    return addDocument('players', playerToAdd);
  }, []);

  const updatePlayer = useCallback(async (playerId: string, playerData: Partial<Player>) => {
    const updateData = {
      ...playerData,
      updatedAt: new Date()
    };
    return updateDocument('players', playerId, updateData);
  }, []);

  const getPlayersByTeam = useCallback(async (teamId: string) => {
    // Load all active players and filter client-side to avoid composite index issues
    const allPlayers = await getDocuments('players', [
      where('isActive', '==', true)
    ]);
    return allPlayers.filter((p: any) => {
      if (p.teamIds && Array.isArray(p.teamIds) && p.teamIds.includes(teamId)) return true;
      if (p.teamId === teamId) return true;
      return false;
    }).sort((a: any, b: any) => (a.jerseyNumber || 999) - (b.jerseyNumber || 999));
  }, [getDocuments]);

  const updatePlayerStats = useCallback(async (playerId: string, newStats: Player['stats']) => {
    return updateDocument('players', playerId, { 
      stats: newStats,
      updatedAt: new Date()
    });
  }, []);

  // Aggregate per-team stats for every player on a team by reading the
  // `stats` collection (per-game records). Use this for displays that need
  // accurate stats for SHARED players (rostered on multiple teams) so we
  // don't combine stats across teams via the global player.stats aggregate.
  const getTeamPlayerStatsMap = useCallback(async (teamId: string): Promise<Record<string, Player['stats']>> => {
    const records = await getDocuments('stats', [where('teamId', '==', teamId)]);
    const map: Record<string, any> = {};
    for (const r of records as any[]) {
      const pid = r.playerId;
      if (!pid) continue;
      const cur = map[pid] || { gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0, saves: 0, cleanSheets: 0 };
      const gid: string = typeof r.gameId === 'string' ? r.gameId : '';
      // Synthetic clip-credit records (gameId starts with 'clip_') only carry
      // goal/assist deltas — don't count them toward gamesPlayed.
      const isClipRecord = gid.startsWith('clip_');
      // Manual correction records (gameId starts with 'adjust_') store the
      // signed delta to apply. We use the record's gamesPlayed value as a
      // delta instead of always adding +1.
      const isAdjustRecord = gid.startsWith('adjust_');
      if (isAdjustRecord) {
        cur.gamesPlayed += r.gamesPlayed || 0;
      } else if (!isClipRecord) {
        cur.gamesPlayed += 1;
      }
      cur.goals += r.goals || 0;
      cur.assists += r.assists || 0;
      cur.saves += r.saves || 0;
      cur.yellowCards += r.yellowCards || 0;
      cur.redCards += r.redCards || 0;
      cur.minutesPlayed += r.minutesPlayed || 0;
      // Clamp to zero so a too-large negative correction never produces
      // negative totals on the UI.
      cur.gamesPlayed = Math.max(0, cur.gamesPlayed);
      cur.goals = Math.max(0, cur.goals);
      cur.assists = Math.max(0, cur.assists);
      cur.saves = Math.max(0, cur.saves);
      cur.yellowCards = Math.max(0, cur.yellowCards);
      cur.redCards = Math.max(0, cur.redCards);
      map[pid] = cur;
    }
    return map;
  }, [getDocuments]);

  // Stats-specific functions
  const addGameStat = useCallback(async (statData: Omit<GameStat, 'id' | 'createdAt'>) => {
    const statToAdd = {
      ...statData,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    return addDocument('stats', statToAdd);
  }, []);

  const getStatsByPlayer = useCallback(async (playerId: string) => {
    return getDocuments('stats', [
      where('playerId', '==', playerId),
      orderBy('createdAt', 'desc')
    ]);
  }, [getDocuments]);

  const getStatsByGame = useCallback(async (gameId: string) => {
    return getDocuments('stats', [
      where('gameId', '==', gameId),
      orderBy('createdAt', 'desc')
    ]);
  }, [getDocuments]);

  // News-specific functions
  const addNews = useCallback(async (newsData: Omit<News, 'id' | 'createdAt' | 'updatedAt'>) => {
    const newsToAdd = {
      ...newsData,
      createdAt: new Date(),
      updatedAt: new Date(),
      isPinned: newsData.isPinned || false,
      isPublished: newsData.isPublished || true,
      publishedAt: new Date()
    };
    return addDocument('news', newsToAdd);
  }, []);

  const updateNews = useCallback(async (newsId: string, newsData: Partial<News>) => {
    const updateData = {
      ...newsData,
      updatedAt: new Date()
    };
    return updateDocument('news', newsId, updateData);
  }, []);

  const getNewsByTeam = useCallback(async (teamId: string) => {
    return getDocuments('news', [
      where('teamId', '==', teamId),
      where('isPublished', '==', true),
      orderBy('createdAt', 'desc')
    ]);
  }, [getDocuments]);

  // Calendar event functions with proper date conversion  
  const addEvent = useCallback(async (eventData: Omit<CalendarEvent, 'id' | 'createdAt'>) => {
    const eventToAdd = {
      ...eventData,
      createdAt: new Date(),
      updatedAt: new Date(),
      date: eventData.date instanceof Date ? eventData.date : new Date(eventData.date)
    };
    return addDocument('events', eventToAdd);
  }, []);

  const updateEvent = useCallback(async (eventId: string, eventData: Partial<CalendarEvent>) => {
    const updateData = {
      ...eventData,
      updatedAt: new Date()
    };
    if (eventData.date) {
      updateData.date = eventData.date instanceof Date ? eventData.date : new Date(eventData.date);
    }
    return updateDocument('events', eventId, updateData);
  }, []);

  const getEventsByTeam = useCallback(async (teamId: string) => {
    return getDocuments('events', [
      where('teamId', '==', teamId),
      orderBy('date', 'asc')
    ]);
  }, [getDocuments]);

  // Gallery-specific functions
  const addPhoto = useCallback(async (photoData: Omit<GalleryPhoto, 'id' | 'createdAt'>) => {
    const photoToAdd = {
      ...photoData,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    return addDocument('gallery', photoToAdd);
  }, []);

  const getPhotosByTeam = useCallback(async (teamId: string) => {
    return getDocuments('gallery', [
      where('teamId', '==', teamId),
      orderBy('createdAt', 'desc')
    ]);
  }, [getDocuments]);

  // ================================
  // NEW CHAT FUNCTIONS ADDED BELOW
  // ================================

  // Chat Thread Functions
  const addChatThread = useCallback(async (threadData: Omit<ChatThread, 'id' | 'createdAt' | 'updatedAt'>) => {
    const threadToAdd = {
      ...threadData,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActivity: new Date(),
      messageCount: 0,
      participants: threadData.participants || [threadData.createdBy]
    };
    return addDocument('chat_threads', threadToAdd);
  }, []);

  const updateChatThread = useCallback(async (threadId: string, threadData: Partial<ChatThread>) => {
    const updateData = {
      ...threadData,
      updatedAt: new Date()
    };
    return updateDocument('chat_threads', threadId, updateData);
  }, []);

  const getChatThreadsByTeam = useCallback(async (teamId: string) => {
    try {
      const q = query(
        collection(db, 'chat_threads'),
        where('teamId', '==', teamId),
        orderBy('isPinned', 'desc'),
        orderBy('lastActivity', 'desc')
      );
      const querySnapshot = await getDocs(q);
      
      const threads = querySnapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          title: data.title || '',
          description: data.description || '',
          teamId: data.teamId || '',
          createdBy: data.createdBy || '',
          createdByName: data.createdByName || '',
          createdAt: data.createdAt?.toDate() || new Date(),
          lastActivity: data.lastActivity?.toDate() || new Date(),
          isPinned: data.isPinned || false,
          isPrivate: data.isPrivate || false,
          messageCount: data.messageCount || 0,
          participants: data.participants || [],
          tags: data.tags || [],
          ...data
        } as ChatThread;
      });
      
      return threads;
    } catch (err) {
      handleError(err);
      throw err;
    }
  }, []);

  // Chat Message Functions
  const addChatMessage = useCallback(async (messageData: Omit<ChatMessage, 'id' | 'createdAt' | 'updatedAt'>) => {
    const messageToAdd = {
      ...messageData,
      createdAt: new Date(),
      updatedAt: new Date(),
      timestamp: messageData.timestamp || new Date()
    };
    return addDocument('chat_messages', messageToAdd);
  }, []);

  const getChatMessagesByThread = useCallback(async (threadId: string, limitCount: number = 50) => {
    try {
      const q = query(
        collection(db, 'chat_messages'),
        where('threadId', '==', threadId),
        orderBy('timestamp', 'asc'),
        limit(limitCount)
      );
      const querySnapshot = await getDocs(q);
      
      const messages = querySnapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          threadId: data.threadId || '',
          content: data.content || '',
          senderId: data.senderId || '',
          senderName: data.senderName || '',
          senderRole: data.senderRole || 'parent',
          timestamp: data.timestamp?.toDate() || new Date(),
          edited: data.edited || false,
          editedAt: data.editedAt?.toDate() || undefined,
          replyTo: data.replyTo || undefined,
          teamId: data.teamId || '',
          ...data
        } as ChatMessage;
      });
      
      return messages;
    } catch (err) {
      handleError(err);
      throw err;
    }
  }, []);

  // Real-time chat subscriptions
  const subscribeToChatThreads = useCallback((teamId: string, callback: (threads: ChatThread[]) => void) => {
    const q = query(
      collection(db, 'chat_threads'),
      where('teamId', '==', teamId),
      orderBy('isPinned', 'desc'),
      orderBy('lastActivity', 'desc')
    );

    return onSnapshot(q, (querySnapshot) => {
      const threads = querySnapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          title: data.title || '',
          description: data.description || '',
          teamId: data.teamId || '',
          createdBy: data.createdBy || '',
          createdByName: data.createdByName || '',
          createdAt: data.createdAt?.toDate() || new Date(),
          lastActivity: data.lastActivity?.toDate() || new Date(),
          isPinned: data.isPinned || false,
          isPrivate: data.isPrivate || false,
          messageCount: data.messageCount || 0,
          participants: data.participants || [],
          tags: data.tags || [],
          ...data
        } as ChatThread;
      });
      callback(threads);
    }, (error) => {
      console.error('Error in threads subscription:', error);
    });
  }, []);

  // Find or create a 1:1 direct-message thread between two users on a team.
  const getOrCreateDMThread = useCallback(async (params: {
    teamId: string;
    me: { uid: string; name: string };
    other: { uid: string; name: string };
  }) => {
    const { teamId, me, other } = params;
    if (!teamId || !me?.uid || !other?.uid || me.uid === other.uid) {
      throw new Error('Invalid DM participants');
    }

    // Look for an existing DM thread between exactly these two users on this team.
    try {
      const q = query(
        collection(db, 'chat_threads'),
        where('teamId', '==', teamId),
        where('isDM', '==', true),
        where('participants', 'array-contains', me.uid)
      );
      const snap = await getDocs(q);
      const existing = snap.docs
        .map(d => ({ id: d.id, ...(d.data() as any) }))
        .find(t => Array.isArray(t.participants)
          && t.participants.length === 2
          && t.participants.includes(other.uid));
      if (existing) return existing.id as string;
    } catch (e) {
      // Index may be missing or rules blocked the lookup; fall through to create.
      console.warn('[chat] DM lookup failed, will create new thread', e);
    }

    const threadToAdd: any = {
      title: `DM: ${me.name} & ${other.name}`,
      description: '',
      teamId,
      createdBy: me.uid,
      createdByName: me.name,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActivity: new Date(),
      isPinned: false,
      isPrivate: false,
      isDM: true,
      messageCount: 0,
      participants: [me.uid, other.uid],
      dmParticipantNames: { [me.uid]: me.name, [other.uid]: other.name },
      tags: ['direct'],
    };
    return addDocument('chat_threads', threadToAdd);
  }, [addDocument]);

  const subscribeToChatMessages = useCallback((threadId: string, callback: (messages: ChatMessage[]) => void) => {
    const q = query(
      collection(db, 'chat_messages'),
      where('threadId', '==', threadId),
      orderBy('timestamp', 'asc'),
      limit(100)
    );

    return onSnapshot(q, (querySnapshot) => {
      const messages = querySnapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          threadId: data.threadId || '',
          content: data.content || '',
          senderId: data.senderId || '',
          senderName: data.senderName || '',
          senderRole: data.senderRole || 'parent',
          timestamp: data.timestamp?.toDate() || new Date(),
          edited: data.edited || false,
          editedAt: data.editedAt?.toDate() || undefined,
          replyTo: data.replyTo || undefined,
          teamId: data.teamId || '',
          ...data
        } as ChatMessage;
      });
      callback(messages);
    }, (error) => {
      console.error('Error in messages subscription:', error);
    });
  }, []);

  // ================================
  // DEVELOPMENT PLAN FUNCTIONS
  // ================================

  const addDevelopmentPlan = useCallback(async (planData: Omit<DevelopmentPlan, 'id' | 'createdAt'>) => {
    const planToAdd = {
      ...planData,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: planData.status || 'active'
    };
    return addDocument('development_plans', planToAdd);
  }, []);

  const updateDevelopmentPlan = useCallback(async (planId: string, planData: Partial<DevelopmentPlan>) => {
    const updateData = {
      ...planData,
      updatedAt: new Date()
    };
    return updateDocument('development_plans', planId, updateData);
  }, []);

  const getDevelopmentPlansByPlayer = useCallback(async (playerId: string) => {
    const docs = await getDocuments('development_plans', [
      where('playerId', '==', playerId),
    ]);
    return docs.sort((a: any, b: any) => {
      const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt || 0).getTime();
      const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });
  }, [getDocuments]);

  const getDevelopmentPlansByTeam = useCallback(async (teamId: string) => {
    const docs = await getDocuments('development_plans', [
      where('teamId', '==', teamId),
    ]);
    return docs.sort((a: any, b: any) => {
      const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt || 0).getTime();
      const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });
  }, [getDocuments]);

  // ================================
  // PLAYER MEDIA FUNCTIONS
  // ================================

  const addPlayerMedia = useCallback(async (mediaData: Omit<PlayerMedia, 'id' | 'createdAt'>) => {
    const mediaToAdd = {
      ...mediaData,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    return addDocument('player_media', mediaToAdd);
  }, []);

  const getPlayerMediaByPlayer = useCallback(async (playerId: string) => {
    const docs = await getDocuments('player_media', [
      where('playerId', '==', playerId),
    ]);
    return docs.sort((a: any, b: any) => {
      const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt || 0).getTime();
      const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });
  }, [getDocuments]);

  const getPlayerMediaByTeam = useCallback(async (teamId: string) => {
    const docs = await getDocuments('player_media', [
      where('teamId', '==', teamId),
    ]);
    return docs.sort((a: any, b: any) => {
      const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt || 0).getTime();
      const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });
  }, [getDocuments]);

  // ================================
  // TEAM MANAGEMENT FUNCTIONS
  // ================================

  const createTeam = useCallback(async (teamData: Omit<Team, 'id' | 'createdAt'>) => {
    const teamToAdd = {
      ...teamData,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    return addDocument('teams', teamToAdd);
  }, []);

  const updateTeam = useCallback(async (teamId: string, teamData: Partial<Team>) => {
    const updateData = {
      ...teamData,
      updatedAt: new Date()
    };
    // Check if team doc exists; if not, create it with setDoc
    const teamRef = doc(db, 'teams', teamId);
    const teamSnap = await getDoc(teamRef);
    if (teamSnap.exists()) {
      return updateDocument('teams', teamId, updateData);
    } else {
      const cleanedData = cleanFirestoreData({
        ...updateData,
        createdAt: new Date(),
      });
      await setDoc(teamRef, cleanedData);
    }
  }, []);

  // ================================
  // COACH INVITE FUNCTIONS
  // ================================

  const addCoachInvite = useCallback(async (inviteData: Omit<CoachInvite, 'id' | 'createdAt'>) => {
    const inviteToAdd = {
      ...inviteData,
      createdAt: new Date(),
      status: 'pending' as const
    };
    return addDocument('coach_invites', inviteToAdd);
  }, []);

  const getCoachInvitesByTeam = useCallback(async (teamId: string) => {
    const docs = await getDocuments('coach_invites', [
      where('teamId', '==', teamId),
    ]);
    return docs.sort((a: any, b: any) => {
      const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt || 0).getTime();
      const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });
  }, [getDocuments]);

  const getCoachInvitesByEmail = useCallback(async (email: string) => {
    return getDocuments('coach_invites', [
      where('email', '==', email),
      where('status', '==', 'pending')
    ]);
  }, [getDocuments]);

  return {
    error,
    // Generic functions
    addDocument,
    updateDocument,
    deleteDocument,
    getDocument,
    getDocuments,
    // User functions
    getUserData,
    createUser,
    // Player functions
    addPlayer,
    updatePlayer,
    getPlayersByTeam,
    updatePlayerStats,
    getTeamPlayerStatsMap,
    // Stats functions
    addGameStat,
    getStatsByPlayer,
    getStatsByGame,
    // News functions
    addNews,
    updateNews,
    getNewsByTeam,
    // Calendar functions
    addEvent,
    updateEvent,
    getEventsByTeam,
    // Gallery functions
    addPhoto,
    getPhotosByTeam,
    // Chat functions
    addChatThread,
    updateChatThread,
    getChatThreadsByTeam,
    addChatMessage,
    getChatMessagesByThread,
    subscribeToChatThreads,
    subscribeToChatMessages,
    getOrCreateDMThread,
    // Development plan functions
    addDevelopmentPlan,
    updateDevelopmentPlan,
    getDevelopmentPlansByPlayer,
    getDevelopmentPlansByTeam,
    // Player media functions
    addPlayerMedia,
    getPlayerMediaByPlayer,
    getPlayerMediaByTeam,
    // Team management functions
    createTeam,
    updateTeam,
    // Coach invite functions
    addCoachInvite,
    getCoachInvitesByTeam,
    getCoachInvitesByEmail
  };
};

// Hook for real-time subscriptions
export const useFirestoreSubscription = (collectionName: string, constraints: QueryConstraint[] = []) => {
  const [data, setData] = useState<DocumentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query(collection(db, collectionName), ...constraints);
    
    const unsubscribe = onSnapshot(
      q,
      (querySnapshot) => {
        const documents = querySnapshot.docs.map(doc => {
          const data = doc.data();
          // Convert Firestore Timestamps to Dates
          const convertedData = { ...data };
          if (data.createdAt && data.createdAt.toDate) {
            convertedData.createdAt = data.createdAt.toDate();
          }
          if (data.updatedAt && data.updatedAt.toDate) {
            convertedData.updatedAt = data.updatedAt.toDate();
          }
          if (data.date && data.date.toDate) {
            convertedData.date = data.date.toDate();
          }
          if (data.timestamp && data.timestamp.toDate) {
            convertedData.timestamp = data.timestamp.toDate();
          }
          if (data.lastActivity && data.lastActivity.toDate) {
            convertedData.lastActivity = data.lastActivity.toDate();
          }
          return {
            id: doc.id,
            ...convertedData
          };
        });
        setData(documents);
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.error('Subscription error:', err);
        setError(err.message);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [collectionName, constraints]);

  return { data, loading, error };
};