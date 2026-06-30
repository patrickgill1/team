import SwiftUI

@main
struct CoachWatchApp: App {
    @StateObject private var model = WatchGameModel()

    var body: some Scene {
        WindowGroup {
            WatchGameView()
                .environmentObject(model)
        }
    }
}
