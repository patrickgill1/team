import React, { Suspense, useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from './utils/firebase';
import { AuthProvider } from './contexts/AuthContext';
import { TeamProvider } from './contexts/TeamContext';
import { ViewModeProvider } from './contexts/ViewModeContext';
import { useAuth } from './hooks/useAuth';
import ProtectedRoute from './components/common/ProtectedRoute';
import SilentErrorBoundary from './components/common/SilentErrorBoundary';
import OnboardingGate from './components/gates/OnboardingGate';
import { getRandomWelcomeBackItem, KIND_LABEL } from './utils/welcomeBackContent';
import Navigation from './components/common/Navigation';
import InstallAppBanner from './components/common/InstallAppBanner';
import ApplyClubBrand from './components/common/ApplyClubBrand';

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
const Onboarding = React.lazy(() => import('./pages/Onboarding'));
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
const GameDay = React.lazy(() => import('./pages/GameDay'));
const QuickGameLauncher = React.lazy(() => import('./pages/QuickGameLauncher'));
const PracticePlanBuilder = React.lazy(() => import('./pages/PracticePlanBuilder'));
const Settings = React.lazy(() => import('./pages/Settings'));
const Tickets = React.lazy(() => import('./pages/Tickets'));
const TicketDetail = React.lazy(() => import('./pages/TicketDetail'));
const ClubAdmins = React.lazy(() => import('./pages/ClubAdmins'));
const AuthAction = React.lazy(() => import('./pages/AuthAction'));
const AuthImpersonate = React.lazy(() => import('./pages/AuthImpersonate'));
const EventDetail = React.lazy(() => import('./pages/EventDetail'));
const People = React.lazy(() => import('./pages/People'));
const Helpdesk = React.lazy(() => import('./pages/Helpdesk'));
const HelpdeskTicketPage = React.lazy(() => import('./pages/HelpdeskTicket'));

// Branded loading screen — picks up where the native splash leaves off
// (same dark navy bg) and shows the app mark with a subtle bouncing
// three-dot indicator below so the user knows something's happening.
const PageSpinner = () => (
  <div className="min-h-screen bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-black flex items-center justify-center">
    <div className="flex flex-col items-center gap-6 animate-fade-in">
      <img
        src="/images/logo.png"
        alt=""
        className="w-24 h-24 rounded-2xl shadow-2xl shadow-brand-primary/20 ring-1 ring-white/10 splash-breathe"
      />
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-brand-primary-soft splash-dot" style={{ animationDelay: '0ms' }} />
        <span className="w-2 h-2 rounded-full bg-brand-primary-soft splash-dot" style={{ animationDelay: '180ms' }} />
        <span className="w-2 h-2 rounded-full bg-brand-primary-soft splash-dot" style={{ animationDelay: '360ms' }} />
      </div>
    </div>
  </div>
);

// Layout component for authenticated pages
const AppLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { userData, logout } = useAuth();
  const [checking, setChecking] = useState(true);
  const [gateReason, setGateReason] = useState<'none' | 'pending-approval' | 'not-linked'>('none');

  useEffect(() => {
    const checkAccess = async () => {
      if (!userData) {
        setGateReason('none');
        setChecking(false);
        return;
      }
      const userAny = userData as any;

      // Coach / team_manager without ANY team → land on OnboardingGate
      // so they can pick Enter invite / Start team / Start club.
      // Patrick 2026-06-26: 'is every new user going to not be able to
      // start a team or club how it sits?' — previous version only
      // gated role=parent, leaving fresh coaches dropped into an empty
      // dashboard. Now both paths land on the gate.
      const role = String(userData.role || '');
      if (role === 'coach' || role === 'team_manager') {
        const teamIds: string[] = Array.isArray(userData.teamIds) ? userData.teamIds : [];
        const hasTeam = teamIds.length > 0 || (typeof userData.teamId === 'string' && userData.teamId.length > 0);
        if (!hasTeam) {
          setGateReason('not-linked');
          setChecking(false);
          return;
        }
        setGateReason('none');
        setChecking(false);
        return;
      }

      if (role !== 'parent') {
        setGateReason('none');
        setChecking(false);
        return;
      }
      // Parent path: check approval first.
      if (userAny.approved === false) {
        setGateReason('pending-approval');
        setChecking(false);
        return;
      }
      // Then check player link (with timeout so mobile doesn't hang).
      try {
        const q = query(
          collection(db, 'players'),
          where('parentIds', 'array-contains', userData.uid)
        );
        const snap = await Promise.race([
          getDocs(q),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))
        ]);
        setGateReason(snap === null || snap.empty ? 'not-linked' : 'none');
      } catch {
        setGateReason('none'); // fail open so they aren't stuck
      }
      setChecking(false);
    };
    checkAccess();

    // Hard safety ceiling — never leave the spinner up forever.
    const timer = setTimeout(() => {
      setChecking(false);
      setGateReason('none');
    }, 4000);
    return () => clearTimeout(timer);
  }, [userData?.uid, userData?.role, userData?.teamId, userData?.teamIds?.length]);

  if (checking) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-charcoal-950 via-charcoal-800 to-charcoal-950 flex items-center justify-center">
        <div className="flex flex-col items-center space-y-3">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-brand-primary/30 border-t-cyan-400" />
        </div>
      </div>
    );
  }

  // Old 'Waiting for Approval' and 'Almost There' dead-end screens
  // replaced 2026-06-26 with OnboardingGate — gives the user real
  // paths forward (enter invite code / start a team / start a club)
  // instead of telling them to nag their coach. Patrick: 'this gate
  // should not exist. if they are tied to a player, it should start
  // the option to make a team, club or join another team.'
  if (gateReason === 'pending-approval' || gateReason === 'not-linked') {
    return <OnboardingGate onSignOut={logout} />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-charcoal-950 via-charcoal-800 to-charcoal-950">
      <Navigation />
      {/* Main content offset: chrome is safe-top + h-14 (the React
          header has safe-top padding now that the AppDelegate
          native strip is gone). pt-14 alone clears the h-14
          content row but NOT the safe-area-top padding, so on
          devices with a Dynamic Island / notch the first ~59px of
          page content was rendering behind the chrome. The inline
          style adds env(safe-area-inset-top) on top of the h-14
          (3.5rem) offset so page content always starts cleanly
          below the chrome regardless of device. lg sidebar layout
          unchanged. */}
      {/* paddingTop was an inline style that always WON against
          lg:pt-0 (Tailwind responsive class), so on desktop / iPad
          landscape the main element still had ~115px of top
          padding it shouldn't have. Pages using height: 100dvh
          (TeamChat's desktop two-pane layout) then overflowed by
          that amount and pushed the composer off-screen. Patrick:
          'i can[not] get a type box to show up on ipad simulator
          in chat.' Switched to Tailwind arbitrary-value class so
          lg:pt-0 can actually override it. */}
      {/* Mount-only — subscribes to the active club's brandColor and
          writes it to --brand-primary on document.documentElement so
          any surface using bg-brand-primary (Button primary, hero
          accents, etc.) re-tints in real time when the admin saves
          a new color on /club/branding. Falls back to GoalKickr
          crimson when no club / no brandColor is set. */}
      <ApplyClubBrand />
      <main className="lg:ml-64 pt-[calc(env(safe-area-inset-top)+3.5rem)] lg:pt-0 pb-20 lg:pb-0">
        {/* Mobile-web only: prompt to install the native app. No-ops
            inside Capacitor, on desktop, or after dismissal. */}
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
  // New design (more like iMessage / Telegram updates):
  //  - Download silently in background. Show the slim progress chip
  //    so it's not invisible, but DON'T take over the screen.
  //  - When download completes, surface a small "Update ready" pill
  //    that the user can tap to apply now (cool splash + reload —
  //    same flow as before). If they ignore it, the new bundle
  //    applies automatically on the next cold start (the user
  //    naturally backgrounds and re-opens the app).
  //  - Cold-start application is the safe path because Firebase Auth
  //    initializes cleanly from a fresh JS context — that's why
  //    force-close + reopen always worked.
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const [updateApplying, setUpdateApplying] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);

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
        onProgress: ({ percent }) => setDownloadPercent(percent),
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
          if (bridgeAvailable) {
            setDownloadPercent(null);
            setUpdateApplying(true);
            window.setTimeout(() => {
              void reloadToLatestCapgoBundle();
            }, 1600);
            return;
          }
          // Safe path:
          setDownloadPercent(null);
          setUpdateReady(true);
        },
        onFailed: () => setDownloadPercent(null),
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
  // UpdatingSplash + reloadToLatestCapgoBundle wiring stays in
  // nativeShell.ts in case a future surface (e.g. a Settings →
  // 'Install update now' row, with a clear warning) wants it.

  return (
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
              <Route path="/privacy" element={<PrivacyPolicy />} />
            
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
                          <p className="text-bone/85 font-bold mb-1">Reconnecting chat…</p>
                          <p className="text-bone/55 text-sm mb-4">Your messages are safe. Pull to refresh, or wait a moment.</p>
                          <button
                            onClick={() => window.location.reload()}
                            className="text-[11px] font-extrabold tracking-widest uppercase text-brand-primary-soft hover:text-bone"
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

            {/* Onboarding wizard — first-run flow for a coach who
                signed up via the marketing site (or any other path
                that leaves teamIds empty). ProtectedRoute funnels
                empty-team coaches here automatically; this route
                renders without AppLayout so the bottom nav doesn't
                show during onboarding. */}
            <Route path="/onboarding" element={
              <ProtectedRoute allowEmpty>
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
      {downloadPercent !== null && !updateApplying && !updateReady && (
        <UpdateProgressBar percent={downloadPercent} />
      )}
      {updateReady && !updateApplying && (
        <UpdateReadyPill />
      )}
      {updateApplying && <UpdatingSplash />}
    </AuthProvider>
  );
}

