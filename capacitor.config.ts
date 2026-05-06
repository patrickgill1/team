import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.firefc.team',
  appName: 'Fire FC',
  // Capacitor copies whatever is in webDir into the iOS app bundle on `cap sync`.
  // CRA emits the production build into ./build, so we point at that.
  webDir: 'build',
  ios: {
    // Allow inline media playback (otherwise videos open in fullscreen Safari)
    // and let the WebView use the same JS engine as Safari.
    contentInset: 'always',
    // Background color while the WebView is booting / between routes.
    backgroundColor: '#0f172a',
    // Use the system status bar style (light text on our dark hero gradient).
    // The plugin actually drives this at runtime — see initStatusBar() below.
    limitsNavigationsToAppBoundDomains: false,
    // NOTE: `ios.scheme` here would override the Xcode build scheme name
    // (default 'App'). Leaving it unset so `cap run ios` finds the scheme.
  },
  server: {
    // Universal links / deep links resolve from these hostnames. Add any
    // production domain you want the app to claim. Apple-association file
    // (apple-app-site-association) must be served from each.
    hostname: 'firefc16.com',
    androidScheme: 'https',
    // For local development you can flip this to your dev box and live-reload
    // the React app inside the iOS simulator. Leave commented for releases.
    // url: 'http://192.168.1.50:3000',
    // cleartext: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: '#0f172a',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    PushNotifications: {
      // Show alerts even when the app is foregrounded (otherwise iOS swallows them).
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    Keyboard: {
      // Don't resize the WebView when the keyboard pops — let CSS handle it.
      resize: 'native',
    },
  },
};

export default config;
