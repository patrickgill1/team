import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App'; // Removed explicit extension
import { initNativeShell } from './utils/nativeShell';
import { initSentry } from './utils/sentry';
import ErrorBoundary from './components/common/ErrorBoundary';

// Sentry FIRST so any error during shell/App bootstrap is captured.
// No-op in dev; sends to prod project in production builds.
initSentry();

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