import React, { Suspense, useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from './utils/firebase';
import { AuthProvider } from './contexts/AuthContext';
import { TeamProvider } from './contexts/TeamContext';
import { useAuth } from './hooks/useAuth';
import ProtectedRoute from './components/common/ProtectedRoute';
import Navigation from './components/common/Navigation';

// Eagerly load auth pages (needed immediately)
import SimpleAuth from './pages/SimpleAuth';
import PublicVote from './pages/PublicVote';
import PublicSurvey from './pages/PublicSurvey';
import PublicGame from './pages/PublicGame';
import PlayerJoin from './pages/PlayerJoin';

// Lazy load all other pages
const Dashboard = React.lazy(() => import('./pages/Dashboard'));
const Players = React.lazy(() => import('./pages/Players'));
const Stats = React.lazy(() => import('./pages/Stats'));
const News = React.lazy(() => import('./pages/News'));
const Calendar = React.lazy(() => import('./pages/CalendarPage'));
const ParentDirectory = React.lazy(() => import('./pages/ParentDirectory'));
const VolunteerScheduler = React.lazy(() => import('./pages/VolunteerScheduler'));
const AttendanceTracker = React.lazy(() => import('./pages/AttendanceTracker'));
const PlayerOfMatch = React.lazy(() => import('./pages/PlayerOfMatch'));
const TeamChat = React.lazy(() => import('./pages/TeamChat'));
const CoachJoin = React.lazy(() => import('./pages/CoachJoin'));
const TeamManagement = React.lazy(() => import('./pages/TeamManagement'));
const PlayerDevelopment = React.lazy(() => import('./pages/PlayerDevelopment'));
const PlayerMediaPage = React.lazy(() => import('./pages/PlayerMediaPage'));
const Highlights = React.lazy(() => import('./pages/Highlights'));
const SharedMedia = React.lazy(() => import('./pages/SharedMedia'));
const PlayerProfile = React.lazy(() => import('./pages/PlayerProfile'));
const Surveys = React.lazy(() => import('./pages/Surveys'));
const FullGames = React.lazy(() => import('./pages/FullGames'));
const GameDay = React.lazy(() => import('./pages/GameDay'));

const PageSpinner = () => (
  <div className="min-h-screen bg-fire-50 flex items-center justify-center">
    <div className="flex flex-col items-center space-y-3">
      <div className="animate-spin rounded-full h-10 w-10 border-2 border-cyan-200 border-t-cyan-500" />
      <span className="text-sm text-fire-400 font-medium">Loading...</span>
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
      if (!userData || userData.role !== 'parent') {
        setGateReason('none');
        setChecking(false);
        return;
      }
      // Check approval first
      const userAny = userData as any;
      if (userAny.approved === false) {
        setGateReason('pending-approval');
        setChecking(false);
        return;
      }
      // Then check player link (with timeout so mobile doesn't hang)
      try {
        const q = query(
          collection(db, 'players'),
          where('parentIds', 'array-contains', userData.uid)
        );
        const snap = await Promise.race([
          getDocs(q),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))
        ]);
        setGateReason(snap === null || snap.empty ? 'not-linked' : 'none');
      } catch {
        setGateReason('none'); // fail open so they aren't stuck
      }
      setChecking(false);
    };
    checkAccess();

    // Safety timeout: never leave the checking spinner up forever
    const timer = setTimeout(() => {
      setChecking(false);
      setGateReason('none'); // fail open
    }, 6000);
    return () => clearTimeout(timer);
  }, [userData?.uid, userData?.role]);

  if (checking) {
    return (
      <div className="min-h-screen bg-fire-50 flex items-center justify-center">
        <div className="flex flex-col items-center space-y-3">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-cyan-200 border-t-cyan-500" />
          <span className="text-sm text-fire-400 font-medium">Loading...</span>
        </div>
      </div>
    );
  }

  if (gateReason === 'pending-approval') {
    return (
      <div className="min-h-screen bg-fire-50 flex items-center justify-center px-4">
        <div className="max-w-sm w-full text-center">
          <div className="text-6xl mb-4">🔒</div>
          <h1 className="text-2xl font-bold text-fire-950 mb-2">Waiting for Approval</h1>
          <p className="text-gray-600 mb-6">
            Your account has been created but needs to be approved by a coach before you can access the team.
          </p>
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-left text-sm text-amber-800 mb-6">
            <p className="font-medium mb-1">Your email:</p>
            <p className="font-mono bg-amber-100 px-2 py-1 rounded-lg">{userData?.email}</p>
          </div>
          <button
            onClick={() => { window.location.reload(); }}
            className="w-full bg-cyan-600 text-white rounded-2xl py-3 font-semibold hover:bg-cyan-700 transition-colors mb-3"
          >
            Check Again
          </button>
          <button
            onClick={logout}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  if (gateReason === 'not-linked') {
    return (
      <div className="min-h-screen bg-fire-50 flex items-center justify-center px-4">
        <div className="max-w-sm w-full text-center">
          <div className="text-6xl mb-4">⏳</div>
          <h1 className="text-2xl font-bold text-fire-950 mb-2">Almost There!</h1>
          <p className="text-gray-600 mb-6">
            Your account is approved! A coach just needs to link you to your child's player profile and everything will appear automatically.
          </p>
          <div className="bg-fire-100 border border-fire-200 rounded-2xl p-4 text-left text-sm text-fire-800 mb-6">
            <p className="font-medium mb-1">Let your coach know:</p>
            <p>Edit the player → add <span className="font-mono bg-fire-200 px-1 rounded-lg">{userData?.email}</span> as a parent email.</p>
          </div>
          <button
            onClick={() => { window.location.reload(); }}
            className="w-full bg-cyan-600 text-white rounded-2xl py-3 font-semibold hover:bg-cyan-700 transition-colors mb-3"
          >
            Check Again
          </button>
          <button
            onClick={logout}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-fire-50">
      <Navigation />
      {/* Main content: offset for desktop sidebar + mobile top/bottom bars */}
      <main className="lg:ml-64 pt-14 lg:pt-0 pb-20 lg:pb-0">
        {children}
      </main>
    </div>
  );
};

function App() {
  return (
    <AuthProvider>
      <TeamProvider>
        <Router>
          <Suspense fallback={<PageSpinner />}>
          <div className="App">
            <Routes>
              {/* Public Routes - NO ProtectedRoute wrapper */}
              <Route path="/auth" element={<SimpleAuth />} />
              <Route path="/login" element={<Navigate to="/auth" replace />} />
              <Route path="/setup" element={<Navigate to="/auth" replace />} />
              <Route path="/vote/:votingId" element={<PublicVote />} />
              <Route path="/join" element={<PlayerJoin />} />
              <Route path="/coach-join" element={<CoachJoin />} />
              <Route path="/media/:mediaId" element={<SharedMedia />} />
              <Route path="/survey/:surveyId" element={<PublicSurvey />} />
              <Route path="/game/:gameId" element={<PublicGame />} />
            
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
                  <TeamChat />
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
            
            <Route path="/news" element={
              <ProtectedRoute>
                <AppLayout>
                  <News />
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

            <Route path="/game-day/:eventId" element={
              <ProtectedRoute>
                <AppLayout>
                  <GameDay />
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
      </TeamProvider>
    </AuthProvider>
  );
}

export default App;