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
import { Player, GameStat, CalendarEvent, GalleryPhoto, User, ChatThread, ChatMessage, DevelopmentPlan, PlayerMedia, CoachInvite, Team } from '../types';
import { cleanFirestoreData } from '../utils/helpers';
import { debug, debugWarn } from '../utils/debug';

export const useFirestore = () => {
  const [error, setError] = useState<string | null>(null);

  const handleError = (err: any) => {
    // Silence expected permission-denied errors — those fire during
    // sign-out / auth-token rotation and are not user-actionable.
    const code = err?.code;
    if (code === 'permission-denied' || code === 'unauthenticated') {
      debugWarn('Firestore error (auth transition):', err);
    } else {
      console.error('Firestore error:', err);
    }
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
    
    debug('Attempting to fetch user data for UID:', uid);

    const userDoc = await getDoc(doc(db, 'users', uid));

    if (userDoc.exists()) {
      const data = userDoc.data();
      debug('Raw user data from Firestore:', data);
      
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
      
      
      debug('Successfully processed user data:', userData);
      return userData;
    } else {
      debug('User document does not exist for UID:', uid);
      return null;
    }
  } catch (err: any) {
    // permission-denied fires during expected auth transitions
    // (sign-out mid-flight, token rotation). Rethrow but don't scare
    // the prod console — the caller decides whether to sign out.
    const code = err?.code;
    if (code === 'permission-denied' || code === 'unauthenticated') {
      debugWarn('getUserData denied (auth transition):', err.message);
    } else {
      console.error('Error in getUserData:', err);
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

  // Scope users LIST to a single team, mirroring getPlayersByTeam.
  // The unfiltered `getDocuments('users', [])` pattern that used to
  // live in Directory / People / VolunteerScheduler / etc. 403's
  // now that the users LIST rule requires a statically-resolvable
  // where clause. Callers can safely swap `getDocuments('users', [])`
  // for `getUsersByTeam(teamId)` — the union of teamIds + legacy
  // teamId matches what the client-side filter used to compute.
  //
  // Deduplication is by uid (or fallback to doc id). Inactive users
  // are still returned because callers often want to distinguish
  // "pending" from "gone" — apply an `isActive !== false` filter at
  // the call site if you want to hide deactivated members.
  const getUsersByTeam = useCallback(async (teamId: string) => {
    if (!teamId) return [];
    const [byTeamIds, byLegacyTeamId] = await Promise.all([
      getDocuments('users', [where('teamIds', 'array-contains', teamId)]).catch(() => []),
      getDocuments('users', [where('teamId', '==', teamId)]).catch(() => []),
    ]);
    const seen = new Set<string>();
    const merged: any[] = [];
    for (const u of [...byTeamIds, ...byLegacyTeamId] as any[]) {
      const key = u.uid || u.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(u);
    }
    return merged;
  }, [getDocuments]);

  const getPlayersByTeam = useCallback(async (teamId: string) => {
    // Scope to the requested team AT THE QUERY LEVEL. The old
    // "fetch every active player, filter client-side" pattern worked
    // when player LIST was `if request.auth != null`, but the
    // 2026-07-08 hardening (callerCanReadPlayer) denies any LIST
    // query whose matched set includes a doc the caller can't read.
    // As multi-tenant data grew, every coach's roster silently came
    // back empty because SOMEONE ELSE's player was in the match set.
    // A coach re-adds the same player because their added kid "disappears".
    //
    // teamIds is the canonical multi-team field; teamId is the legacy
    // pre-2026 single-team fallback. Firestore doesn't support OR
    // across `array-contains` and `==` in one query, so we run both
    // and merge. Both queries include team scope, so the rule passes
    // for every matched doc.
    const [byTeamIds, byLegacyTeamId] = await Promise.all([
      getDocuments('players', [where('teamIds', 'array-contains', teamId)]).catch(() => []),
      getDocuments('players', [where('teamId', '==', teamId)]).catch(() => []),
    ]);
    const seen = new Set<string>();
    const merged: any[] = [];
    for (const p of [...byTeamIds, ...byLegacyTeamId] as any[]) {
      if (seen.has(p.id)) continue;
      if (p.isActive === false) continue;
      seen.add(p.id);
      merged.push(p);
    }
    return merged.sort((a, b) => (a.jerseyNumber || 999) - (b.jerseyNumber || 999));
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
  //
  // 2026-07-14: added optional seasonId — when provided, rows are filtered
  // client-side to that season (matches the pattern in
  // src/utils/teamRecords.ts filterStatsBySeason). Founder-reported bug:
  // Dashboard MyPlayerCard's "This Season" was showing last season's totals
  // because this map wasn't season-scoped. Client-side filter avoids
  // needing a new composite index and is safe because per-team stat volume
  // is small (hundreds of docs per team-season). Rows written before we
  // auto-stamped seasonId in addGameStat will lack the field and be
  // excluded from a season-scoped call — that's correct behavior: a
  // pre-history row belongs to no season.
  const getTeamPlayerStatsMap = useCallback(async (
    teamId: string,
    seasonId?: string | null,
    tripScope?: { tripId?: string | null; excludeTrips?: boolean } | null,
  ): Promise<Record<string, Player['stats']>> => {
    const records = await getDocuments('stats', [where('teamId', '==', teamId)]);
    // 2026-07-19 Trip primitive: layer a tripId filter on top of season.
    //   - tripScope.tripId set → include ONLY rows tagged with that trip
    //     (feeds Trip detail + Player Profile "Tournaments" section).
    //   - tripScope.excludeTrips === true (or undefined + no tripId) →
    //     regulation-only view: drop any row that carries a tripId.
    //   - null / omitted → back-compat: still drops tripId rows so
    //     existing "Season 2026" surfaces stay pure without a caller
    //     change.
    let filtered = seasonId
      ? (records as any[]).filter((r) => (r?.seasonId || null) === seasonId)
      : (records as any[]);
    if (tripScope?.tripId) {
      filtered = (filtered as any[]).filter((r) => r?.tripId === tripScope.tripId);
    } else {
      // Default: exclude any tripId-tagged rows from the season bucket.
      filtered = (filtered as any[]).filter((r) => !r?.tripId);
    }
    const map: Record<string, any> = {};
    for (const r of filtered as any[]) {
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
    // 2026-07-14: auto-stamp seasonId at the funnel so callers can't
    // forget. Before this fix, GameDay + AdjustStatsModal wrapped
    // payloads in withSeasonId, but StatsTracker.handleSubmit and
    // PlayerMediaPage clip-credit skipped it — the rows they wrote
    // never joined a season and were invisible to any season-scoped
    // read (Dashboard Season Card, TeamRecordsSection "This Season").
    // withSeasonId is idempotent: no-op when seasonId is already set,
    // resolves from the team's active season otherwise.
    const { withSeasonId } = await import('../utils/seasons');
    const stamped = await withSeasonId(statData as any);
    const statToAdd = {
      ...stamped,
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
    const docs = await getDocuments('gallery', [
      where('teamId', '==', teamId),
      orderBy('createdAt', 'desc')
    ]);
    return docs.filter((d: any) => d.isActive !== false);
  }, [getDocuments]);

  /** Gallery photos tagged to a specific player. Powers the Photo
   *  Tape ribbon on /player/:id — the profile also needs the player_
   *  media half (existing getPlayerMediaByPlayer + array-contains
   *  inline in PlayerProfile), so the caller merges both streams.
   *  array-contains on taggedPlayerIds uses the auto single-field
   *  index; no composite required. Sort client-side. */
  const getPhotosByPlayer = useCallback(async (playerId: string) => {
    const docs = await getDocuments('gallery', [
      where('taggedPlayerIds', 'array-contains', playerId),
    ]);
    return docs.filter((d: any) => d.isActive !== false);
  }, [getDocuments]);

  /** Subscribe (live) to all gallery photos tagged to a specific event,
   *  so the event card's photo strip updates as parents upload. */
  const subscribeToEventPhotos = useCallback((eventId: string, callback: (photos: any[]) => void) => {
    const q = query(
      collection(db, 'gallery'),
      where('eventId', '==', eventId),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q, (snap) => {
      const photos = snap.docs.map((d) => {
        const data = d.data();
        return {
          ...data,
          id: d.id,
          createdAt: data.createdAt?.toDate?.() || new Date(),
        };
      }).filter((p: any) => p.isActive !== false);
      callback(photos);
    }, (err) => {
      const code = (err as any)?.code;
      if (code === 'permission-denied' || code === 'unauthenticated') {
        debugWarn('Event photos subscription denied (auth transition):', err);
      } else {
        console.error('Event photos subscription failed:', err);
      }
    });
  }, []);

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

  /** Create a new group-chat thread at `chat_group_threads/{cuid}`.
   *  Client-generated cuid keeps deep links stable and lets the
   *  push-fanout audit doc key on the message id without collision.
   *  Caller supplies the participants list; rules require the caller
   *  be in it and be `createdBy`. */
  const addGroupThread = useCallback(async (threadData: Partial<ChatThread> & { createdBy: string; participants: string[] }) => {
    const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `gt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date();
    const payload: any = {
      id,
      title: threadData.title || 'Group chat',
      teamId: threadData.teamId || '',
      clubId: (threadData as any).clubId || null,
      createdBy: threadData.createdBy,
      createdByName: threadData.createdByName || '',
      participants: threadData.participants,
      createdAt: now,
      updatedAt: now,
      // lastActivity retained for a clean revert of the sidebar sort
      // (it mirrors updatedAt on every write below).
      lastActivity: now,
      isActive: true,
      isPinned: false,
      unreadCount: {},
      mutedByUids: [],
      pinnedMessageIds: [],
      tags: ['group'],
    };
    try {
      const { setDoc, doc: fsDoc } = await import('firebase/firestore');
      await setDoc(fsDoc(db, 'chat_group_threads', id), cleanFirestoreData(payload));
      return id;
    } catch (err) {
      const { logFirestoreError } = await import('../utils/firestoreLogger');
      logFirestoreError('write', `chat_group_threads/${id}`, err, { op: 'addGroupThread' });
      throw err;
    }
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
  //
  // Idempotent writes. The caller passes a client-generated id; we
  // setDoc at that exact path. If the network drops mid-send and we
  // retry with the same id, Firestore overwrites (same data → no-op
  // dupe). Without this the retry queue could plant the same message
  // twice on bad connections.
  const addChatMessage = useCallback(async (messageData: Omit<ChatMessage, 'createdAt' | 'updatedAt'> & { id?: string }) => {
    const id = messageData.id || (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `cm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
    const { id: _stripId, ...rest } = messageData as any;
    const messageToWrite = {
      ...rest,
      createdAt: new Date(),
      updatedAt: new Date(),
      timestamp: messageData.timestamp || new Date(),
    };
    try {
      const { setDoc, doc: fsDoc } = await import('firebase/firestore');
      await setDoc(fsDoc(db, 'chat_messages', id), messageToWrite);
      return id;
    } catch (err) {
      const { logFirestoreError } = await import('../utils/firestoreLogger');
      logFirestoreError('write', `chat_messages/${id}`, err, { op: 'addChatMessage' });
      throw err;
    }
  }, []);

  /** Fetch the next page of older messages above `beforeTimestamp`.
   *  Used by the chat view when the user scrolls near the top — we
   *  prepend the older batch to the existing list without resetting
   *  the live subscription on the tail. Returns ascending order so
   *  callers can splice into the front of their list directly. */
  const getOlderChatMessages = useCallback(async (threadId: string, beforeTimestamp: Date, pageSize: number = 50) => {
    try {
      const q = query(
        collection(db, 'chat_messages'),
        where('threadId', '==', threadId),
        where('timestamp', '<', beforeTimestamp),
        orderBy('timestamp', 'desc'),
        limit(pageSize),
      );
      const snap = await getDocs(q);
      const messages = snap.docs.slice().reverse().map(doc => {
        const data = doc.data() as any;
        return {
          ...data,
          id: doc.id,
          threadId: data.threadId || '',
          content: data.content || '',
          senderId: data.senderId || '',
          senderName: data.senderName || '',
          senderRole: data.senderRole || 'parent',
          timestamp: data.timestamp?.toDate?.() || (data.timestamp instanceof Date ? data.timestamp : new Date()),
          edited: data.edited || false,
          editedAt: data.editedAt?.toDate?.() || undefined,
          replyTo: data.replyTo || undefined,
          teamId: data.teamId || '',
        } as ChatMessage;
      });
      return messages;
    } catch (err) {
      const { logFirestoreError } = await import('../utils/firestoreLogger');
      logFirestoreError('read', `chat_messages?threadId=${threadId}&before=${beforeTimestamp.toISOString()}`, err, { op: 'getOlderChatMessages' });
      throw err;
    }
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

  // Real-time chat subscriptions. Accepts either a single teamId or
  // an array of teamIds — the user gets every team-chat from every
  // team they're on (and DMs created on any of those teams), so the
  // chat tab is no longer per-team-context.
  const subscribeToChatThreads = useCallback((teamIdOrIds: string | string[], callback: (threads: ChatThread[]) => void) => {
    const ids = Array.isArray(teamIdOrIds) ? teamIdOrIds : [teamIdOrIds];
    const cleanIds = ids.filter(Boolean).slice(0, 30); // Firestore in-query max
    if (cleanIds.length === 0) { callback([]); return () => {}; }
    const q = query(
      collection(db, 'chat_threads'),
      where('teamId', 'in', cleanIds),
      orderBy('isPinned', 'desc'),
      orderBy('lastActivity', 'desc')
    );

    return onSnapshot(q, (querySnapshot) => {
      const threads = querySnapshot.docs.map(doc => {
        const data = doc.data();
        // Same ordering as subscribeToChatMessages: spread raw `data`
        // FIRST so the explicit Firestore-Timestamp→Date conversions
        // win and the threads' dates aren't reverted to raw Timestamps.
        return {
          ...data,
          id: doc.id,
          title: data.title || '',
          description: data.description || '',
          teamId: data.teamId || '',
          createdBy: data.createdBy || '',
          createdByName: data.createdByName || '',
          createdAt: data.createdAt?.toDate?.() || new Date(),
          lastActivity: data.lastActivity?.toDate?.() || new Date(),
          isPinned: data.isPinned || false,
          isPrivate: data.isPrivate || false,
          messageCount: data.messageCount || 0,
          participants: data.participants || [],
          tags: data.tags || [],
        } as ChatThread;
      });
      callback(threads);
    }, (error) => {
      const code = (error as any)?.code;
      if (code === 'permission-denied' || code === 'unauthenticated') {
        debugWarn('Threads subscription denied (auth transition):', error);
      } else {
        console.error('Error in threads subscription:', error);
      }
    });
  }, []);

  /**
   * Subscribe to club-wide threads — anything whose scope is one of
   * 'club' / 'coaches' / 'admins'. These threads are NOT team-scoped
   * so they show up regardless of which team is currently selected.
   * Caller filters by role on the client side.
   *
   * clubId REQUIRED as of 3.9.154. Before this argument existed, the
   * query fetched EVERY club-scoped thread across every club in the
   * database — a legitimate cross-tenant leak. Any coach at Club A
   * received Club B's coach chat titles + participant lists in their
   * onSnapshot. Now we scope to the caller's own club and refuse to
   * fire when no clubId is resolvable (returning a no-op unsub so
   * the caller's cleanup still runs cleanly).
   */
  /**
   * Subscribe to the caller's ad-hoc group chats. Group threads live
   * in the dedicated `chat_group_threads` collection (moved out of
   * `chat_threads` in the 2026-07-21 subcollection migration). The
   * collection identity IS the discriminator: no stored `isGroup`
   * field needed. Rules on `chat_group_threads` gate read/list on
   * `participants array-contains uid`, so this query is safe by
   * construction against the list-fails-if-any-doc-denied semantic.
   *
   * Tags each returned thread with `isGroup: true` in memory so the
   * downstream section-bucketing (TeamChat.tsx) continues to work
   * without a broad rename.
   */
  const subscribeToChatGroups = useCallback((uid: string | null | undefined, callback: (threads: ChatThread[]) => void) => {
    if (!uid) {
      try { callback([]); } catch { /* ignore */ }
      return () => {};
    }
    const q = query(
      collection(db, 'chat_group_threads'),
      where('participants', 'array-contains', uid),
    );
    return onSnapshot(q, (querySnapshot) => {
      const threads = querySnapshot.docs
        .map(doc => {
          const data = doc.data();
          return {
            ...data,
            id: doc.id,
            title: data.title || '',
            description: data.description || '',
            teamId: data.teamId || '',
            createdBy: data.createdBy || '',
            createdByName: data.createdByName || '',
            createdAt: data.createdAt?.toDate?.() || new Date(),
            lastActivity: data.lastActivity?.toDate?.() || (data.updatedAt?.toDate?.() || new Date()),
            isPinned: data.isPinned || false,
            isPrivate: data.isPrivate || false,
            messageCount: data.messageCount || 0,
            participants: data.participants || [],
            tags: data.tags || ['group'],
            // Collection identity is the discriminator; tag in memory
            // so the UI's section-bucketing (dms / groups / teams)
            // keeps working without a broader rename.
            isGroup: true,
          } as ChatThread;
        })
        // Soft-deleted groups (isActive === false) are hidden from
        // every user surface per the soft-delete rule. Migration
        // script uses this to tombstone the legacy chat_threads
        // source; new client cascade-delete uses it here too.
        .filter(t => (t as any).isActive !== false);
      callback(threads);
    }, (error) => {
      const code = (error as any)?.code;
      if (code === 'permission-denied' || code === 'unauthenticated') {
        debugWarn('Group threads subscription denied (auth transition):', error);
      } else {
        console.error('Error in group threads subscription:', error);
      }
    });
  }, []);

  // ================================
  // GROUP CHAT SUBCOLLECTION WRAPPERS
  // ================================
  //
  // Groups moved from top-level chat_threads/chat_messages to a
  // dedicated collection with messages as a subcollection:
  //   chat_group_threads/{gid}
  //   chat_group_threads/{gid}/messages/{mid}
  //
  // The subcollection rule gates on
  //   get(chat_group_threads/{gid}).data.participants
  // so children inherit the parent's trust boundary without a
  // per-message participants denorm.

  /** Write a new message into a group thread's subcollection.
   *  Client-generated id keeps retries idempotent (same as
   *  addChatMessage). Strips path-authoritative fields the caller
   *  used to send with top-level chat_messages. */
  const addGroupMessage = useCallback(async (
    threadId: string,
    messageData: Omit<ChatMessage, 'createdAt' | 'updatedAt'> & { id?: string },
  ) => {
    const id = messageData.id || (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `cm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
    // Path is authoritative: threadId + teamId are inferred from the
    // parent doc, so we drop them from the message payload rather
    // than let them go stale.
    const { id: _stripId, threadId: _stripThread, teamId: _stripTeam, ...rest } = messageData as any;
    const messageToWrite = {
      ...rest,
      createdAt: new Date(),
      updatedAt: new Date(),
      timestamp: messageData.timestamp || new Date(),
    };
    try {
      const { setDoc, doc: fsDoc } = await import('firebase/firestore');
      await setDoc(
        fsDoc(db, 'chat_group_threads', threadId, 'messages', id),
        cleanFirestoreData(messageToWrite),
      );
      return id;
    } catch (err) {
      const { logFirestoreError } = await import('../utils/firestoreLogger');
      logFirestoreError('write', `chat_group_threads/${threadId}/messages/${id}`, err, { op: 'addGroupMessage' });
      throw err;
    }
  }, []);

  /** Update a message inside a group thread's subcollection.
   *  Rule-allowed fields for author: content/editedAt/mediaAttachments/isDeleted/poll.
   *  For other participants: reactions/readBy/acknowledgedBy only. */
  const updateGroupMessage = useCallback(async (
    threadId: string,
    messageId: string,
    data: any,
  ) => {
    try {
      const { updateDoc, doc: fsDoc } = await import('firebase/firestore');
      await updateDoc(
        fsDoc(db, 'chat_group_threads', threadId, 'messages', messageId),
        cleanFirestoreData(data),
      );
    } catch (err) {
      handleError(err);
      throw err;
    }
  }, []);

  /** Delete a message inside a group thread's subcollection. Author
   *  or platform admin per rule. */
  const deleteGroupMessage = useCallback(async (threadId: string, messageId: string) => {
    try {
      const { deleteDoc, doc: fsDoc } = await import('firebase/firestore');
      await deleteDoc(fsDoc(db, 'chat_group_threads', threadId, 'messages', messageId));
    } catch (err) {
      handleError(err);
      throw err;
    }
  }, []);

  /** Patch the group thread parent doc (lastActivity, lastMessage,
   *  participants union, typingBy, unreadCount, isPinned, mutedByUids,
   *  pinnedMessageIds, title, isActive). Callers should already be
   *  participants. */
  const updateGroupThread = useCallback(async (threadId: string, data: Partial<ChatThread> | any) => {
    try {
      const { updateDoc, doc: fsDoc } = await import('firebase/firestore');
      const payload = { ...data, updatedAt: new Date() };
      await updateDoc(
        fsDoc(db, 'chat_group_threads', threadId),
        cleanFirestoreData(payload),
      );
    } catch (err) {
      handleError(err);
      throw err;
    }
  }, []);

  /** Subscribe to the live tail of a group thread's messages. Same
   *  shape as subscribeToChatMessages so TeamChat can branch once at
   *  the subscribe call and reuse every downstream mapper. */
  const subscribeToGroupMessages = useCallback((
    threadId: string,
    callback: (messages: ChatMessage[]) => void,
    pageSize: number = 50,
  ) => {
    const q = query(
      collection(db, 'chat_group_threads', threadId, 'messages'),
      orderBy('timestamp', 'desc'),
      limit(pageSize),
    );
    return onSnapshot(q, (querySnapshot) => {
      const messages = querySnapshot.docs.slice().reverse().map(doc => {
        const data = doc.data() as any;
        return {
          ...data,
          id: doc.id,
          // Synthesized so downstream callers that still reference
          // `message.threadId` continue to work; path is authoritative.
          threadId,
          content: data.content || '',
          senderId: data.senderId || '',
          senderName: data.senderName || '',
          senderRole: data.senderRole || 'parent',
          timestamp: data.timestamp?.toDate?.() || (data.timestamp instanceof Date ? data.timestamp : new Date()),
          edited: data.edited || false,
          editedAt: data.editedAt?.toDate?.() || undefined,
          replyTo: data.replyTo || undefined,
          teamId: data.teamId || '',
        } as ChatMessage;
      });
      callback(messages);
    }, (error) => {
      void import('../utils/firestoreLogger').then(({ logFirestoreError }) =>
        logFirestoreError('subscribe', `chat_group_threads/${threadId}/messages`, error, { source: 'subscribeToGroupMessages' })
      );
    });
  }, []);

  /** Older-page fetch for group threads (scroll-up pagination). */
  const getOlderGroupMessages = useCallback(async (threadId: string, beforeTimestamp: Date, pageSize: number = 50) => {
    try {
      const q = query(
        collection(db, 'chat_group_threads', threadId, 'messages'),
        where('timestamp', '<', beforeTimestamp),
        orderBy('timestamp', 'desc'),
        limit(pageSize),
      );
      const snap = await getDocs(q);
      const messages = snap.docs.slice().reverse().map(doc => {
        const data = doc.data() as any;
        return {
          ...data,
          id: doc.id,
          threadId,
          content: data.content || '',
          senderId: data.senderId || '',
          senderName: data.senderName || '',
          senderRole: data.senderRole || 'parent',
          timestamp: data.timestamp?.toDate?.() || (data.timestamp instanceof Date ? data.timestamp : new Date()),
          edited: data.edited || false,
          editedAt: data.editedAt?.toDate?.() || undefined,
          replyTo: data.replyTo || undefined,
          teamId: data.teamId || '',
        } as ChatMessage;
      });
      return messages;
    } catch (err) {
      const { logFirestoreError } = await import('../utils/firestoreLogger');
      logFirestoreError('read', `chat_group_threads/${threadId}/messages?before=${beforeTimestamp.toISOString()}`, err, { op: 'getOlderGroupMessages' });
      throw err;
    }
  }, []);

  /** Enumerate every message id under a group thread — used only by
   *  the cascade-delete path (soft-delete the parent, hard-delete
   *  the children). */
  const getGroupMessageIds = useCallback(async (threadId: string): Promise<string[]> => {
    try {
      const snap = await getDocs(collection(db, 'chat_group_threads', threadId, 'messages'));
      return snap.docs.map(d => d.id);
    } catch (err) {
      handleError(err);
      throw err;
    }
  }, []);

  const subscribeToClubChatThreads = useCallback((clubId: string | null | undefined, callback: (threads: ChatThread[]) => void) => {
    if (!clubId) {
      // No club scope resolvable → immediately emit an empty list
      // and hand back a no-op unsub. Caller's Loading→empty state
      // still lands correctly.
      try { callback([]); } catch { /* ignore */ }
      return () => {};
    }
    const q = query(
      collection(db, 'chat_threads'),
      where('clubId', '==', clubId),
      where('scope', 'in', ['club', 'coaches', 'admins']),
      orderBy('isPinned', 'desc'),
      orderBy('lastActivity', 'desc')
    );
    return onSnapshot(q, (querySnapshot) => {
      const threads = querySnapshot.docs.map(doc => {
        const data = doc.data();
        return {
          ...data,
          id: doc.id,
          title: data.title || '',
          description: data.description || '',
          teamId: data.teamId || '',
          createdBy: data.createdBy || '',
          createdByName: data.createdByName || '',
          createdAt: data.createdAt?.toDate?.() || new Date(),
          lastActivity: data.lastActivity?.toDate?.() || new Date(),
          isPinned: data.isPinned || false,
          isPrivate: data.isPrivate || false,
          messageCount: data.messageCount || 0,
          participants: data.participants || [],
          tags: data.tags || [],
        } as ChatThread;
      });
      callback(threads);
    }, (error) => {
      const code = (error as any)?.code;
      if (code === 'permission-denied' || code === 'unauthenticated') {
        debugWarn('Club threads subscription denied (auth transition):', error);
      } else {
        console.error('Error in club threads subscription:', error);
      }
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

    // DMs are PEOPLE-to-PEOPLE, not team-scoped. Drop teamId from the
    // lookup so the same pair always lands on the same thread no
    // matter which team the user is currently viewing.
    //
    // CRITICAL: distinguish 'lookup succeeded, found nothing' from
    // 'lookup errored.' The previous version's try/catch fell through
    // to CREATE on any error (network blip, transient rules denial
    // during auth-token refresh, missing index). That produced
    // duplicate DM threads for the same participant pair — same two
    // people end up with one DM tagged with team A and another tagged
    // with team B, each holding only half the message history.
    // Patrick caught it 2026-06-21 ('on the android simulator, it
    // will show all the messages on one team, but if I go to that dm
    // from another team, there are no messages'). New behavior:
    // create ONLY when the lookup demonstrably returned no match;
    // throw on lookup error so the caller can retry the open instead
    // of silently spawning a duplicate.
    try {
      const q = query(
        collection(db, 'chat_threads'),
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
      // Lookup succeeded and found no match — safe to create below.
    } catch (e) {
      debugWarn('[chat] DM lookup failed; refusing to create duplicate. Retry after reload.', e);
      throw new Error('DM_LOOKUP_FAILED');
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

  const subscribeToChatMessages = useCallback((threadId: string, callback: (messages: ChatMessage[]) => void, pageSize: number = 50) => {
    // Pull the LATEST `pageSize` messages — descending order + reverse
    // client-side. Older messages load via getOlderChatMessages on
    // scroll-up. The subscription only tracks the live tail so new
    // sends always surface; pagination history is fetched out-of-band.
    const q = query(
      collection(db, 'chat_messages'),
      where('threadId', '==', threadId),
      orderBy('timestamp', 'desc'),
      limit(pageSize)
    );

    return onSnapshot(q, (querySnapshot) => {
      const messages = querySnapshot.docs.slice().reverse().map(doc => {
        const data = doc.data();
        // ORDER MATTERS: spread raw `data` FIRST, then layer the
        // doc id + Firestore-Timestamp → Date conversions on top so
        // they override the raw values. Previous order had `...data`
        // last, which clobbered the Date conversion and made every
        // message timestamp render as "Unknown".
        return {
          ...data,
          id: doc.id,
          threadId: data.threadId || '',
          content: data.content || '',
          senderId: data.senderId || '',
          senderName: data.senderName || '',
          senderRole: data.senderRole || 'parent',
          timestamp: data.timestamp?.toDate?.() || (data.timestamp instanceof Date ? data.timestamp : new Date()),
          edited: data.edited || false,
          editedAt: data.editedAt?.toDate?.() || undefined,
          replyTo: data.replyTo || undefined,
          teamId: data.teamId || '',
        } as ChatMessage;
      });
      callback(messages);
    }, (error) => {
      void import('../utils/firestoreLogger').then(({ logFirestoreError }) =>
        logFirestoreError('subscribe', `chat_messages/${threadId}`, error, { source: 'subscribeToChatMessages' })
      );
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
    const id = await addDocument('development_plans', planToAdd);
    // Coarse cache clear: any Dashboard mount for the affected
    // player would otherwise render a stale "no plan tonight" from
    // the previous session. Prefix-drop is cheap (in-memory Map) and
    // subsequent dashboards just refetch on the natural code path.
    try {
      const { invalidateCachePrefix } = await import('../utils/queryCache');
      invalidateCachePrefix('dashboard:tonightGoal:');
    } catch { /* non-fatal */ }
    return id;
  }, []);

  const updateDevelopmentPlan = useCallback(async (planId: string, planData: Partial<DevelopmentPlan>) => {
    const updateData = {
      ...planData,
      updatedAt: new Date()
    };
    const res = await updateDocument('development_plans', planId, updateData);
    // Same cache-invalidation reason as addDevelopmentPlan. Coach
    // marking a goal verified, archiving a plan, adding a video link,
    // etc. all flow through here; the Dashboard's tonight-goal query
    // would otherwise cache the pre-update shape.
    try {
      const { invalidateCachePrefix } = await import('../utils/queryCache');
      invalidateCachePrefix('dashboard:tonightGoal:');
    } catch { /* non-fatal */ }
    return res;
  }, []);

  // 2026-07-14: optional teamId scopes results to a single team.
  // Founder-reported bug: a shared/transferred player was seeing an
  // old team's dev plans on the new team's PlayerProfile view. Plan
  // docs already carry teamId at write time (PlayerDevelopment.tsx
  // stamps it via withSeasonId), but the LIST rule on
  // /development_plans is isAuthed(), so a playerId-only query
  // returns every team's plans. Callers that view a single-team
  // scope (Profile, /development, Dashboard tonight-goal, Kid
  // dashboard) MUST pass teamId now. Omitting teamId preserves the
  // legacy any-team behavior for the rare caller that genuinely
  // wants a career view (none today).
  const getDevelopmentPlansByPlayer = useCallback(async (playerId: string, teamId?: string) => {
    const clauses: any[] = [where('playerId', '==', playerId)];
    if (teamId) clauses.push(where('teamId', '==', teamId));
    const docs = await getDocuments('development_plans', clauses);
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
    return docs
      .filter((d: any) => d.isActive !== false)
      .sort((a: any, b: any) => {
        const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt || 0).getTime();
        const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt || 0).getTime();
        return bTime - aTime;
      });
  }, [getDocuments]);

  const getPlayerMediaByTeam = useCallback(async (teamId: string) => {
    const docs = await getDocuments('player_media', [
      where('teamId', '==', teamId),
    ]);
    return docs
      .filter((d: any) => d.isActive !== false)
      .sort((a: any, b: any) => {
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

  // Provisioning a new club from the onboarding wizard. Solo coaches
  // get a club auto-created behind the scenes (named after their
  // team), per the data-model intent in types/index.ts:125. The club
  // is the multi-team container even when there's only one team; this
  // way "becoming a club" later is a no-op.
  const createClub = useCallback(async (clubData: {
    name: string;
    ownerUid: string;
    logoUrl?: string;
    initialTeamId?: string;
  }) => {
    const clubToAdd: any = {
      name: clubData.name,
      ownerUid: clubData.ownerUid,
      adminUids: [clubData.ownerUid],
      teamIds: clubData.initialTeamId ? [clubData.initialTeamId] : [],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (clubData.logoUrl) clubToAdd.logoUrl = clubData.logoUrl;
    return addDocument('clubs', clubToAdd);
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
    // User functions
    getUsersByTeam,
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
    // Calendar functions
    addEvent,
    updateEvent,
    getEventsByTeam,
    // Gallery functions
    addPhoto,
    getPhotosByTeam,
    getPhotosByPlayer,
    subscribeToEventPhotos,
    // Chat functions
    addChatThread,
    updateChatThread,
    getChatThreadsByTeam,
    addChatMessage,
    getChatMessagesByThread,
    getOlderChatMessages,
    subscribeToChatThreads,
    subscribeToChatGroups,
    subscribeToClubChatThreads,
    subscribeToChatMessages,
    getOrCreateDMThread,
    // Group-chat subcollection wrappers
    addGroupThread,
    addGroupMessage,
    updateGroupMessage,
    deleteGroupMessage,
    updateGroupThread,
    subscribeToGroupMessages,
    getOlderGroupMessages,
    getGroupMessageIds,
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
    createClub,
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
        const code = (err as any)?.code;
        if (code === 'permission-denied' || code === 'unauthenticated') {
          debugWarn('Subscription denied (auth transition):', err);
        } else {
          console.error('Subscription error:', err);
        }
        setError(err.message);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [collectionName, constraints]);

  return { data, loading, error };
};