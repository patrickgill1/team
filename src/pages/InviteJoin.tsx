import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  User as FbUser,
} from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../utils/firebase';
import { fetchInvite, consumeInvite, type FetchedInvite } from '../utils/invites';
import type { Player } from '../types';

/**
 * Public-facing invite-join page.
 *   /join/<inviteId>
 *
 * Resolves the invite, shows context (player or team + role), runs sign-in
 * or sign-up, then atomically links the new user to the team/player via
 * consumeInvite().
 *
 * Notes:
 * - On native iOS the existing AuthContext also handles Apple/Google flows;
 *   here we keep it minimal (email/password) so the flow works even in a
 *   public web browser. After consume, we redirect to the appropriate page.
 * - Coexists with the legacy /join?player=&code= flow at PlayerJoin.
 */

const Spinner: React.FC = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin rounded-full h-10 w-10 border-2 border-cyan-200 border-t-cyan-500" />
  </div>
);

const Page: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-black flex items-start justify-center p-4 pt-12 pb-16">
    <div className="bg-slate-900/60 backdrop-blur ring-1 ring-white/10 rounded-3xl shadow-2xl w-full max-w-md overflow-hidden text-white">
      {children}
    </div>
  </div>
);

const InviteJoin: React.FC = () => {
  const { inviteId } = useParams<{ inviteId: string }>();
  const navigate = useNavigate();
  const [invite, setInvite] = useState<FetchedInvite | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [teamName, setTeamName] = useState<string>('the team');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<FbUser | null>(null);
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-up');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Watch auth state — auto-skip the form if already signed in.
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => setCurrentUser(u));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!inviteId) {
        setError('No invite specified.');
        setLoading(false);
        return;
      }
      try {
        const inv = await fetchInvite(inviteId);
        if (!inv) {
          if (!cancelled) { setError('This invite link is invalid or has been deleted.'); setLoading(false); }
          return;
        }
        if (cancelled) return;
        setInvite(inv);

        // Resolve context — for player invites we want the player's name/jersey;
        // for staff invites the team name + role.
        if (inv.type === 'player' && inv.playerId) {
          const p = await getDoc(doc(db, 'players', inv.playerId));
          if (p.exists() && !cancelled) {
            const v: any = p.data();
            setPlayer({
              id: p.id, name: v.name, jerseyNumber: v.jerseyNumber, position: v.position,
              profilePhotoUrl: v.profilePhotoUrl,
              teamId: v.teamId, isActive: v.isActive,
              createdAt: v.createdAt?.toDate ? v.createdAt.toDate() : new Date(),
            } as Player);
          }
        }
        try {
          const t = await getDoc(doc(db, 'teams', inv.teamId));
          if (t.exists() && !cancelled) setTeamName((t.data() as any).name || 'the team');
        } catch { /* ignore */ }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Could not load this invite.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [inviteId]);

  const handleConsume = async (uid: string) => {
    if (!inviteId) return;
    const result: any = await consumeInvite(inviteId, uid);
    if (!result?.ok) {
      setError(`Couldn't link your account: ${result?.reason || 'unknown'}. Ask the coach for a new invite.`);
      return;
    }
    setDone(true);
    setTimeout(() => {
      if (result.type === 'player' && result.playerId) navigate(`/player/${result.playerId}`);
      else navigate('/dashboard');
    }, 1200);
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invite || !inviteId) return;
    if (!email.trim() || !password) {
      setError('Email and password are required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      let uid: string;
      if (mode === 'sign-up') {
        if (!name.trim()) { setError('Your name is required for new accounts.'); setSubmitting(false); return; }
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        uid = cred.user.uid;
        // Create the user doc so consumeInvite has something to update.
        await setDoc(doc(db, 'users', uid), {
          uid,
          email: email.trim(),
          name: name.trim(),
          // role/teamId are set inside consumeInvite based on invite type.
          role: invite.type === 'player' ? 'parent' : invite.type === 'team_manager' ? 'team_manager' : 'coach',
          teamId: invite.teamId,
          teamIds: [invite.teamId],
          isActive: true,
          createdAt: serverTimestamp(),
          privacy: { showPhone: true, showEmail: true, showAddress: false },
        });
      } else {
        const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
        uid = cred.user.uid;
        // Make sure the user doc exists; create a minimal stub if not.
        const userRef = doc(db, 'users', uid);
        const u = await getDoc(userRef);
        if (!u.exists()) {
          await setDoc(userRef, {
            uid,
            email: email.trim(),
            name: cred.user.displayName || email.trim().split('@')[0],
            role: invite.type === 'player' ? 'parent' : invite.type === 'team_manager' ? 'team_manager' : 'coach',
            teamId: invite.teamId,
            teamIds: [invite.teamId],
            isActive: true,
            createdAt: serverTimestamp(),
            privacy: { showPhone: true, showEmail: true, showAddress: false },
          });
        }
      }
      await handleConsume(uid);
    } catch (err: any) {
      const code = err?.code as string | undefined;
      const msg =
        code === 'auth/email-already-in-use' ? 'That email already has an account — switch to "I already have an account" below.' :
        code === 'auth/wrong-password' || code === 'auth/invalid-credential' ? 'Wrong password. Try again or reset.' :
        code === 'auth/weak-password' ? 'Password should be at least 6 characters.' :
        err?.message || 'Sign-in failed.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  // Render branches ----------------------------------------------------------
  if (loading) return <Page><Spinner /></Page>;

  if (error && !invite) {
    return (
      <Page>
        <div className="p-8 text-center">
          <div className="text-5xl mb-3">😕</div>
          <h1 className="text-xl font-bold">Invite unavailable</h1>
          <p className="text-white/70 text-sm mt-2">{error}</p>
          <Link to="/auth" className="mt-6 inline-block px-4 py-2 rounded-full bg-white/10 ring-1 ring-white/20 text-sm font-semibold">Go to sign-in</Link>
        </div>
      </Page>
    );
  }

  if (invite && (invite.expired || invite.exhausted || invite.revoked)) {
    const reason = invite.revoked ? 'has been revoked' : invite.expired ? 'has expired' : 'has reached its use limit';
    return (
      <Page>
        <div className="p-8 text-center">
          <div className="text-5xl mb-3">⏰</div>
          <h1 className="text-xl font-bold">This invite {reason}</h1>
          <p className="text-white/70 text-sm mt-2">Ask the coach to send you a fresh link.</p>
        </div>
      </Page>
    );
  }

  if (done) {
    return (
      <Page>
        <div className="p-8 text-center">
          <div className="text-5xl mb-3">🎉</div>
          <h1 className="text-2xl font-black">You're in!</h1>
          <p className="text-white/70 text-sm mt-2">Loading your team…</p>
        </div>
      </Page>
    );
  }

  // Header content depends on invite type
  const headerInner = invite?.type === 'player' && player ? (
    <>
      <div className="flex items-center gap-4 mb-3">
        {player.profilePhotoUrl ? (
          <img src={player.profilePhotoUrl} alt={player.name} className="w-16 h-16 rounded-full object-cover ring-2 ring-white/25" />
        ) : (
          <div className="w-16 h-16 rounded-full bg-white/10 ring-2 ring-white/25 flex items-center justify-center text-2xl font-black">
            {player.jerseyNumber ? `#${player.jerseyNumber}` : player.name.charAt(0)}
          </div>
        )}
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/60">Joining as parent</p>
          <h1 className="text-2xl font-black leading-tight">{player.name}</h1>
          <p className="text-white/70 text-sm">
            {player.jerseyNumber ? `#${player.jerseyNumber}` : ''}{player.jerseyNumber && player.position ? ' · ' : ''}{player.position}
          </p>
        </div>
      </div>
      <p className="text-white/80 text-sm">Are you {player.name.split(' ')[0]}'s parent? Create an account or sign in below to follow their stats, clips, and team updates.</p>
    </>
  ) : invite?.type === 'coach' ? (
    <>
      <p className="text-[10px] font-bold uppercase tracking-widest text-white/60 mb-2">Coach invite</p>
      <h1 className="text-2xl font-black mb-2">Join {teamName}</h1>
      <p className="text-white/80 text-sm">You're being added as <b>{invite.role === 'head_coach' ? 'Head Coach' : 'Assistant Coach'}</b>. Sign in or create an account to accept.</p>
    </>
  ) : invite?.type === 'team_manager' ? (
    <>
      <p className="text-[10px] font-bold uppercase tracking-widest text-white/60 mb-2">Team manager invite</p>
      <h1 className="text-2xl font-black mb-2">Manage {teamName}</h1>
      <p className="text-white/80 text-sm">You're being added as <b>Team Manager</b>. Sign in or create an account to accept.</p>
    </>
  ) : (
    <p className="text-white/70 text-sm">Loading invite details…</p>
  );

  return (
    <Page>
      {/* Hero */}
      <div className="relative overflow-hidden bg-gradient-to-br from-fire-900 via-fire-950 to-black p-6 border-b border-cyan-500/10">
        <div className="absolute -top-16 -right-16 w-56 h-56 bg-cyan-500/20 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-16 -left-10 w-56 h-56 bg-rose-500/20 rounded-full blur-3xl pointer-events-none" />
        <div className="relative">{headerInner}</div>
      </div>

      {/* Already signed in shortcut */}
      {currentUser ? (
        <div className="p-6 space-y-3">
          <p className="text-sm text-white/85">
            Signed in as <b>{currentUser.email}</b>. Tap below to link this account to {invite?.type === 'player' && player ? player.name : teamName}.
          </p>
          {error && <p className="text-rose-300 text-sm">{error}</p>}
          <button
            onClick={() => handleConsume(currentUser.uid)}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-500 hover:from-cyan-400 hover:to-violet-400 text-white font-bold text-sm transition"
          >
            Yes, link this account
          </button>
          <button
            onClick={async () => { await auth.signOut(); }}
            className="w-full py-2 text-xs font-semibold text-white/60 hover:text-white"
          >
            Use a different account
          </button>
        </div>
      ) : (
        <form onSubmit={handleAuthSubmit} className="p-6 space-y-4">
          <div className="flex gap-2 mb-2">
            <button
              type="button"
              onClick={() => setMode('sign-up')}
              className={`flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition ${mode === 'sign-up' ? 'bg-white text-slate-900' : 'bg-white/10 text-white/70'}`}
            >
              Create account
            </button>
            <button
              type="button"
              onClick={() => setMode('sign-in')}
              className={`flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition ${mode === 'sign-in' ? 'bg-white text-slate-900' : 'bg-white/10 text-white/70'}`}
            >
              I already have one
            </button>
          </div>

          {mode === 'sign-up' && (
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="w-full px-4 py-3 rounded-xl bg-white/5 ring-1 ring-white/15 text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-400"
            />
          )}
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            className="w-full px-4 py-3 rounded-xl bg-white/5 ring-1 ring-white/15 text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-400"
          />
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            className="w-full px-4 py-3 rounded-xl bg-white/5 ring-1 ring-white/15 text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-400"
          />

          {error && <p className="text-rose-300 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-cyan-500 via-violet-500 to-fuchsia-500 hover:from-cyan-400 hover:via-violet-400 hover:to-fuchsia-400 text-white font-bold text-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Working…' : mode === 'sign-up' ? 'Create account & join' : 'Sign in & join'}
          </button>
        </form>
      )}

      {/* Footer */}
      <div className="border-t border-white/10 px-6 py-3 text-center text-[11px] text-white/40 font-semibold tracking-wider uppercase">
        🔥 Fire FC
      </div>
    </Page>
  );
};

export default InviteJoin;
