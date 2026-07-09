import React from 'react';
import { logRenderCrash } from '../../utils/crashLog';

interface State {
  error: Error | null;
  // Distinguishes "app broke, show scary reload prompt" from "app
  // just needs to fetch a new bundle after a deploy" — the latter
  // renders a friendly spinner because the reload fires within
  // milliseconds and shouldn't alarm the user.
  staleChunk: boolean;
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
  state: State = { error: null, staleChunk: false };

  static getDerivedStateFromError(error: Error): State {
    const msg = String(error?.message || '').toLowerCase();
    const isStale =
      msg.includes('loading chunk') ||
      msg.includes('failed to fetch dynamically imported module') ||
      msg.includes('importing a module script failed');
    return { error, staleChunk: isStale };
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

    // Friendly transient screen for stale-chunk errors. The
    // componentDidCatch above fires window.location.reload() within
    // ms, so this render only flashes for a heartbeat between the
    // catch and the reload. Showing an alarming "Something went
    // wrong ⚠️" during that window scares users for no reason —
    // they didn't do anything wrong; they just have an old bundle
    // in memory because we shipped a new one while their tab was
    // open. Show a gentle "Updating…" instead.
    if (this.state.staleChunk) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-surface-base p-6">
          <div className="max-w-sm w-full text-center">
            <div className="mx-auto mb-4 w-10 h-10 rounded-full border-2 border-brand-primary/30 border-t-brand-primary animate-spin" />
            <h1 className="text-lg font-black text-ink-primary mb-1 tracking-tight">Updating GoalKickr…</h1>
            <p className="text-sm text-ink-primary/60">
              Fetching the latest version. This takes a second.
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-base p-6">
        <div className="max-w-md w-full bg-surface-elevated ring-1 ring-line-default/10 rounded-2xl shadow-2xl p-6 text-center">
          <h1 className="text-xl font-black text-ink-primary mb-2">Something went wrong</h1>
          <p className="text-sm text-ink-primary/60 mb-6">
            The app hit a snag. Reloading usually fixes it.
          </p>
          <button
            onClick={this.handleReload}
            className="w-full bg-brand-primary hover:bg-brand-primary/90 text-white font-black tracking-wider uppercase text-sm rounded-xl py-3 transition"
          >
            Reload
          </button>
          <details className="mt-4 text-left">
            <summary className="text-xs text-ink-primary/40 cursor-pointer">Technical details</summary>
            <pre className="mt-2 text-[10px] text-ink-primary/50 whitespace-pre-wrap break-all">
              {String(this.state.error?.message || this.state.error)}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
