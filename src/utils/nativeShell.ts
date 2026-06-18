// Native (Capacitor / iOS) bootstrap. Safe to import in pure-web builds —
// every Capacitor call is wrapped behind `Capacitor.isNativePlatform()` so
// running in a normal browser is a no-op.

import { Capacitor } from '@capacitor/core';

export async function initNativeShell(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    // Status bar: dark hero gradient looks best with light status bar text.
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Light });
    await StatusBar.setBackgroundColor({ color: '#8c1922' });
    // setOverlaysWebView({overlay:true}) lets the WebView paint the
    // ENTIRE screen including the safe-area-inset-top region (notch
    // / Dynamic Island). Without this, Capacitor on iOS creates a
    // separate strip above the WebView whose color it can't actually
    // control on iOS 14+ — Patrick saw it persist as navy regardless
    // of setBackgroundColor calls. With overlay=true the navigation
    // header (which has bg-charcoal-950 + safe-top padding) paints
    // the strip cleanly in brand color.
    await StatusBar.setOverlaysWebView({ overlay: true });
  } catch (err) {
    console.warn('StatusBar init failed', err);
  }

  // NOTE: splash dismissal moved to hideSplash() below. The old
  // behavior hid the splash as soon as initNativeShell resolved —
  // which fires before React first-paint, so the WebView was empty
  // (or showed an unstyled flash) for a frame. Now we wait until
  // App.tsx asks us to hide, after the React tree has actually
  // committed to the DOM.

  try {
    // Hardware back button + URL handling. Capacitor on iOS doesn't have a
    // hardware back button, but `appUrlOpen` fires for universal links and
    // custom-scheme URLs (e.g. firefc://vote/abc123).
    const { App } = await import('@capacitor/app');
    App.addListener('appUrlOpen', (data) => {
      try {
        const url = new URL(data.url);
        // Strip the host so react-router treats it as an in-app route.
        const path = url.pathname + url.search + url.hash;
        if (path && path !== '/') {
          window.history.pushState({}, '', path);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }
      } catch (err) {
        console.warn('appUrlOpen parse failed', data.url, err);
      }
    });
  } catch (err) {
    console.warn('App listener init failed', err);
  }
}

/**
 * Dismiss the native splash. Call this from React AFTER first paint so
 * the user never sees an empty WebView between splash and React tree.
 * Safe to call multiple times; SplashScreen.hide() is idempotent.
 */
export async function hideSplash(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide({ fadeOutDuration: 200 });
  } catch (err) {
    console.warn('SplashScreen hide failed', err);
  }
}

/**
 * Tell Capgo the current JS bundle booted to a working state. If we don't
 * call this within Capgo's appReadyTimeout (default 10s) after a new bundle
 * is applied, Capgo rolls back to the previous bundle on the next launch.
 * Without that signal, a broken bundle would brick every device that
 * downloaded it.
 *
 * Safe to call on every cold start — for the App-Store-shipped baseline
 * bundle it's a no-op, for an OTA-applied bundle it marks it as good.
 */
export async function notifyCapgoReady(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
    await CapacitorUpdater.notifyAppReady();
  } catch (err) {
    console.warn('Capgo notifyAppReady failed', err);
  }
}

/**
 * Subscribe to Capgo's download/install events so the app can show
 * a progress bar during download and an "Updating…" splash before
 * auto-reloading onto the new bundle. Returns an unsubscribe fn.
 *
 * Events:
 *  - download({ percent, bundle }) — fires throughout the download.
 *  - downloadComplete({ bundle })  — fires once the bundle is on disk.
 *  - downloadFailed({ version })   — fires if the download didn't finish.
 *  - majorAvailable                — fires when a new major bundle is detected.
 *
 * Caller-side:
 *  - onProgress({percent}) is invoked for each download tick.
 *  - onComplete() is invoked when the bundle is ready to apply.
 *  - The caller decides WHEN to apply (call reloadToLatestCapgoBundle()).
 */
export async function watchCapgoUpdate(handlers: {
  onProgress: (info: { percent: number }) => void;
  onComplete: () => void;
  onFailed?: () => void;
}): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
    const subs: Array<{ remove: () => Promise<void> }> = [];
    subs.push(await CapacitorUpdater.addListener('download', (info: any) => {
      handlers.onProgress({ percent: Number(info?.percent) || 0 });
    }));
    subs.push(await CapacitorUpdater.addListener('downloadComplete', () => {
      handlers.onComplete();
    }));
    subs.push(await CapacitorUpdater.addListener('downloadFailed' as any, () => {
      handlers.onFailed?.();
    }));
    return () => { for (const s of subs) { void s.remove(); } };
  } catch (err) {
    console.warn('Capgo listeners init failed', err);
    return () => {};
  }
}

