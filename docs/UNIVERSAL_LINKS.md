# Universal Links / App Links — open firefc.app URLs in the native app

When this is set up, any link to `firefc.app` in an email, push notification,
text message, or web link auto-opens the app if installed; falls back to web
in the browser otherwise. iOS calls this **Universal Links**, Android calls
it **App Links**.

The Capacitor `appUrlOpen` listener that routes incoming URLs into
react-router is already wired in `src/utils/nativeShell.ts` — once the
platform-side setup below is done, the rest just works.

## iOS

### 1. Find your Apple Team ID

- Open Xcode → select the `App` target → **Signing & Capabilities** tab.
- The Team ID is shown next to your name (10-character alphanumeric, e.g.
  `ABC123DEF`).
- Alternatively: https://developer.apple.com/account → **Membership** →
  Team ID.

### 2. Patch the AASA file

The file lives at `public/.well-known/apple-app-site-association`. Open it
and replace `REPLACE_WITH_APPLE_TEAM_ID` with your Team ID. Final shape:

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["ABC123DEF.com.firefc.team"],
        "components": [{ "/": "/*" }]
      }
    ]
  }
}
```

`{"/": "/*"}` claims every path on `firefc.app`. If you ever want to keep a
specific path web-only (e.g. a marketing page), add another component with
`"exclude": true`.

### 3. Push to Vercel

Commit + push. Vercel serves it at `https://firefc.app/.well-known/apple-app-site-association`
with `Content-Type: application/json` (the `vercel.json` headers rule handles
that — Apple rejects the file if served as `application/octet-stream`).

Verify with:
```bash
curl -I https://firefc.app/.well-known/apple-app-site-association
# → HTTP/2 200 ; content-type: application/json
```

### 4. Enable Associated Domains in Xcode

- Xcode → `App` target → **Signing & Capabilities** → **+ Capability**
  (button near the top) → **Associated Domains**.
- A new section appears with a `+` button. Add: `applinks:firefc.app`
- (Optional during testing) add a second entry: `applinks:firefc.app?mode=developer`
  — this skips Apple's CDN cache so you don't have to wait an hour for AASA
  changes to propagate during initial setup.

This change modifies `App.entitlements`. Commit that file too.

### 5. Rebuild + reinstall on device

```bash
npm run build && npx cap sync ios
```

Then Run from Xcode on a physical device (Universal Links don't work in the
simulator). First launch on the device triggers iOS to fetch the AASA file
in the background. Wait ~30 seconds after first launch.

### 6. Test

- Send yourself a text or email containing `https://firefc.app/development`
- Tap the link. The app should open directly to the development page
  instead of Safari.
- If it opens Safari, see Troubleshooting below.

## Android (do this later)

Equivalent setup, different file:

### 1. Get the SHA-256 of your release signing key

```bash
keytool -list -v -keystore android/app/release.keystore -alias <your-alias>
```

Copy the `SHA256:` line (40-character colon-separated).

### 2. Create `public/.well-known/assetlinks.json`

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.firefc.team",
    "sha256_cert_fingerprints": ["SHA256:..."]
  }
}]
```

### 3. Add intent filters to `android/app/src/main/AndroidManifest.xml`

Inside the main `<activity>` tag:

```xml
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="https"
        android:host="firefc.app" />
</intent-filter>
```

### 4. Rebuild + verify

`npx cap sync android`, rebuild the AAB, install. Google verifies the
`assetlinks.json` on first install — links should open in the app immediately
after.

## Troubleshooting

- **Link still opens Safari, not the app**: AASA cache. Either wait ~1 hour
  for Apple's CDN, or in Xcode add `applinks:firefc.app?mode=developer` to
  Associated Domains, then long-press the link in Notes to verify ("Open in
  'Fire FC'" should appear in the menu).
- **AASA file 404s**: confirm the file exists at
  `public/.well-known/apple-app-site-association` (no `.json` extension —
  Apple rejects it with the extension) and that Vercel has redeployed.
- **`curl -I` shows `content-type: application/octet-stream`**: the
  `vercel.json` headers rule isn't matching. Check the source pattern.
- **App opens but lands on the wrong page**: check the `appUrlOpen` listener
  in `src/utils/nativeShell.ts` — it strips the host and pushes the path to
  react-router. If your URL has a redirect (`firefc.app/r/abc`), expand the
  path → route map there.
