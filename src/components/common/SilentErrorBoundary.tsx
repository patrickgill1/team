import React from 'react';

interface Props {
  /** Tag included in [silent-eb] console.error so the source is
   *  identifiable in logs (e.g. 'message-bubble', 'chat-surface'). */
  label?: string;
  /** Fallback UI to render when children throw. Defaults to nothing
   *  (silent — keeps the surrounding container intact). */
  fallback?: React.ReactNode;
  /** Optional callback fired once per error with the error object,
   *  so the caller can log to telemetry without a custom boundary. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Local, non-fatal error boundary. Unlike the top-level ErrorBoundary
 * (which swaps the entire UI for a "Something went wrong" page),
 * this catches a render error inside a specific subtree and renders
 * `fallback` in its place — the rest of the page keeps working.
 *
 * Used in chat (per-message + chat-surface) so a single bad message
 * doc or one wedged thread can't take the whole inbox down. Patrick
 * 2026-06-25: 'we need chat to be something that never fails, or if
 * it does, they should not see any other page other than the actual
 * chats.'
 */
class SilentErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[silent-eb${this.props.label ? `:${this.props.label}` : ''}] caught:`, error, info?.componentStack);
    this.props.onError?.(error, info);
  }

  render() {
    if (this.state.error) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}

export default SilentErrorBoundary;
