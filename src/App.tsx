import React, { Suspense, useEffect, useState } from 'react';
// Firestore imports removed 3.9.161 — the parentIds query in
// AppLayout was replaced with a synchronous derive from
// userData.onboardingStage (worker stamps it now). See spine refactor
// Phase C.
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { db } from './utils/firebase';
import { AuthProvider } from './contexts/AuthContext';
import { TeamProvider } from './contexts/TeamContext';
import { ViewModeProvider } from './contexts/ViewModeContext';
import { ThemeProvider, useTheme, isThemePickerVisible } from './contexts/ThemeContext';
import { bootstrapWidgetToken } from './utils/widgetBridge';
import { updateDoc } from 'firebase/firestore';
import { useAuth } from './hooks/useAuth';
import ProtectedRoute from './components/common/ProtectedRoute';
import SilentErrorBoundary from './components/common/SilentErrorBoundary';
import OnboardingGate from './components/gates/OnboardingGate';
// Onboarding wizard — post-signup guided setup (team, kid, schedule,
// invites, notifications, trial). Un-retired 2026-07-08 when Patrick
// asked for the step-by-step flow he'd originally spec'd.
import Onboarding from './pages/Onboarding';
import { getRandomWelcomeBackItem, KIND_LABEL } from './utils/welcomeBackContent';
import Navigation from './components/common/Navigation';
import { SidebarProvider, useSidebar } from './contexts/SidebarContext';
import InstallAppBanner from './components/common/InstallAppBanner';
import LiveGameBanner from './components/gameday/LiveGameBanner';
import ApplyClubBrand from './components/common/ApplyClubBrand';
// Static import so the splash dismissal can't be blocked by a
// failed dynamic-chunk fetch on cold start.
import { hideSplash, notifyCapgoReady } from './utils/nativeShell';

// Eagerly load auth pages (needed immediately)
import SimpleAuth from './pages/SimpleAuth';
import PublicVote from './pages/PublicVote';
import PublicSurvey from './pages/PublicSurvey';
import PublicGame from './pages/PublicGame';
import PublicWallPost from './pages/PublicWallPost';
import PlayerJoin from './pages/PlayerJoin';
import PrivacyPolicy from './pages/PrivacyPolicy';

// Lazy load all other pages
const InviteJoin = React.lazy(() => import('./pages/InviteJoin'));
const Dashboard = React.lazy(() => import('./pages/Dashboard'));
const Players = React.lazy(() => import('./pages/Players'));
const Stats = React.lazy(() => import('./pages/Stats'));
const Calendar = React.lazy(() => import('./pages/CalendarPage'));
const ParentDirectory = React.lazy(() => import('./pages/ParentDirectory'));
const VolunteerScheduler = React.lazy(() => import('./pages/VolunteerScheduler'));
const AttendanceTracker = React.lazy(() => import('./pages/AttendanceTracker'));
const PlayerOfMatch = React.lazy(() => import('./pages/PlayerOfMatch'));
const TeamChat = React.lazy(() => import('./pages/TeamChat'));
const Wall = React.lazy(() => import('./pages/Wall'));
const TeamStore = React.lazy(() => import('./pages/TeamStore'));
const Equipment = React.lazy(() => import('./pages/Equipment'));
const Drills = React.lazy(() => import('./pages/Drills'));
const Register = React.lazy(() => import('./pages/Register'));
const RegisterSuccess = React.lazy(() => import('./pages/RegisterStripeReturn').then(m => ({ default: m.RegisterSuccess })));
const RegisterCancel = React.lazy(() => import('./pages/RegisterStripeReturn').then(m => ({ default: m.RegisterCancel })));
const Registrations = React.lazy(() => import('./pages/Registrations'));
const AdminTeams = React.lazy(() => import('./pages/AdminTeams'));
const SeasonWizard = React.lazy(() => import('./pages/SeasonWizard'));
const CoachCockpit = React.lazy(() => import('./pages/CoachCockpit'));
const StaffManagement = React.lazy(() => import('./pages/StaffManagement'));
// FamilyHome retired 2026-07-08 — see comment on removed /home-v2 route.
const Products = React.lazy(() => import('./pages/Products'));
const RegistrationFormBuilder = React.lazy(() => import('./pages/RegistrationFormBuilder'));
const Tryouts = React.lazy(() => import('./pages/Tryouts'));
const Offer = React.lazy(() => import('./pages/Offer'));
const FamilyTimeline = React.lazy(() => import('./pages/FamilyTimeline'));
const FamilyForms = React.lazy(() => import('./pages/FamilyForms'));
const OfferTemplates = React.lazy(() => import('./pages/OfferTemplates'));
const Seasons = React.lazy(() => import('./pages/Seasons'));
const Reports = React.lazy(() => import('./pages/Reports'));
const PersonAdmin = React.lazy(() => import('./pages/PersonAdmin'));
const Forms = React.lazy(() => import('./pages/Forms'));
const Tasks = React.lazy(() => import('./pages/Tasks'));
const PlatformClubs = React.lazy(() => import('./pages/PlatformClubs'));
const CoachJoin = React.lazy(() => import('./pages/CoachJoin'));
const TeamManagement = React.lazy(() => import('./pages/TeamManagement'));
const AddRoster = React.lazy(() => import('./pages/AddRoster'));
const ClubOverview = React.lazy(() => import('./pages/ClubOverview'));
const ClubBranding = React.lazy(() => import('./pages/ClubBranding'));
const PlayerDevelopment = React.lazy(() => import('./pages/PlayerDevelopment'));
const PlayerMediaPage = React.lazy(() => import('./pages/PlayerMediaPage'));
const Highlights = React.lazy(() => import('./pages/Highlights'));
const MentionsInbox = React.lazy(() => import('./pages/MentionsInbox'));
const SharedMedia = React.lazy(() => import('./pages/SharedMedia'));
const PlayerProfile = React.lazy(() => import('./pages/PlayerProfile'));
const Surveys = React.lazy(() => import('./pages/Surveys'));
const FullGames = React.lazy(() => import('./pages/FullGames'));
const VideoUpgradePage = React.lazy(() => import('./pages/VideoUpgradePage'));
const GameDay = React.lazy(() => import('./pages/GameDay'));
const QuickGameLauncher = React.lazy(() => import('./pages/QuickGameLauncher'));
const PracticePlanBuilder = React.lazy(() => import('./pages/PracticePlanBuilder'));
const Settings = React.lazy(() => import('./pages/Settings'));
const Tickets = React.lazy(() => import('./pages/Tickets'));
const TicketDetail = React.lazy(() => import('./pages/TicketDetail'));
const ClubAdmins = React.lazy(() => import('./pages/ClubAdmins'));
const AuthAction = React.lazy(() => import('./pages/AuthAction'));
const AuthImpersonate = React.lazy(() => import('./pages/AuthImpersonate'));
const PublicPlayerCard = React.lazy(() => import('./pages/PublicPlayerCard'));
const PublicFixtures = React.lazy(() => import('./pages/PublicFixtures'));
const PublicLeague = React.lazy(() => import('./pages/PublicLeague'));
const LeagueConsole = React.lazy(() => import('./pages/LeagueConsole'));
// Showcase pages — public, unauth'd, screenshot-ready renders of
// production components with hand-curated demo data. Used to grab
// marketing screenshots without needing a real season played.
const PotmShowcase = React.lazy(() => import('./pages/showcase/PotmShowcase'));
const RecapShowcase = React.lazy(() => import('./pages/showcase/RecapShowcase'));
const WallShowcase = React.lazy(() => import('./pages/showcase/WallShowcase'));
const EventDetail = React.lazy(() => import('./pages/EventDetail'));
const People = React.lazy(() => import('./pages/People'));
const Helpdesk = React.lazy(() => import('./pages/Helpdesk'));
const HelpdeskTicketPage = React.lazy(() => import('./pages/HelpdeskTicket'));

