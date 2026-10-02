//
//  AppIntent.swift
//  PlayerWidget
//
//  Configuration intent for the Player widget. Two parameters:
//    - setupCode: long-lived per-user token the user pastes once
//      (or gets written into the App Group automatically by the
//      Capacitor plugin when they open Settings → Widget).
//    - player: optional per-widget pick. When set, this widget
//      instance shows that specific player's snapshot. Lets the
//      user stack ONE widget per kid on the home screen, Tesla-
//      car-picker style. When unset, server falls back to the
//      user's default (widgetPlayerId → selfPlayerId → first
//      linked player).
//
//  The player list is fetched dynamically from
//  api.goalkickr.com/widget/candidates using the token stored in
//  the shared App Group (same place the setup code lives). Means
//  the user never has to paste anything to pick a player — the
//  Edit Widget sheet just lists their kids.
//

import WidgetKit
import AppIntents
import Foundation

// MARK: - WidgetPlayer AppEntity

struct WidgetPlayer: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        TypeDisplayRepresentation(name: "Player")
    }
    static var defaultQuery = WidgetPlayerQuery()

    var id: String
    var name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

// MARK: - Candidate fetch

private let CANDIDATES_ENDPOINT = "https://api.goalkickr.com/widget/candidates"
private let APP_GROUP_ID = "group.com.goalkickr.widget"
private let WIDGET_TOKEN_KEY = "global_token"

private struct CandidatesResponse: Decodable {
    let ok: Bool
    let candidates: [CandidateRow]?
    let error: String?
}

private struct CandidateRow: Decodable {
    let id: String
    let name: String
    let photoUrl: String?
    let isSelf: Bool?
}

private func sharedToken() -> String {
    let shared = UserDefaults(suiteName: APP_GROUP_ID)
    return shared?.string(forKey: WIDGET_TOKEN_KEY) ?? ""
}

private func fetchCandidates() async -> [WidgetPlayer] {
    let token = sharedToken()
    guard !token.isEmpty else { return [] }

    var components = URLComponents(string: CANDIDATES_ENDPOINT)!
    components.queryItems = [URLQueryItem(name: "token", value: token)]
    guard let url = components.url else { return [] }

    var req = URLRequest(url: url)
    req.httpMethod = "GET"
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.timeoutInterval = 10
    req.cachePolicy = .reloadIgnoringLocalCacheData

    do {
        let (data, _) = try await URLSession.shared.data(for: req)
        let decoded = try JSONDecoder().decode(CandidatesResponse.self, from: data)
        guard decoded.ok, let rows = decoded.candidates else { return [] }
        return rows.map { WidgetPlayer(id: $0.id, name: $0.name) }
    } catch {
        return []
    }
}

// MARK: - EntityQuery

struct WidgetPlayerQuery: EntityQuery {
    func entities(for identifiers: [WidgetPlayer.ID]) async throws -> [WidgetPlayer] {
        let all = await fetchCandidates()
        return all.filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [WidgetPlayer] {
        return await fetchCandidates()
    }

    // Deliberately NO defaultResult — nil means "use the user's
    // default pick on the server," which is what we want so a fresh
    // widget just works without the user editing anything.
}

// MARK: - Configuration intent

struct ConfigurationAppIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource { "Player Widget" }
    static var description: IntentDescription {
        IntentDescription("Shows a player's photo, streak, and next event. Long-press the widget → Edit Widget to pick which player.")
    }

    @Parameter(
        title: "Setup code",
        description: "Only needed for the very first widget. Open GoalKickr → Settings → Widget, copy the code, paste here. After that, every widget auto-finds your players.",
        default: ""
    )
    var setupCode: String

    @Parameter(
        title: "Player",
        description: "Which player this widget shows. Leave blank to show your default."
    )
    var player: WidgetPlayer?
}
