import React, { createContext, useContext, useEffect, useState } from 'react';
import { 
  User,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  GoogleAuthProvider,
  signInWithPopup
} from 'firebase/auth';
import { auth, db } from '../utils/firebase';
import { collection, query, where, getDocs, doc, updateDoc, arrayUnion } from 'firebase/firestore';
import { useFirestore } from '../hooks/useFirestore';

// FIXED TEAM ID - existing team; new users get assigned here by default
const DEFAULT_TEAM_ID = "team_1752188125868";

interface UserData {
  uid: string;
  id?: string;
  email: string;
  name: string;
  role: 'coach' | 'parent';
  teamId: string;
  teamIds?: string[];
  coachLevel?: 'head_coach' | 'assistant_coach';
  approved?: boolean;
  createdAt: Date;
  // Contact properties:
  phoneNumber?: string;
  address?: string;
  emergencyContact?: string;
  emergencyPhone?: string;
  privacy?: {
    showPhone: boolean;
    showEmail: boolean;
    showAddress: boolean;
  };
  // Google-specific properties:
  profilePhotoUrl?: string | null;
  authProvider?: 'email' | 'google';
}

interface AuthContextType {
  currentUser: User | null;
  userData: UserData | null;
  loading: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, userData: Omit<UserData, 'uid'>) => Promise<void>;
  signInWithGoogle: (inviteTeamId?: string) => Promise<void>;
  signInWithApple: (inviteTeamId?: string) => Promise<void>;
  logout: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [userData, setUserData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { getUserData, createUser, updateDocument } = useFirestore();

  const signIn = async (email: string, password: string) => {
    try {
      setError(null);
      const result = await signInWithEmailAndPassword(auth, email, password);
      // User data will be fetched in the auth state change listener
      return;
    } catch (error) {
      console.error('Sign in error:', error);
      throw error;
    }
  };

  const signUp = async (email: string, password: string, newUserData: Omit<UserData, 'uid'>) => {
    try {
      setError(null);
      console.log('Creating Firebase Auth user...');
      const result = await createUserWithEmailAndPassword(auth, email, password);
      
      console.log('Auth user created, now creating Firestore document...');
      
      // Use the team ID from the invite code if provided, otherwise default
      const effectiveTeamId = (newUserData.teamId && !newUserData.teamId.startsWith('team_temp'))
        ? newUserData.teamId
        : DEFAULT_TEAM_ID;

      const userDataWithId: any = {
        ...newUserData,
        uid: result.user.uid,
        teamId: effectiveTeamId,
        teamIds: [effectiveTeamId],
        isActive: true,
        approved: newUserData.role === 'coach' ? true : false,
        authProvider: 'email'
      };
      
      await createUser(userDataWithId);
      console.log('Firestore user document created successfully with team ID:', effectiveTeamId);
      
      // Auto-link and auto-approve if email already on a player
      if (userDataWithId.role !== 'coach' && userDataWithId.email) {
        try {
          const playersRef = collection(db, 'players');
          const q = query(playersRef, where('parentEmails', 'array-contains', userDataWithId.email.toLowerCase()));
          const snapshot = await getDocs(q);
          let linked = false;
          for (const playerDoc of snapshot.docs) {
            const playerData = playerDoc.data();
            if (!playerData.parentIds?.includes(result.user.uid)) {
              await updateDoc(doc(db, 'players', playerDoc.id), {
                parentIds: arrayUnion(result.user.uid)
              });
              console.log('Auto-linked new email parent to player:', playerDoc.id);
            }
            linked = true;
          }
          if (linked) {
            await updateDoc(doc(db, 'users', result.user.uid), { approved: true });
            console.log('Auto-approved new email parent via email match');
          }
        } catch (linkError) {
          console.error('Error auto-linking new email parent:', linkError);
        }
      }
      
      return;
    } catch (error: any) {
      console.error('Sign up error:', error);
      
      // If auth user was created but Firestore failed, clean up
      if (error.code === 'permission-denied' && auth.currentUser) {
        console.log('Firestore creation failed, cleaning up auth user...');
        try {
          await auth.currentUser.delete();
        } catch (deleteError) {
          console.error('Failed to clean up auth user:', deleteError);
        }
      }
      
      throw error;
    }
  };

  const signInWithGoogle = async (inviteTeamId?: string): Promise<void> => {
    try {
      console.log('Starting Google sign-in...', inviteTeamId ? `with invite team: ${inviteTeamId}` : '');
      setLoading(true);
      setError(null);

      // Native iOS path: use the Capacitor Firebase Authentication plugin
      // which calls Google's native iOS Sign-In SDK (avoids the broken web
      // popup flow under capacitor:// origin). Falls through to the web
      // popup path on browsers.
      const { Capacitor } = await import('@capacitor/core');
      let user;
      if (Capacitor.isNativePlatform()) {
        const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
        await FirebaseAuthentication.signInWithGoogle();
        // The plugin signs in to the Firebase Auth instance automatically;
        // pull the current user from our existing auth instance.
        user = auth.currentUser;
        if (!user) throw new Error('native Google sign-in did not return a user');
      } else {
        const provider = new GoogleAuthProvider();
        provider.addScope('email');
        provider.addScope('profile');
        const result = await signInWithPopup(auth, provider);
        user = result.user;
      }
      
      console.log('Google sign-in successful:', user.uid, user.email);
      
      // Check if user document exists in Firestore
      let userData = await getUserData(user.uid);
      
      if (!userData) {
        // Use invite team ID if provided, otherwise default
        const effectiveTeamId = inviteTeamId || DEFAULT_TEAM_ID;
        console.log('New Google user, creating user document with team ID:', effectiveTeamId);
        
        // Extract name from Google profile
        const displayName = user.displayName || '';
        const nameParts = displayName.split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';
        const fullName = displayName || `${firstName} ${lastName}`.trim() || 'Google User';
        
        const newUserData: any = {
          uid: user.uid,
          email: user.email || '',
          name: fullName,
          role: 'parent', // Default to parent
          teamId: effectiveTeamId,
          teamIds: [effectiveTeamId],
          isActive: true,
          approved: false,
          profilePhotoUrl: user.photoURL || null,
          authProvider: 'google',
          privacy: {
            showPhone: true,
            showEmail: true,
            showAddress: false
          }
        };
        
        await createUser(newUserData);
        userData = newUserData;
        
        // Auto-link and auto-approve if email already on a player
        if (user.email) {
          try {
            const playersRef = collection(db, 'players');
            const q = query(playersRef, where('parentEmails', 'array-contains', user.email.toLowerCase()));
            const snapshot = await getDocs(q);
            let linked = false;
            for (const playerDoc of snapshot.docs) {
              const playerData = playerDoc.data();
              if (!playerData.parentIds?.includes(user.uid)) {
                await updateDoc(doc(db, 'players', playerDoc.id), {
                  parentIds: arrayUnion(user.uid)
                });
                console.log('Auto-linked new Google parent to player:', playerDoc.id);
              }
              linked = true;
            }
            if (linked) {
              await updateDoc(doc(db, 'users', user.uid), { approved: true });
              (userData as any).approved = true;
              console.log('Auto-approved new Google parent via email match');
            }
          } catch (linkError) {
            console.error('Error auto-linking new Google parent:', linkError);
          }
        }
        
        console.log('New Google user created with team ID:', effectiveTeamId);
      } else {
        console.log('Existing Google user found:', userData);
        
        // Fix existing users with temp team IDs
        if (userData.teamId?.startsWith('temp_')) {
          console.log('User has temp team ID, updating to correct team:', DEFAULT_TEAM_ID);
          try {
            await updateDocument('users', user.uid, {
              teamId: DEFAULT_TEAM_ID,
              teamIds: [DEFAULT_TEAM_ID],
              updatedAt: new Date()
            });
            // Update local userData object
            userData.teamId = DEFAULT_TEAM_ID;
          } catch (updateError) {
            console.error('Error updating team ID:', updateError);
          }
        }
        
        // Update profile photo and other data if changed
        const updateData: any = {
          updatedAt: new Date()
        };
        
        if (user.photoURL && user.photoURL !== userData.profilePhotoUrl) {
          updateData.profilePhotoUrl = user.photoURL;
        }
        
        // Mark as Google auth if not already set
        if (!userData.authProvider) {
          updateData.authProvider = 'google';
        }
        
        try {
          await updateDocument('users', user.uid, updateData);
        } catch (updateError) {
          console.error('Error updating user data:', updateError);
          // Don't fail the sign-in if update fails
        }
      }
      
      // Force re-fetch and set userData since onAuthStateChanged may have already fired
      try {
        const freshData = await getUserData(user.uid) as any;
        if (freshData) {
          const freshUserData: UserData = {
            uid: freshData.uid || user.uid,
            id: freshData.id || freshData.uid || user.uid,
            email: freshData.email || user.email || '',
            name: freshData.name || '',
            role: freshData.role || 'parent',
            teamId: freshData.teamId || '',
            teamIds: freshData.teamIds || (freshData.teamId ? [freshData.teamId] : []),
            coachLevel: freshData.coachLevel || undefined,
            createdAt: freshData.createdAt instanceof Date
              ? freshData.createdAt
              : freshData.createdAt?.toDate?.()
                ? freshData.createdAt.toDate()
                : new Date(freshData.createdAt || Date.now()),
            phoneNumber: freshData.phoneNumber || undefined,
            address: freshData.address || undefined,
            emergencyContact: freshData.emergencyContact || undefined,
            emergencyPhone: freshData.emergencyPhone || undefined,
            privacy: freshData.privacy || { showPhone: true, showEmail: true, showAddress: false },
            profilePhotoUrl: freshData.profilePhotoUrl || user.photoURL || null,
            authProvider: freshData.authProvider || 'google'
          };
          setUserData(freshUserData);
          console.log('Google sign-in: userData set directly:', freshUserData.name);
        }
      } catch (refreshError) {
        console.error('Error refreshing userData after Google sign-in:', refreshError);
      }
      setLoading(false);
      
    } catch (error: any) {
      console.error('Google sign-in error:', error);
      
      // Handle specific Google sign-in errors
      let errorMessage = 'Google sign-in failed. Please try again.';
      
      if (error.code === 'auth/popup-closed-by-user') {
        errorMessage = 'Sign-in was cancelled';
      } else if (error.code === 'auth/popup-blocked') {
        errorMessage = 'Pop-up was blocked. Please allow pop-ups and try again.';
      } else if (error.code === 'auth/network-request-failed') {
        errorMessage = 'Network error. Please check your connection and try again.';
      } else if (error.code === 'auth/too-many-requests') {
        errorMessage = 'Too many attempts. Please wait a moment and try again.';
      } else if (error.message) {
        errorMessage = error.message;
      }
      
      setError(errorMessage);
      setLoading(false);
      throw error;
    }
  };

  // Sign in with Apple — native only (Apple Store requires it whenever the
  // app offers third-party sign-in like Google). Uses the same Capacitor
  // Firebase Authentication plugin and follows the same downstream flow as
  // Google: onAuthStateChanged fires, a Firestore user doc gets created if
  // the uid is new.
  const signInWithApple = async (inviteTeamId?: string): Promise<void> => {
    try {
      setLoading(true);
      setError(null);

      const { Capacitor } = await import('@capacitor/core');
      if (!Capacitor.isNativePlatform()) {
        throw new Error('Sign in with Apple is only available in the iOS app.');
      }
      const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
      await FirebaseAuthentication.signInWithApple();
      const user = auth.currentUser;
      if (!user) throw new Error('native Apple sign-in did not return a user');

      // Create the Firestore user doc on first sign-in.
      let userData = await getUserData(user.uid);
      if (!userData) {
        const effectiveTeamId = inviteTeamId || DEFAULT_TEAM_ID;
        const fullName = user.displayName || (user.email ? user.email.split('@')[0] : 'Player');
        const newUserData: any = {
          uid: user.uid,
          email: user.email || '',
          name: fullName,
          role: 'parent',
          teamId: effectiveTeamId,
          teamIds: [effectiveTeamId],
          isActive: true,
          approved: false,
          profilePhotoUrl: user.photoURL || null,
          authProvider: 'apple',
          privacy: { showPhone: true, showEmail: true, showAddress: false },
        };
        await createUser(newUserData);
      }
    } catch (error: any) {
      console.error('Apple sign-in error:', error);
      const msg = error?.message?.includes('canceled') || error?.code === 'cancelled'
        ? 'Sign-in was cancelled'
        : (error?.message || 'Apple sign-in failed. Please try again.');
      setError(msg);
      setLoading(false);
      throw error;
    }
  };

  const logout = async () => {
    try {
      setError(null);
      // Sign out of native providers too so the next launch is clean.
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (Capacitor.isNativePlatform()) {
          const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
          await FirebaseAuthentication.signOut().catch(() => {});
        }
      } catch { /* ignore */ }
      await signOut(auth);
      setUserData(null);
    } catch (error) {
      console.error('Logout error:', error);
      throw error;
    }
  };

  const resetPassword = async (email: string) => {
    try {
      setError(null);
      await sendPasswordResetEmail(auth, email);
    } catch (error) {
      console.error('Password reset error:', error);
      throw error;
    }
  };

  // Helper: race a promise against a timeout so Firestore can't hang forever
  const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | null> =>
    Promise.race([
      promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))
    ]);

  // Helper: build UserData from raw Firestore doc + Firebase user
  const buildUserData = (data: any, user: User): UserData => ({
    uid: data.uid || user.uid,
    id: data.id || data.uid || user.uid,
    email: data.email || user.email || '',
    name: data.name || '',
    role: data.role || 'parent',
    teamId: data.teamId || '',
    teamIds: data.teamIds || (data.teamId ? [data.teamId] : []),
    coachLevel: data.coachLevel || undefined,
    createdAt: data.createdAt instanceof Date
      ? data.createdAt
      : data.createdAt?.toDate?.()
        ? data.createdAt.toDate()
        : new Date(data.createdAt || Date.now()),
    phoneNumber: data.phoneNumber || undefined,
    address: data.address || undefined,
    emergencyContact: data.emergencyContact || undefined,
    emergencyPhone: data.emergencyPhone || undefined,
    privacy: data.privacy || { showPhone: true, showEmail: true, showAddress: false },
    profilePhotoUrl: data.profilePhotoUrl || user.photoURL || null,
    authProvider: data.authProvider || 'email'
  });

  // Background tasks that should NOT block the loading spinner
  const runBackgroundTasks = (userData: UserData, userId: string) => {
    // Native push notifications — register with FCM and save the device token
    // to the user doc so the Cloudflare Worker can target this device. No-op
    // on web. Imports lazily so the web bundle doesn't pay for the plugin.
    import('../utils/nativeShell').then(({ registerPushNotifications }) => {
      registerPushNotifications(async (token: string) => {
        try {
          await updateDoc(doc(db, 'users', userId), { fcmTokens: arrayUnion(token) });
        } catch (err) {
          console.warn('Failed to save fcmToken:', err);
        }
      });
    }).catch(err => console.warn('nativeShell import failed', err));

    // Auto-fix temp team IDs
    if (userData.teamId?.startsWith('temp_')) {
      updateDocument('users', userId, {
        teamId: DEFAULT_TEAM_ID,
        teamIds: [DEFAULT_TEAM_ID],
        updatedAt: new Date()
      }).then(() => {
        userData.teamId = DEFAULT_TEAM_ID;
        userData.teamIds = [DEFAULT_TEAM_ID];
        setUserData({ ...userData });
      }).catch(err => console.error('Error fixing temp team ID:', err));
    }

    // Backfill teamIds
    if (!userData.teamIds?.length && userData.teamId) {
      userData.teamIds = [userData.teamId];
      updateDocument('users', userId, {
        teamIds: [userData.teamId],
        updatedAt: new Date()
      }).catch(err => console.error('Error backfilling teamIds:', err));
    }

    // Auto-link parent to players by email match
    if (userData.role === 'parent' && userData.email) {
      const playersRef = collection(db, 'players');
      const q = query(playersRef, where('parentEmails', 'array-contains', userData.email.toLowerCase()));
      getDocs(q).then(async (snapshot) => {
        let linked = false;
        for (const playerDoc of snapshot.docs) {
          const playerData = playerDoc.data();
          if (!playerData.parentIds?.includes(userId)) {
            await updateDoc(doc(db, 'players', playerDoc.id), {
              parentIds: arrayUnion(userId)
            }).catch(() => {});
          }
          linked = true;
        }
        if (linked && userData.approved === false) {
          await updateDoc(doc(db, 'users', userId), { approved: true }).catch(() => {});
          userData.approved = true;
          setUserData({ ...userData });
        }
      }).catch(err => console.error('Error auto-linking parent:', err));
    }

    // Sync parent teamIds with their shared players' teamIds
    if (userData.role === 'parent') {
      const playersRef = collection(db, 'players');
      const q2 = query(playersRef, where('parentIds', 'array-contains', userId));
      getDocs(q2).then(async (snapshot) => {
        const parentTeamIds = new Set(userData.teamIds || (userData.teamId ? [userData.teamId] : []));
        let needsUpdate = false;
        for (const playerDoc of snapshot.docs) {
          const playerData = playerDoc.data();
          const playerTeamIds = playerData.teamIds || (playerData.teamId ? [playerData.teamId] : []);
          for (const tid of playerTeamIds) {
            if (!parentTeamIds.has(tid)) {
              parentTeamIds.add(tid);
              needsUpdate = true;
            }
          }
        }
        if (needsUpdate) {
          const newTeamIds = Array.from(parentTeamIds);
          await updateDoc(doc(db, 'users', userId), {
            teamIds: newTeamIds,
            updatedAt: new Date()
          }).catch(() => {});
          userData.teamIds = newTeamIds;
          setUserData({ ...userData });
        }
      }).catch(err => console.error('Error syncing parent teamIds:', err));
    }
  };

  useEffect(() => {
    // Safety timeout: if loading hasn't resolved in 8 seconds, force it off
    const safetyTimer = setTimeout(() => {
      setLoading((prev) => {
        if (prev) {
          console.warn('Auth loading safety timeout – forcing loading off');
        }
        return false;
      });
    }, 8000);

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      
      if (user) {
        try {
          console.log('Fetching user data for:', user.uid);
          
          // Race Firestore against a 6-second timeout so we never hang
          const data = await withTimeout(getUserData(user.uid), 6000) as any;

          if (data) {
            const userDataObj = buildUserData(data, user);
            setUserData(userDataObj);
            setLoading(false); // ← unblock the UI immediately
            console.log('User data loaded:', userDataObj);

            // Fire-and-forget background tasks
            runBackgroundTasks(userDataObj, user.uid);
          } else {
            console.log('No user data found for:', user.uid);
            setUserData(null);
            
            if (user.providerData.some(p => p.providerId === 'google.com')) {
              console.log('Google user detected, waiting for Firestore document…');
              setLoading(false); // unblock while we wait
              setTimeout(async () => {
                try {
                  const retryData = await withTimeout(getUserData(user.uid), 5000) as any;
                  if (retryData) {
                    const retryUserData = buildUserData(retryData, user);
                    setUserData(retryUserData);
                    runBackgroundTasks(retryUserData, user.uid);
                  } else {
                    console.log('Still no Firestore data for Google user, signing out');
                    await signOut(auth);
                  }
                } catch (retryError) {
                  console.error('Retry error for Google user:', retryError);
                  await signOut(auth);
                }
              }, 2000);
            } else {
              await signOut(auth);
              setLoading(false);
            }
          }
        } catch (error: any) {
          console.error('Error fetching user data:', error);
          setUserData(null);
          setLoading(false); // ← always unblock on error
          try { await signOut(auth); } catch {}
        }
      } else {
        console.log('No authenticated user');
        setUserData(null);
        setLoading(false);
      }
    });

    return () => {
      clearTimeout(safetyTimer);
      unsubscribe();
    };
  }, [getUserData]);

  const value: AuthContextType = {
    currentUser,
    userData,
    loading,
    error,
    signIn,
    signUp,
    signInWithGoogle,
    signInWithApple,
    logout,
    resetPassword
  };

  // Debug logging
  console.log('AuthContext providing functions:', Object.keys(value));
  console.log('signInWithGoogle function type:', typeof value.signInWithGoogle);
  console.log('Default team ID:', DEFAULT_TEAM_ID);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};