const prefetchCoreRoutes = (() => {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    [
      () => import('./pages/Dashboard'),
      () => import('./pages/CalendarPage'),
      () => import('./pages/PlayerMediaPage'),
      () => import('./pages/TeamChat'),
      () => import('./pages/Wall'),
      () => import('./pages/Stats'),
      () => import('./pages/PlayerProfile'),
      () => import('./pages/CoachCockpit'),
      () => import('./pages/GameDay'),
      () => import('./pages/Settings'),
    ].forEach((load) => { load().catch(() => {}); });
  };
})();

const UPDATE_STORY_MIN_MS = 6500;

// Branded loading screen — picks up where the native splash leaves off
// (same dark navy bg) and shows the app mark with a subtle bouncing
// three-dot indicator below so the user knows something's happening.
const PageSpinner = () => (
  <div className="min-h-screen bg-gradient-to-br from-surface-base via-surface-elevated to-vignette-deep flex items-center justify-center">
    <div className="flex flex-col items-center gap-6 animate-fade-in">
      <img
        src="/images/logo.png"
        alt=""
        className="w-24 h-24 rounded-2xl shadow-2xl shadow-brand-primary/20 ring-1 ring-line-default/10 splash-breathe"
      />
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-brand-primary-soft splash-dot" style={{ animationDelay: '0ms' }} />
        <span className="w-2 h-2 rounded-full bg-brand-primary-soft splash-dot" style={{ animationDelay: '180ms' }} />
        <span className="w-2 h-2 rounded-full bg-brand-primary-soft splash-dot" style={{ animationDelay: '360ms' }} />
      </div>
    </div>
  </div>
);

// Layout component for authenticated pages.
//
// Phase C of the spine refactor (3.9.161) replaced the old 75-line
// useEffect that ran a `players where parentIds array-contains uid`
// query on every AppLayout mount with a synchronous derive from
// userData.onboardingStage. The worker now stamps the field on
// every membership mutation (Phase A) so this reader is pure
// derived value — no round-trip, no timeout, no fail-open branch,
// no re-run storm on teamIds changes.
//
// Bugs killed:
//   1. 200-800ms gate flash on every load
//   2. 3s timeout that flashed fresh parents from OnboardingGate → empty dashboard
//   3. Silent 'none' fallback on Firestore errors that stranded parents
//   4. Re-runs on every userData.teamIds.length change (5-10x per session)
//   5. OnboardingGate.tsx's window.location.reload() workaround (no
//      longer needed — stage re-derives synchronously on refreshUserData)
//
// Fallback for legacy users (onboardingStage undefined): recompute
// the SAME logic client-side minus the parentIds query. Fresh parents
// briefly show as active; heal-on-signin lands the stamp within one
// cycle. See onboarding-stage design §3.
const AppLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { userData, logout } = useAuth();

  // Synchronous derive. See onboarding-stage design §3 for the exact
  // fallback rules (required change #4 from user-impact review baked
  // in: fresh parents fall closed to needs_player unless children[]
  // is populated).
  type Stage = 'active' | 'needs_team' | 'needs_player' | 'pending_parent';
  const stage: Stage = (() => {
    if (!userData) return 'active'; // auth still resolving — render spinner via ProtectedRoute upstream
    const stamped = (userData as any)?.onboardingStage;
    if (stamped === 'active' || stamped === 'needs_team' || stamped === 'needs_player' || stamped === 'pending_parent') {
      // Sanity short-circuit: if stamp says needs_team but the user
      // demonstrably has a team, prefer the derived truth. Convergent
      // under stamp drift (per design §6).
      const hasTeam = ((userData.teamIds?.length ?? 0) > 0) || !!(userData as any).teamId;
      if (stamped === 'needs_team' && hasTeam) return 'active';
      return stamped;
    }
    // Legacy user, no stamp. Client fallback covers the four branches
    // using data already streamed by AuthContext.
    const role = String(userData.role || '');
    const hasTeam = ((userData.teamIds?.length ?? 0) > 0) || !!(userData as any).teamId;
    const isClubAdmin = (userData as any).isClubAdmin === true || role === 'club_admin';
    if (isClubAdmin) return 'active';
    if (role === 'coach' || role === 'team_manager') return hasTeam ? 'active' : 'needs_team';
    if (role === 'parent') {
      if ((userData as any).approved === false) return 'pending_parent';
      // No parentIds query anymore — fresh parents fall closed to
      // needs_player unless they have a children[] denorm on their
      // user doc (which /claim/player-link + auto-link stamp). Prevents
      // the "empty dashboard for 200ms" regression while migration
      // finishes.
      const children: string[] = Array.isArray((userData as any).children) ? (userData as any).children : [];
      return children.length > 0 || hasTeam ? 'active' : 'needs_player';
    }
    return 'active';
  })();

  if (stage === 'needs_team' || stage === 'needs_player' || stage === 'pending_parent') {
    return <OnboardingGate onSignOut={logout} />;
  }

  return (
    <SidebarProvider>
      <AppLayoutShell>{children}</AppLayoutShell>
    </SidebarProvider>
  );
};