// Slim non-blocking status strip pinned to the very top of the screen
// while Capgo downloads a new bundle in the background. The user can
// keep using the app — this just tells them "something's happening"
// the way Gmail / Chrome / Spotify do during a silent update. The
// bar slides down into the safe-area-top so it doesn't fight the
// notch / Dynamic Island.
const UpdateProgressBar: React.FC<{ percent: number }> = ({ percent }) => {
  return (
    <div
      aria-hidden
      className="fixed left-0 right-0 z-[9998] pointer-events-none"
      style={{ top: 'env(safe-area-inset-top)' }}
    >
      <div className="mx-3 mt-1 rounded-full bg-charcoal-900/85 ring-1 ring-brand-primary-soft/20 backdrop-blur-md shadow-lg shadow-brand-primary/10 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inset-0 rounded-full bg-brand-primary-soft animate-ping opacity-75" />
            <span className="relative rounded-full bg-brand-primary-soft h-2 w-2" />
          </span>
          <span className="text-[11px] font-semibold tracking-wide text-white/90 flex-1">
            Updating · {Math.max(1, Math.floor(percent))}%
          </span>
        </div>
        <div className="h-0.5 bg-white/5">
          <div
            className="h-full bg-gradient-to-r from-brand-primary-soft to-fuchsia-400 transition-[width] duration-300 ease-out"
            style={{ width: `${Math.max(2, Math.floor(percent))}%` }}
          />
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
      <div className="mx-3 mt-1 rounded-full bg-charcoal-900/90 ring-1 ring-emerald-400/30 backdrop-blur-md shadow-lg shadow-emerald-500/15 pointer-events-auto">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-75" />
            <span className="relative rounded-full bg-emerald-400 h-2 w-2" />
          </span>
          <span className="text-[12px] font-semibold text-white/90 flex-1">
            Update ready · installs when you reopen the app
          </span>
          <button
            onClick={() => setDismissed(true)}
            aria-label="Dismiss"
            className="text-white/40 hover:text-white/70 transition-colors"
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

// Branded full-screen overlay shown for ~1.5s right before the WebView
// swaps onto the new bundle. Same gradient + breathing logo as
// BrandedSplash so the transition reads as "the app is launching"
// rather than "the app crashed." The progress bar is finished/full
// here so the user sees the moment-of-install.
const UpdatingSplash: React.FC = () => {
  return (
    <div
      aria-hidden
      className="fixed inset-0 z-[9999] bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-black flex flex-col items-center justify-center animate-fade-in"
    >
      <div className="flex flex-col items-center gap-6">
        <img
          src="/images/logo.png"
          alt=""
          className="w-28 h-28 rounded-2xl shadow-2xl shadow-brand-primary/30 ring-1 ring-white/10 splash-breathe"
        />
        <div className="flex flex-col items-center gap-3">
          <p className="text-white/85 text-sm font-semibold tracking-wide">Updating…</p>
          <div className="w-44 h-1 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full w-full bg-gradient-to-r from-brand-primary-soft to-fuchsia-400 animate-shimmer-bar" />
          </div>
        </div>
      </div>
    </div>
  );
};

// "Just updated" splash — runs INSTEAD of the regular BrandedSplash
// on the first cold start after a Capgo bundle swap. Same gradient
// + breathing logo as the regular splash so it reads as continuous
// with the launch, plus a kind chip + rotating content item (quote
// / trivia / skill tip / practice idea) so the parent's brain has
// something to land on while the app finishes booting. Two real
// jobs: (1) make the update moment feel intentional, not "wait,
// what just refreshed?", (2) reinforce that the team behind the
// app cares — Patrick: "more polish means more trust."
//
// Visible duration is longer than the standard splash (3s vs 1.5s)
// because there's actual content to read.
const JustUpdatedSplash: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [fading, setFading] = useState(false);
  const itemRef = React.useRef(getRandomWelcomeBackItem());
  const item = itemRef.current;
  useEffect(() => {
    let t1: number | undefined;
    let t2: number | undefined;
    const startVisibleClock = () => {
      t1 = window.setTimeout(() => setFading(true), 3000);
      t2 = window.setTimeout(() => onDone(), 3400);
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
      className={`fixed inset-0 z-[9999] bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-black flex items-center justify-center px-8 transition-opacity ${fading ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
      style={{ transitionDuration: '400ms' }}
    >
      <div className="flex flex-col items-center gap-6 max-w-md">
        <img
          src="/images/logo.png"
          alt=""
          className="w-20 h-20 rounded-2xl shadow-2xl shadow-brand-primary/30 ring-1 ring-white/10 splash-breathe"
        />
        <p className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-brand-primary-soft/70">
          {KIND_LABEL[item.kind]}
        </p>
        <p className="text-white text-base sm:text-lg font-medium leading-relaxed text-center">
          {item.attribution ? `"${item.text}"` : item.text}
        </p>
        {item.attribution && (
          <p className="text-white/50 text-xs font-semibold tracking-wide">
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
        import('./utils/nativeShell').then((m) => {
          // Start counting the visible window the moment we ask
          // Capacitor to dismiss. The native dismiss completes a
          // frame or two later, but starting the clock here keeps
          // the perceived duration consistent across fast and slow
          // cold starts.
          startVisibleClock();
          void m.hideSplash();
          // Tell Capgo the OTA bundle (if any) booted to a working
          // state. Must fire within Capgo's appReadyTimeout (default
          // 10s) or it rolls back to the previous bundle on next
          // launch. Doing it here means a JS-crashing bundle that
          // never reaches splash dismiss IS rolled back — exactly
          // the safety net we want.
          void m.notifyCapgoReady();
        }).catch(() => {
          // hideSplash failure (e.g. web build, no Capacitor) — still
          // play the React splash for the full duration so devs see
          // the same animation users do.
          startVisibleClock();
        });
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
      className={`fixed inset-0 z-[9999] bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-black flex items-center justify-center transition-opacity ${fading ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
      style={{ transitionDuration: '400ms' }}
    >
      <div className="flex flex-col items-center gap-6">
        <img
          src="/images/logo.png"
          alt=""
          className="w-28 h-28 rounded-2xl shadow-2xl shadow-brand-primary/30 ring-1 ring-white/10 splash-breathe"
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