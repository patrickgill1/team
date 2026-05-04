import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import ProtectedRoute from './components/common/ProtectedRoute';
import Navigation from './components/common/Navigation';

// Pages
import Login from './pages/Login';
import Setup from './pages/Setup';
import Dashboard from './pages/Dashboard';
import Players from './pages/Players';
import Stats from './pages/Stats';
import News from './pages/News';
import Calendar from './pages/CalendarPage';
import Gallery from './pages/GalleryPage';

// Layout component for authenticated pages
const AppLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation />
      <main>{children}</main>
    </div>
  );
};

function App() {
  return (
    <AuthProvider>
      <Router>
        <div className="App">
          <Routes>
            {/* Public Routes */}
            <Route path="/login" element={<Login />} />
            <Route path="/setup" element={<Setup />} />
            
            {/* Protected Routes */}
            <Route path="/" element={
              <ProtectedRoute>
                <Navigate to="/dashboard" replace />
              </ProtectedRoute>
            } />
            
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
            
            <Route path="/gallery" element={
              <ProtectedRoute>
                <AppLayout>
                  <Gallery />
                </AppLayout>
              </ProtectedRoute>
            } />
            
            {/* Catch all route - redirect to dashboard */}
            <Route path="*" element={
              <ProtectedRoute>
                <Navigate to="/dashboard" replace />
              </ProtectedRoute>
            } />
          </Routes>
        </div>
      </Router>
    </AuthProvider>
  );
}

export default App;