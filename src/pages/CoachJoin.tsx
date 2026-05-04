import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { collection, query, where, getDocs, doc, getDoc, updateDoc, setDoc } from 'firebase/firestore';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import { auth, db } from '../utils/firebase';

const DEFAULT_TEAM_ID = "team_1752188125868";

const CoachJoin: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const inviteCode = searchParams.get('code');

  const [invite, setInvite] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null | undefined>(undefined);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);

  // Auth form
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, user => {
      setCurrentUser(user);
    });
    return () => unsubscribe();
  }, []);

  // Load invite
  useEffect(() => {
    if (inviteCode) {
      loadInvite(inviteCode);
    } else {
      setError('Invalid invite link. No code provided.');
      setLoading(false);
    }
  }, [inviteCode]);

  // Auto-join when authenticated
  useEffect(() => {
    if (currentUser && invite && !joined && !joining) {
      acceptInvite(currentUser);
    }
  }, [currentUser, invite, joined, joining]);

  const loadInvite = async (code: string) => {
    try {
      const q = query(
        collection(db, 'coach_invites'),
        where('inviteCode', '==', code),
        where('status', '==', 'pending')
      );
      const snapshot = await getDocs(q);
      if (snapshot.empty) {
        setError('This invite link is invalid or has already been used.');
        setLoading(false);
        return;
      }
      const inviteDoc = snapshot.docs[0];
      setInvite({ id: inviteDoc.id, ...inviteDoc.data() });
      setLoading(false);
    } catch (err) {
      console.error('Error loading invite:', err);
      setError('Failed to load invite. Please try again.');
      setLoading(false);
    }
  };

  const acceptInvite = async (user: User) => {
    if (!invite) return;
    setJoining(true);
    try {
      // Get or create user doc
      const userRef = doc(db, 'users', user.uid);
      const userDoc = await getDoc(userRef);

      if (userDoc.exists()) {
        // Existing user — update role to coach and add team
        const userData = userDoc.data();
        const currentTeamIds = userData.teamIds || (userData.teamId ? [userData.teamId] : []);
        const newTeamIds = currentTeamIds.includes(invite.teamId)
          ? currentTeamIds
          : [...currentTeamIds, invite.teamId];

        await updateDoc(userRef, {
          role: 'coach',
          coachLevel: invite.coachLevel,
          teamIds: newTeamIds,
          updatedAt: new Date()
        });
      } else {
        // New user — create user doc as coach
        await setDoc(userRef, {
          uid: user.uid,
          email: user.email || '',
          name: name || user.displayName || user.email?.split('@')[0] || 'Coach',
          role: 'coach',
          coachLevel: invite.coachLevel,
          teamId: invite.teamId,
          teamIds: [invite.teamId],
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }

      // Add coach to the team doc
      try {
        const teamRef = doc(db, 'teams', invite.teamId);
        const teamDoc = await getDoc(teamRef);
        if (teamDoc.exists()) {
          const teamData = teamDoc.data();
          const coachIds = teamData.coachIds || [];
          if (!coachIds.includes(user.uid)) {
            const updateData: any = {
              coachIds: [...coachIds, user.uid],
              updatedAt: new Date(),
            };
            if (invite.coachLevel === 'head_coach') {
              updateData.headCoachId = user.uid;
              // Move previous head coach to assistants if they exist
              if (teamData.headCoachId && teamData.headCoachId !== user.uid) {
                const assistants = (teamData.assistantCoachIds || []).filter((id: string) => id !== user.uid);
                assistants.push(teamData.headCoachId);
                updateData.assistantCoachIds = assistants;
              }
            } else {
              updateData.assistantCoachIds = [...(teamData.assistantCoachIds || []), user.uid];
            }
            await updateDoc(teamRef, updateData);
          }
        }
      } catch (err) {
        console.error('Error updating team doc:', err);
      }

      // Mark invite as accepted
      await updateDoc(doc(db, 'coach_invites', invite.id), {
        status: 'accepted',
        acceptedAt: new Date(),
        acceptedBy: user.uid
      });

      setJoined(true);
      setJoining(false);
    } catch (err) {
      console.error('Error accepting invite:', err);
      setError('Failed to join team. Please try again.');
      setJoining(false);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSubmitting(true);

    try {
      if (authMode === 'register') {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      setAuthError(
        err.code === 'auth/email-already-in-use' ? 'Email already in use. Try logging in instead.' :
        err.code === 'auth/invalid-email' ? 'Invalid email address.' :
        err.code === 'auth/weak-password' ? 'Password must be at least 6 characters.' :
        err.code === 'auth/user-not-found' ? 'No account found. Try registering instead.' :
        err.code === 'auth/wrong-password' ? 'Incorrect password.' :
        'Authentication failed. Please try again.'
      );
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleGoogleAuth = async () => {
    setAuthError(null);
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      if (err.code !== 'auth/popup-closed-by-user') {
        setAuthError('Google sign-in failed. Please try again.');
      }
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-emerald-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-emerald-50 flex items-center justify-center p-4">
        <div className="bg-gray-900/80 rounded-xl shadow-lg p-8 max-w-md w-full text-center">
          <div className="text-4xl mb-4">❌</div>
          <h2 className="text-xl font-bold text-white mb-2">Invalid Invite</h2>
          <p className="text-gray-300">{error}</p>
        </div>
      </div>
    );
  }

  if (joined) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-emerald-50 flex items-center justify-center p-4">
        <div className="bg-gray-900/80 rounded-xl shadow-lg p-8 max-w-md w-full text-center">
          <div className="text-5xl mb-4">🎉</div>
          <h2 className="text-2xl font-bold text-white mb-2">Welcome, Coach!</h2>
          <p className="text-gray-300 mb-2">
            You've joined <strong>{invite?.teamName}</strong> as {invite?.coachLevel === 'head_coach' ? 'Head Coach' : 'Assistant Coach'}.
          </p>
          <p className="text-gray-400 text-sm mb-6">You now have access to manage voting, view stats, and help with team admin.</p>
          <button
            onClick={() => navigate('/dashboard')}
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 rounded-lg font-medium transition-colors"
          >
            Go to Dashboard →
          </button>
        </div>
      </div>
    );
  }

  if (joining) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-emerald-50 flex items-center justify-center p-4">
        <div className="bg-gray-900/80 rounded-xl shadow-lg p-8 max-w-md w-full text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600 mx-auto mb-4"></div>
          <p className="text-gray-300">Joining team...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-emerald-50 flex items-center justify-center p-4">
      <div className="bg-gray-900/80 rounded-xl shadow-lg max-w-md w-full overflow-hidden">
        {/* Header */}
        <div className="bg-emerald-600 px-6 py-5 text-white text-center">
          <div className="text-3xl mb-2">⚽</div>
          <h1 className="text-xl font-bold">Coach Invite</h1>
          <p className="text-emerald-100 text-sm mt-1">
            You've been invited to join <strong>{invite?.teamName}</strong>
          </p>
          <div className="mt-2 inline-block bg-emerald-500 px-3 py-1 rounded-full text-xs font-medium">
            {invite?.coachLevel === 'head_coach' ? '👑 Head Coach' : '🏅 Assistant Coach'}
          </div>
        </div>

        {/* Auth */}
        <div className="p-6">
          <p className="text-sm text-gray-300 mb-4 text-center">
            {currentUser ? 'Processing...' : 'Sign in or create an account to join the team.'}
          </p>

          {/* Google Sign In */}
          <button
            onClick={handleGoogleAuth}
            className="w-full flex items-center justify-center space-x-3 bg-white border-2 border-white/10 hover:border-white/15 hover:bg-white/5 px-4 py-3 rounded-lg font-medium transition-colors mb-4"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            <span className="text-gray-200">Continue with Google</span>
          </button>

          <div className="relative mb-4">
            <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-white/10"></div></div>
            <div className="relative flex justify-center text-sm"><span className="px-2 bg-white text-gray-400">or</span></div>
          </div>

          {/* Email/Password form */}
          <form onSubmit={handleEmailAuth} className="space-y-3">
            {authMode === 'register' && (
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full px-3 py-2 border border-white/15 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                placeholder="Your name"
                required
              />
            )}
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-white/15 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              placeholder="Email address"
              required
            />
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-white/15 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              placeholder="Password"
              required
              minLength={6}
            />

            {authError && (
              <p className="text-red-500 text-sm">{authError}</p>
            )}

            <button
              type="submit"
              disabled={authSubmitting}
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-3 rounded-lg font-medium transition-colors disabled:opacity-50"
            >
              {authSubmitting ? 'Please wait...' : authMode === 'register' ? 'Create Account & Join' : 'Sign In & Join'}
            </button>
          </form>

          <p className="text-center text-sm text-gray-400 mt-4">
            {authMode === 'register' ? (
              <>Already have an account? <button onClick={() => setAuthMode('login')} className="text-emerald-600 font-medium hover:underline">Sign in</button></>
            ) : (
              <>Need an account? <button onClick={() => setAuthMode('register')} className="text-emerald-600 font-medium hover:underline">Register</button></>
            )}
          </p>
        </div>
      </div>
    </div>
  );
};

export default CoachJoin;
