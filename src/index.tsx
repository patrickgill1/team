import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App'; // Removed explicit extension
import { initNativeShell } from './utils/nativeShell';
import { initSentry } from './utils/sentry';
import { installStaleChunkGuard } from './utils/staleChunk';
import ErrorBoundary from './components/common/ErrorBoundary';

// Sentry FIRST so any error during shell/App bootstrap is captured.
// No-op in dev; sends to prod project in production builds.
initSentry();

// Stale-chunk auto-reload backstop. Catches the SyntaxError path
// (server returned HTML for a missing chunk hash) which webpack's
// script-tag loader surfaces at window-level, NOT through React's
// error boundary. Must install before any lazy() route mounts.
installStaleChunkGuard();

// Native (iOS via Capacitor) setup — no-op on web.
initNativeShell();

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);