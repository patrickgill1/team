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
    // White WebView bg so any region the page doesn't actively paint (e.g.
    // safe-area-inset around the home indicator) doesn't show a dark navy
    // strip behind the bottom tab bar. The page's own dark header still
    // covers the top notch area via its own bg.
    backgroundColor: '#ffffff',
    // Use the system status bar style (light text on our dark hero gradient).
    // The plugin actually drives this at runtime — see initStatusBar() below.
    limitsNavigationsToAppBoundDomains: false,
    // NOTE: `ios.scheme` here would override the Xcode build scheme name
    // (default 'App'). Leaving it unset so `cap run ios` finds the scheme.
  },
  server: {
    // NOTE: leaving hostname unset so Capacitor serves the bundled web build
    // from capacitor://localhost. Setting hostname to a real domain causes
    // WKWebView to attempt fetching from that domain instead of local files.
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
      // We handle keyboard position manually via Capacitor.Keyboard listeners
      // in TeamChat — see kbHeight state there. The 'native' mode's WebView
      // resize was flaky on iOS 17/18 (composer ended up behind the keyboard
      // anyway), so we set resize to 'none' and let our own offset drive the
      // chat container's bottom anchor. 'body' / 'ionic' both fight our
      // position:fixed layout. 'none' = full control.
      resize: 'none' as any,
    },
    FirebaseAuthentication: {
      // We sign into the web Firebase SDK ourselves with the credential the
      // native plugin returns; otherwise the native iOS Firebase Auth would
      // be signed in but the WebView's auth instance would still be empty.
      skipNativeAuth: true,
      providers: ['apple.com', 'google.com'],
    },
  },
};

export default config;
