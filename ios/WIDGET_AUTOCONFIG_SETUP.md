# iOS Widget Auto-Config — Manual Setup Steps

The Swift `WidgetBridgePlugin`, entitlements files, and the
`PlayerWidget.swift` App Group fallback are all in source. To make
them actually work, you need to do two manual steps that Apple
doesn't let any tool automate.

## Step 1 — Apple Developer Portal (one time, ~5 min)

1. Go to https://developer.apple.com/account → **Identifiers**.
2. Filter by **App Groups** in the top-right dropdown.
3. Click **+** (top-left), pick **App Groups**, Continue.
4. Description: `GoalKickr Widget Shared`
5. Identifier: `group.com.firefc.team.widget`
   (must match exactly — this is hardcoded in
   `WidgetBridgePlugin.swift` and `PlayerWidget.swift`)
6. Continue → Register.

If you ever rotate App IDs or use a different team, the group ID
stays the same — App Groups are global per developer account.

## Step 2 — Xcode (one time per machine, ~3 min)

1. Open `ios/App/App.xcworkspace` (NOT the `.xcodeproj`).
2. In the project navigator, click the **App** project (top-level
   blue icon), then in the right pane click the **App** target
   (NOT the project, NOT the widget).
3. Click the **Signing & Capabilities** tab.
4. Click **+ Capability** (top-left of that tab) → search **App
   Groups** → double-click it.
5. In the new App Groups section that appears, the table will be
   empty. Click **+** below the table to add a group.
   - If the cloud-sync icon next to your team name is spinning,
     wait for it (Xcode is syncing the identifier you created in
     Step 1).
   - Once it stops, `group.com.firefc.team.widget` should appear
     as an option. Check the box next to it.
6. **Now repeat 2–5 for the PlayerWidget target.** Click the
   `PlayerWidget` target in the same target list, repeat Signing
   & Capabilities → + Capability → App Groups → check the same
   group ID.

Xcode will rewrite both entitlements files (`App/App.entitlements`
and `PlayerWidget/PlayerWidget.entitlements`) — they should
already have the `application-groups` key from this commit, so
the diff will be a no-op. If Xcode insists on rewriting it
"correctly," let it.

## Step 3 — Verify

1. Clean build (Product → Clean Build Folder).
2. Build the App target onto a device or simulator.
3. Open GoalKickr → Settings → Widget. Tap **Generate setup
   code** if there isn't one already.
4. Long-press the home screen → + → search GoalKickr → add the
   Player widget.
5. The widget should populate within ~3 seconds — no code paste
   required.

If it shows "Tap to set up" instead:
- Confirm both targets have the App Group capability checked.
- Confirm the group ID is exactly `group.com.firefc.team.widget`
  in BOTH the Apple Developer Portal and Xcode.
- Open Console.app, filter for "PlayerWidget", look for any
  "Couldn't open App Group" entries — usually means the
  provisioning profile didn't pick up the new entitlement
  (Xcode → Product → Archive normally regenerates; otherwise
  delete the provisioning profile and let Xcode re-download).

## What the user sees

Before: Settings → Widget → Generate → Copy → Add Widget → Edit
Widget → Paste → Done (7 steps, 24-char string).

After: Settings → Widget → Generate → Add Widget → Done (3 steps,
nothing to type).
