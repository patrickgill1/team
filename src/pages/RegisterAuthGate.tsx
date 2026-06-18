import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import Logo from '../components/common/Logo';

// Pre-registration auth gate. Shown above the /register form when the
// parent isn't signed in. Three choices: Google, Apple, or email +
// password (sign in OR create). Existing Fire FC accounts (returning
// families) just sign in; new families create on the fly. Once authed,
// /register replaces this gate with the actual form.

interface Props {
  onAuthed: () => void;
}

const RegisterAuthGate: React.FC<Props> = ({ onAuthed }) => {
  const { signInWithGoogle, signInWithApple, signIn, signUp } = useAuth() as any;
  const [mode, setMode] = useState<'choose' | 'email-signin' | 'email-signup'>('choose');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGoogle = async () => {
    setBusy(true); setError(null);
    try {
      await signInWithGoogle();
      onAuthed();
    } catch (err: any) {
      setError(err?.message || 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleApple = async () => {
    setBusy(true); setError(null);
    try {
      await signInWithApple();
      onAuthed();
    } catch (err: any) {
      setError(err?.message || 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleEmail = async () => {
    if (!email.trim() || !password) return;
    setBusy(true); setError(null);
    try {
      if (mode === 'email-signup') {
        // signUp requires a full UserData shape minus uid. Self-signup
        // from /register defaults to parent role with no team — the
        // registration submit fills in the rest (and AuthContext's
        // email-matcher will auto-link them to a kid if one already
        // exists with their email).
        await signUp(email.trim(), password, {
          email: email.trim(),
          name: name.trim() || email.split('@')[0],
          role: 'parent',
          teamId: '',
          createdAt: new Date(),
        });
      } else {
        await signIn(email.trim(), password);
      }
      onAuthed();
    } catch (err: any) {
      setError(err?.message || 'Sign in failed — check your email + password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-black px-4 py-10 sm:py-16">
      <div className="max-w-md mx-auto">
        <div className="text-center mb-8">
          <div className="inline-flex p-3 rounded-2xl bg-white/5 ring-1 ring-white/10 backdrop-blur mb-4">
            <Logo size="lg" variant="full" />
          </div>
          <h1 className="text-4xl sm:text-5xl font-black text-white leading-tight">
            You're a few clicks from the<br />
            <span className="text-crimson-400">GoalKickr family.</span>
          </h1>
          <p className="text-slate-300 mt-3 text-sm leading-relaxed">
            Sign in or create your account to start your registration. One login covers every kid in your family — past, present, and future seasons.
          </p>
        </div>

        <div className="bg-white/[0.04] backdrop-blur-2xl ring-1 ring-white/10 rounded-3xl p-6 sm:p-8 space-y-4">
          {mode === 'choose' && (
            <>
              <button
                type="button"
                onClick={handleGoogle}
                disabled={busy}
                className="w-full py-3 rounded-xl font-bold text-sm bg-white text-slate-900 hover:bg-slate-100 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Continue with Google
              </button>
              <button
                type="button"
                onClick={handleApple}
                disabled={busy}
                className="w-full py-3 rounded-xl font-bold text-sm bg-black text-white ring-1 ring-white/20 hover:bg-charcoal-900 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01M12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25"/>
                </svg>
                Continue with Apple
              </button>
              <div className="flex items-center gap-3 my-2">
                <div className="flex-1 h-px bg-white/10" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">or</span>
                <div className="flex-1 h-px bg-white/10" />
              </div>
              <button
                type="button"
                onClick={() => setMode('email-signup')}
                className="w-full py-3 rounded-xl font-bold text-sm bg-crimson-600 hover:bg-crimson-500 text-white"
              >
                Create account with email
              </button>
              <button
                type="button"
                onClick={() => setMode('email-signin')}
                className="w-full py-2 text-xs font-bold text-crimson-400 hover:text-bone"
              >
                Already have an account? Sign in
              </button>
            </>
          )}

          {(mode === 'email-signin' || mode === 'email-signup') && (
            <>
              {mode === 'email-signup' && (
                <label className="block">
                  <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Your name</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Jane Carter"
                    className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white placeholder-slate-500 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-crimson-400/60 text-sm"
                    style={{ fontSize: '16px' }}
                  />
                </label>
              )}
              <label className="block">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="jane@example.com"
                  className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white placeholder-slate-500 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-crimson-400/60 text-sm"
                  style={{ fontSize: '16px' }}
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'email-signup' ? 'At least 6 characters' : 'Your password'}
                  className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white placeholder-slate-500 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-crimson-400/60 text-sm"
                  style={{ fontSize: '16px' }}
                />
              </label>
              <button
                type="button"
                onClick={handleEmail}
                disabled={busy || !email || !password}
                className="w-full py-3 rounded-xl font-bold text-sm text-white bg-crimson-600 hover:bg-crimson-500 disabled:opacity-50"
              >
                {busy ? 'Working…' : mode === 'email-signup' ? 'Create account' : 'Sign in'}
              </button>
              <button
                type="button"
                onClick={() => setMode('choose')}
                className="w-full py-2 text-xs font-bold text-slate-400 hover:text-slate-200"
              >
                ← Other sign-in options
              </button>
            </>
          )}

          {error && (
            <div className="rounded-lg bg-rose-500/10 ring-1 ring-rose-500/40 px-3 py-2 text-sm text-rose-200">{error}</div>
          )}

          <p className="text-[10px] text-slate-500 text-center pt-2">
            By signing in you agree to our Privacy Policy. We use your account so you can manage your kids, RSVP events, chat with coaches, and get updates.
          </p>
        </div>
      </div>
    </div>
  );
};

export default RegisterAuthGate;
