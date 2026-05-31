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
    await StatusBar.setBackgroundColor({ color: '#0f172a' });
    // setOverlaysWebView({overlay:false}) shifts the WebView down past
    // the status bar. iOS needs this so content doesn't draw under
    // the notch / Dynamic Island. Android does NOT need it because
    // MainActivity already pads the activity root by the system-bar
    // insets — calling it on Android double-pads the WebView and
    // produces a tall empty navy strip above the app header.
    if (Capacitor.getPlatform() === 'ios') {
      await StatusBar.setOverlaysWebView({ overlay: false });
    }
  } catch (err) {
    console.warn('StatusBar init failed', err);
  }

  try {
    // Hide the launch splash once the React tree has rendered.
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide({ fadeOutDuration: 250 });
  } catch (err) {
    console.warn('SplashScreen hide failed', err);
  }

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
