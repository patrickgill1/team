# iOS App Scaffold (Capacitor)

This branch wraps the existing React build in [Capacitor](https://capacitorjs.com/) so the same codebase ships to the App Store as a native iOS app. No UI rewrite required — the React app runs inside `WKWebView`, with native plugins for the iOS-specific bits.

## What was added on this branch

| File | Purpose |
| --- | --- |
| `capacitor.config.ts` | App ID (`com.firefc.team`), display name, splash/status-bar settings, deep-link host |
| `src/utils/nativeShell.ts` | Tiny init module — sets the status bar, hides the splash, handles universal links + push registration. **No-op on web.** |
| `src/index.tsx` | Calls `initNativeShell()` once on startup |
| `package.json` | New scripts: `ios:add`, `ios:sync`, `ios:open`, `ios:run` |
| Capacitor packages | core, ios, app, push-notifications, share, camera, status-bar, splash-screen, keyboard |

The `ios/` Xcode project is **not** generated yet — that's a one-time native step (see below) that requires Xcode and CocoaPods on your Mac.

## One-time setup

**Prerequisites** (macOS only):

1. **Xcode** (free from the App Store, ~12 GB) — the *full* app, not just Command Line Tools. Capacitor's `pod install` step calls `xcodebuild` which only ships with Xcode.app.
2. After Xcode finishes installing, open it once to accept the license, then point `xcode-select` at it:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -runFirstLaunch
   ```
3. **CocoaPods**: `brew install cocoapods` (already installed if `pod --version` works).
4. **Apple Developer account** ($99/yr) — required to ship to TestFlight / App Store. The simulator works without it.

**Project state in this branch:** `npm run ios:add` has already been run, so the `ios/` directory is checked in with the generated Xcode project, Podfile, Pods lockfile, and your web build copied into `ios/App/App/public/`. You don't need to re-run `ios:add` — just sync after every code change:

```bash
npm run ios:sync       # rebuild React + copy into the iOS bundle
```

If you ever delete `ios/` or want to regenerate from scratch:

```bash
rm -rf ios && npm run ios:add
```

> **Capacitor version note:** This branch pins Capacitor 7.x because Capacitor 8 requires Node 22+. CRA / react-scripts 5 is happiest on Node 20, so we stay there.

## ⚠ .env.local is required for local builds

CRA inlines `REACT_APP_*` env vars **at build time**. Vercel sets them on their build server, but locally there's nothing — so a `npm run build` here produces a bundle with empty Firebase config, which throws on init and renders a blank screen in the simulator.

Two ways to populate `.env.local`:

```bash
# Option A — pull from Vercel (recommended, no copy/paste)
npx vercel link        # one-time
npx vercel env pull .env.local

# Option B — copy from Vercel dashboard manually
cp .env.example .env.local
# edit .env.local and fill in REACT_APP_FIREBASE_* values
```

After either, **always re-sync**:
```bash
npm run ios:sync
```

`.env.local` is git-ignored. Don't commit it.

## Day-to-day workflow

```bash
npm run ios:sync      # rebuild React, copy to iOS bundle
npm run ios:open      # open the Xcode workspace
npm run ios:run       # build, sync, and launch in the simulator (one shot)
```

You only need `ios:add` once. After that, every code change is just `ios:sync` (which is `npm run build && cap sync ios`).

## What you'll get out of the box

- **Native app icon + splash** (replace defaults in Xcode → `App/Assets.xcassets`)
- **Status bar** matches the dark hero (`#0f172a`)
- **Native share sheet** when you call `navigator.share` (already used in PlayerProfile / PlayerMediaPage)
- **Camera + photo-library access** via `@capacitor/camera` if you want native capture
- **Universal links**: tapping a `https://firefc16.com/vote/abc123` link opens directly in the app — see *Deep linking* below
- **Push notifications**: scaffolded in `nativeShell.ts`, see *Push setup* below

## Deep linking (universal links)

`appUrlOpen` listener in `nativeShell.ts` already routes incoming URLs to react-router. To make `https://firefc16.com/...` links open the app, you need:

1. **Apple App Site Association file** at `https://firefc16.com/.well-known/apple-app-site-association` — JSON with your Team ID + bundle ID. Vercel can serve a static file.
2. Enable the **Associated Domains** capability in Xcode and add `applinks:firefc16.com`.

Until that's set up, links open in Safari like today. The custom scheme (`firefc://...`) works without any web-side config.

## Push notifications

**Good news:** the entire pipeline is already wired in this branch.

- Worker has `/send-push` (FCM HTTP v1, JWT-signed). No changes needed.
- `notify.ts` has `sendPushToUsers()` and `sendPushToPlayerParents()`.
- Client-side: `nativeShell.ts` calls `@capacitor-firebase/messaging` after sign-in, saves the FCM token to `users/<uid>.fcmTokens` via arrayUnion.
- Triggers: POTM win, dev plan, clip upload, parent whisper all fan out push notifications alongside the existing email.

### One-time platform setup (what you need to do once):

1. **Generate an APNs Auth Key** in [Apple Developer Console → Keys](https://developer.apple.com/account/resources/authkeys/list).
   - "+" → Enable **Apple Push Notifications service (APNs)** → continue
   - Download the `.p8` file (you only get one chance — save it somewhere safe)
   - Note the **Key ID** (10-char string) and your **Apple Team ID** (top-right of Apple Dev console)

2. **Upload the .p8 to Firebase**:
   - Firebase Console → Project Settings → **Cloud Messaging** tab
   - "Apple app configuration" → upload the `.p8` + Key ID + Team ID + your iOS bundle ID (`com.firefc.team`)
   - Save

3. **Enable Push Notifications in Xcode**:
   - Open `ios/App/App.xcworkspace` in Xcode
   - Select the `App` target → "Signing & Capabilities"
   - Click "+ Capability" → add **Push Notifications**
   - Click "+ Capability" → add **Background Modes** → check "Remote notifications"
   - This adds `aps-environment` to the entitlements file

4. **Test**: build to a real device (push doesn't work on simulator), sign in, look at the user's Firestore doc — `fcmTokens` array should have one entry. Trigger a POTM close or a clip upload and the device should buzz within 1-2 seconds.

### Native Google sign-in setup

The Google sign-in flow needs a separate iOS OAuth client (the web one doesn't work in the WebView).

1. [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. "+ CREATE CREDENTIALS" → "OAuth client ID" → Application type: **iOS**
   - Name: "Fire FC iOS"
   - Bundle ID: `com.firefc.team`
3. Copy the generated **iOS client ID** (looks like `1234567890-abc...apps.googleusercontent.com`)
4. Open it again to find the **iOS URL scheme** — Google reverses the client ID into a URL scheme like `com.googleusercontent.apps.1234567890-abc`
5. In Xcode → `App` target → Info → "URL Types" → "+", paste the reversed client ID into "URL Schemes"
6. Open `ios/App/App/Info.plist` (also visible in Xcode project navigator) and verify the URL scheme entry is there.

The plugin reads the iOS client ID from `GoogleService-Info.plist` if you have one, or you can hardcode it. Easiest path: download `GoogleService-Info.plist` from Firebase Console → Project Settings → "Your apps" → iOS app → drag it into the Xcode project at `ios/App/App/` (next to `Info.plist`). Make sure "Copy items if needed" is checked and the App target is selected.

### Sign in with Apple setup

Apple requires this whenever an app offers third-party sign-in (like Google).

1. [Apple Developer Console → Identifiers](https://developer.apple.com/account/resources/identifiers/list) → click your app's identifier (`com.firefc.team`)
2. Scroll to capabilities, check **Sign In with Apple** → Save
3. In Xcode → App target → Signing & Capabilities → "+ Capability" → **Sign In with Apple**
4. Firebase Console → Authentication → Sign-in method → enable **Apple** provider → enter your Services ID (or just toggle on; Firebase auto-derives from your bundle ID for native iOS)

The branch already has the "Continue with Apple" button on `SimpleAuth` — it only renders on the iOS app, hidden on web.

## Things that already work because the app is web

- Firebase Auth (email/password + Google sign-in) — works in `WKWebView` with no changes
- Firestore real-time listeners
- R2 / Cloudflare uploads via presigned URLs
- All the existing routes — react-router resolves them client-side inside the WebView

## Things to double-check before the App Store review

- [ ] **Privacy policy URL** (Apple requires one if you have accounts/auth). Vercel-hosted page is fine.
- [ ] **App Tracking Transparency** prompt if you use any cross-site tracking (Firebase Analytics counts — turn it off if you don't need it, otherwise add `NSUserTrackingUsageDescription` to `Info.plist`).
- [ ] **Camera + photo-library permission strings** in `Info.plist` (`NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`) — Capacitor adds placeholders, customize the copy.
- [ ] **App Transport Security** — Firestore + your Worker are HTTPS, so default settings work.
- [ ] **Sign in with Apple** — Apple requires this if you offer Google sign-in. ~30 min to add via Firebase.
- [ ] **Screenshots + privacy nutrition labels** in App Store Connect — separate web flow.

## Rough effort estimate

| Phase | Effort |
| --- | --- |
| Run `ios:add`, build to simulator, replace icon | 1 evening |
| Sign in with Apple integration | 1 evening |
| APNs cert + Worker push adapter | 1 weekend |
| TestFlight upload + invite testers | 1 evening |
| App Store review (screenshots, privacy nutrition labels) | 1 weekend |
| **Total to v1 in App Store** | **~1–2 weeks of part-time work** |

## Reverting

This is a branch (`ios-capacitor`). Nothing on main is touched. To abandon: `git checkout main && git branch -D ios-capacitor`.
