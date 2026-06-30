# GoalKickr Coach Watch

WatchOS companion app scaffold for GameDay.

## V1 Scope

- Receives the active GameDay session from the iPhone app via WatchConnectivity.
- Shows score, status, period, and a local live game clock.
- Shows the sub timer based on `lineup.shiftSeconds` and `lineup.lastBellAtSec`.
- Plays a watch haptic when the sub timer reaches zero.
- Sends quick actions back to the iPhone app:
  - `ourGoal`
  - `oppGoal`
  - `undoLast`
  - `subMade`
  - `pauseClock`

## Xcode Target Wiring

Add a new watchOS App target in `ios/App/App.xcodeproj`:

1. Open `ios/App/App.xcworkspace`.
2. File > New > Target.
3. Choose watchOS > App.
4. Product Name: `CoachWatch`.
5. Interface: SwiftUI.
6. Language: Swift.
7. Include Notification Scene: off for V1.
8. Add the files in this folder to the `CoachWatch` target.
9. Ensure the iOS `App` target embeds the Watch app.
10. Build the `App` scheme for an iPhone + Apple Watch simulator pair.

The iPhone-side bridge is implemented in `App/WidgetBridgePlugin.swift` so no separate Capacitor plugin target is required.
