import React from 'react';
import { logRenderCrash } from '../../utils/crashLog';

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary. Without one, any unhandled React render error
 * (a single component throwing) blanks the entire app — which on iOS is
 * indistinguishable from a crash for users. With this, we keep the chrome
 * and show a recovery card.
 *
 * Reset key resets the boundary when the route changes, so a stuck error
 * on one page doesn't permanently break navigation.
 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep the stack visible in the iOS Safari Web Inspector + Vercel logs.
    console.error('[ErrorBoundary] render crashed:', error, info?.componentStack);
    // And persist to crash_logs so we can read the actual error from
    // Firestore Console after the user reports the bug — console
    // history is gone by the time they explain what happened.
    logRenderCrash(error, info, 'top-level');

    // Auto-recover from stale-chunk errors. When Vercel deploys a new
    // build, hashed chunk filenames change — any open tab still
    // holding the old index.html will 404 the next lazy-loaded route
    // ("Loading chunk 870 failed"). A single hard reload fetches the
    // new index.html and resolves it. We only retry once per session
    // so an infinite loop on a real bug doesn't spin the user.
    const msg = String(error?.message || '').toLowerCase();
    const looksLikeStaleChunk =
      msg.includes('loading chunk') ||
      msg.includes('failed to fetch dynamically imported module') ||
      msg.includes('importing a module script failed');
    if (looksLikeStaleChunk) {
      const KEY = 'firefc.chunkReloadAt';
      const last = Number(sessionStorage.getItem(KEY) || 0);
      // Don't retry more than once in 60s.
      if (Date.now() - last > 60_000) {
        try { sessionStorage.setItem(KEY, String(Date.now())); } catch {}
        window.location.reload();
      }
    }
  }

  handleReload = () => {
    // Hard reload so any wedged state is gone. On Capacitor this reloads
    // the WebView from the bundled index.html.
    try {
      window.location.reload();
    } catch {
      this.setState({ error: null });
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-6 text-center">
          <div className="text-5xl mb-3">⚠️</div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Something went wrong</h1>
          <p className="text-sm text-gray-600 mb-6">
            The app hit a snag. Reloading usually fixes it.
          </p>
          <button
            onClick={this.handleReload}
            className="w-full bg-brand-primary hover:bg-brand-primary text-white font-semibold rounded-xl py-3 transition-colors"
          >
            Reload
          </button>
          <details className="mt-4 text-left">
            <summary className="text-xs text-gray-400 cursor-pointer">Technical details</summary>
            <pre className="mt-2 text-[10px] text-gray-500 whitespace-pre-wrap break-all">
              {String(this.state.error?.message || this.state.error)}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