// Inner shell — needs to live below SidebarProvider so it can read
// the collapsed state and shift the <main> ml accordingly. Without
// this layer, collapsing the sidebar to lg:w-20 left a 44 rem ghost
// band between sidebar and content because main was hardcoded
// lg:ml-64.
const AppLayoutShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { collapsed } = useSidebar();
  const { userData } = useAuth();
  const { mode, setMode } = useTheme();
  // Self-heal non-owners back to dark. Light mode is owner-only while
  // the native underlay fixes await binary submission; any non-owner
  // who toggled to light during the brief 3.7.40-42 window (when the
  // picker was visible to all) gets reset on next auth-resolved render.
  React.useEffect(() => {
    if (!userData) return;
    if (!isThemePickerVisible(userData) && mode !== 'dark') {
      setMode('dark');
    }
  }, [userData, mode, setMode]);

  // Implicit widget-token bootstrap. Fires once per session for the
  // signed-in user. If they already have a token on their user doc
  // we just push it into the native App Group bridge so the widget
  // can read it. If they don't, we generate one and persist. Result:
  // the user never visits Settings → Widget to "Generate" — they
  // sign in (which they had to do anyway), add the widget, done.
  // Matches the Instagram / Facebook widget UX. See widgetBridge.ts.
  React.useEffect(() => {
    if (!userData?.uid) return;
    const prefetchTimer = window.setTimeout(prefetchCoreRoutes, 250);
    void bootstrapWidgetToken({
      uid: userData.uid,
      existingToken: (userData as any).widgetToken,
      writeFirestore: async (uid, token) => {
        const { doc } = await import('firebase/firestore');
        await updateDoc(doc(db, 'users', uid), { widgetToken: token });
      },
    });
    return () => window.clearTimeout(prefetchTimer);
  }, [userData?.uid, (userData as any)?.widgetToken]);
  // Page shell uses the semantic surface token so the toggle in
  // Settings → Appearance flips the background. Inner components
  // still render their own (mostly charcoal-*) backgrounds until
  // migrated; the shell flip is what makes the toggle visible.
  return (
    <div className="min-h-screen bg-surface-base">
      <Navigation />
      <ApplyClubBrand />
      <main className={`${collapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-[calc(env(safe-area-inset-top)+3.5rem)] lg:pt-0 pb-20 lg:pb-0 transition-all duration-300`}>
        <LiveGameBanner />
        <InstallAppBanner />
        {children}
      </main>
    </div>
  );
};

