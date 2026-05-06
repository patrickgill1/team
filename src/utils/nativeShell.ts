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
    // Keep the WebView *below* the status bar so the notch / Dynamic Island
    // doesn't draw on top of the page content.
    await StatusBar.setOverlaysWebView({ overlay: false });
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

// Push notifications — call this AFTER the user is signed in, so we know
// which Firestore user record to attach the device token to.
export async function registerPushNotifications(
  onToken: (token: string) => void | Promise<void>,
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;

    await PushNotifications.register();

    PushNotifications.addListener('registration', (t) => {
      onToken(t.value);
    });
    PushNotifications.addListener('registrationError', (err) => {
      console.warn('Push registration error', err);
    });
    PushNotifications.addListener('pushNotificationReceived', (n) => {
      // Foreground push — iOS will show the banner via presentationOptions
      // in capacitor.config.ts. Hook here if you want in-app toasts.
      console.debug('Push received', n);
    });
    PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
      // User tapped a notification. Route to the right place if the payload
      // includes a `path` (e.g. `/vote/<id>`).
      const path = (a.notification.data as any)?.path;
      if (typeof path === 'string' && path.startsWith('/')) {
        window.history.pushState({}, '', path);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    });
  } catch (err) {
    console.warn('Push notifications init failed', err);
  }
}