/**
 * Switch the active WebView to the latest downloaded Capgo bundle
 * without forcing the user to force-quit the app. Call this AFTER a
 * brief "Updating…" splash so the swap feels intentional, not a crash.
 */
export async function reloadToLatestCapgoBundle(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
    await CapacitorUpdater.reload();
  } catch (err) {
    console.warn('Capgo reload failed', err);
  }
}

/**
 * Return the currently-running Capgo bundle's version string (e.g.
 * "3.1.14"). For the built-in bundle (App-Store-shipped, never OTA'd
 * over), this returns the binary's MARKETING_VERSION. Returns null on
 * web (no Capgo plugin) or if the call fails for any reason — the
 * caller should treat null as "I don't know" and fall back to
 * APP_VERSION from utils/version.ts.
 */
export async function getCurrentCapgoBundleVersion(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
    const result: any = await CapacitorUpdater.current();
    const v = result?.bundle?.version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Check current native push permission without prompting. Returns:
 *   'granted'   — user has approved, we can fetch a token
 *   'denied'    — user said no; OS will not re-prompt, send them to Settings
 *   'prompt'    — never asked OR asked-and-undecided; safe to call request
 *   'unsupported' — running in a browser, not a native shell
 */
export async function getPushPermissionState(): Promise<'granted' | 'denied' | 'prompt' | 'unsupported'> {
  if (!Capacitor.isNativePlatform()) return 'unsupported';
  try {
    const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');
    const perm = await FirebaseMessaging.checkPermissions();
    const r = perm.receive;
    if (r === 'granted') return 'granted';
    if (r === 'denied') return 'denied';
    return 'prompt';
  } catch (err) {
    console.warn('checkPermissions failed', err);
    return 'unsupported';
  }
}

// Push notifications — call this AFTER the user is signed in, so the FCM
// token can be saved to the user's Firestore doc. Uses
// @capacitor-firebase/messaging which returns FCM tokens directly (instead
// of raw APNs tokens), so the existing Worker /send-push endpoint works
// unchanged on iOS.
export async function registerPushNotifications(
  saveToken: (token: string) => void | Promise<void>,
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');

    // iOS prompts for permission here. On Android 13+ this also prompts.
    const perm = await FirebaseMessaging.requestPermissions();
    if (perm.receive !== 'granted') {
      console.info('Push permission not granted:', perm.receive);
      return;
    }

    // Get the current FCM token (registers with APNs under the hood on iOS).
    const { token } = await FirebaseMessaging.getToken();
    if (token) await saveToken(token);

    // Re-save if the token changes (e.g. on app reinstall, restore).
    await FirebaseMessaging.addListener('tokenReceived', async (e) => {
      if (e?.token) await saveToken(e.token);
    });

    // Foreground notifications — iOS already shows banners via the
    // presentationOptions in capacitor.config.ts; hook here for in-app UI.
    await FirebaseMessaging.addListener('notificationReceived', (n) => {
      console.debug('Push received in foreground', n);
    });

    // User tapped a notification. Route to the right place if payload
    // includes `path` (e.g. `/vote/<id>` or `/player/<id>`).
    await FirebaseMessaging.addListener('notificationActionPerformed', (a) => {
      const data = (a?.notification as any)?.data;
      const path = typeof data?.path === 'string' ? data.path
                : typeof data?.url === 'string' ? new URL(data.url, window.location.origin).pathname + new URL(data.url, window.location.origin).search
                : null;
      if (path && path.startsWith('/')) {
        window.history.pushState({}, '', path);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    });
  } catch (err) {
    console.warn('Push notifications init failed', err);
  }
}

// Light haptic feedback on tap. Wrapped so callers don't have to
// check isNativePlatform — on web this just no-ops. Used by the
// bottom tab bar to give iOS users the same micro-feedback they get
// when tapping native tabs.
let _hapticsCache: any = null;
export async function tapHaptic(style: 'light' | 'medium' = 'light'): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (!_hapticsCache) {
      _hapticsCache = await import('@capacitor/haptics');
    }
    const { Haptics, ImpactStyle } = _hapticsCache;
    const styleEnum = style === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light;
    await Haptics.impact({ style: styleEnum });
  } catch { /* ignore */ }
}