function App() {
  // Install the global Firestore error handler once. Any unhandled
  // Firebase rejection (rule denial, network failure, etc.) lands as
  // a structured console line instead of disappearing silently.
  useEffect(() => {
    let cancelled = false;
    import('./utils/firestoreLogger').then(({ installFirestoreErrorHandler }) => {
      if (!cancelled) installFirestoreErrorHandler();
    });
    return () => { cancelled = true; };
  }, []);

  // Branded React splash that takes over from the native iOS / Android
  // splash. The HANDOFF is owned by <BrandedSplash /> itself — it
  // calls hideSplash() from inside its own mount effect, so the
  // native splash only goes away once the React overlay is painted
  // and ready. That eliminates the brief flash Patrick reported
  // where the native splash dismissed but the React overlay hadn't
  // rendered yet.
  //
  // Visible duration is 1.5s + 400ms fade, counted from the moment
  // the BrandedSplash mounts (i.e. from the user's perspective, from
  // when the animated logo first appears).
  const [splashPlaying, setSplashPlaying] = useState(true);

  // Belt-and-suspenders splash dismissal. The BrandedSplash mount
  // effect is the polished path: it paints the React overlay first,
  // THEN tells iOS to fade the native splash so the handoff is
  // seamless. But if something prevents BrandedSplash from mounting
  // (a hidden render error, a context throw, a lazy chunk failing
  // to resolve), users used to sit on the native splash for the
  // full 10s native ceiling. This top-level effect runs the moment
  // ANYTHING in the App tree mounts and fires hideSplash() at 1.2s
  // unconditionally — short enough to feel snappy, long enough
  // that the BrandedSplash path still owns the handoff in the
  // happy case (since IT calls hideSplash within ~3 frames of
  // mount, well before this timer fires). Idempotent on the
  // Capacitor side, so calling it twice is harmless.
  useEffect(() => {
    const t = window.setTimeout(() => { void hideSplash(); }, 1200);
    return () => window.clearTimeout(t);
  }, []);

  // "Just updated" detection. On every cold start, compare the running
  // Capgo bundle version against the last one we saw and stored in
  // localStorage. If they differ, this is the first launch on a new
  // bundle — show an extended splash with rotating soccer content so
  // the moment feels intentional and polished rather than "did
  // something just refresh?" When they match (the typical case), we
  // show the normal short splash and skip the update treatment.
  // First-ever launch (no last-seen value): treat as normal, just
  // record the current version so we have a baseline.
  const [justUpdatedFrom, setJustUpdatedFrom] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentCapgoBundleVersion } = await import('./utils/nativeShell');
        const cur = (await getCurrentCapgoBundleVersion()) || '';
        if (!cur || cancelled) return;
        const lastSeen = (() => {
          try { return localStorage.getItem('firefc.lastSeenBundle'); } catch { return null; }
        })();
        if (lastSeen && lastSeen !== cur) {
          setJustUpdatedFrom(lastSeen);
        }
        try { localStorage.setItem('firefc.lastSeenBundle', cur); } catch {}
      } catch { /* native plugin missing, web build — no-op */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Capgo OTA update progress.
  //
  // Previous design auto-reloaded the WebView once the download
  // completed. The cool splash + reload sequence worked visually,
  // BUT Firebase Auth couldn't recover its token inside the
  // post-reload WebView session — only a real cold start could.
  // Result: parents got logged out mid-session every time a bundle
  // landed. Patrick verified the cascade in 3.1.6, 3.1.7, and 3.1.8.
  //
  // The update moment should feel consistent with launch, not like
  // the app stalled. While Capgo downloads we show the same branded
  // quote/trivia/skill splash used after an update. Even if the bundle
  // downloads quickly, the splash remains for a readable minimum so
  // parents can actually finish the quote before the UI changes.
  // If the native auth bridge is unavailable we still avoid a
  // mid-session reload; after the readable pause the overlay steps
  // down to the small "Update ready" pill and the bundle applies on
  // the next cold start.
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const [updateApplying, setUpdateApplying] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [updateStoryVisible, setUpdateStoryVisible] = useState(false);
  const updateStoryStartedAtRef = React.useRef<number | null>(null);
  const updateStoryTimersRef = React.useRef<number[]>([]);

  const clearUpdateStoryTimers = React.useCallback(() => {
    updateStoryTimersRef.current.forEach((id) => window.clearTimeout(id));
    updateStoryTimersRef.current = [];
  }, []);

  const beginUpdateStory = React.useCallback(() => {
    if (!updateStoryStartedAtRef.current) {
      updateStoryStartedAtRef.current = performance.now();
    }
    setUpdateStoryVisible(true);
  }, []);

  const updateStoryRemainingMs = React.useCallback(() => {
    const startedAt = updateStoryStartedAtRef.current ?? performance.now();
    return Math.max(0, UPDATE_STORY_MIN_MS - (performance.now() - startedAt));
  }, []);

  const resetUpdateStory = React.useCallback(() => {
    clearUpdateStoryTimers();
    updateStoryStartedAtRef.current = null;
    setUpdateStoryVisible(false);
  }, [clearUpdateStoryTimers]);

  useEffect(() => clearUpdateStoryTimers, [clearUpdateStoryTimers]);

  // Detect whether the binary supports the Keychain auth bridge. If the
  // native plugin reports a currently-signed-in user, we're on a build
  // with `skipNativeAuth: false` AND the user has populated their
  // Keychain by signing in at least once on this binary — meaning
  // tryBridgeNativeSession in AuthContext can re-hydrate the Web SDK
  // post-reload. In that case it's safe to auto-reload mid-session
  // instead of waiting for cold start. On older binaries (skipNativeAuth:
  // true) or before the first sign-in, native getCurrentUser returns
  // null and we fall back to the safe pill + cold-start-apply path.
  const canAutoReload = async (): Promise<boolean> => {
    try {
      const { Capacitor } = await import('@capacitor/core');
      if (!Capacitor.isNativePlatform()) return false;
      const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
      const cur = await FirebaseAuthentication.getCurrentUser();
      return !!cur?.user?.uid;
    } catch {
      return false;
    }
  };

  useEffect(() => {
    let unsub: () => void = () => {};
    let cancelled = false;
    import('./utils/nativeShell').then(({ watchCapgoUpdate, reloadToLatestCapgoBundle }) => {
      if (cancelled) return;
      watchCapgoUpdate({
        onProgress: ({ percent }) => {
          beginUpdateStory();
          setUpdateReady(false);
          setDownloadPercent(percent);
        },
        onComplete: async () => {
          // Two paths, gated by Keychain bridge availability:
          //
          // (a) Keychain-backed binary AND user signed in natively →
          //     auto-reload mid-session. tryBridgeNativeSession in
          //     AuthContext resurrects the Web SDK from native auth
          //     post-reload, so no logout cascade. Cool splash + swap
          //     + dashboard. This is the experience we always wanted.
          //
          // (b) Old binary (skipNativeAuth: true) OR not yet signed in
          //     under the new binary → safe pill, apply on next
          //     natural cold start. Same model we've been on tonight.
          const bridgeAvailable = await canAutoReload();
          beginUpdateStory();
          setDownloadPercent(100);
          clearUpdateStoryTimers();
          if (bridgeAvailable) {
            setUpdateApplying(true);
            const reloadDelay = Math.max(1200, updateStoryRemainingMs());
            const timerId = window.setTimeout(() => {
              void reloadToLatestCapgoBundle();
            }, reloadDelay);
            updateStoryTimersRef.current.push(timerId);
            return;
          }
          // Safe path:
          setUpdateReady(true);
          const timerId = window.setTimeout(() => {
            setDownloadPercent(null);
            resetUpdateStory();
          }, updateStoryRemainingMs());
          updateStoryTimersRef.current.push(timerId);
        },
        onFailed: () => {
          setDownloadPercent(null);
          setUpdateApplying(false);
          resetUpdateStory();
        },
      }).then((u) => {
        if (cancelled) { u(); return; }
        unsub = u;
      });
    });
    return () => { cancelled = true; unsub(); };
  }, []);
  // applyUpdateNow used to be wired to a "Now" button on the pill,
  // but that flow logged users out (mid-session WebView reload breaks
  // Firebase Auth recovery). Removed the trigger entirely; the
  // reloadToLatestCapgoBundle wiring stays in nativeShell.ts in case
  // a future surface (e.g. a Settings → 'Install update now' row,
  // with a clear warning) wants it.

  return (
    <ThemeProvider>
    <AuthProvider>
      <TeamProvider>
        <ViewModeProvider>
        <Router>
          <Suspense fallback={<PageSpinner />}>
          <div className="App">
            <Routes>
              {/* Public Routes - NO ProtectedRoute wrapper */}
              <Route path="/auth" element={<SimpleAuth />} />
              {/* Firebase Auth action handler — verify email, reset
                  password, recover email. Worker rewrites Firebase's
                  default action link to point here so we can render a
                  branded success/error page. */}
              <Route path="/auth/action" element={<AuthAction />} />
              <Route path="/auth/impersonate" element={<AuthImpersonate />} />
              <Route path="/login" element={<Navigate to="/auth" replace />} />
              <Route path="/setup" element={<Navigate to="/auth" replace />} />
              <Route path="/vote/:votingId" element={<PublicVote />} />
              <Route path="/join" element={<PlayerJoin />} />
              {/* New invite-link flow (Phase 3 of seasons + invites redesign) */}
              <Route path="/join/:inviteId" element={<InviteJoin />} />
              <Route path="/coach-join" element={<CoachJoin />} />
              <Route path="/media/:mediaId" element={<SharedMedia />} />
              <Route path="/survey/:surveyId" element={<PublicSurvey />} />
              <Route path="/game/:gameId" element={<PublicGame />} />
              <Route path="/wall/p/:postId" element={<PublicWallPost />} />
              <Route path="/p/:playerId" element={<PublicPlayerCard />} />
              <Route path="/f/:teamId" element={<PublicFixtures />} />
              <Route path="/l/:leagueId" element={<PublicLeague />} />
              <Route path="/leagues/:leagueId/console" element={
                <ProtectedRoute>
                  <AppLayout>
                    <LeagueConsole />
                  </AppLayout>
                </ProtectedRoute>
              } />
              <Route path="/privacy" element={<PrivacyPolicy />} />
              <Route path="/showcase/potm" element={<PotmShowcase />} />
              <Route path="/showcase/recap" element={<RecapShowcase />} />
              <Route path="/showcase/wall" element={<WallShowcase />} />
            
            {/* Root redirect - goes to dashboard if authenticated, auth if not */}
            <Route path="/" element={
              <ProtectedRoute>
                <Navigate to="/dashboard" replace />
              </ProtectedRoute>
            } />
            
            {/* Protected Routes - All wrapped in ProtectedRoute */}
            <Route path="/dashboard" element={
              <ProtectedRoute>
                <AppLayout>
                  <Dashboard />
                </AppLayout>
              </ProtectedRoute>
            } />
            
            <Route path="/players" element={
              <ProtectedRoute>
                <AppLayout>
                  <Players />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/player/:playerId" element={
              <ProtectedRoute>
                <AppLayout>
                  <PlayerProfile />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/chat" element={
              <ProtectedRoute>
                <AppLayout>
                  {/* Chat must never bounce the user to the global
                      'Something went wrong' page. Wrap in a silent
                      boundary that just shows a small reconnect hint
                      if the surface ever crashes. The per-message
                      boundary inside TeamChat already isolates single
                      bad messages; this is the wider safety net. */}
                  <SilentErrorBoundary
                    label="chat-surface"
                    fallback={(
                      <div className="min-h-[60vh] flex items-center justify-center p-6">
                        <div className="text-center max-w-sm">
                          <p className="text-ink-primary/80 font-bold mb-1">Reconnecting chat…</p>
                          <p className="text-ink-primary/55 text-sm mb-4">Your messages are safe. Pull to refresh, or wait a moment.</p>
                          <button
                            onClick={() => window.location.reload()}
                            className="text-[11px] font-extrabold tracking-widest uppercase text-brand-primary-soft hover:text-ink-primary"
                          >
                            Tap to refresh
                          </button>
                        </div>
                      </div>
                    )}
                  >
                    <TeamChat />
                  </SilentErrorBoundary>
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/wall" element={
              <ProtectedRoute>
                <AppLayout>
                  <Wall />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/store" element={
              <ProtectedRoute>
                <AppLayout>
                  <TeamStore />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/equipment" element={
              <ProtectedRoute>
                <AppLayout>
                  <Equipment />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/drills" element={
              <ProtectedRoute>
                <AppLayout>
                  <Drills />
                </AppLayout>
              </ProtectedRoute>
            } />

            {/* Public registration — no auth required. Parents land
                here from email blasts or posted links. */}
            <Route path="/register" element={<Register />} />
            <Route path="/register/success" element={<RegisterSuccess />} />
            <Route path="/register/cancel" element={<RegisterCancel />} />
            <Route path="/offer/:offerId" element={<Offer />} />

            <Route path="/club/registrations" element={
              <ProtectedRoute>
                <AppLayout>
                  <Registrations />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/admin/teams" element={
              <ProtectedRoute>
                <AppLayout>
                  <AdminTeams />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/admin/seasons/:id" element={
              <ProtectedRoute>
                <AppLayout>
                  <SeasonWizard />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/coach" element={
              <ProtectedRoute>
                <AppLayout>
                  <CoachCockpit />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/team/staff" element={
              <ProtectedRoute>
                <AppLayout>
                  <StaffManagement />
                </AppLayout>
              </ProtectedRoute>
            } />

            {/* /home-v2 (FamilyHome preview) retired 2026-07-08. The
                surface didn't hit the elegance bar and its best moves
                (multi-kid strip, cross-team next event) will be folded
                into classic Home. */}

            <Route path="/club/products" element={
              <ProtectedRoute>
                <AppLayout>
                  <Products />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/club/registration-form" element={
              <ProtectedRoute>
                <AppLayout>
                  <RegistrationFormBuilder />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/club/tryouts" element={
              <ProtectedRoute>
                <AppLayout>
                  <Tryouts />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/family/forms" element={
              <ProtectedRoute>
                <AppLayout>
                  <FamilyForms />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/club/family/:email" element={
              <ProtectedRoute>
                <AppLayout>
                  <FamilyTimeline />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/club/offer-templates" element={
              <ProtectedRoute>
                <AppLayout>
                  <OfferTemplates />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/club/seasons" element={
              <ProtectedRoute>
                <AppLayout>
                  <Seasons />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/club/reports" element={
              <ProtectedRoute>
                <AppLayout>
                  <Reports />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/club/person/:playerId" element={
              <ProtectedRoute>
                <AppLayout>
                  <PersonAdmin />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/club/forms" element={
              <ProtectedRoute>
                <AppLayout>
                  <Forms />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/club/tasks" element={
              <ProtectedRoute>
                <AppLayout>
                  <Tasks />
                </AppLayout>
              </ProtectedRoute>
            } />

            {/* Platform owner only — gated client-side by isOwner. URL
                not advertised in any nav; bookmark it. */}
            <Route path="/platform/clubs" element={
              <ProtectedRoute>
                <AppLayout>
                  <PlatformClubs />
                </AppLayout>
              </ProtectedRoute>
            } />
            
            <Route path="/stats" element={
              <ProtectedRoute>
                <AppLayout>
                  <Stats />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/calendar" element={
              <ProtectedRoute>
                <AppLayout>
                  <Calendar />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/people" element={
              <ProtectedRoute>
                <AppLayout>
                  <People />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/helpdesk" element={
              <ProtectedRoute>
                <AppLayout>
                  <Helpdesk />
                </AppLayout>
              </ProtectedRoute>
            } />
            <Route path="/helpdesk/:ticketId" element={
              <ProtectedRoute>
                <AppLayout>
                  <HelpdeskTicketPage />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/events/:eventId" element={
              <ProtectedRoute>
                <AppLayout>
                  <EventDetail />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/game-day/:eventId" element={
              <ProtectedRoute>
                <AppLayout>
                  <GameDay />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/game-day" element={
              <ProtectedRoute>
                <AppLayout>
                  <QuickGameLauncher />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/practice-plan" element={
              <ProtectedRoute>
                <AppLayout>
                  <PracticePlanBuilder />
                </AppLayout>
              </ProtectedRoute>
            } />
            
            <Route path="/gallery" element={<Navigate to="/player-media" replace />} />

            {/* Feature Routes */}
            <Route path="/directory" element={
              <ProtectedRoute>
                <AppLayout>
                  <ParentDirectory />
                </AppLayout>
              </ProtectedRoute>
            } />
            
            <Route path="/volunteers" element={
              <ProtectedRoute>
                <AppLayout>
                  <VolunteerScheduler />
                </AppLayout>
              </ProtectedRoute>
            } />
            
            <Route path="/attendance" element={
              <ProtectedRoute>
                <AppLayout>
                  <AttendanceTracker />
                </AppLayout>
              </ProtectedRoute>
            } />
            
            <Route path="/player-of-match" element={
              <ProtectedRoute>
                <AppLayout>
                  <PlayerOfMatch />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/teams" element={
              <ProtectedRoute>
                <AppLayout>
                  <TeamManagement />
                </AppLayout>
              </ProtectedRoute>
            } />

            {/* /onboarding — post-signup wizard. OnboardingGate now
                routes fresh coaches here when they pick "Start a
                team" so they get the full step-by-step setup: team
                name → kid? → practice days → schedule preview →
                time/location → confirm → invite parents → invite
                coach → notifications → checklist → another team? →
                trial. The wizard does the team-create write itself
                (see handleCreateTeamAndAdvance in Onboarding.tsx). */}
            <Route path="/onboarding" element={
              <ProtectedRoute>
                <Onboarding />
              </ProtectedRoute>
            } />

            {/* Standalone bulk add-players + invite-parents page.
                Reachable from Dashboard's Getting Started card and
                anywhere else that needs a focused add flow. */}
            <Route path="/people/add" element={
              <ProtectedRoute>
                <AppLayout>
                  <AddRoster />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/club" element={
              <ProtectedRoute>
                <AppLayout>
                  <ClubOverview />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/club/branding" element={
              <ProtectedRoute>
                <AppLayout>
                  <ClubBranding />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/development" element={
              <ProtectedRoute>
                <AppLayout>
                  <PlayerDevelopment />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/player-media" element={
              <ProtectedRoute>
                <AppLayout>
                  <PlayerMediaPage />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/highlights" element={
              <ProtectedRoute>
                <AppLayout>
                  <Highlights />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/mentions" element={
              <ProtectedRoute>
                <AppLayout>
                  <MentionsInbox />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/surveys" element={
              <ProtectedRoute>
                <AppLayout>
                  <Surveys />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/full-games" element={
              <ProtectedRoute>
                <AppLayout>
                  <FullGames />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/upgrade/video" element={
              <ProtectedRoute>
                <AppLayout>
                  <VideoUpgradePage />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/settings" element={
              <ProtectedRoute>
                <AppLayout>
                  <Settings />
                </AppLayout>
              </ProtectedRoute>
            } />

            <Route path="/tickets" element={
              <ProtectedRoute>
                <AppLayout>
                  <Tickets />
                </AppLayout>
              </ProtectedRoute>
            } />
            <Route path="/tickets/:ticketId" element={
              <ProtectedRoute>
                <AppLayout>
                  <TicketDetail />
                </AppLayout>
              </ProtectedRoute>
            } />
            <Route path="/club/admins" element={
              <ProtectedRoute>
                <AppLayout>
                  <ClubAdmins />
                </AppLayout>
              </ProtectedRoute>
            } />

            {/* Catch all route - redirect to auth if not authenticated, dashboard if authenticated */}
            <Route path="*" element={
              <ProtectedRoute fallbackPath="/auth">
                <Navigate to="/dashboard" replace />
              </ProtectedRoute>
            } />
          </Routes>
        </div>
          </Suspense>
      </Router>
        </ViewModeProvider>
      </TeamProvider>
      {splashPlaying && (
        justUpdatedFrom
          ? <JustUpdatedSplash onDone={() => setSplashPlaying(false)} />
          : <BrandedSplash onDone={() => setSplashPlaying(false)} />
      )}
      {updateStoryVisible && (downloadPercent !== null || updateReady || updateApplying) && (
        <UpdateStorySplash
          percent={downloadPercent ?? (updateReady || updateApplying ? 100 : 0)}
          mode={updateApplying ? 'applying' : updateReady ? 'ready' : 'downloading'}
        />
      )}
      {updateReady && !updateApplying && !updateStoryVisible && (
        <UpdateReadyPill />
      )}
    </AuthProvider>
    </ThemeProvider>
  );
}

