import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import Logo from '../components/common/Logo';
import { friendlyAuthError } from '../utils/authErrors';

const SimpleAuth: React.FC = () => {
  const { signIn, signUp, signInWithGoogle, signInWithApple, currentUser, userData, loading, error } = useAuth();
  const isNativePlatform = typeof window !== 'undefined' && (window as any).Capacitor?.isNativePlatform?.();
  const navigate = useNavigate();
  // Default to register. A cold download is almost always a new user
  // setting up their first team — making them figure out "I need to
  // switch from sign-in to sign-up" is friction. Returning users tap
  // the prominent Sign In tab below; one tap, no thinking. (TeamSnap
  // does the same split-button pattern at the splash.)
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    name: '',
    // Default to coach for direct app signups. Parents arrive via
    // invite link OR /register; cold signups are almost always coaches
    // setting up a team. The picker UI is hidden — keep the field on
    // formData so the existing signup payload shape doesn't change.
    role: 'coach' as 'coach' | 'parent',
    inviteCode: ''
  });
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Redirect if user is already logged in AND has userData
  useEffect(() => {
    if (!loading && currentUser && userData) {
      console.log('User is authenticated and userData is loaded, redirecting to dashboard');
      navigate('/dashboard', { replace: true });
    }
  }, [currentUser, userData, loading, navigate]);

  // Check for invite code in URL only once when component mounts
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const inviteCode = urlParams.get('invite');
    if (inviteCode) {
      setFormData(prev => ({ ...prev, inviteCode }));
      setMode('register');
    }
  }, []);

  const validateForm = (): boolean => {
    const newErrors: { [key: string]: string } = {};

    if (!formData.email.trim()) {
      newErrors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Please enter a valid email address';
    }

    if (!formData.password) {
      newErrors.password = 'Password is required';
    } else if (mode !== 'login' && formData.password.length < 6) {
      newErrors.password = 'Password must be at least 6 characters';
    }

    if (mode === 'register') {
      if (formData.password !== formData.confirmPassword) {
        newErrors.confirmPassword = 'Passwords do not match';
      }

      if (!formData.name.trim()) {
        newErrors.name = 'Name is required';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Prevent submission if form is invalid
    if (!validateForm()) {
      console.log('Form validation failed, not submitting');
      return;
    }

    // Don't submit if already submitting
    if (isSubmitting) {
      console.log('Already submitting, ignoring');
      return;
    }

    setIsSubmitting(true);
    setErrors({});
    
    try {
      if (mode === 'login') {
        console.log('Attempting login with:', formData.email);
        await signIn(formData.email, formData.password);
        console.log('Login successful - waiting for auth state change');
      } else {
        // Lockdown gate — EVERY signup must have either:
        //   (a) an invite code (passed via ?invite= or typed in), OR
        //   (b) an email already on some player.parentEmails list
        //       (a coach pre-added them).
        // No "anyone who picks Coach can sign up" bypass anymore —
        // that was letting random people land directly on the club's
        // active team. Brand-new coaches need a staff invite from a
        // club admin first.
        if (!formData.inviteCode) {
          const { collection, query, where, getDocs } = await import('firebase/firestore');
          const { db } = await import('../utils/firebase');
          const emailLc = formData.email.toLowerCase().trim();
          const snap = await getDocs(query(
            collection(db, 'players'),
            where('parentEmails', 'array-contains', emailLc),
          ));
          if (snap.empty) {
            setErrors({ submit:
              "You need an invite to join. Ask your coach for an invite link, or have them add your email to your player's parent list."
            });
            setIsSubmitting(false);
            return;
          }
          // Force parent role when we matched on parent-email. A coach
          // claiming "Coach" without an invite shouldn't backdoor in.
          formData.role = 'parent';
        }

        const tempTeamId = formData.inviteCode || `team_${Date.now()}`;

        await signUp(formData.email, formData.password, {
          email: formData.email,
          name: formData.name,
          role: formData.role,
          teamId: tempTeamId,
          createdAt: new Date()
        });
        console.log('Signup successful - waiting for auth state change');
      }
    } catch (error: any) {
      console.error('Auth error:', error);
      // Auto-switch to the correct mode when the error tells us we
      // were in the wrong one. friendlyAuthError handles the copy.
      if (error?.code === 'auth/user-not-found') setMode('register');
      else if (error?.code === 'auth/email-already-in-use') setMode('login');
      setErrors({ submit: friendlyAuthError(error, 'email') });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    // Check if function exists
    if (!signInWithGoogle) {
      console.error('signInWithGoogle function not available');
      setErrors({ submit: 'Google Sign-In is not available. Please try email sign-in.' });
      return;
    }

    if (isSubmitting) {
      console.log('Already submitting, ignoring Google sign-in');
      return;
    }

    setIsSubmitting(true);
    setErrors({});
    
    try {
      console.log('Attempting Google sign-in');
      await signInWithGoogle(formData.inviteCode || undefined);
      console.log('Google sign-in successful - waiting for auth state change');
    } catch (error: any) {
      console.error('Google sign-in error:', error);
      setErrors({ submit: friendlyAuthError(error, 'google') });
    } finally {
      setIsSubmitting(false);
    }
  };

  const switchMode = (newMode: typeof mode) => {
    setMode(newMode);
    setErrors({});
    setFormData(prev => ({
      ...prev,
      password: '',
      confirmPassword: ''
    }));
  };

  // No loading spinner here — show the login form immediately.
  // If the user is already authenticated, the redirect useEffect above handles it.

  return (
    <div
      className="relative min-h-screen overflow-hidden bg-gradient-to-b from-crimson-800 from-0% via-black via-[10%] to-black flex items-start justify-center px-4 pb-10 sm:pb-16"
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 4rem)' }}
    >
      {/* Top region pure black so it blends with the native
          AppDelegate safe-area strip without a visible seam.
          Patrick: "login screen top needs to blend all the way up.
          maybe the icon can come down a bit." Extra paddingTop
          (env(safe-area-inset-top) + 4rem) pushes the logo out of
          the Dynamic Island shadow zone so it doesn't sit jammed
          against the status bar. */}
      {/* Ambient gradient orbs. The crimson orb used to sit at
          -top-40 -left-32 with a 120px blur, which bled red into
          the WebView's topmost pixels. That made the pure-black
          AppDelegate native strip above it read as "grey" by
          simultaneous contrast — Patrick saw a band there. Moved
          to top-48 so the orb lives below the safe-area zone; the
          top edge of the WebView is now uniform black and blends
          seamlessly with the native strip. */}
      <div className="pointer-events-none absolute top-48 -left-32 h-96 w-96 rounded-full bg-crimson-500/20 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-40 -right-32 h-[28rem] w-[28rem] rounded-full bg-violet-600/20 blur-[140px]" />
      <div className="pointer-events-none absolute top-1/3 left-1/2 -translate-x-1/2 h-72 w-72 rounded-full bg-fuchsia-500/10 blur-[100px]" />
      {/* Subtle grid */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

      {/* Mobile-first container with better spacing */}
      <div className="relative w-full max-w-sm sm:max-w-md space-y-7 sm:space-y-9">
        {/* Logo and Header Section */}
        <div className="text-center">
          <div className="mb-5 sm:mb-6 flex justify-center">
            <div className="rounded-2xl bg-white/5 ring-1 ring-white/10 backdrop-blur-md p-3">
              <Logo size="lg" variant="full" />
            </div>
          </div>

          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 ring-1 ring-white/10 backdrop-blur-md mb-4">
            <span className="h-1.5 w-1.5 rounded-full bg-crimson-400 animate-pulse" />
            <span className="text-[11px] font-semibold tracking-[0.2em] uppercase text-crimson-400/90">
              {mode === 'login' && 'Member Access'}
              {mode === 'register' && 'Get Started'}
            </span>
          </div>

          <h2 className="text-4xl sm:text-5xl font-black tracking-tight bg-gradient-to-r from-white via-crimson-200 to-violet-300 bg-clip-text text-transparent leading-tight mb-2">
            {mode === 'login' && 'Welcome Back'}
            {mode === 'register' && 'Start Your Team'}
          </h2>
          <p className="text-sm sm:text-base text-slate-400 px-2">
            {mode === 'login' && 'Sign in to access your team hub'}
            {mode === 'register' && 'Create an account to set up your team or join one'}
          </p>
        </div>

        {/* Form Container - dark glass */}
        <div className="relative rounded-3xl bg-white/[0.04] backdrop-blur-2xl ring-1 ring-white/10 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)]">
          <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-crimson-400/60 to-transparent" />
          {/* Form padding optimized for mobile */}
          <div className="p-6 sm:p-8">

            {/* Sign Up / Sign In segmented control — the explicit
                first decision so a brand-new user doesn't have to
                figure out which mode they're in. Active pill is
                crimson; inactive is muted. One tap to switch. */}
            <div className="mb-6 grid grid-cols-2 gap-1 p-1 rounded-2xl bg-white/[0.04] ring-1 ring-white/10">
              <button
                type="button"
                onClick={() => switchMode('register')}
                className={`py-2.5 rounded-xl font-bold text-sm transition-all ${
                  mode === 'register'
                    ? 'bg-crimson-600 text-white shadow-lg shadow-crimson-900/40'
                    : 'text-white/65 hover:text-white hover:bg-white/[0.04]'
                }`}
              >
                Sign Up
              </button>
              <button
                type="button"
                onClick={() => switchMode('login')}
                className={`py-2.5 rounded-xl font-bold text-sm transition-all ${
                  mode === 'login'
                    ? 'bg-crimson-600 text-white shadow-lg shadow-crimson-900/40'
                    : 'text-white/65 hover:text-white hover:bg-white/[0.04]'
                }`}
              >
                Sign In
              </button>
            </div>

            {/* Sign in with Apple — native iOS only (Apple Store requirement when offering Google sign-in) */}
            {isNativePlatform && signInWithApple && (
              <div className="mb-3">
                <button
                  onClick={async () => {
                    // Clear any stale errors from a prior Google /
                    // email attempt BEFORE we try Apple. Without this,
                    // a previous 'Google sign-in failed' chip stays
                    // visible on screen — which is exactly the App
                    // Store rejection 2.1(a) on build 24: reviewer
                    // tapped Sign in with Apple and saw 'Google
                    // sign-in failed' from a stale state.
                    setErrors({});
                    setIsSubmitting(true);
                    try {
                      await signInWithApple(formData.inviteCode || undefined);
                    } catch (err: any) {
                      // Surface the Apple-specific error to the chip
                      // the UI actually renders (errors.submit). Don't
                      // rely on context.error — the panel below only
                      // reads errors.submit, so context errors never
                      // showed for the Apple path.
                      setErrors({ submit: friendlyAuthError(err, 'apple') });
                    } finally {
                      setIsSubmitting(false);
                    }
                  }}
                  disabled={isSubmitting}
                  className="w-full flex items-center justify-center px-4 py-3.5 rounded-xl bg-black hover:bg-charcoal-900 ring-1 ring-white/15 shadow-lg shadow-black/30 focus:outline-none focus:ring-2 focus:ring-white/40 transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:-translate-y-0.5"
                >
                  <svg className="w-5 h-5 mr-3" viewBox="0 0 24 24" fill="white">
                    <path d="M17.05 20.28c-.98.95-2.05.86-3.08.43-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.43C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
                  </svg>
                  <span className="text-white font-medium">
                    {isSubmitting ? 'Signing in...' : 'Continue with Apple'}
                  </span>
                </button>
              </div>
            )}

            {/* Google Sign-In Button - Only show if function is available */}
            {signInWithGoogle && (
              <div className="mb-6">
                <button
                  onClick={handleGoogleSignIn}
                  disabled={isSubmitting}
                  className="w-full flex items-center justify-center px-4 py-3.5 rounded-xl bg-white hover:bg-slate-50 ring-1 ring-white/40 shadow-lg shadow-black/30 focus:outline-none focus:ring-2 focus:ring-crimson-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:-translate-y-0.5"
                >
                  <svg className="w-5 h-5 mr-3" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  <span className="text-gray-700 font-medium">
                    {isSubmitting ? 'Signing in...' : 'Continue with Google'}
                  </span>
                </button>
              </div>
            )}

            {/* Debug info - remove this after testing */}
            {!signInWithGoogle && (
              <div className="mb-6 p-3 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-600">
                  🚨 Google Sign-In not available. Check AuthContext.
                </p>
                <p className="text-xs text-red-500 mt-1">
                  Available functions: {Object.keys({ signIn, signUp, logout: signIn && 'logout' }).join(', ')}
                </p>
              </div>
            )}

            {/* Show divider only if Google Sign-In is available */}
            {signInWithGoogle && (
              <>
                {/* Divider */}
                <div className="relative mb-6">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-white/10" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="px-3 bg-charcoal-950/40 backdrop-blur-sm text-slate-400 uppercase tracking-widest">Or continue with email</span>
                  </div>
                </div>
              </>
            )}

            <form className="space-y-5 sm:space-y-6" onSubmit={handleSubmit}>
              {/* Email */}
              <div>
                <label htmlFor="email" className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2">
                  Email Address
                </label>
                <input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className={`w-full px-4 py-3.5 rounded-xl bg-white/5 text-white placeholder-slate-500 ring-1 transition-all focus:outline-none focus:ring-2 text-base ${
                    errors.email ? 'ring-red-500/70 bg-red-500/5 focus:ring-red-400' : 'ring-white/10 focus:ring-crimson-400/60 focus:bg-white/[0.07]'
                  }`}
                  placeholder="you@example.com"
                  disabled={isSubmitting}
                  autoComplete="email"
                />
                {errors.email && <p className="text-red-400 text-sm mt-1.5">{errors.email}</p>}
              </div>

              {/* Password */}
              <div>
                <label htmlFor="password" className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className={`w-full px-4 py-3.5 rounded-xl bg-white/5 text-white placeholder-slate-500 ring-1 transition-all focus:outline-none focus:ring-2 text-base ${
                    errors.password ? 'ring-red-500/70 bg-red-500/5 focus:ring-red-400' : 'ring-white/10 focus:ring-crimson-400/60 focus:bg-white/[0.07]'
                  }`}
                  placeholder={mode === 'login' ? '••••••••' : 'At least 6 characters'}
                  disabled={isSubmitting}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
                {errors.password && <p className="text-red-400 text-sm mt-1.5">{errors.password}</p>}
              </div>

              {/* Confirm Password (Register/Setup only) */}
              {mode === 'register' && (
                <div>
                  <label htmlFor="confirmPassword" className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2">
                    Confirm Password
                  </label>
                  <input
                    id="confirmPassword"
                    type="password"
                    value={formData.confirmPassword}
                    onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                    className={`w-full px-4 py-3.5 rounded-xl bg-white/5 text-white placeholder-slate-500 ring-1 transition-all focus:outline-none focus:ring-2 text-base ${
                      errors.confirmPassword ? 'ring-red-500/70 bg-red-500/5 focus:ring-red-400' : 'ring-white/10 focus:ring-crimson-400/60 focus:bg-white/[0.07]'
                    }`}
                    placeholder="Repeat your password"
                    disabled={isSubmitting}
                    autoComplete="new-password"
                  />
                  {errors.confirmPassword && <p className="text-red-400 text-sm mt-1.5">{errors.confirmPassword}</p>}
                </div>
              )}

              {/* Name (Register/Setup only) */}
              {mode === 'register' && (
                <div>
                  <label htmlFor="name" className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2">
                    Your Full Name
                  </label>
                  <input
                    id="name"
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className={`w-full px-4 py-3.5 rounded-xl bg-white/5 text-white placeholder-slate-500 ring-1 transition-all focus:outline-none focus:ring-2 text-base ${
                      errors.name ? 'ring-red-500/70 bg-red-500/5 focus:ring-red-400' : 'ring-white/10 focus:ring-crimson-400/60 focus:bg-white/[0.07]'
                    }`}
                    placeholder="Enter your full name"
                    disabled={isSubmitting}
                    autoComplete="name"
                  />
                  {errors.name && <p className="text-red-400 text-sm mt-1.5">{errors.name}</p>}
                </div>
              )}

              {/* Role picker removed 2026-06-23. Was friction for
                  every new direct signup ("am I a parent or a coach?")
                  and defaulted to parent — which dumped the user into
                  the "in the pool" screen instead of the onboarding
                  wizard. Now new direct signups default to coach
                  (see formData.role default + AuthContext.signInWithGoogle
                  /signInWithApple new-user-creation paths). Parents
                  arrive via invite link (consumeInvite sets role=parent)
                  or via /register (writes role=parent + registration
                  record). The onboarding wizard's team-vs-club picker
                  handles the real "what are you setting up?" question. */}

              {/* Invite Code (Register mode only) */}
              {mode === 'register' && formData.inviteCode && (
                <div className="rounded-xl p-4 bg-emerald-400/10 ring-1 ring-emerald-400/30">
                  <div className="flex items-center space-x-2">
                    <svg className="w-5 h-5 text-emerald-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-emerald-100 font-semibold text-sm">Joining existing team</span>
                  </div>
                  <p className="text-emerald-200/80 text-sm mt-1">You'll be added to the team automatically after creating your account.</p>
                </div>
              )}

              {/* Submit Error */}
              {errors.submit && (
                <div className="rounded-xl p-4 bg-red-500/10 ring-1 ring-red-500/30">
                  <div className="flex items-start space-x-2">
                    <svg className="w-5 h-5 text-red-300 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p className="text-red-200 text-sm font-medium">{errors.submit}</p>
                  </div>
                </div>
              )}

              {/* Submit Button - Add type="submit" and better disabled logic */}
              <button
                type="submit"
                disabled={isSubmitting || !formData.email.trim() || !formData.password.trim()}
                className="relative w-full overflow-hidden rounded-xl py-4 px-4 font-semibold text-white text-base transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2 shadow-[0_10px_30px_-10px_rgba(34,211,238,0.5)] enabled:hover:-translate-y-0.5 bg-crimson-600 hover:bg-crimson-500"
              >
                {isSubmitting ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                    <span>
                      {mode === 'login' ? 'Signing in...' : 'Creating account...'}
                    </span>
                  </>
                ) : (
                  <>
                    {mode === 'login' && (
                      <>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                        </svg>
                        <span>Sign In</span>
                      </>
                    )}
                    {mode === 'register' && (
                      <>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                        </svg>
                        <span>Create Account</span>
                      </>
                    )}
                  </>
                )}
              </button>

              {/* Mode Switching - Mobile optimized */}
              <div className="text-center space-y-3 pt-2">
                {mode === 'login' && (
                  <p className="text-sm text-slate-400">
                    Have an invite?{' '}
                    <button
                      type="button"
                      onClick={() => switchMode('register')}
                      className="font-semibold text-crimson-400 hover:text-bone transition-colors duration-200"
                      disabled={isSubmitting}
                    >
                      Join your team
                    </button>
                  </p>
                )}
                
                {mode === 'register' && (
                  <p className="text-sm text-slate-400">
                    Already have an account?{' '}
                    <button 
                      type="button"
                      onClick={() => switchMode('login')}
                      className="font-semibold text-crimson-400 hover:text-bone transition-colors duration-200"
                      disabled={isSubmitting}
                    >
                      Sign in
                    </button>
                  </p>
                )}
              </div>
            </form>

            <p className="mt-6 text-center text-xs text-slate-500">
              By signing in you agree to our{' '}
              <a href="/privacy" className="underline hover:text-slate-300">Privacy Policy</a>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SimpleAuth;