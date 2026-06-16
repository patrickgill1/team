import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  User,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
} from 'firebase/auth';
import { auth, db } from '../utils/firebase';
import { collection, query, where, getDocs, doc, updateDoc, arrayUnion, deleteDoc } from 'firebase/firestore';
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
  isClubAdmin?: boolean;
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
  // Self-uploaded user avatar (Settings → My Account). Independent of
  // OAuth profilePhotoUrl so a user can override what Google supplied.
  photoURL?: string;
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
  deleteAccount: () => Promise<void>;
  /** Re-pull the user's Firestore doc and refresh context. Call after
   *  editing profile fields so the UI reflects the change without a
   *  sign-out / sign-in cycle. */
  refreshUserData: () => Promise<void>;
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
  const userDocUnsubRef = React.useRef<(() => void) | null>(null);
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
      
      // Only attach to a team when the signup carried a real invite-
      // derived team id. Previously this fell back to DEFAULT_TEAM_ID
      // for anything that smelled like a temp id, which silently
      // attached random signups straight to Fire FC's active team.
      // Now if no real team id is present we leave it empty and let
      // the parent-email matcher below find the right team. If neither
      // works, the user gets approved=false and no team — they can't
      // see anything until a coach intentionally links them.
      const looksReal = !!newUserData.teamId
        && !newUserData.teamId.startsWith('team_temp')
        && !newUserData.teamId.startsWith('team_'); // bare timestamps used to fall through
      const effectiveTeamId = looksReal ? newUserData.teamId : '';

      const userDataWithId: any = {
        ...newUserData,
        uid: result.user.uid,
        teamId: effectiveTeamId,
        teamIds: effectiveTeamId ? [effectiveTeamId] : [],
        isActive: true,
        // Approved only when joining via a real invite. Self-signup
        // (even with role=coach) starts as not-approved.
        approved: looksReal,
        approvalStatus: looksReal ? 'auto' : 'pending',
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
          const linkedTeamIds = new Set<string>();
          let firstPlayerPrimaryTeamId: string | null = null;
          for (const playerDoc of snapshot.docs) {
            const playerData = playerDoc.data();
            if (!playerData.parentIds?.includes(result.user.uid)) {
              await updateDoc(doc(db, 'players', playerDoc.id), {
                parentIds: arrayUnion(result.user.uid)
              });
              console.log('Auto-linked new email parent to player:', playerDoc.id);
            }
            linked = true;
            const pTeams: string[] = playerData.teamIds || (playerData.teamId ? [playerData.teamId] : []);
            for (const t of pTeams) linkedTeamIds.add(t);
            if (!firstPlayerPrimaryTeamId) {
              firstPlayerPrimaryTeamId = playerData.teamId || pTeams[0] || null;
            }
          }
          if (linked) {
            // Replace the placeholder team assignment with the team(s) of the
            // child this account was just linked to. Previously we left teamId
            // as DEFAULT_TEAM_ID, so a parent whose kid was on Team B would
            // log in and see Team A by default.
            const userPatch: Record<string, unknown> = { approved: true };
            if (firstPlayerPrimaryTeamId && !linkedTeamIds.has(effectiveTeamId)) {
              userPatch.teamId = firstPlayerPrimaryTeamId;
              userPatch.teamIds = Array.from(linkedTeamIds);
            }
            await updateDoc(doc(db, 'users', result.user.uid), userPatch);
            console.log('Auto-approved new email parent via email match', userPatch);
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
        // Plugin runs the native Google Sign-In sheet and returns an idToken;
        // we then sign into the *web* Firebase SDK with that credential so
        // onAuthStateChanged fires inside the WebView.
        const result = await FirebaseAuthentication.signInWithGoogle();
        const idToken = result.credential?.idToken;
        if (!idToken) throw new Error('native Google sign-in returned no idToken');
        const credential = GoogleAuthProvider.credential(idToken);
        const cred = await signInWithCredential(auth, credential);
        user = cred.user;
      } else {
        const provider = new GoogleAuthProvider();
        provider.addScope('email');
        provider.addScope('profile');
        // Mobile browsers (iOS Safari + Chrome iOS especially) break
        // the signInWithPopup flow: the popup either won't post the
        // result back to the parent window, or the parent is GC'd
        // when the new tab takes focus. Use signInWithRedirect on
        // anything that smells like mobile web; the desktop popup
        // stays for keyboard-and-mouse contexts where it works well.
        const isMobileWeb = typeof navigator !== 'undefined'
          && /Android|iPhone|iPad|iPod|Mobile/.test(navigator.userAgent);
        if (isMobileWeb) {
          // Stash the optional invite team id so we can pick it back
          // up on return — the redirect navigates the whole tab away.
          if (inviteTeamId) {
            try { sessionStorage.setItem('firefc.pendingInviteTeamId', inviteTeamId); } catch { /* ignore */ }
          }
          await signInWithRedirect(auth, provider);
          // signInWithRedirect navigates away; control returns via
          // getRedirectResult in handleGoogleRedirectReturn (mounted
          // below). Nothing more to do here.
          return;
        }
        const result = await signInWithPopup(auth, provider);
        user = result.user;
      }
      
      console.log('Google sign-in successful:', user.uid, user.email);
      
      // Check if user document exists in Firestore
      let userData = await getUserData(user.uid);
      
      if (!userData) {
        // No DEFAULT_TEAM_ID fallback anymore — if there's no invite,
        // we'll see if the email matches a roster parent below. If
        // neither, the user lands with no team + approved=false,
        // which keeps them out of any club's data.
        const effectiveTeamId = inviteTeamId || '';

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
          teamIds: effectiveTeamId ? [effectiveTeamId] : [],
          isActive: true,
          approved: !!inviteTeamId,
          approvalStatus: inviteTeamId ? 'auto' : 'pending',
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
            const linkedTeamIds = new Set<string>();
            let firstPlayerPrimaryTeamId: string | null = null;
            for (const playerDoc of snapshot.docs) {
              const playerData = playerDoc.data();
              if (!playerData.parentIds?.includes(user.uid)) {
                await updateDoc(doc(db, 'players', playerDoc.id), {
                  parentIds: arrayUnion(user.uid)
                });
                console.log('Auto-linked new Google parent to player:', playerDoc.id);
              }
              linked = true;
              const pTeams: string[] = playerData.teamIds || (playerData.teamId ? [playerData.teamId] : []);
              for (const t of pTeams) linkedTeamIds.add(t);
              if (!firstPlayerPrimaryTeamId) {
                firstPlayerPrimaryTeamId = playerData.teamId || pTeams[0] || null;
              }
            }
            if (linked) {
              // Switch the new user away from the DEFAULT_TEAM_ID placeholder
              // onto their child's team(s) — see signUp() for the same logic.
              const userPatch: Record<string, unknown> = { approved: true };
              if (firstPlayerPrimaryTeamId && !linkedTeamIds.has(effectiveTeamId)) {
                userPatch.teamId = firstPlayerPrimaryTeamId;
                userPatch.teamIds = Array.from(linkedTeamIds);
                (userData as any).teamId = firstPlayerPrimaryTeamId;
                (userData as any).teamIds = Array.from(linkedTeamIds);
              }
              await updateDoc(doc(db, 'users', user.uid), userPatch);
              (userData as any).approved = true;
              console.log('Auto-approved new Google parent via email match', userPatch);
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
      // Native Apple sheet → idToken + nonce; we bridge into the web SDK so
      // onAuthStateChanged fires inside the WebView.
      const result = await FirebaseAuthentication.signInWithApple();
      const idToken = result.credential?.idToken;
      if (!idToken) throw new Error('native Apple sign-in returned no idToken');
      const provider = new OAuthProvider('apple.com');
      const credential = provider.credential({
        idToken,
        rawNonce: result.credential?.nonce,
      });
      const cred = await signInWithCredential(auth, credential);
      const user = cred.user;

      // Create the Firestore user doc on first sign-in.
      let userData = await getUserData(user.uid);
      if (!userData) {
        // Same lockdown as Google + email signup paths. No
        // DEFAULT_TEAM_ID fallback. New users get a real team only
        // when an invite carried one; otherwise team-less + pending.
        const effectiveTeamId = inviteTeamId || '';
        const fullName = user.displayName || (user.email ? user.email.split('@')[0] : 'Player');
        const newUserData: any = {
          uid: user.uid,
          email: user.email || '',
          name: fullName,
          role: 'parent',
          teamId: effectiveTeamId,
          teamIds: effectiveTeamId ? [effectiveTeamId] : [],
          isActive: true,
          approved: !!inviteTeamId,
          approvalStatus: inviteTeamId ? 'auto' : 'pending',
          profilePhotoUrl: user.photoURL || null,
          authProvider: 'apple',
          privacy: { showPhone: true, showEmail: true, showAddress: false },
        };
        await createUser(newUserData);
        // Push the new doc into local state immediately so the SimpleAuth
        // post-sign-in redirect fires without waiting for onAuthStateChanged
        // → subscribeToUser to round-trip Firestore.
        setUserData(newUserData);
      } else {
        setUserData(userData);
      }
      setCurrentUser(user);
      // CRITICAL: SimpleAuth gates its redirect to /dashboard on `!loading`.
      // Without this, loading stays true forever after Apple sign-in
      // succeeds and the user bounces back to the auth screen — which is
      // exactly what the App Store reviewer hit on iPad Air (rejection
      // 2.1(a), build 6).
      setLoading(false);
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
      if (userDocUnsubRef.current) {
        userDocUnsubRef.current();
        userDocUnsubRef.current = null;
      }
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

  // Delete the user's account. Required by App Store guideline 5.1.1(v) —
  // any app that supports account creation must let users delete from inside
  // the app. We:
  //   1. Delete the Firestore /users/{uid} doc so their profile + team
  //      membership disappears immediately.
  //   2. Delete the Firebase Auth user so the same email can sign up again
  //      and the account credentials are gone.
  //   3. Sign out (cleans up native session) and clear local state.
  //
  // Team-shared content they uploaded (photos, chat messages, RSVPs) stays
  // visible to the team — that's content the team owns, not personal data.
  // Coaches can manually scrub it if needed.
  //
  // Firebase Auth requires a recent sign-in to delete an account. If the
  // credential is stale, Firebase throws auth/requires-recent-login; we
  // catch that and ask the user to sign back in.
  const deleteAccount = async (): Promise<void> => {
    const user = auth.currentUser;
    if (!user) throw new Error('Not signed in.');
    setError(null);
    try {
      // 1) Firestore user doc first — if Auth delete fails, at least we tried
      //    to clear the profile data.
      await deleteDoc(doc(db, 'users', user.uid)).catch(err => {
        console.warn('Failed to delete /users doc, continuing with Auth delete:', err);
      });

      // 2) Firebase Auth account.
      await user.delete();

      // 3) Belt-and-suspenders: clear native session too.
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (Capacitor.isNativePlatform()) {
          const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
          await FirebaseAuthentication.signOut().catch(() => {});
        }
      } catch { /* ignore */ }

      setUserData(null);
      setCurrentUser(null);
    } catch (error: any) {
      console.error('Delete account error:', error);
      if (error?.code === 'auth/requires-recent-login') {
        throw new Error(
          'For security, please sign out and sign back in, then try deleting your account again.'
        );
      }
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
    // Spread the raw Firestore data FIRST so dynamic fields the chat /
    // notifications / settings store on the user doc — pinnedThreadIds,
    // mutedThreadIds, mutedUserIds, wallLastSeen, etc. — pass through
    // every snapshot. Without this, the live onSnapshot fires but
    // buildUserData strips the new array, so pin/mute toggles never
    // visibly stick. Explicit fields below still win for safety
    // (defaults, type coercion).
    ...(data || {}),
    uid: data.uid || user.uid,
    id: data.id || data.uid || user.uid,
    email: data.email || user.email || '',
    name: data.name || '',
    role: data.role || 'parent',
    teamId: data.teamId || '',
    teamIds: data.teamIds || (data.teamId ? [data.teamId] : []),
    isClubAdmin: data.isClubAdmin === true,
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
    authProvider: data.authProvider || 'email',
    // Prefer the user's manually-uploaded avatar over the OAuth one
    // (data.photoURL is what Settings writes; user.photoURL comes from
    // the Firebase Auth provider).
    photoURL: data.photoURL || data.profilePhotoUrl || user.photoURL || undefined,
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
        // Merge into CURRENT state — never replace with our stale
        // closure snapshot. Otherwise an in-flight update (e.g. the
        // user uploaded a new profile photo in Settings) gets clobbered
        // when this background fix resolves.
        setUserData(prev => prev ? { ...prev, teamId: DEFAULT_TEAM_ID, teamIds: [DEFAULT_TEAM_ID] } : prev);
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
          setUserData(prev => prev ? { ...prev, approved: true } as any : prev);
        }
      }).catch(err => console.error('Error auto-linking parent:', err));
    }

    // Sync parent teamIds with their players' current teamIds.
    // AUTHORITATIVE: replace, don't just append. Otherwise a parent who once
    // had a player shared to Team B keeps Team B in their teamIds forever,
    // even after we unshare the player. Authoritative set =
    //   parent's own primary teamId ∪ union of all teamIds across all their players.
    if (userData.role === 'parent') {
      const playersRef = collection(db, 'players');
      const q2 = query(playersRef, where('parentIds', 'array-contains', userId));
      getDocs(q2).then(async (snapshot) => {
        const correct = new Set<string>();
        if (userData.teamId) correct.add(userData.teamId);
        for (const playerDoc of snapshot.docs) {
          const playerData = playerDoc.data();
          const playerTeamIds = playerData.teamIds || (playerData.teamId ? [playerData.teamId] : []);
          for (const tid of playerTeamIds) correct.add(tid);
        }
        const newTeamIds = Array.from(correct);
        const currentTeamIds = userData.teamIds || (userData.teamId ? [userData.teamId] : []);
        const sameSet =
          newTeamIds.length === currentTeamIds.length &&
          newTeamIds.every(t => currentTeamIds.includes(t));
        // If the parent's primary teamId is no longer represented (e.g. they
        // were created with DEFAULT_TEAM_ID but their kid is on another team,
        // or we just unshared the only team they had access to), promote one
        // of the valid teams to primary.
        const primaryNeedsFix =
          newTeamIds.length > 0 && !!userData.teamId && !correct.has(userData.teamId);
        // Never write an empty set — if we somehow computed [], the parent has
        // no players right now (e.g. mid-sign-up before linking) and we don't
        // want to lock them out of their existing primary team.
        if (newTeamIds.length > 0 && (!sameSet || primaryNeedsFix)) {
          const patch: Record<string, unknown> = {
            teamIds: newTeamIds,
            updatedAt: new Date(),
          };
          if (primaryNeedsFix) {
            patch.teamId = newTeamIds[0];
            userData.teamId = newTeamIds[0];
          }
          await updateDoc(doc(db, 'users', userId), patch).catch(() => {});
          userData.teamIds = newTeamIds;
          // Merge — don't blast over a fresh photoURL the user just set
          // in Settings while this background sync was running.
          setUserData(prev => prev ? { ...prev, teamIds: newTeamIds, ...(primaryNeedsFix ? { teamId: newTeamIds[0] } : {}) } : prev);
        }
      }).catch(err => console.error('Error syncing parent teamIds:', err));
    }
  };

  // Catch the return leg of signInWithRedirect (mobile browsers).
  // Runs once on mount. If Firebase has a pending credential from a
  // just-completed redirect, we create the Firestore user doc here
  // — same shape as the popup path's first-time-user branch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await getRedirectResult(auth);
        if (cancelled || !result?.user) return;
        const user = result.user;
        const existing = await getUserData(user.uid);
        if (existing) return; // onAuthStateChanged will pick this up

        // Pull the invite team id we stashed before the redirect (if any).
        let inviteTeamId = '';
        try {
          inviteTeamId = sessionStorage.getItem('firefc.pendingInviteTeamId') || '';
          sessionStorage.removeItem('firefc.pendingInviteTeamId');
        } catch { /* ignore */ }

        const displayName = user.displayName || '';
        const fullName = displayName || (user.email ? user.email.split('@')[0] : 'Member');
        const newUserData: any = {
          uid: user.uid,
          email: user.email || '',
          name: fullName,
          role: 'parent',
          teamId: inviteTeamId,
          teamIds: inviteTeamId ? [inviteTeamId] : [],
          isActive: true,
          approved: !!inviteTeamId,
          approvalStatus: inviteTeamId ? 'auto' : 'pending',
          profilePhotoUrl: user.photoURL || null,
          authProvider: 'google',
          privacy: { showPhone: true, showEmail: true, showAddress: false },
        };
        await createUser(newUserData);

        // Roster auto-link: same logic as the popup path so a parent
        // who's been pre-added by a coach gets approved + on the
        // right team without any extra steps.
        if (user.email) {
          try {
            const snap = await getDocs(query(
              collection(db, 'players'),
              where('parentEmails', 'array-contains', user.email.toLowerCase()),
            ));
            const linkedTeamIds = new Set<string>();
            let firstPlayerPrimaryTeamId: string | null = null;
            for (const playerDoc of snap.docs) {
              const p = playerDoc.data();
              if (!p.parentIds?.includes(user.uid)) {
                await updateDoc(doc(db, 'players', playerDoc.id), {
                  parentIds: arrayUnion(user.uid),
                });
              }
              const pTeams: string[] = p.teamIds || (p.teamId ? [p.teamId] : []);
              for (const t of pTeams) linkedTeamIds.add(t);
              if (!firstPlayerPrimaryTeamId) firstPlayerPrimaryTeamId = p.teamId || pTeams[0] || null;
            }
            if (snap.size > 0 && firstPlayerPrimaryTeamId) {
              await updateDoc(doc(db, 'users', user.uid), {
                approved: true,
                approvalStatus: 'auto',
                teamId: firstPlayerPrimaryTeamId,
                teamIds: Array.from(linkedTeamIds),
              });
            }
          } catch (err) {
            console.warn('redirect-return roster link failed', err);
          }
        }
      } catch (err) {
        // No-op when there's nothing to handle. Firebase throws here
        // if the page wasn't reached via a redirect.
        console.warn('getRedirectResult skipped', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // Safety timeout: if loading hasn't resolved in 25 seconds, force
    // it off. (Was 8s — too tight: the retry loop in the catch path
    // below can take ~22s if Firestore is recovering from a Capgo OTA
    // reload, and we want the spinner to stay up rather than bouncing
    // the user to /auth mid-retry.)
    const safetyTimer = setTimeout(() => {
      setLoading((prev) => {
        if (prev) {
          console.warn('Auth loading safety timeout – forcing loading off');
        }
        return false;
      });
    }, 25000);

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

            // Live subscribe to the user doc so changes the user makes
            // from any device (pinning a chat, updating their name,
            // joining a team) reflect immediately without a reload.
            try {
              const { onSnapshot, doc: fsDoc } = await import('firebase/firestore');
              const { db } = await import('../utils/firebase');
              const liveUnsub = onSnapshot(fsDoc(db, 'users', user.uid), (snap) => {
                if (!snap.exists()) return;
                const fresh = buildUserData(snap.data(), user);
                setUserData(fresh);
              }, (err) => console.warn('user-doc snapshot failed', err));
              // Cleanup happens implicitly when the user signs out
              // (onAuthStateChanged fires again with null) — store the
              // unsubscribe on a ref so we can call it then.
              (userDocUnsubRef.current as any) = liveUnsub;
            } catch (err) {
              console.warn('user-doc live subscribe init failed', err);
            }

            // Fire-and-forget background tasks
            runBackgroundTasks(userDataObj, user.uid);
          } else {
            // getUserData returned null. That means EITHER (a) the doc
            // doesn't exist yet (brand-new federated sign-up, Firestore
            // doc still being written by the signInWith… caller) OR
            // (b) Firestore was briefly unreachable and withTimeout
            // returned null at the 6s deadline (a Capgo OTA reload
            // race, cellular handoff, etc.).
            //
            // We can't tell those apart from the snapshot alone, so we
            // retry up to 3 times with backoff. CRITICAL: keep loading=true
            // throughout — without that, ProtectedRoute sees
            // (currentUser, !userData, !loading) and bounces the user to
            // /auth during the retry window. That's what was logging
            // people out after a Capgo OTA swap.
            console.log('userData not present on first read, will retry:', user.uid);
            let attempts = 0;
            const MAX_ATTEMPTS = 3;
            const tryAgain = async () => {
              attempts++;
              try {
                const retryData = await withTimeout(getUserData(user.uid), 8000) as any;
                if (retryData) {
                  const retryUserData = buildUserData(retryData, user);
                  setUserData(retryUserData);
                  setLoading(false);
                  runBackgroundTasks(retryUserData, user.uid);
                  return;
                }
                // Still no data. If we've exhausted retries, this is
                // most likely a brand-new federated user whose Firestore
                // doc the signInWith… path is about to write. Drop
                // loading off; signInWithGoogle/Apple will call
                // setUserData when the doc lands.
                if (attempts < MAX_ATTEMPTS) {
                  setTimeout(tryAgain, 2000 * attempts);
                  return;
                }
                setUserData(null);
                setLoading(false);
              } catch (err: any) {
                const code = err?.code || '';
                if (code === 'permission-denied' || code === 'unauthenticated') {
                  console.warn('userData fetch denied, signing out');
                  setUserData(null);
                  setLoading(false);
                  try { await signOut(auth); } catch {}
                  return;
                }
                if (attempts < MAX_ATTEMPTS) {
                  setTimeout(tryAgain, 2000 * attempts);
                  return;
                }
                setLoading(false);
              }
            };
            setTimeout(tryAgain, 1500);
          }
        } catch (error: any) {
          // A Firestore fetch error here used to immediately sign the
          // user out — which turned every transient hiccup (especially
          // the unavoidable Listen-channel renegotiation after a Capgo
          // OTA reload, or a brief cellular handoff) into a forced
          // re-login. Now: keep loading=true (so ProtectedRoute keeps
          // showing the spinner instead of bouncing to /auth) and
          // retry up to 3 times with backoff. Only sign out on a
          // definitive auth error.
          console.warn('user data fetch failed, will retry:', error);
          let attempts = 0;
          const MAX_ATTEMPTS = 3;
          const tryAgain = async () => {
            attempts++;
            try {
              const retryData = await withTimeout(getUserData(user.uid), 8000) as any;
              if (retryData) {
                const obj = buildUserData(retryData, user);
                setUserData(obj);
                setLoading(false);
                runBackgroundTasks(obj, user.uid);
                return;
              }
              // Got no data and no error — treat as transient and retry.
              if (attempts < MAX_ATTEMPTS) {
                setTimeout(tryAgain, 2000 * attempts);
                return;
              }
            } catch (retryErr: any) {
              const code = retryErr?.code || '';
              if (code === 'permission-denied' || code === 'unauthenticated') {
                console.warn('userData fetch denied by auth state, signing out');
                setUserData(null);
                setLoading(false);
                try { await signOut(auth); } catch {}
                return;
              }
              if (attempts < MAX_ATTEMPTS) {
                setTimeout(tryAgain, 2000 * attempts);
                return;
              }
            }
            // All retries exhausted. Unblock the UI; the live user-doc
            // snapshot listener that runs alongside this path will
            // eventually fill userData in once Firestore recovers.
            setLoading(false);
          };
          setTimeout(tryAgain, 1500);
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

  const refreshUserData = async () => {
    if (!currentUser) return;
    try {
      const fresh = await getUserData(currentUser.uid) as any;
      if (fresh) setUserData(buildUserData(fresh, currentUser));
    } catch (err) {
      console.warn('refreshUserData failed:', err);
    }
  };

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
    resetPassword,
    deleteAccount,
    refreshUserData,
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