type UpdateStoryMode = 'downloading' | 'ready' | 'applying';

const UpdateStorySplash: React.FC<{ percent: number; mode: UpdateStoryMode }> = ({ percent, mode }) => {
  const itemRef = React.useRef(getRandomWelcomeBackItem());
  const item = itemRef.current;
  const pct = Math.min(100, Math.max(1, Math.floor(percent)));
  const status = mode === 'applying'
    ? 'Installing update'
    : mode === 'ready'
      ? 'Update ready'
      : `Updating ${pct}%`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[9999] bg-gradient-to-br from-surface-base via-surface-elevated to-vignette-deep flex items-center justify-center px-8 animate-fade-in"
    >
      <div className="flex flex-col items-center gap-6 max-w-lg w-full">
        <img
          src="/images/logo.png"
          alt=""
          className="w-20 h-20 rounded-2xl shadow-2xl shadow-brand-primary/30 ring-1 ring-line-default/10 splash-breathe"
        />
        <p className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-brand-primary">
          {KIND_LABEL[item.kind]}
        </p>
        <p className="text-ink-primary text-base sm:text-lg font-semibold leading-relaxed text-center">
          {item.attribution ? `"${item.text}"` : item.text}
        </p>
        {item.attribution && (
          <p className="text-ink-primary/55 text-xs font-semibold tracking-wide">
            — {item.attribution}
          </p>
        )}
        <div className="w-full max-w-xs mt-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-extrabold uppercase tracking-widest text-ink-primary/55">
              {status}
            </span>
            <span className="text-[11px] font-bold text-brand-primary-soft">
              {pct}%
            </span>
          </div>
          <div className="h-1 rounded-full bg-line-default/10 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-brand-primary-soft to-fuchsia-400 transition-[width] duration-300 ease-out"
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </div>
          <div className="flex items-center justify-center gap-1.5 mt-4">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-primary-soft splash-dot" style={{ animationDelay: '0ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-brand-primary-soft splash-dot" style={{ animationDelay: '180ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-brand-primary-soft splash-dot" style={{ animationDelay: '360ms' }} />
          </div>
        </div>
      </div>
    </div>
  );
};

// Informational pill that surfaces after a Capgo bundle has finished
// downloading. The bundle will apply on its own the next time the
// user backgrounds and reopens the app — Capgo's safe default. We
// don't expose a tappable "apply now" action: the mid-session
// CapacitorUpdater.reload() path WILL log the user out (Firebase
// Auth can't recover its token in a reloaded WebView), and Patrick
// hit exactly that footgun when an earlier version showed a 'Now'
// button. The dismiss X is the only action — purely informational.
const UpdateReadyPill: React.FC = () => {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div
      className="fixed left-0 right-0 z-[9998] pointer-events-none"
      style={{ top: 'env(safe-area-inset-top)' }}
    >
      <div className="mx-3 mt-1 rounded-full bg-surface-elevated/90 ring-1 ring-emerald-400/30 backdrop-blur-md shadow-lg shadow-emerald-500/15 pointer-events-auto">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-75" />
            <span className="relative rounded-full bg-emerald-400 h-2 w-2" />
          </span>
          <span className="text-[12px] font-semibold text-ink-primary flex-1">
            Update ready · installs when you reopen the app
          </span>
          <button
            onClick={() => setDismissed(true)}
            aria-label="Dismiss"
            className="text-ink-primary/50 hover:text-ink-primary/70 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

// "Just updated" splash — runs INSTEAD of the regular BrandedSplash
// on the first cold start after a Capgo bundle swap. Same gradient
// + breathing logo as the regular splash so it reads as continuous
// with the launch, plus a kind chip + rotating content item so the
// parent's brain has something to land on while the app finishes
// booting. Two real jobs: (1) make the update moment feel intentional,
// not "wait, what just refreshed?", (2) reinforce that the team behind
// the app cares — Patrick: "more polish means more trust."
//
// Visible duration is longer than the standard splash (5.6s vs 1.5s)
// because there's actual content to read.
const JustUpdatedSplash: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [fading, setFading] = useState(false);
  const itemRef = React.useRef(getRandomWelcomeBackItem());
  const item = itemRef.current;
  useEffect(() => {
    let t1: number | undefined;
    let t2: number | undefined;
    const startVisibleClock = () => {
      t1 = window.setTimeout(() => setFading(true), 5600);
      t2 = window.setTimeout(() => onDone(), 6000);
    };
    const id1 = requestAnimationFrame(() => {
      const id2 = requestAnimationFrame(() => {
        import('./utils/nativeShell').then((m) => {
          startVisibleClock();
          void m.hideSplash();
          void m.notifyCapgoReady();
        }).catch(() => {
          startVisibleClock();
        });
        (JustUpdatedSplash as any).__raf2 = id2;
      });
      (JustUpdatedSplash as any).__raf1 = id1;
    });
    return () => {
      if (t1) window.clearTimeout(t1);
      if (t2) window.clearTimeout(t2);
    };
  }, [onDone]);

  return (
    <div
      aria-hidden
      className={`fixed inset-0 z-[9999] bg-gradient-to-br from-surface-base via-surface-elevated to-vignette-deep flex items-center justify-center px-8 transition-opacity ${fading ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
      style={{ transitionDuration: '400ms' }}
    >
      <div className="flex flex-col items-center gap-6 max-w-md">
        <img
          src="/images/logo.png"
          alt=""
          className="w-20 h-20 rounded-2xl shadow-2xl shadow-brand-primary/30 ring-1 ring-line-default/10 splash-breathe"
        />
        <p className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-brand-primary">
          {KIND_LABEL[item.kind]}
        </p>
        <p className="text-ink-primary text-base sm:text-lg font-semibold leading-relaxed text-center">
          {item.attribution ? `"${item.text}"` : item.text}
        </p>
        {item.attribution && (
          <p className="text-ink-primary/55 text-xs font-semibold tracking-wide">
            — {item.attribution}
          </p>
        )}
        <div className="flex items-center gap-1.5 mt-2">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-primary-soft splash-dot" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-brand-primary-soft splash-dot" style={{ animationDelay: '180ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-brand-primary-soft splash-dot" style={{ animationDelay: '360ms' }} />
        </div>
      </div>
    </div>
  );
};

// Branded React splash — fixed overlay that paints over the native
// launch screen, then dismisses the native splash from inside its
// own mount effect so the handoff is atomic (no gap, no flash).
// Plays for ~1.5s + 400ms fade counted from the moment the user
// actually SEES the animated logo, not from React's mount time.
const BrandedSplash: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [fading, setFading] = useState(false);
  useEffect(() => {
    let visibleStart = 0;
    let t1: number | undefined;
    let t2: number | undefined;

    // Two RAFs: first to let the overlay paint into the DOM, second
    // confirms the browser has committed that paint. Only then do we
    // tell Capacitor to dismiss the native splash. From the user's
    // POV the native splash and the React splash share one frame —
    // there is no visible gap.
    const startVisibleClock = () => {
      visibleStart = performance.now();
      t1 = window.setTimeout(() => setFading(true), 1500);
      t2 = window.setTimeout(() => onDone(), 1900);
    };

    const id1 = requestAnimationFrame(() => {
      const id2 = requestAnimationFrame(() => {
        // Use the statically-imported helpers — no dynamic chunk
        // fetch that can fail on flaky cold-start networks. Start
        // the visible clock first so the perceived duration is
        // consistent regardless of plugin failure.
        startVisibleClock();
        void hideSplash();
        // Tell Capgo the OTA bundle (if any) booted to a working
        // state. Must fire within Capgo's appReadyTimeout (default
        // 10s) or it rolls back to the previous bundle on next
        // launch. Doing it here means a JS-crashing bundle that
        // never reaches splash dismiss IS rolled back — exactly
        // the safety net we want.
        void notifyCapgoReady();
        (BrandedSplash as any).__raf2 = id2;
      });
      (BrandedSplash as any).__raf1 = id1;
    });

    return () => {
      if (t1) window.clearTimeout(t1);
      if (t2) window.clearTimeout(t2);
      // Reference visibleStart so the linter doesn't flag the assignment.
      void visibleStart;
    };
  }, [onDone]);

  return (
    <div
      aria-hidden
      className={`fixed inset-0 z-[9999] bg-gradient-to-br from-surface-base via-surface-elevated to-vignette-deep flex items-center justify-center transition-opacity ${fading ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
      style={{ transitionDuration: '400ms' }}
    >
      <div className="flex flex-col items-center gap-6">
        <img
          src="/images/logo.png"
          alt=""
          className="w-28 h-28 rounded-2xl shadow-2xl shadow-brand-primary/30 ring-1 ring-line-default/10 splash-breathe"
        />
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-brand-primary-soft splash-dot" style={{ animationDelay: '0ms' }} />
          <span className="w-2 h-2 rounded-full bg-brand-primary-soft splash-dot" style={{ animationDelay: '180ms' }} />
          <span className="w-2 h-2 rounded-full bg-brand-primary-soft splash-dot" style={{ animationDelay: '360ms' }} />
        </div>
      </div>
    </div>
  );
};

export default App;