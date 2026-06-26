# Player widget — Xcode setup

The widget target already exists in `ios/App/App.xcodeproj`. These
notes cover the remaining wiring you'll do in Xcode before the
widget can build, run, or ship.

## 1. Verify target settings (one-time)

Open the Xcode project (`npm run ios:open`), pick the **PlayerWidget**
target, then:

- **General → Minimum Deployments**: iOS 17.0 (`AppIntentConfiguration`
  requires it).
- **Signing & Capabilities**: same team as the App target.
- **Bundle Identifier**: `com.firefc.team.PlayerWidget` (or whatever
  the Xcode template generated — must be a child of the App's
  bundle ID).

If signing complains about provisioning, click "Try Again" — Xcode
will create the widget extension provisioning profile under the
same team.

## 2. Build + run locally

- Plug in your iPhone (or use a simulator running iOS 17+).
- In Xcode's scheme selector (top toolbar), pick the **App** scheme
  + your device.
- Cmd+R.
- After the app launches, swipe to home screen → long-press empty
  area → tap **+** in top left → search "GoalKickr" → add the
  Player widget (small or medium).
- Long-press the new widget → **Edit Widget** → paste the setup
  code from GoalKickr → Settings → Widget.
- The widget should populate within ~5 seconds (one network round
  trip to `api.goalkickr.com/widget/snapshot`).

## 3. Ship to the App Store

Widgets ship inside the App bundle — no separate review track.
What changes vs a normal release:

1. Bump the **iOS App** target version (the binary version, not
   `package.json`). Go to App target → General → Version + Build.
2. Bump the **PlayerWidget** target version to match.
3. Product → Archive → Distribute App → App Store Connect.
4. App Store Connect: under the new build, you'll see the widget
   extension listed automatically. No separate metadata required.
5. Review usually takes 24-72h; widget extensions don't trigger
   the longer "new app" review path.

## 4. Architecture (so future-you remembers)

```
iPhone home screen widget
        │
        │  every ~hour
        │  Authorization: Bearer <setupCode>
        ▼
api.goalkickr.com/widget/snapshot
        │
        │  matches setupCode → users/{uid}.widgetToken
        │  resolves user.selfPlayerId OR widgetPlayerId OR first parented player
        │  reads players/{playerId} + upcoming events
        ▼
JSON { playerName, photoUrl, streakDays, nextEventTitle, ... }
```

Token model: long-lived, stored on `users/{uid}.widgetToken`.
Generated client-side from `crypto.getRandomValues` (24 url-safe
chars). Rotatable from the Settings card. NO Firebase Auth in the
widget — the bearer token IS the auth.

## 5. Known limitations / followups

- **Multi-kid families**: today we show `selfPlayerId` (adult player
  path) → `widgetPlayerId` (explicit pick, not exposed in UI yet) →
  first parented player. The "pick which kid" UI doesn't exist; add
  it under Settings → Widget when a multi-kid family asks. The
  worker already honors `widgetPlayerId`.
- **No App Group**: tradeoff for v1 simplicity. If the worker is
  down, the widget shows the "Can't connect" view rather than the
  last cached snapshot. Add App Group + cache when this becomes a
  real complaint.
- **Brand color**: widget uses the default crimson palette. Adding
  per-club re-tinting would require pushing the resolved brand
  color from the snapshot into the widget; haven't wired it yet.
- **Live Activity**: deleted from `PlayerWidgetBundle.swift` — keep
  in mind for a future game-day clock + score Live Activity.
