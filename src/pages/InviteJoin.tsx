import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
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
    <div className="animate-spin rounded-full h-10 w-10 border-2 border-brand-primary-soft border-t-cyan-500" />
  </div>
);

const Page: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="min-h-screen bg-gradient-to-br from-surface-base via-surface-elevated to-vignette-deep flex items-start justify-center p-4 pt-12 pb-16">
    <div className="bg-surface-elevated/60 backdrop-blur ring-1 ring-line-default/10 rounded-3xl shadow-2xl w-full max-w-md overflow-hidden text-ink-primary">
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
  // Club brand surfaces here so a parent sees who they're joining
  // (Fire FC the club, not just "GoalKickr"). Falls back to the
  // default GoalKickr crimson when the team's club has no branding
  // set — same look as before.
  const [clubBrand, setClubBrand] = useState<{ name: string; logoUrl?: string; brandColor?: string } | null>(null);
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
              // Adult-team pickup players use the same invite path as
              // youth players, but the copy has to swap so a 30-year-old
              // doesn't read "Joining as parent" on their own claim.
              isAdultPlayer: v.isAdultPlayer === true,
              createdAt: v.createdAt?.toDate ? v.createdAt.toDate() : new Date(),
            } as Player);
          }
        }
        try {
          const t = await getDoc(doc(db, 'teams', inv.teamId));
          if (t.exists() && !cancelled) {
            const tData = t.data() as any;
            setTeamName(tData.name || 'the team');
            // Fetch the team's club for branding. Public-read on the
            // club doc is allowed via the catch-all auth rule. If the
            // team has no clubId (rare; pre-onboarding-wizard teams),
            // the strip just hides.
            if (tData.clubId) {
              try {
                const c = await getDoc(doc(db, 'clubs', tData.clubId));
                if (c.exists() && !cancelled) {
                  const cData = c.data() as any;
                  setClubBrand({
                    name: cData.name || '',
                    logoUrl: cData.logoUrl,
                    brandColor: cData.brandColor,
                  });
                }
              } catch { /* ignore */ }
            }
          }
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
      // team_self_serve_adult also lands on a player doc (the worker
      // just created one for this user); route to it same as the
      // player-invite path so the new adult player lands on their own
      // profile with the "welcome / rsvp for saturday" affordance.
      const landOnPlayer =
        (result.type === 'player' || result.type === 'team_self_serve_adult')
        && result.playerId;
      if (landOnPlayer) navigate(`/player/${result.playerId}`);
      else navigate('/dashboard');
    }, 1200);
  };

  const ensureUserDocFor = async (uid: string, fallbackEmail: string, fallbackName: string) => {
    if (!invite) return;
    const userRef = doc(db, 'users', uid);
    const existing = await getDoc(userRef);
    if (existing.exists()) return;
    // Route the first-time create through /users/bootstrap so the
    // sensitive fields (role, teamIds, approved) come from the guarded
    // path. Role here is a placeholder — /claim/invite overwrites it
    // based on the invite's actual type on the next step.
    const { workerFetch } = await import('../utils/workerFetch');
    await workerFetch('/users/bootstrap', {
      method: 'POST',
      body: JSON.stringify({
        role: invite.type === 'player' ? 'parent' : 'coach',
        name: fallbackName,
        email: fallbackEmail.toLowerCase(),
        authProvider: 'email',
      }),
    });
  };

  const handleGoogle = async () => {
    if (!invite || !inviteId) return;
    setSubmitting(true);
    setError(null);
    try {
      // Three-way sign-in branch matching AuthContext.signInWithGoogle:
      //   - native (Capacitor): FirebaseAuthentication plugin, then
      //     sign into the web SDK with the returned credential. Popup
      //     on capacitor://localhost otherwise trips COOP warnings AND
      //     fails silently when a parent opens this invite deep link
      //     from inside the installed app.
      //   - desktop / mobile web: signInWithPopup is fine (COOP only
      //     fires on the capacitor origin, and the invite flow needs
      //     the returned user object to consume the invite atomically
      //     — signInWithRedirect would navigate the whole tab away).
      const { Capacitor } = await import('@capacitor/core');
      let u: FbUser;
      if (Capacitor.isNativePlatform()) {
        const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
        const nativeResult = await FirebaseAuthentication.signInWithGoogle();
        const idToken = nativeResult.credential?.idToken;
        if (!idToken) throw new Error('native Google sign-in returned no idToken');
        const credential = GoogleAuthProvider.credential(idToken);
        const { signInWithCredential } = await import('firebase/auth');
        const cred = await signInWithCredential(auth, credential);
        u = cred.user;
      } else {
        const provider = new GoogleAuthProvider();
        provider.addScope('email');
        provider.addScope('profile');
        const result = await signInWithPopup(auth, provider);
        u = result.user;
      }
      await ensureUserDocFor(
        u.uid,
        u.email || '',
        u.displayName || u.email?.split('@')[0] || 'New member',
      );
      await handleConsume(u.uid);
    } catch (err: any) {
      if (err?.code !== 'auth/popup-closed-by-user') {
        setError(err?.message || 'Google sign-in failed.');
      }
    } finally {
      setSubmitting(false);
    }
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
      const { workerFetch } = await import('../utils/workerFetch');
      if (mode === 'sign-up') {
        if (!name.trim()) { setError('Your name is required for new accounts.'); setSubmitting(false); return; }
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        uid = cred.user.uid;
        await workerFetch('/users/bootstrap', {
          method: 'POST',
          body: JSON.stringify({
            role: invite.type === 'player' ? 'parent' : 'coach',
            name: name.trim(),
            email: email.trim().toLowerCase(),
            authProvider: 'email',
          }),
        });
      } else {
        const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
        uid = cred.user.uid;
        // Make sure the user doc exists; bootstrap if not.
        const u = await getDoc(doc(db, 'users', uid));
        if (!u.exists()) {
          await workerFetch('/users/bootstrap', {
            method: 'POST',
            body: JSON.stringify({
              role: invite.type === 'player' ? 'parent' : 'coach',
              name: cred.user.displayName || email.trim().split('@')[0],
              email: email.trim().toLowerCase(),
              authProvider: 'email',
            }),
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
          <svg className="w-14 h-14 mx-auto mb-3 text-rose-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <h1 className="text-xl font-bold">Invite unavailable</h1>
          <p className="text-ink-primary/70 text-sm mt-2">{error}</p>
          <Link to="/auth" className="mt-6 inline-block px-4 py-2 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-sm font-semibold">Go to sign-in</Link>
        </div>
      </Page>
    );
  }

  if (invite && (invite.expired || invite.exhausted || invite.revoked)) {
    const reason = invite.revoked ? 'has been revoked' : invite.expired ? 'has expired' : 'has reached its use limit';
    return (
      <Page>
        <div className="p-8 text-center">
          <svg className="w-14 h-14 mx-auto mb-3 text-amber-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <h1 className="text-xl font-bold">This invite {reason}</h1>
          <p className="text-ink-primary/70 text-sm mt-2">Ask the coach to send you a fresh link.</p>
        </div>
      </Page>
    );
  }

  if (done) {
    return (
      <Page>
        <div className="p-8 text-center">
          <svg className="w-14 h-14 mx-auto mb-3 text-emerald-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <h1 className="text-2xl font-black">You're in!</h1>
          <p className="text-ink-primary/70 text-sm mt-2">Opening your Team HQ...</p>
        </div>
      </Page>
    );
  }

  // Header content depends on invite type
  const headerInner = invite?.type === 'player' && player ? (
    <>
      <div className="flex items-center gap-4 mb-3">
        {player.profilePhotoUrl ? (
          <img src={player.profilePhotoUrl} alt={player.name} className="w-16 h-16 rounded-full object-cover ring-2 ring-line-default/25" />
        ) : (
          <div className="w-16 h-16 rounded-full bg-line-default/10 ring-2 ring-line-default/25 flex items-center justify-center text-2xl font-black">
            {player.jerseyNumber ? `#${player.jerseyNumber}` : player.name.charAt(0)}
          </div>
        )}
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-ink-primary/60">
            {(player as any).isAdultPlayer ? 'Claim your spot' : `Joining ${player.name.split(' ')[0]}'s Circle`}
          </p>
          <h1 className="text-2xl font-black leading-tight">{player.name}</h1>
          <p className="text-ink-primary/70 text-sm">
            {player.jerseyNumber ? `#${player.jerseyNumber}` : ''}{player.jerseyNumber && player.position ? ' · ' : ''}{player.position}
          </p>
        </div>
      </div>
      <p className="text-ink-primary/80 text-sm">
        {(player as any).isAdultPlayer
          ? `Sign in below to lock in your roster spot on ${teamName || 'the team'} — RSVPs, tagged clips, and team splits will land on your device.`
          : `Create an account or sign in below to follow ${player.name.split(' ')[0]}'s stats, clips, and team updates.`}
      </p>
    </>
  ) : invite?.type === 'coach' ? (
    <>
      <p className="text-[10px] font-bold uppercase tracking-widest text-ink-primary/60 mb-2">Coach invite</p>
      <h1 className="text-2xl font-black mb-2">Join {teamName}</h1>
      <p className="text-ink-primary/80 text-sm">You're being added as <b>{invite.role === 'head_coach' ? 'Head Coach' : 'Assistant Coach'}</b>. Sign in or create an account to accept.</p>
    </>
  ) : invite?.type === 'team_manager' ? (
    <>
      <p className="text-[10px] font-bold uppercase tracking-widest text-ink-primary/60 mb-2">Team manager invite</p>
      <h1 className="text-2xl font-black mb-2">Manage {teamName}</h1>
      <p className="text-ink-primary/80 text-sm">You're being added as <b>Team Manager</b>. Sign in or create an account to accept.</p>
    </>
  ) : invite?.type === 'team_self_serve_adult' ? (
    <>
      <p className="text-[10px] font-bold uppercase tracking-widest text-ink-primary/60 mb-2">Team join link</p>
      <h1 className="text-2xl font-black mb-2">Join {teamName || 'the team'}</h1>
      <p className="text-ink-primary/80 text-sm">
        Sign in below and you're on the roster. RSVPs, chat, and team updates land on your device.
      </p>
    </>
  ) : (
    <p className="text-ink-primary/70 text-sm">Loading invite details…</p>
  );

  return (
    <Page>
      {/* Club brand strip — only renders if the team's club has a
          logo or color set. Gives a new family the "I'm joining Fire
          FC" signal before they see the team-specific hero. */}
      {clubBrand && (clubBrand.logoUrl || clubBrand.brandColor) && (
        <div
          className="flex items-center gap-3 px-5 py-3 border-b border-line-default/10"
          style={{
            backgroundColor: '#0d0d10',
            boxShadow: clubBrand.brandColor ? `inset 0 -2px 0 ${clubBrand.brandColor}` : undefined,
          }}
        >
          {clubBrand.logoUrl ? (
            <img
              src={clubBrand.logoUrl}
              alt={clubBrand.name}
              className="w-9 h-9 rounded-md object-contain bg-line-default/5 ring-1 ring-line-default/10"
            />
          ) : (
            <div
              className="w-9 h-9 rounded-md flex items-center justify-center text-white font-black text-sm"
              style={{ backgroundColor: clubBrand.brandColor || '#DC2626' }}
            >
              {(clubBrand.name || 'C').slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/55">Invited by</p>
            <p className="text-ink-primary font-bold text-sm leading-tight truncate">{clubBrand.name || 'your club'}</p>
          </div>
        </div>
      )}

      {/* Hero */}
      <div
        className="relative overflow-hidden bg-gradient-to-br from-surface-elevated via-surface-base to-vignette-deep p-6 border-b border-brand-primary/10"
        style={clubBrand?.brandColor ? { borderBottomColor: `${clubBrand.brandColor}33` } : undefined}
      >
        <div
          className="absolute -top-16 -right-16 w-56 h-56 rounded-full blur-3xl pointer-events-none"
          style={{ backgroundColor: clubBrand?.brandColor ? `${clubBrand.brandColor}33` : 'rgba(220,38,38,0.20)' }}
        />
        <div className="absolute -bottom-16 -left-10 w-56 h-56 bg-rose-500/20 rounded-full blur-3xl pointer-events-none" />
        <div className="relative">{headerInner}</div>
      </div>

      {/* Already signed in shortcut */}
      {currentUser ? (
        <div className="p-6 space-y-3">
          <p className="text-sm text-ink-primary/85">
            Signed in as <b>{currentUser.email}</b>. Tap below to link this account to {invite?.type === 'player' && player ? player.name : teamName}.
          </p>
          {error && <p className="text-rose-300 text-sm">{error}</p>}
          <button
            onClick={() => handleConsume(currentUser.uid)}
            className="w-full py-3 rounded-xl bg-brand-primary hover:bg-brand-primary text-white font-bold text-sm transition"
          >
            Yes, link this account
          </button>
          <button
            onClick={async () => { await auth.signOut(); }}
            className="w-full py-2 text-xs font-semibold text-ink-primary/60 hover:text-ink-primary"
          >
            Use a different account
          </button>
        </div>
      ) : (
        <form onSubmit={handleAuthSubmit} className="p-6 space-y-4">
          {/* One-tap Google sign-in (works for both new + existing accounts) */}
          <button
            type="button"
            onClick={handleGoogle}
            disabled={submitting}
            className="w-full py-3 rounded-xl bg-brand-primary text-white font-bold text-sm flex items-center justify-center gap-3 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Continue with Google
          </button>

          <div className="flex items-center gap-3 text-[10px] uppercase tracking-widest text-ink-primary/40">
            <div className="flex-1 h-px bg-line-default/10" />
            <span>or with email</span>
            <div className="flex-1 h-px bg-line-default/10" />
          </div>

          <div className="flex gap-2 mb-2">
            <button
              type="button"
              onClick={() => setMode('sign-up')}
              className={`flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition ${mode === 'sign-up' ? 'bg-brand-primary text-white' : 'bg-line-default/10 text-ink-primary/70'}`}
            >
              Create account
            </button>
            <button
              type="button"
              onClick={() => setMode('sign-in')}
              className={`flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition ${mode === 'sign-in' ? 'bg-brand-primary text-white' : 'bg-line-default/10 text-ink-primary/70'}`}
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
              className="w-full px-4 py-3 rounded-xl bg-line-default/5 ring-1 ring-line-default/15 text-ink-primary placeholder-ink-primary/40 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary-soft"
            />
          )}
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            className="w-full px-4 py-3 rounded-xl bg-line-default/5 ring-1 ring-line-default/15 text-ink-primary placeholder-ink-primary/40 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary-soft"
          />
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            className="w-full px-4 py-3 rounded-xl bg-line-default/5 ring-1 ring-line-default/15 text-ink-primary placeholder-ink-primary/40 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary-soft"
          />

          {error && <p className="text-rose-300 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-3 rounded-xl bg-brand-primary hover:bg-brand-primary text-white font-bold text-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Working...' : mode === 'sign-up' ? 'Create account & join' : 'Sign in & join'}
          </button>

          <p className="text-ink-primary/45 text-[11px] text-center leading-snug">
            Nothing to install. You'll be inside your team hub in this browser the moment this finishes.
          </p>
        </form>
      )}

      {/* Footer */}
      <div className="border-t border-line-default/10 px-6 py-3 text-center text-[11px] text-ink-primary/40 font-semibold tracking-wider uppercase">
        GoalKickr
      </div>
    </Page>
  );
};

export default InviteJoin;
