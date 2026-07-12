// Sentry setup — error tracking for React on web AND inside the
// Capacitor WebView. Same SDK handles both because Capacitor is
// just a browser under the hood.
//
// Design choices vs. Sentry's copy-paste snippet:
//   - tracesSampleRate: 0 (not 1.0). Performance tracing is
//     quota-expensive on Sentry's free tier (10k transactions/mo)
//     and we don't need it to spot the reconnect/permission bugs
//     Patrick is chasing. Flip to 0.05 later if we want p95 latency
//     visibility.
//   - browserTracingIntegration DISABLED for the same reason —
//     it auto-instruments every route change into a transaction.
//   - Release stamp from package.json so we can filter by version
//     in the Sentry UI. Critical for OTA — a bug that only appears
//     on 3.9.147 needs to be tied to that bundle, not "current."
//   - DSN pulled from env so we can point local dev at a separate
//     project (or /dev/null) instead of polluting prod.
//   - beforeSend drops noise Sentry can't act on: ChunkLoadError
//     during a Vercel deploy (transient), Capgo "already up to date"
//     info messages, network aborts on view teardown.

import * as Sentry from '@sentry/react';

const RELEASE = process.env.REACT_APP_VERSION || 'unknown';

// Match the ChunkLoadError / Loading chunk N failed messages we
// already handle with the friendly "Updating GoalKickr" transient
// screen — no need to double-report to Sentry.
const NOISE_PATTERNS: RegExp[] = [
  /Loading chunk \d+ failed/i,
  /ChunkLoadError/i,
  /Loading CSS chunk/i,
  /ResizeObserver loop/i, // benign browser quirk
  /Non-Error promise rejection captured with keys/i, // firebase auth churn
];

export function initSentry() {
  const dsn = process.env.REACT_APP_SENTRY_DSN
    || 'https://23e32bc2b9be7a3adf259681cfc2fb36@o4511707482947584.ingest.us.sentry.io/4511707540881408';
  if (!dsn) return;

  const isProd = process.env.NODE_ENV === 'production';

  Sentry.init({
    dsn,
    release: RELEASE,
    environment: isProd ? 'production' : 'development',
    // Errors only for now. Turn tracing on later if we need it.
    tracesSampleRate: 0,
    // Never report a dev-server localhost error as if it were prod.
    enabled: isProd,
    beforeSend(event) {
      const msg = event.message || event.exception?.values?.[0]?.value || '';
      if (typeof msg === 'string' && NOISE_PATTERNS.some((p) => p.test(msg))) {
        return null;
      }
      return event;
    },
  });

  // Verification helpers for Sentry onboarding. Sentry's Getting
  // Started flow won't mark the project "verified" until it
  // receives its first event. Two ways to trigger, both harmless:
  //
  //   window.__sentryTest()         → throws an unhandled Error
  //                                  (captured by global handler)
  //   window.__sentryMessage()      → sends a captureMessage event
  //                                  (no console noise, no user
  //                                  impact); returns the event id
  //                                  so the DevTools console prints
  //                                  a UUID confirming the roundtrip
  //                                  instead of `undefined`
  //
  // Only wired when Sentry is actually enabled (production build) —
  // in dev the SDK no-ops which made a call return undefined and
  // misread as "helper missing" during the 3.9.235 audit.
  //
  // Call from Chrome DevTools on the deployed web app or Safari
  // Web Inspector on a physical device.
  if (isProd) {
    try {
      (window as any).__sentryTest = () => {
        throw new Error(`Sentry verification test — ${RELEASE}`);
      };
      (window as any).__sentryMessage = () => {
        const id = Sentry.captureMessage(`Sentry verification message — ${RELEASE}`, 'info');
        return id;
      };
    } catch { /* window unavailable in some SSR paths */ }
  }
}

/** Attach the current user to every subsequent error report. Call
 *  from AuthContext once userData resolves so we can filter Sentry
 *  by uid / email when a specific coach reports a bug. */
export function setSentryUser(user: { uid: string; email?: string; name?: string } | null) {
  if (!user) {
    Sentry.setUser(null);
    return;
  }
  Sentry.setUser({
    id: user.uid,
    email: user.email,
    username: user.name,
  });
}

/** Attach the currently-selected team to error context so a bug on
 *  a specific roster is easy to spot. Called from TeamContext on
 *  team change. */
export function setSentryTeam(teamId: string | null, teamName: string | null) {
  Sentry.setTag('teamId', teamId || '');
  Sentry.setTag('teamName', teamName || '');
}
