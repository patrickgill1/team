//
//  PlayerWidgetBundle.swift
//  PlayerWidget
//
//  Trimmed to just PlayerWidget. The Xcode template also generates
//  a Control Center widget (PlayerWidgetControl) and a Live
//  Activity (PlayerWidgetLiveActivity) — both intentionally
//  removed for v1; revisit when there's a real use case (e.g. a
//  game-day Live Activity that shows running clock + score).
//

import WidgetKit
import SwiftUI

@main
struct PlayerWidgetBundle: WidgetBundle {
    var body: some Widget {
        PlayerWidget()
    }
}
