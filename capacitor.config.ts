import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.firefc.team',
  appName: 'Fire FC',
  // Capacitor copies whatever is in webDir into the iOS app bundle on `cap sync`.
  // CRA emits the production build into ./build, so we point at that.
  webDir: 'build',
  ios: {
    // 'never' = WebView extends edge-to-edge of the screen, including
    // under the notch and home indicator. Our app header has a `safe-top`
    // padding (env(safe-area-inset-top)) so its navy bg paints over the
    // notch region; the bottom tab bar has `safe-bottom` so its white bg
    // paints into the home-indicator region. With 'always', the WebView
    // was inset by the system and its own backgroundColor showed through
    // the safe-area edges — that's where the white strip at the top came
    // from. 'never' gives the page full control over both edges.
    contentInset: 'never',
    // White, so when iOS shrinks the WebView for the keyboard, the area
    // behind the keyboard's rounded top corners is white instead of a
    // dark navy underlay that bled through the corner blur. Tradeoff:
    // a possible brief (~50-100ms) white flash on splash → first React
    // paint. Worth it — chat is used constantly, splash is launch-only.
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
      // Safety ceiling only. Our React BrandedSplash hides the
      // native splash via hideSplash() as soon as it mounts — the
      // tight handoff avoids the flash Patrick reported. This 10s
      // value is just a paranoid backstop for the (rare) case where
      // React fails to mount; before, the 3000ms cap force-dismissed
      // the native splash on slow cold starts before React was
      // ready, leaving an ugly gap.
      launchShowDuration: 10000,
      autoHide: false,
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
      // 'native' resizes the WebView itself when the keyboard opens —
      // window.innerHeight drops by the keyboard height, so any
      // position:fixed bottom-anchored element automatically rides above
      // the keyboard with no JS offset gymnastics. This is what
      // iMessage/Telegram/Slack effectively do via UIScrollView.
      // (We tried 'none' + manual padding-bottom in the chat container, but
      // diagnostic HUD showed the WebView didn't honor any of our manual
      // offsets — composer stayed behind the keyboard at y=599.)
      resize: 'native' as any,
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
