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
  // Heja-style landing lives ABOVE the auth form. First-time visitors
  // see the brand + hero photo + three CTAs + scrollable teaser, and
  // only reveal the form when they tap 'Set up a team' or 'Log in'.
  // Returning visitors with an invite code in the URL skip the
  // landing entirely — they know what they're doing.
  const [showLanding, setShowLanding] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const q = new URLSearchParams(window.location.search);
    if (q.get('invite')) return false;
    if (q.get('mode') === 'signin' || q.get('mode') === 'login') return false;
    return true;
  });
  // Distinct 'join with code' flow — when the visitor taps 'Join a
  // team with a code' on the landing, we surface an invite-code
  // input at the top of the register form so they can paste/type
  // one without hunting for it. The signup submission then applies
  // the code same as the ?invite= URL path.
  const [joinFlow, setJoinFlow] = useState(false);

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
        // Precheck the email against player.parentEmails to decide
        // the post-signup flow:
        //   hasPlayer = true  → force role=parent, pre-approve, auto-
        //                       link will fire after createUser, user
        //                       lands inside their kid's team directly.
        //   hasPlayer = false → role stays whatever the form has
        //                       (default 'coach'), user lands on
        //                       OnboardingGate to pick Enter invite /
        //                       Start a team / Start a club.
        // Patrick 2026-06-26: the previous version BLOCKED signup
        // here when hasPlayer=false, which made the OnboardingGate
        // 'Start a team / club' path unreachable. The right model is
        // 'never block signup; let them choose what to do from the
        // OnboardingGate' — the gate itself prevents random people
        // from landing in an existing tenant without consent.
        let hasPlayer = false;
        if (!formData.inviteCode) {
          try {
            const resp = await fetch('https://api.goalkickr.com/precheck/parent-email', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ email: formData.email.toLowerCase().trim() }),
            });
            const j = await resp.json().catch(() => ({}));
            hasPlayer = !!j?.hasPlayer;
          } catch (e) {
            console.warn('precheck failed, treating as no match', e);
            hasPlayer = false;
          }
          if (hasPlayer) {
            // Email matched a player → they're a parent. Force the
            // role so a 'pick Coach' attempt on the form can't
            // backdoor them into elevated permissions.
            formData.role = 'parent';
          }
          // hasPlayer=false: don't force role. They'll see the
          // OnboardingGate after auth + pick Create Team / Create
          // Club / Enter Invite. role stays whatever the form has.
        }

        const tempTeamId = formData.inviteCode || `team_${Date.now()}`;
        // Pre-approve only when the precheck confirmed auto-link
        // will fire (hasPlayer=true). Without this hint, the
        // OnboardingGate would flash for ~200ms during the
        // createUser → auto-link window. New coaches who'll see
        // the gate intentionally DON'T get pre-approved.
        const willAutoLink = !formData.inviteCode && hasPlayer;

        await signUp(formData.email, formData.password, {
          email: formData.email,
          name: formData.name,
          role: formData.role,
          teamId: tempTeamId,
          createdAt: new Date(),
          // Pre-approval hint: the precheck found a matching player,
          // so the auto-link inside signUp() will succeed. Tell
          // signUp() to write approved=true on the initial create
          // so the OnboardingGate doesn't flash 'approved=false' in
          // the ~200ms window before auto-link's user-doc patch.
          ...(willAutoLink ? { preApproveOnAutoLink: true } : {}),
        } as any);
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

  if (showLanding) {
    return (
      <div className="min-h-screen bg-charcoal-950 text-white">
        {/* Hero fold — first thing an unauth'd visitor sees. Big
            celebration photo, brand, tagline, three CTAs. Scroll down
            for the teaser cards. */}
        <section
          className="relative overflow-hidden"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <div className="relative min-h-[100svh] flex flex-col">
            <img
              src="/hero/celebration.jpg"
              alt="Kids celebrating a goal at sunset"
              className="absolute inset-0 w-full h-full object-cover"
              loading="eager"
            />
            {/* Scrim so brand + copy read against the sky */}
            <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/20 to-black/80 pointer-events-none" aria-hidden />

            <div className="relative flex-1 flex flex-col justify-between px-6 py-8">
              {/* Brand */}
              <div className="flex justify-center pt-4">
                <div className="rounded-2xl bg-black/25 backdrop-blur-md px-4 py-2 ring-1 ring-white/10">
                  <Logo size="lg" variant="full" />
                </div>
              </div>

              {/* Tagline centered in the middle third */}
              <div className="text-center max-w-md mx-auto">
                <p className="text-[11px] font-black tracking-[0.3em] uppercase text-brand-primary-soft/95 drop-shadow mb-3">The season lives here</p>
                <h1 className="text-3xl sm:text-4xl font-black leading-tight drop-shadow-lg">
                  Every kid's season, every coach's crew, every parent's front-row seat.
                </h1>
              </div>

              {/* CTAs */}
              <div className="max-w-md mx-auto w-full space-y-3">
                <button
                  type="button"
                  onClick={() => { setMode('register'); setJoinFlow(false); setShowLanding(false); }}
                  className="w-full py-3.5 rounded-full bg-brand-primary hover:bg-brand-primary/90 text-white font-black tracking-wider uppercase text-sm shadow-lg active:scale-95 transition"
                >
                  Set up a new team
                </button>
                <button
                  type="button"
                  onClick={() => { setMode('register'); setJoinFlow(true); setShowLanding(false); }}
                  className="w-full py-3.5 rounded-full bg-white text-charcoal-950 font-black tracking-wider uppercase text-sm shadow-lg active:scale-95 transition"
                >
                  Join a team with a code
                </button>
                <button
                  type="button"
                  onClick={() => { setMode('login'); setShowLanding(false); }}
                  className="w-full py-3 rounded-full bg-white/10 hover:bg-white/15 backdrop-blur-md ring-1 ring-white/20 text-white/90 font-bold tracking-wider uppercase text-xs transition"
                >
                  Log in
                </button>
                <p className="text-center text-[10px] tracking-widest uppercase text-white/60 pt-1">
                  Scroll to see what your season looks like ↓
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Teaser pages — each fills the viewport so the visitor sees
            one story at a time, cinematic-style. Photos take the full
            frame; copy sits at the bottom over a scrim. Feels like
            chapters, not a scroll of cards. */}
        <TeaserSlide
          src="/hero/coach-huddle.jpg"
          alt="Coach kneeling with team at sunset"
          kicker="For coaches"
          title="You're the person these kids remember."
          body="Live gameday tracker, POTM crowns, one-tap tagging, a drill library, and a wall that turns each game into a story your team scrolls Monday morning."
        />
        <TeaserSlide
          src="/hero/friends.jpg"
          alt="Teammates laughing on the field at sunset"
          kicker="For parents"
          title="Your kid's season, from anywhere."
          body="Tagged clips push to your phone. RSVP once. See the game recap the moment the whistle blows. When you can't be there, you're still there."
        />
        <TeaserSlide
          src="/hero/training.jpg"
          alt="Kids working through a dribbling drill"
          kicker="For growth"
          title="Every day the kid gets a little better."
          body="Practice streaks (with a rest day if your family keeps one), development plans, a drill library that plays inline. Not just a schedule. A path."
        />

        {/* Bottom CTA repeats so scrollers don't hunt for it. Same
            three buttons as the top so 'Join with code' is discover-
            able from either end of the page. */}
        <section className="bg-charcoal-950 px-6 py-16 border-t border-white/5">
          <div className="max-w-md mx-auto text-center space-y-6">
            <p className="text-[10px] font-black tracking-[0.3em] uppercase text-brand-primary-soft">Ready?</p>
            <h2 className="text-3xl font-black tracking-tight">Start your team in a minute.</h2>
            <p className="text-white/60 text-sm">7-day free trial for coaches. No card up front.</p>
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => { setMode('register'); setShowLanding(false); }}
                className="w-full py-3.5 rounded-full bg-brand-primary hover:bg-brand-primary/90 text-white font-black tracking-wider uppercase text-sm shadow-lg active:scale-95 transition"
              >
                Set up a new team
              </button>
              <button
                type="button"
                onClick={() => { setMode('register'); setShowLanding(false); }}
                className="w-full py-3.5 rounded-full bg-white text-charcoal-950 font-black tracking-wider uppercase text-sm shadow-lg active:scale-95 transition"
              >
                Join a team with a code
              </button>
              <button
                type="button"
                onClick={() => { setMode('login'); setShowLanding(false); }}
                className="w-full py-3 rounded-full ring-1 ring-white/20 text-white/85 font-bold tracking-wider uppercase text-xs hover:bg-white/5 transition"
              >
                I already have an account
              </button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div
      className="relative min-h-screen overflow-hidden bg-gradient-to-b from-brand-primary-dim from-0% via-black via-[10%] to-black flex items-start justify-center px-4 pb-10 sm:pb-16"
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
      <div className="pointer-events-none absolute top-48 -left-32 h-96 w-96 rounded-full bg-brand-primary/20 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-40 -right-32 h-[28rem] w-[28rem] rounded-full bg-violet-600/20 blur-[140px]" />
      <div className="pointer-events-none absolute top-1/3 left-1/2 -translate-x-1/2 h-72 w-72 rounded-full bg-fuchsia-500/10 blur-[100px]" />
      {/* Subtle grid */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

      {/* Mobile-first container with better spacing */}
      <div className="relative w-full max-w-sm sm:max-w-md space-y-7 sm:space-y-9">
        {/* Logo and Header Section */}
        <div className="text-center">
          <div className="mb-5 sm:mb-6 flex justify-center">
            <div className="rounded-2xl bg-line-default/5 ring-1 ring-line-default/10 backdrop-blur-md p-3">
              <Logo size="lg" variant="full" />
            </div>
          </div>

          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-line-default/5 ring-1 ring-line-default/10 backdrop-blur-md mb-4">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-primary-soft animate-pulse" />
            <span className="text-[11px] font-semibold tracking-[0.2em] uppercase text-brand-primary-soft/90">
              {mode === 'login' && 'Member Access'}
              {mode === 'register' && 'Get Started'}
            </span>
          </div>

          <h2 className="text-4xl sm:text-5xl font-black tracking-tight bg-gradient-to-r from-white via-brand-primary-soft to-violet-300 bg-clip-text text-transparent leading-tight mb-2">
            {mode === 'login' && 'Welcome Back'}
            {mode === 'register' && 'Start Your Team'}
          </h2>
          <p className="text-sm sm:text-base text-slate-400 px-2">
            {mode === 'login' && 'Sign in to access your team hub'}
            {mode === 'register' && 'Create an account to set up your team or join one'}
          </p>
        </div>

        {/* Form Container - dark glass */}
        <div className="relative rounded-3xl bg-line-default/[0.04] backdrop-blur-2xl ring-1 ring-line-default/10 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)]">
          <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-brand-primary-soft/60 to-transparent" />
          {/* Form padding optimized for mobile */}
          <div className="p-6 sm:p-8">

            {/* Sign Up / Sign In segmented control — the explicit
                first decision so a brand-new user doesn't have to
                figure out which mode they're in. Active pill is
                crimson; inactive is muted. One tap to switch. */}
            <div className="mb-6 grid grid-cols-2 gap-1 p-1 rounded-2xl bg-line-default/[0.04] ring-1 ring-line-default/10">
              <button
                type="button"
                onClick={() => switchMode('register')}
                className={`py-2.5 rounded-xl font-bold text-sm transition-all ${
                  mode === 'register'
                    ? 'bg-brand-primary text-white shadow-lg shadow-brand-primary-dim/40'
                    : 'text-white/65 hover:text-white hover:bg-line-default/[0.04]'
                }`}
              >
                Sign Up
              </button>
              <button
                type="button"
                onClick={() => switchMode('login')}
                className={`py-2.5 rounded-xl font-bold text-sm transition-all ${
                  mode === 'login'
                    ? 'bg-brand-primary text-white shadow-lg shadow-brand-primary-dim/40'
                    : 'text-white/65 hover:text-white hover:bg-line-default/[0.04]'
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
                  className="w-full flex items-center justify-center px-4 py-3.5 rounded-xl bg-black hover:bg-surface-elevated ring-1 ring-line-default/15 shadow-lg shadow-black/30 focus:outline-none focus:ring-2 focus:ring-line-default/40 transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:-translate-y-0.5"
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
                  className="w-full flex items-center justify-center px-4 py-3.5 rounded-xl bg-white hover:bg-slate-50 ring-1 ring-line-default/40 shadow-lg shadow-black/30 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:-translate-y-0.5"
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
                    <div className="w-full border-t border-line-default/10" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="px-3 bg-surface-base/40 backdrop-blur-sm text-slate-400 uppercase tracking-widest">Or continue with email</span>
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
                  className={`w-full px-4 py-3.5 rounded-xl bg-line-default/5 text-white placeholder-slate-500 ring-1 transition-all focus:outline-none focus:ring-2 text-base ${
                    errors.email ? 'ring-red-500/70 bg-red-500/5 focus:ring-red-400' : 'ring-line-default/10 focus:ring-brand-primary-soft/60 focus:bg-line-default/[0.07]'
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
                  className={`w-full px-4 py-3.5 rounded-xl bg-line-default/5 text-white placeholder-slate-500 ring-1 transition-all focus:outline-none focus:ring-2 text-base ${
                    errors.password ? 'ring-red-500/70 bg-red-500/5 focus:ring-red-400' : 'ring-line-default/10 focus:ring-brand-primary-soft/60 focus:bg-line-default/[0.07]'
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
                    className={`w-full px-4 py-3.5 rounded-xl bg-line-default/5 text-white placeholder-slate-500 ring-1 transition-all focus:outline-none focus:ring-2 text-base ${
                      errors.confirmPassword ? 'ring-red-500/70 bg-red-500/5 focus:ring-red-400' : 'ring-line-default/10 focus:ring-brand-primary-soft/60 focus:bg-line-default/[0.07]'
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
                    className={`w-full px-4 py-3.5 rounded-xl bg-line-default/5 text-white placeholder-slate-500 ring-1 transition-all focus:outline-none focus:ring-2 text-base ${
                      errors.name ? 'ring-red-500/70 bg-red-500/5 focus:ring-red-400' : 'ring-line-default/10 focus:ring-brand-primary-soft/60 focus:bg-line-default/[0.07]'
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

              {/* Invite Code entry — visible + editable when the
                  visitor arrived here via the 'Join a team with a
                  code' landing CTA. Same field also shows as an
                  emerald confirmation banner when a code is already
                  filled (URL-driven ?invite=... path). */}
              {mode === 'register' && joinFlow && !formData.inviteCode && (
                <div className="rounded-xl p-4 bg-brand-primary/10 ring-1 ring-brand-primary/30">
                  <label className="block text-sm font-bold text-white mb-2">Team code from your coach</label>
                  <input
                    type="text"
                    value={formData.inviteCode}
                    onChange={(e) => setFormData(prev => ({ ...prev, inviteCode: e.target.value.trim().toUpperCase() }))}
                    placeholder="e.g. UF-841422"
                    autoFocus
                    className="w-full px-3 py-2.5 rounded-lg bg-black/40 ring-1 ring-white/15 text-white font-mono tracking-wider placeholder-white/30 focus:ring-brand-primary-soft/60 focus:outline-none"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <p className="mt-2 text-[11px] text-white/55">
                    Paste the code your coach shared. You'll join their team the moment you finish signing up.
                  </p>
                </div>
              )}
              {mode === 'register' && formData.inviteCode && (
                <div className="rounded-xl p-4 bg-emerald-400/10 ring-1 ring-emerald-400/30">
                  <div className="flex items-center space-x-2">
                    <svg className="w-5 h-5 text-emerald-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-emerald-100 font-semibold text-sm">Joining existing team</span>
                    <span className="ml-auto font-mono text-[11px] text-emerald-100/70">{formData.inviteCode}</span>
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
                className="relative w-full overflow-hidden rounded-xl py-4 px-4 font-semibold text-white text-base transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2 shadow-[0_10px_30px_-10px_rgba(34,211,238,0.5)] enabled:hover:-translate-y-0.5 bg-brand-primary hover:bg-brand-primary"
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
                      className="font-semibold text-brand-primary-soft hover:text-ink-primary transition-colors duration-200"
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
                      className="font-semibold text-brand-primary-soft hover:text-ink-primary transition-colors duration-200"
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

// Teaser slide — full viewport per section, cinematic. Photo fills
// the entire slide; copy sits ~60% down the frame over a soft scrim.
// Each slide reads as its own PAGE, not a card on a scroll. Apple
// product-page rhythm, not a Facebook feed.
const TeaserSlide: React.FC<{
  src: string;
  alt: string;
  kicker: string;
  title: string;
  body: string;
  reversed?: boolean;
}> = ({ src, alt, kicker, title, body }) => (
  <section className="relative overflow-hidden bg-charcoal-950">
    <div
      className="relative flex flex-col justify-end"
      style={{ minHeight: '85svh' }}
    >
      <img
        src={src}
        alt={alt}
        className="absolute inset-0 w-full h-full object-cover"
        loading="lazy"
      />
      {/* Cinematic scrim — light in the top third, heavy at the
          bottom half so copy has serious contrast without darkening
          the emotional beat of the photo. */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/25 to-black/85 pointer-events-none" aria-hidden />
      <div className="relative px-6 pb-16 sm:pb-20 pt-16 max-w-2xl mx-auto text-white">
        <p className="text-[10px] font-black tracking-[0.35em] uppercase text-brand-primary-soft drop-shadow-lg mb-3">{kicker}</p>
        <h2 className="text-[28px] sm:text-4xl font-black leading-[1.1] tracking-tight drop-shadow-lg mb-4 max-w-xl">
          {title}
        </h2>
        <p className="text-[15px] sm:text-base text-white/85 leading-relaxed drop-shadow max-w-md">
          {body}
        </p>
      </div>
    </div>
  </section>
);

export default SimpleAuth;