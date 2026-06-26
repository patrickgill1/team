import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { doc, getDoc, updateDoc, arrayUnion } from 'firebase/firestore';
import { 
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import { auth, db } from '../utils/firebase';
import { Player } from '../types';

const TEAM_ID = "team_1752188125868";

const PlayerJoin: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const playerId = searchParams.get('player');
  const inviteCode = searchParams.get('code');

  const [player, setPlayer] = useState<Player | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null | undefined>(undefined); // undefined = unknown
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState(false);
  const [alreadyLinked, setAlreadyLinked] = useState(false);

  // Auth form state
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  // Listen to auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, user => {
      setCurrentUser(user);
    });
    return () => unsubscribe();
  }, []);

  // Load player data
  useEffect(() => {
    if (playerId) {
      loadPlayer(playerId);
    } else {
      setError('Invalid invite link. No player specified.');
      setLoading(false);
    }
  }, [playerId]);

  // Auto-link when user is authenticated
  useEffect(() => {
    if (currentUser && player && !linked && !linking) {
      checkAndLink(currentUser, player);
    }
  }, [currentUser, player]);

  const loadPlayer = async (id: string) => {
    try {
      setLoading(true);
      const playerDoc = await getDoc(doc(db, 'players', id));
      if (!playerDoc.exists()) {
        setError('Player not found. This invite link may be invalid or expired.');
        return;
      }
      const data = playerDoc.data();

      // Validate invite code
      if (inviteCode && data.inviteCode && data.inviteCode !== inviteCode) {
        setError('Invalid invite code. Please request a new invite link.');
        return;
      }

      setPlayer({ id: playerDoc.id, ...data } as Player);
    } catch (err) {
      console.error('Error loading player:', err);
      setError('Failed to load player information. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const checkAndLink = async (user: User, playerData: Player) => {
    // Check if already linked
    if (playerData.parentIds?.includes(user.uid)) {
      setAlreadyLinked(true);
      return;
    }
    await linkUserToPlayer(user, playerData);
  };

  const linkUserToPlayer = async (user: User, playerData: Player) => {
    setLinking(true);
    try {
      // Add parent to player's parentIds
      await updateDoc(doc(db, 'players', playerData.id), {
        parentIds: arrayUnion(user.uid),
      });

      // Add player to user's children list
      await updateDoc(doc(db, 'users', user.uid), {
        children: arrayUnion(playerData.id),
      });

      setLinked(true);
    } catch (err) {
      console.error('Error linking player:', err);
      setError('Failed to link your account. Please contact the coach.');
    } finally {
      setLinking(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);

      // Ensure user doc exists in Firestore
      const userDoc = await getDoc(doc(db, 'users', result.user.uid));
      if (!userDoc.exists()) {
        const { setDoc } = await import('firebase/firestore');
        await setDoc(doc(db, 'users', result.user.uid), {
          uid: result.user.uid,
          email: result.user.email,
          name: result.user.displayName || result.user.email?.split('@')[0] || 'Parent',
          role: 'parent',
          teamId: TEAM_ID,
          createdAt: new Date(),
          authProvider: 'google',
          profilePhotoUrl: result.user.photoURL || null,
          isActive: true,
        });
      }
    } catch (err: any) {
      setAuthError(err.message || 'Google sign-in failed. Please try again.');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    if (!email.trim() || !password.trim()) {
      setAuthError('Please fill in all fields.');
      return;
    }
    if (authMode === 'register' && !name.trim()) {
      setAuthError('Please enter your name.');
      return;
    }
    if (password.length < 6) {
      setAuthError('Password must be at least 6 characters.');
      return;
    }

    setAuthSubmitting(true);

    try {
      if (authMode === 'login') {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      } else {
        // Register
        const result = await createUserWithEmailAndPassword(auth, email.trim(), password);
        // Create user doc
        const { setDoc } = await import('firebase/firestore');
        await setDoc(doc(db, 'users', result.user.uid), {
          uid: result.user.uid,
          email: result.user.email,
          name: name.trim(),
          role: 'parent',
          teamId: TEAM_ID,
          createdAt: new Date(),
          authProvider: 'email',
          isActive: true,
        });
      }
    } catch (err: any) {
      const code = err.code;
      if (code === 'auth/user-not-found' || code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        setAuthError('Incorrect email or password.');
      } else if (code === 'auth/email-already-in-use') {
        setAuthError('An account with this email already exists. Try signing in instead.');
        setAuthMode('login');
      } else if (code === 'auth/invalid-email') {
        setAuthError('Please enter a valid email address.');
      } else {
        setAuthError(err.message || 'Authentication failed. Please try again.');
      }
    } finally {
      setAuthSubmitting(false);
    }
  };

  // --- RENDER ---

  if (loading || currentUser === undefined) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-brand-primary-soft to-indigo-100 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-charcoal-600 mx-auto mb-4"></div>
          <p className="text-bone/65">Loading player profile...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-brand-primary-soft to-indigo-100 flex items-center justify-center p-4">
        <div className="bg-charcoal-900 rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
          <div className="text-5xl mb-4">⚠️</div>
          <h1 className="text-xl font-bold text-bone mb-2">Invalid Invite Link</h1>
          <p className="text-rose-300 bg-rose-500/15 p-3 rounded-lg text-sm">{error}</p>
          <button
            onClick={() => navigate('/')}
            className="mt-4 text-bone/65 hover:text-charcoal-800 text-sm underline"
          >
            Go to homepage
          </button>
        </div>
      </div>
    );
  }

  // Player loaded, now show the appropriate state
  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-primary-soft to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-charcoal-900 rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        {/* Player header */}
        <div className="bg-gradient-to-r from-charcoal-600 to-indigo-600 p-6 text-white text-center">
          {player?.profilePhotoUrl ? (
            <img
              src={player.profilePhotoUrl}
              alt={player?.name}
              className="w-20 h-20 rounded-full object-cover mx-auto mb-3 border-4 border-white shadow-lg"
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-charcoal-900 bg-opacity-20 flex items-center justify-center mx-auto mb-3 border-4 border-white shadow-lg">
              <span className="text-white font-bold text-3xl">
                {player?.name.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <h1 className="text-2xl font-bold">{player?.name}</h1>
          {player?.position && <p className="text-bone">{player.position}</p>}
          {player?.jerseyNumber && <p className="text-brand-primary-soft text-sm">#{player.jerseyNumber}</p>}
        </div>

        <div className="p-6">
          {/* Success / already linked states */}
          {(linked || alreadyLinked) && (
            <div className="text-center">
              <div className="text-5xl mb-3">{linked ? '🎉' : '✅'}</div>
              <h2 className="text-xl font-bold text-bone mb-1">
                {linked ? "You're all set!" : 'Already linked!'}
              </h2>
              <p className="text-bone/65 text-sm mb-4">
                {linked
                  ? `Your account is now linked to ${player?.name}'s profile. You can vote in Player of the Match polls and stay connected with the team.`
                  : `Your account is already linked to ${player?.name}'s profile.`}
              </p>
              <button
                onClick={() => navigate('/dashboard')}
                className="w-full bg-charcoal-600 hover:bg-charcoal-700 text-white font-bold py-3 rounded-xl transition-colors"
              >
                Go to Team Dashboard →
              </button>
            </div>
          )}

          {/* Linking in progress */}
          {linking && (
            <div className="text-center py-4">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-charcoal-600 mx-auto mb-3"></div>
              <p className="text-bone/65">Linking your account...</p>
            </div>
          )}

          {/* Not logged in — show auth */}
          {!currentUser && !linking && !linked && !alreadyLinked && (
            <div>
              <h2 className="text-lg font-bold text-bone mb-1">
                {authMode === 'login' ? 'Sign in to claim this profile' : 'Create an account'}
              </h2>
              <p className="text-bone/50 text-sm mb-4">
                {authMode === 'login'
                  ? `Sign in to link your account to ${player?.name}'s profile.`
                  : `Create a free account to link to ${player?.name}'s profile and join the team.`}
              </p>

              {/* Google Sign In */}
              <button
                onClick={handleGoogleSignIn}
                disabled={authSubmitting}
                className="w-full flex items-center justify-center gap-3 border border-white/15 rounded-xl py-2.5 px-4 hover:bg-white/[0.05] transition-colors mb-3 font-medium text-bone/85 disabled:opacity-50"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="#4285f4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34a853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#fbbc05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#ea4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Continue with Google
              </button>

              <div className="flex items-center my-3">
                <div className="flex-1 h-px bg-white/15"></div>
                <span className="px-3 text-bone/40 text-xs">or</span>
                <div className="flex-1 h-px bg-white/15"></div>
              </div>

              <form onSubmit={handleEmailAuth} className="space-y-3">
                {authMode === 'register' && (
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="Your full name"
                    className="w-full border border-white/15 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-brand-primary text-sm"
                  />
                )}
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="Email address"
                  className="w-full border border-white/15 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-brand-primary text-sm"
                />
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={authMode === 'register' ? 'Create a password (min 6 chars)' : 'Password'}
                  className="w-full border border-white/15 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-brand-primary text-sm"
                />

                {authError && (
                  <p className="text-rose-300 text-sm bg-rose-500/15 p-2 rounded-lg">{authError}</p>
                )}

                <button
                  type="submit"
                  disabled={authSubmitting}
                  className="w-full bg-charcoal-600 hover:bg-charcoal-700 text-white font-bold py-2.5 rounded-xl transition-colors disabled:opacity-50"
                >
                  {authSubmitting
                    ? 'Please wait...'
                    : authMode === 'login'
                    ? 'Sign In'
                    : 'Create Account'}
                </button>
              </form>

              <p className="text-center text-sm text-bone/50 mt-4">
                {authMode === 'login' ? (
                  <>
                    Don't have an account?{' '}
                    <button onClick={() => { setAuthMode('register'); setAuthError(null); }} className="text-bone/65 font-medium hover:underline">
                      Sign up
                    </button>
                  </>
                ) : (
                  <>
                    Already have an account?{' '}
                    <button onClick={() => { setAuthMode('login'); setAuthError(null); }} className="text-bone/65 font-medium hover:underline">
                      Sign in
                    </button>
                  </>
                )}
              </p>
            </div>
          )}

          {/* Logged in but not yet linked (shouldn't happen, but fallback) */}
          {currentUser && !linking && !linked && !alreadyLinked && player && (
            <div className="text-center py-4">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-charcoal-600 mx-auto mb-3"></div>
              <p className="text-bone/65 text-sm">Linking your account to {player.name}'s profile...</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PlayerJoin;
