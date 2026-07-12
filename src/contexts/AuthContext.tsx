import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  User,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  sendEmailVerification,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
} from 'firebase/auth';
import { auth, db } from '../utils/firebase';
import { collection, query, where, getDocs, doc, updateDoc, arrayUnion, arrayRemove, deleteDoc } from 'firebase/firestore';
import { useFirestore } from '../hooks/useFirestore';
import { debug, debugWarn } from '../utils/debug';

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
  signInWithGoogle: (inviteTeamId?: string, wantRole?: 'coach' | 'parent') => Promise<void>;
  signInWithApple: (inviteTeamId?: string, wantRole?: 'coach' | 'parent') => Promise<void>;
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
      debug('Creating Firebase Auth user...');
      const result = await createUserWithEmailAndPassword(auth, email, password);

      // Send the branded verification email via our worker. This
      // replaces Firebase's default sender (noreply@<project>.
      // firebaseapp.com — Patrick: 'looks so unprofessional') with
      // a Resend-powered email from noreply@goalkickr.com that links
      // to OUR /auth/action route instead of Firebase's hosted page.
      // Fire-and-forget; the banner has a resend button if this fails.
      try {
        const NOTIFY_URL = process.env.REACT_APP_NOTIFY_URL;
        if (NOTIFY_URL) {
          fetch(`${NOTIFY_URL}/auth/send-verification`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email }),
          }).catch((e) => debugWarn('[auth] branded verification send failed, falling back to Firebase default', e))
            .then((r) => {
              if (!r || !r.ok) {
                // Fall back to Firebase's default sender if the worker
                // path is unreachable — better to send the ugly email
                // than no email at all.
                sendEmailVerification(result.user).catch(() => {});
              }
            });
        } else {
          // No worker configured (local dev without env) — use the
          // Firebase default.
          sendEmailVerification(result.user).catch(() => {});
        }
      } catch (e) {
        debugWarn('[auth] verification send threw', e);
      }

      debug('Auth user created; posting to /users/bootstrap...');

      // Bootstrap the user doc + email-match auto-link on the worker
      // side. Server owns all the sensitive writes (role, teamIds,
      // approved, players.parentIds) so a rogue client can't fabricate
      // them. Same net effect for the user as the old client-side
      // flow, plus the auto-link races into a single atomic write
      // instead of three.
      //
      // Preserved from the pre-2026-07-03 flow:
      //  - The `preApproveOnAutoLink` hint is redundant now — the
      //    worker always runs auto-link when the email matches, and
      //    stamps approved:true in the same commit. No UI flicker.
      //  - The `team_temp` / `team_` id sanitization is no longer
      //    needed at the client boundary — the worker ignores any
      //    caller-supplied teamId and derives teamIds from the
      //    linked player docs only.
      delete (newUserData as any).preApproveOnAutoLink;

      try {
        const { workerFetch } = await import('../utils/workerFetch');
        const bootstrapRes = await workerFetch('/users/bootstrap', {
          method: 'POST',
          body: JSON.stringify({
            role: newUserData.role || 'parent',
            name: newUserData.name || '',
            email: (newUserData.email || email).toLowerCase(),
            phone: (newUserData as any).phone || '',
            authProvider: 'email',
          }),
        });
        const bootstrapData: any = await bootstrapRes.json().catch(() => ({}));
        if (!bootstrapRes.ok || !bootstrapData?.ok) {
          const code = bootstrapData?.error || `bootstrap-${bootstrapRes.status}`;
          throw new Error(code);
        }
        debug('Firestore user document created via worker; linkedCount=', bootstrapData.linkedCount);
      } catch (bootstrapErr) {
        // Roll back the Firebase Auth account if the worker rejected
        // us — otherwise the user retries and hits "email already in
        // use" without any user doc to sign into. Same recovery
        // posture as the old permission-denied handler.
        if (auth.currentUser) {
          try { await auth.currentUser.delete(); } catch { /* best effort */ }
        }
        throw bootstrapErr;
      }

      return;
    } catch (error: any) {
      console.error('Sign up error:', error);
      throw error;
    }
  };

  const signInWithGoogle = async (inviteTeamId?: string, wantRole?: 'coach' | 'parent'): Promise<void> => {
    try {
      debug('Starting Google sign-in...', inviteTeamId ? `with invite team: ${inviteTeamId}` : '');
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
          // Stash both the invite team id AND the explicit role
          // choice so we can pick them back up on return — the
          // redirect navigates the whole tab away. Without the
          // role stash, the redirect-return path defaults everyone
          // to coach and silently overrides the landing choice.
          if (inviteTeamId) {
            try { sessionStorage.setItem('firefc.pendingInviteTeamId', inviteTeamId); } catch { /* ignore */ }
          }
          if (wantRole === 'coach' || wantRole === 'parent') {
            try { sessionStorage.setItem('firefc.pendingWantRole', wantRole); } catch { /* ignore */ }
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
      
      debug('Google sign-in successful:', user.uid, user.email);
      
      // Check if user document exists in Firestore
      let userData = await getUserData(user.uid);
      
      if (!userData) {
        // Extract name from Google profile
        const displayName = user.displayName || '';
        const fullName = displayName || 'Google User';

        // Post to /users/bootstrap for the user-doc create + email-
        // match auto-link. Same posture as the email signUp path:
        // worker owns all sensitive writes (role, teamIds, approved,
        // players.parentIds).
        //
        // Role resolution priority (3.9.156):
        //   1. Explicit choice from the landing screen ("Set up a
        //      team" → coach, "Join with code" → parent), passed
        //      as wantRole. Always wins if provided.
        //   2. Fallback: inviteTeamId present → parent, else coach.
        // Worker no longer force-flips role based on email match,
        // so this stated intent is the source of truth.
        try {
          const { workerFetch } = await import('../utils/workerFetch');
          const resolvedRoleG = wantRole ?? (inviteTeamId ? 'parent' : 'coach');
          const bootstrapRes = await workerFetch('/users/bootstrap', {
            method: 'POST',
            body: JSON.stringify({
              role: resolvedRoleG,
              name: fullName,
              email: (user.email || '').toLowerCase(),
              authProvider: 'google',
            }),
          });
          const bootstrapData: any = await bootstrapRes.json().catch(() => ({}));
          if (!bootstrapRes.ok || !bootstrapData?.ok) {
            throw new Error(bootstrapData?.error || `bootstrap-${bootstrapRes.status}`);
          }
          userData = await getUserData(user.uid);
        } catch (bootstrapErr) {
          console.error('[google] bootstrap failed', bootstrapErr);
          // Don't delete the Firebase Auth account here — Google's
          // credential store may hold onto it and the user won't be
          // able to retry cleanly. Instead surface the error and let
          // the user try signing in again.
          throw bootstrapErr;
        }

        debug('New Google user created via worker');
      } else {
        debug('Existing Google user found:', userData);
        
        // Fix existing users with temp team IDs
        if (userData.teamId?.startsWith('temp_')) {
          debug('User has temp team ID, updating to correct team:', DEFAULT_TEAM_ID);
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
          debug('Google sign-in: userData set directly:', freshUserData.name);
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
  const signInWithApple = async (inviteTeamId?: string, wantRole?: 'coach' | 'parent'): Promise<void> => {
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
      //
      // skipNativeAuth: true is REQUIRED for Apple specifically. Without it,
      // the plugin signs in natively (consuming Apple's nonce), then the
      // signInWithCredential call below tries to reuse the same nonce and
      // fails with auth/missing-or-invalid-nonce — Apple's replay protection
      // doesn't let the same nonce be used twice. Google doesn't single-use
      // nonces the same way, which is why Google works without this flag.
      const result = await FirebaseAuthentication.signInWithApple({ skipNativeAuth: true });
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
        // Same posture as Google + email: worker /users/bootstrap
        // owns the sensitive writes; auto-link runs server-side.
        const fullName = user.displayName || (user.email ? user.email.split('@')[0] : 'Player');
        try {
          const { workerFetch } = await import('../utils/workerFetch');
          const resolvedRoleA = wantRole ?? (inviteTeamId ? 'parent' : 'coach');
          const bootstrapRes = await workerFetch('/users/bootstrap', {
            method: 'POST',
            body: JSON.stringify({
              role: resolvedRoleA,
              name: fullName,
              email: (user.email || '').toLowerCase(),
              authProvider: 'apple',
            }),
          });
          const bootstrapData: any = await bootstrapRes.json().catch(() => ({}));
          if (!bootstrapRes.ok || !bootstrapData?.ok) {
            throw new Error(bootstrapData?.error || `bootstrap-${bootstrapRes.status}`);
          }
        } catch (bootstrapErr) {
          console.error('[apple] bootstrap failed', bootstrapErr);
          throw bootstrapErr;
        }
        // Hydrate local state from the just-created doc.
        const fresh = await getUserData(user.uid);
        if (fresh) setUserData(fresh as any);
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

      // Clear Sentry user context so post-logout errors aren't
      // attributed to the signed-out user. Runs before Firebase
      // signOut so the ordering matches the localStorage clears.
      try {
        const { setSentryUser } = await import('../utils/sentry');
        setSentryUser(null);
      } catch { /* non-fatal */ }

      // CRITICAL ORDERING: clear all the "I was signed in" hints
      // BEFORE calling any signOut. The native plugin signOut() and
      // the Web SDK signOut(auth) both fire onAuthStateChanged(null)
      // — and the legacy recovery path in that handler triggers
      // window.location.reload() if firefc.lastKnownUid is still set.
      // Patrick's bug: native signOut fires the listener before we
      // clear the localStorage hint -> reload -> Firebase Web SDK
      // restores the session from IndexedDB cache -> still signed in.
      try { sessionStorage.setItem('gk.intentionalSignout', '1'); } catch {}
      try { localStorage.removeItem('firefc.lastKnownUid'); } catch {}
      try { sessionStorage.removeItem('firefc.authRecoveryAttempted'); } catch {}
      // Wipe ALL per-team localStorage so the next user on this
      // device doesn't inherit team selection or any per-team UI
      // state from the prior session. Without this, a brand-new
      // signup could see the previous user's team data flicker
      // through (TeamContext restores selectedTeamId from
      // localStorage before it knows the new user has no teams).
      try {
        const keysToKill: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k) continue;
          if (k === 'selectedTeamId' || k.startsWith('wall.lastSeen.') || k.startsWith('gk_') || k.startsWith('firefc.')) {
            keysToKill.push(k);
          }
        }
        for (const k of keysToKill) localStorage.removeItem(k);
      } catch { /* ignore */ }

      // Remove THIS device's FCM token from the outgoing user's
      // user doc BEFORE we lose write authority via signOut. Without
      // this, the worker keeps pushing the previous user's
      // notifications to this device after another account signs
      // in. Patrick caught this — got pushes for the account he had
      // logged out from while signed in as a different one.
      try {
        const outgoingUid = currentUser?.uid;
        if (outgoingUid) {
          const { getCurrentPushToken } = await import('../utils/nativeShell');
          const token = await getCurrentPushToken();
          if (token) {
            await updateDoc(doc(db, 'users', outgoingUid), {
              fcmTokens: arrayRemove(token),
            }).catch((e) => debugWarn('[logout] fcmTokens cleanup failed', e));
            // Also invalidate the token on the native side so the
            // device generates a fresh one for the next user. Avoids
            // a rare race where Firebase reuses the same token.
            try {
              const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');
              await FirebaseMessaging.deleteToken().catch(() => {});
            } catch { /* ignore */ }
          }
        }
      } catch (e) {
        debugWarn('[logout] push cleanup failed', e);
      }

      // Now safe to sign out — listeners see clean state.
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (Capacitor.isNativePlatform()) {
          const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
          await FirebaseAuthentication.signOut().catch(() => {});
        }
      } catch { /* ignore */ }
      await signOut(auth);

      // Force the local component state to logged-out NOW, so
      // ProtectedRoute redirects immediately even if a stray
      // onAuthStateChanged emission happens later.
      setCurrentUser(null);
      setUserData(null);
      setLoading(false);

      if (userDocUnsubRef.current) {
        userDocUnsubRef.current();
        userDocUnsubRef.current = null;
      }

      // Evict the Firebase Web SDK's IndexedDB so an aggressive
      // restore-from-cache can't re-bridge a session we just killed.
      // Best-effort: if IndexedDB isn't available (rare), the
      // intentionalSignout sessionStorage flag is still our backstop.
      try {
        const dbs = ['firebaseLocalStorageDb', 'firebase-installations-database', 'firebase-messaging-database'];
        for (const name of dbs) {
          try { indexedDB.deleteDatabase(name); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
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
        debugWarn('Failed to delete /users doc, continuing with Auth delete:', err);
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
          debugWarn('Failed to save fcmToken:', err);
        }
      });
    }).catch(err => debugWarn('nativeShell import failed', err));

    // Custom JWT claims refresh. Worker /users/refresh-claims stamps
    // request.auth.token.clubIds and request.auth.token.teamIds from
    // the current userDoc, then we force a token refresh so LIST
    // rules can statically verify the caller's scope without falling
    // back to `if isAuthed()` (which is what today's rules do while
    // the older userDoc()-based rules can't be resolved for LIST).
    // Non-fatal — sign-in still works if this fails; the rules keep
    // their permissive fallback branches during migration.
    (async () => {
      try {
        const { workerFetch } = await import('../utils/workerFetch');
        const res = await workerFetch('/users/refresh-claims', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          debugWarn('[claims] refresh non-2xx', res.status);
          return;
        }
        // Web SDK: force a fresh ID token so the new claim shows up.
        try {
          await auth.currentUser?.getIdToken(true);
        } catch (err) {
          debugWarn('[claims] web getIdToken(true) failed', err);
        }
        // Native SDK parity: Capacitor plugin has its own token cache
        // used by tryBridgeNativeSession.
        try {
          const { Capacitor } = await import('@capacitor/core');
          if (Capacitor.isNativePlatform()) {
            const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
            await FirebaseAuthentication.getIdToken({ forceRefresh: true });
          }
        } catch (err) {
          debugWarn('[claims] native getIdToken(true) failed', err);
        }
      } catch (err) {
        debugWarn('[claims] refresh threw', err);
      }
    })();

    // The four legacy background writes that used to live here
    // (temp team ID fix, teamIds backfill, parent-email auto-link,
    // authoritative parent teamIds sync) are removed 2026-07-06.
    //
    // Reasons:
    //  1. First-time user-doc creation + email-match auto-link is now
    //     server-owned via /users/bootstrap. Fresh accounts never
    //     have a `temp_` teamId, empty `teamIds` while a legacy
    //     `teamId` sits stale, or a missing parent link.
    //  2. `teamIds` writes here would fail under the tightened rules
    //     anyway — worker owns those.
    //  3. The "authoritative parent teamIds sync" (rebuild teamIds
    //     from the union of each kid's teams every session) races
    //     with /teams/share-player and /teams/unshare-player which
    //     already fan out to parents server-side. When a parent's
    //     teamIds ever drift, they'll be corrected on the next
    //     share/unshare action — not on every login.
    //
    // If a drift bug shows up in the wild, the right fix is a
    // dedicated /users/resync-teams worker endpoint, not resurrecting
    // this session-time write.
  };

  // Catch the return leg of signInWithRedirect (mobile browsers).
  // Runs once on mount. If Firebase has a pending credential from a
  // just-completed redirect, we create the Firestore user doc here
  // — same shape as the popup path's first-time-user branch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Skip on Capacitor native: redirect sign-in never runs there
        // (native uses the FirebaseAuthentication plugin path instead),
        // and calling getRedirectResult on capacitor://localhost trips
        // Firebase's internal window.opener/postMessage plumbing which
        // emits the Cross-Origin-Opener-Policy warning to the console
        // on every cold start. Zero-cost fix for a warning that
        // otherwise reads as "the app is broken" to any user who peeks
        // at DevTools.
        const { Capacitor } = await import('@capacitor/core');
        if (Capacitor.isNativePlatform()) return;

        const result = await getRedirectResult(auth);
        if (cancelled || !result?.user) return;
        const user = result.user;
        const existing = await getUserData(user.uid);
        if (existing) return; // onAuthStateChanged will pick this up

        // Pull the invite team id AND the explicit role choice we
        // stashed before the redirect (if any). Both get consumed
        // one-shot — sessionStorage is per-tab so a fresh tab
        // doesn't accidentally inherit stale intent.
        let inviteTeamId = '';
        let stashedWantRole: 'coach' | 'parent' | null = null;
        try {
          inviteTeamId = sessionStorage.getItem('firefc.pendingInviteTeamId') || '';
          sessionStorage.removeItem('firefc.pendingInviteTeamId');
          const rawRole = sessionStorage.getItem('firefc.pendingWantRole');
          sessionStorage.removeItem('firefc.pendingWantRole');
          if (rawRole === 'coach' || rawRole === 'parent') stashedWantRole = rawRole;
        } catch { /* ignore */ }

        const displayName = user.displayName || '';
        const fullName = displayName || (user.email ? user.email.split('@')[0] : 'Member');
        // Same worker path as the popup + native Google flows. Auto-
        // link runs server-side during /users/bootstrap.
        try {
          const { workerFetch } = await import('../utils/workerFetch');
          const resolvedRoleRR = stashedWantRole ?? (inviteTeamId ? 'parent' : 'coach');
          const bootstrapRes = await workerFetch('/users/bootstrap', {
            method: 'POST',
            body: JSON.stringify({
              role: resolvedRoleRR,
              name: fullName,
              email: (user.email || '').toLowerCase(),
              authProvider: 'google',
            }),
          });
          const bootstrapData: any = await bootstrapRes.json().catch(() => ({}));
          if (!bootstrapRes.ok || !bootstrapData?.ok) {
            throw new Error(bootstrapData?.error || `bootstrap-${bootstrapRes.status}`);
          }
        } catch (err) {
          console.error('[redirect-return] bootstrap failed', err);
          return;  // onAuthStateChanged still fires; user can retry
        }
      } catch (err) {
        // No-op when there's nothing to handle. Firebase throws here
        // if the page wasn't reached via a redirect.
        debugWarn('getRedirectResult skipped', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Try to bridge a Keychain-backed native Firebase Auth session
  // into the Web SDK by exchanging an ID token from the native
  // plugin for a custom token via the worker, then calling
  // signInWithCustomToken. Returns true if the bridge succeeded
  // (caller should expect another onAuthStateChanged with the
  // user), false otherwise (no native session, no plugin, worker
  // unreachable, etc.).
  //
  // This is the core of the Keychain migration: once the binary
  // ships with `skipNativeAuth: false`, the native plugin will
  // sign into native Firebase Auth on every sign-in, which is
  // Keychain-backed on iOS / Keystore on Android. That session
  // survives WebView reloads cleanly. After a reload (whether
  // from Capgo or anywhere else), the Web SDK is blank but the
  // native plugin still knows who's signed in, and this function
  // brings the Web SDK back in line.
  //
  // While the binary is still running `skipNativeAuth: true` (the
  // status quo on Patrick's current build), the plugin's
  // getCurrentUser will return null and this function returns
  // false — the legacy localStorage + force-reload recovery
  // takes over. So the bridge is forward-compatible: deploys
  // safely via OTA, activates on next native binary release.
  const tryBridgeNativeSession = async (): Promise<boolean> => {
    try {
      // Honor an intentional sign-out (logout() set this flag). Without
      // this check, tapping Logout would clear the Web SDK session,
      // onAuthStateChanged would fire null, this function would
      // immediately re-sign-in the user from the Keychain-backed native
      // session, and the logout would visibly fail (page refresh,
      // still signed in). Clear the flag so future bridge calls work
      // again (e.g. they re-sign-in and then experience a Capgo reload).
      try {
        if (sessionStorage.getItem('gk.intentionalSignout') === '1') {
          sessionStorage.removeItem('gk.intentionalSignout');
          return false;
        }
      } catch { /* sessionStorage unavailable — proceed normally */ }
      const { Capacitor } = await import('@capacitor/core');
      if (!Capacitor.isNativePlatform()) return false;
      const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
      const cur = await FirebaseAuthentication.getCurrentUser();
      if (!cur?.user?.uid) return false;
      const tokenRes = await FirebaseAuthentication.getIdToken({ forceRefresh: false });
      const idToken = tokenRes?.token;
      if (!idToken) return false;
      const NOTIFY_URL = process.env.REACT_APP_NOTIFY_URL || '';
      if (!NOTIFY_URL) {
        debugWarn('[auth] keychain bridge: notify worker not configured');
        return false;
      }
      // /auth/exchange-id-token self-authenticates via the ID token
      // in the body — no bearer needed. This is the ONE endpoint that
      // must remain reachable without a bearer, because it's how we
      // get a bearer in the first place after a WebView reload.
      const res = await fetch(`${NOTIFY_URL}/auth/exchange-id-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok || !data?.customToken) {
        debugWarn('[auth] keychain bridge: exchange failed', res.status, data?.error);
        return false;
      }
      const { signInWithCustomToken } = await import('firebase/auth');
      await signInWithCustomToken(auth, data.customToken);
      debug('[auth] keychain bridge: signed in via native session', data.uid);
      return true;
    } catch (err) {
      debugWarn('[auth] keychain bridge failed', err);
      return false;
    }
  };

  useEffect(() => {
    // Safety timeout: if loading hasn't resolved in 25 seconds, force
    // it off. (Was 8s — too tight: the retry loop in the catch path
    // below can take ~22s if Firestore is recovering from a Capgo OTA
    // reload, and we want the spinner to stay up rather than bouncing
    // the user to /auth mid-retry.)
    const safetyTimer = setTimeout(() => {
      setLoading((prev) => {
        if (prev) {
          debugWarn('Auth loading safety timeout – forcing loading off');
        }
        return false;
      });
    }, 25000);

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);

      if (user) {
        // Remember that we had a real signed-in session so a later
        // transient null emission from Firebase (token re-validation
        // after a Capgo OTA reload, etc.) can be distinguished from
        // a genuine sign-out.
        try { localStorage.setItem('firefc.lastKnownUid', user.uid); } catch {}
        // Clear the "we already tried recovery this session" flag —
        // we recovered (either naturally or via a forced reload that
        // worked). Future transient nulls can attempt recovery again.
        try { sessionStorage.removeItem('firefc.authRecoveryAttempted'); } catch {}

        try {
          debug('Fetching user data for:', user.uid);
          
          // Race Firestore against a 6-second timeout so we never hang
          const data = await withTimeout(getUserData(user.uid), 6000) as any;

          if (data) {
            const userDataObj = buildUserData(data, user);
            setUserData(userDataObj);
            setLoading(false); // ← unblock the UI immediately
            debug('User data loaded:', userDataObj);

            // Attach the current user to Sentry so every subsequent
            // error report knows who hit it. Filter by uid or email
            // in the Sentry UI when a specific coach says "it broke
            // for me." No-op in dev / when Sentry isn't initialized.
            try {
              const { setSentryUser } = await import('../utils/sentry');
              setSentryUser({
                uid: userDataObj.uid,
                email: userDataObj.email,
                name: userDataObj.name,
              });
            } catch { /* non-fatal */ }

            // Defense-in-depth: ensure user.teamIds mirrors every team
            // whose coachIds contains this uid. Some coaches ended up
            // with team.coachIds set but user.teamIds empty — worker's
            // requireCoachOfTeam let them WRITE, but callerCanReadPlayer
            // (which only checked user.teamIds) 403'd every read. Worker
            // heals in O(1) query + at most 1 write, idempotent. Fires
            // on every sign-in load so a stale sessionStorage flag
            // (from an old version) can't block it.
            try {
              const { workerFetch } = await import('../utils/workerFetch');
              workerFetch('/users/heal-team-membership', {
                method: 'POST',
                body: JSON.stringify({}),
              }).then(r => r.json().then(j => ({ status: r.status, body: j }))).then((res: any) => {
                debug('[heal] status', res.status, 'foundTeams', res.body?.foundTeams, 'legacyTeamId', res.body?.legacyTeamId, 'added', JSON.stringify(res.body?.added), 'teamIds', JSON.stringify(res.body?.teamIds), 'role', res.body?.role, 'clubIds', JSON.stringify(res.body?.clubIds));
              }).catch(err => debugWarn('[heal] failed', err));
            } catch { /* non-fatal */ }

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
              }, (err) => {
                // permission-denied fires as the auth token transitions
                // (sign-out, token rotation). Not user-facing, don't
                // scare the prod console.
                const code = (err as any)?.code;
                if (code === 'permission-denied' || code === 'unauthenticated') {
                  debugWarn('user-doc snapshot denied (expected during auth transition)', err);
                } else {
                  console.warn('user-doc snapshot failed', err);
                }
              });
              // Cleanup happens implicitly when the user signs out
              // (onAuthStateChanged fires again with null) — store the
              // unsubscribe on a ref so we can call it then.
              (userDocUnsubRef.current as any) = liveUnsub;
            } catch (err) {
              debugWarn('user-doc live subscribe init failed', err);
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
            debug('userData not present on first read, will retry:', user.uid);
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
          debugWarn('user data fetch failed, will retry:', error);
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
        // onAuthStateChanged fired with null. Three possibilities:
        // 1) Real sign-out (signOut() called, or never signed in here)
        // 2) Post-OTA WebView reload — Firebase Web SDK lost its
        //    session but the NATIVE Firebase Auth (Keychain-backed
        //    via @capacitor-firebase/authentication, when
        //    skipNativeAuth: false) still knows who the user is. We
        //    can BRIDGE that native session into the Web SDK by
        //    asking the plugin for an ID token, having the worker
        //    mint a custom token, and signing in with that. This
        //    is the path that eliminates the logout cascade —
        //    when it succeeds, onAuthStateChanged fires AGAIN with
        //    the real user, hitting the success path above.
        // 3) Same WebView-reload scenario but on a binary still
        //    running with skipNativeAuth: true — no native session
        //    to bridge from. Falls through to the legacy
        //    localStorage + force-reload recovery.

        // Step 1: try the Keychain bridge.
        const bridged = await tryBridgeNativeSession();
        if (bridged) {
          // The bridge called signInWithCustomToken which will
          // trigger another onAuthStateChanged emission with the
          // real user. Nothing else to do here.
          return;
        }

        // Step 2: legacy recovery — windows.location.reload() when
        // localStorage remembers a session, accept sign-out otherwise.
        const LAST_UID_KEY = 'firefc.lastKnownUid';
        const RECOVERY_KEY = 'firefc.authRecoveryAttempted';
        const wasSignedIn = (() => {
          try { return localStorage.getItem(LAST_UID_KEY); } catch { return null; }
        })();
        if (wasSignedIn) {
          const alreadyTried = (() => {
            try { return sessionStorage.getItem(RECOVERY_KEY); } catch { return null; }
          })();
          if (alreadyTried) {
            // We already reloaded once in this session and Firebase
            // STILL can't recover. The session is well and truly bad —
            // accept the sign-out and let the user re-authenticate.
            debug('Auth recovery already attempted this session, accepting sign-out');
            try { localStorage.removeItem(LAST_UID_KEY); } catch {}
            try { sessionStorage.removeItem(RECOVERY_KEY); } catch {}
            setUserData(null);
            setLoading(false);
            return;
          }
          debug('Auth null but lastKnownUid present — watching for recovery');
          let checks = 0;
          const interval = window.setInterval(() => {
            checks++;
            if (auth.currentUser) {
              // Firebase recovered on its own. Next onAuthStateChanged
              // emission will hit the success path; just stop watching.
              debug('Auth recovered naturally');
              window.clearInterval(interval);
              return;
            }
            if (checks >= 3) {
              // 3 seconds of nothing. Force-reload to mimic the
              // force-close + reopen flow that Patrick verified works.
              window.clearInterval(interval);
              try { sessionStorage.setItem(RECOVERY_KEY, '1'); } catch {}
              debug('Auth still null after 3s — forcing reload to recover');
              window.location.reload();
            }
          }, 1000);
          return;
        }
        debug('No authenticated user');
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
      debugWarn('refreshUserData failed:', err);
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

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};