import React from 'react';

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
            className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-semibold rounded-xl py-3 transition-colors"
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
