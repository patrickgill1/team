//
//  AppIntent.swift
//  PlayerWidget
//
//  Configuration intent for the Player widget. User pastes the
//  setup code from GoalKickr → Settings → Widget. The code is a
//  long-lived per-user token; the widget uses it to fetch the
//  player snapshot from api.goalkickr.com on every refresh.
//

import WidgetKit
import AppIntents

struct ConfigurationAppIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource { "Player Widget" }
    static var description: IntentDescription {
        IntentDescription("Open GoalKickr → Settings → Widget, copy your setup code, then paste it here.")
    }

    @Parameter(
        title: "Setup code",
        description: "Paste the code shown in GoalKickr's Settings → Widget screen.",
        default: ""
    )
    var setupCode: String
}
