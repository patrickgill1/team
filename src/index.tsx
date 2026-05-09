import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App'; // Removed explicit extension
import { initNativeShell } from './utils/nativeShell';

// Native (iOS via Capacitor) setup — no-op on web.
initNativeShell();

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);