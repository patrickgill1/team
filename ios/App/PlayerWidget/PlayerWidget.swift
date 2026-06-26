//
//  PlayerWidget.swift
//  PlayerWidget
//
//  Home-screen widget that shows a single player's snapshot.
//  Branded charcoal-on-bone palette that matches the app (dark
//  charcoal-950 background, crimson accents, bone text). Fetches
//  every ~60 minutes from api.goalkickr.com/widget/snapshot using
//  the long-lived setup code the user pastes in the widget config.
//

import WidgetKit
import SwiftUI

// MARK: - Snapshot model (matches worker /widget/snapshot response)

struct PlayerSnapshot: Codable {
    let playerId: String
    let playerName: String
    let jerseyNumber: Int?
    let photoUrl: String?
    let teamName: String?
    let streakDays: Int
    let potmCount: Int?
    let nextEventTitle: String?
    let nextEventType: String?
    let nextEventDateMs: Double?
    let nextEventLocation: String?
    let nextEventRsvp: String?    // "going" | "maybe" | "no" | nil
    let lastResultTitle: String?
    let lastResultScore: String?
    let lastResultDateMs: Double?
    let generatedAt: Double

    static let placeholder = PlayerSnapshot(
        playerId: "preview",
        playerName: "Hunter Gill",
        jerseyNumber: 10,
        photoUrl: nil,
        teamName: "Fire FC",
        streakDays: 7,
        potmCount: 3,
        nextEventTitle: "Practice",
        nextEventType: "practice",
        nextEventDateMs: Date().addingTimeInterval(60 * 60 * 24).timeIntervalSince1970 * 1000,
        nextEventLocation: "West Field",
        nextEventRsvp: "going",
        lastResultTitle: "vs Spartans",
        lastResultScore: "W 3-1",
        lastResultDateMs: Date().addingTimeInterval(-60 * 60 * 48).timeIntervalSince1970 * 1000,
        generatedAt: Date().timeIntervalSince1970 * 1000
    )
}

private struct SnapshotResponse: Codable {
    let ok: Bool
    let error: String?
    let snapshot: PlayerSnapshot?
}

// MARK: - Networking

private let WIDGET_ENDPOINT = "https://api.goalkickr.com/widget/snapshot"

private func fetchSnapshot(setupCode: String) async -> (PlayerSnapshot?, String?) {
    guard !setupCode.isEmpty else { return (nil, "needs-setup") }
    // Cache-bust: append a per-second nonce AND set URLSession to
    // skip the local cache. Two layers of defense because iOS
    // widget extensions are aggressive about caching responses to
    // save battery, and a stale 'no events' payload can hang
    // around for hours otherwise.
    let nonce = Int(Date().timeIntervalSince1970)
    var req = URLRequest(url: URL(string: "\(WIDGET_ENDPOINT)?t=\(nonce)")!)
    req.httpMethod = "GET"
    req.setValue("Bearer \(setupCode)", forHTTPHeaderField: "Authorization")
    req.cachePolicy = .reloadIgnoringLocalCacheData
    req.timeoutInterval = 20
    do {
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { return (nil, "invalid-code") }
        if status != 200 { return (nil, "server") }
        let decoded = try JSONDecoder().decode(SnapshotResponse.self, from: data)
        if !decoded.ok { return (nil, decoded.error ?? "server") }
        return (decoded.snapshot, nil)
    } catch {
        return (nil, "offline")
    }
}

private func fetchImage(urlString: String?) async -> UIImage? {
    guard let urlString = urlString, let url = URL(string: urlString) else { return nil }
    do {
        let (data, _) = try await URLSession.shared.data(from: url)
        return UIImage(data: data)
    } catch {
        return nil
    }
}

// MARK: - TimelineProvider

struct PlayerEntry: TimelineEntry {
    let date: Date
    let snapshot: PlayerSnapshot?
    let photo: UIImage?
    let errorCode: String?
    let configuration: ConfigurationAppIntent
}

struct Provider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> PlayerEntry {
        PlayerEntry(date: Date(), snapshot: PlayerSnapshot.placeholder, photo: nil, errorCode: nil, configuration: ConfigurationAppIntent())
    }

    func snapshot(for configuration: ConfigurationAppIntent, in context: Context) async -> PlayerEntry {
        if context.isPreview {
            return PlayerEntry(date: Date(), snapshot: PlayerSnapshot.placeholder, photo: nil, errorCode: nil, configuration: configuration)
        }
        let (snap, err) = await fetchSnapshot(setupCode: configuration.setupCode)
        let img = await fetchImage(urlString: snap?.photoUrl)
        return PlayerEntry(date: Date(), snapshot: snap, photo: img, errorCode: err, configuration: configuration)
    }

    func timeline(for configuration: ConfigurationAppIntent, in context: Context) async -> Timeline<PlayerEntry> {
        let (snap, err) = await fetchSnapshot(setupCode: configuration.setupCode)
        let img = await fetchImage(urlString: snap?.photoUrl)
        let now = Date()
        let entry = PlayerEntry(date: now, snapshot: snap, photo: img, errorCode: err, configuration: configuration)
        let next = Calendar.current.date(byAdding: .hour, value: 1, to: now)!
        return Timeline(entries: [entry], policy: .after(next))
    }
}

// MARK: - Brand palette (matches the app's tokens)
//
// We force a dark charcoal background regardless of system
// appearance so the widget reads as "GoalKickr" on any home
// screen. The app itself is dark-mode-first (bone on charcoal),
// so the widget matches that aesthetic.

private extension Color {
    static let brand     = Color(red: 220 / 255, green:  38 / 255, blue:  38 / 255)
    static let brandDim  = Color(red: 153 / 255, green:  27 / 255, blue:  27 / 255)
    static let bone      = Color(red: 245 / 255, green: 242 / 255, blue: 232 / 255)
    static let boneSoft  = Color(red: 245 / 255, green: 242 / 255, blue: 232 / 255).opacity(0.65)
    static let boneDim   = Color(red: 245 / 255, green: 242 / 255, blue: 232 / 255).opacity(0.42)
    static let charcoal  = Color(red:  10 / 255, green:  12 / 255, blue:  16 / 255)
    static let charcoalLift = Color(red: 20 / 255, green: 24 / 255, blue: 32 / 255)
}

private let BRAND_GRADIENT = LinearGradient(
    colors: [Color.charcoal, Color.charcoalLift],
    startPoint: .topLeading,
    endPoint: .bottomTrailing
)

// MARK: - Sub-views

private struct BrandKicker: View {
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(Color.brand).frame(width: 6, height: 6)
            Text("GOALKICKR")
                .font(.system(size: 9, weight: .black))
                .kerning(1.8)
                .foregroundColor(.boneDim)
        }
    }
}

private struct AvatarView: View {
    let snap: PlayerSnapshot
    let photo: UIImage?
    let size: CGFloat
    let showJersey: Bool

    var body: some View {
        ZStack {
            Circle().fill(Color.brand.opacity(0.18))
            if let img = photo {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            } else {
                Text(initials(snap.playerName))
                    .font(.system(size: size * 0.38, weight: .heavy))
                    .foregroundColor(.brand)
            }
        }
        .frame(width: size, height: size)
        .overlay(
            Circle().stroke(Color.brand.opacity(0.55), lineWidth: 1.5)
        )
        .overlay(alignment: .bottomTrailing) {
            if showJersey, let n = snap.jerseyNumber {
                Text("\(n)")
                    .font(.system(size: size * 0.22, weight: .black))
                    .foregroundColor(.bone)
                    .frame(minWidth: size * 0.36, minHeight: size * 0.36)
                    .padding(.horizontal, 4)
                    .background(Circle().fill(Color.brand))
                    .overlay(Circle().stroke(Color.charcoal, lineWidth: 2))
                    .offset(x: size * 0.05, y: size * 0.05)
            }
        }
    }

    private func initials(_ name: String) -> String {
        let parts = name.split(separator: " ")
        let first = parts.first.map { String($0.prefix(1)) } ?? ""
        let last  = parts.count > 1 ? String(parts.last!.prefix(1)) : ""
        return (first + last).uppercased()
    }
}

private struct StreakBadge: View {
    let days: Int
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "flame.fill")
                .font(.system(size: 11, weight: .heavy))
                .foregroundColor(.brand)
            Text("\(days)d")
                .font(.system(size: 12, weight: .black))
                .foregroundColor(.bone)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Capsule().fill(Color.brand.opacity(0.15)))
        .overlay(Capsule().stroke(Color.brand.opacity(0.35), lineWidth: 1))
    }
}

private struct PotmBadge: View {
    let count: Int
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "star.fill")
                .font(.system(size: 10, weight: .heavy))
                .foregroundColor(.brand)
            Text("\(count)")
                .font(.system(size: 12, weight: .black))
                .foregroundColor(.bone)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Capsule().fill(Color.brand.opacity(0.10)))
        .overlay(Capsule().stroke(Color.brand.opacity(0.25), lineWidth: 1))
    }
}

private struct RsvpPill: View {
    let status: String   // "going" | "maybe" | "no"

    private var label: String {
        switch status {
        case "going": return "Going"
        case "maybe": return "Maybe"
        case "no":    return "Not going"
        default:      return status.capitalized
        }
    }

    private var tint: Color {
        switch status {
        case "going": return .brand
        case "maybe": return .bone
        case "no":    return .boneDim
        default:      return .boneSoft
        }
    }

    private var fillOpacity: Double {
        switch status {
        case "going": return 0.20
        case "maybe": return 0.10
        case "no":    return 0.08
        default:      return 0.10
        }
    }

    var body: some View {
        Text(label)
            .font(.system(size: 9, weight: .black))
            .kerning(0.4)
            .foregroundColor(tint)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(Capsule().fill(tint.opacity(fillOpacity)))
            .overlay(Capsule().stroke(tint.opacity(0.35), lineWidth: 1))
    }
}

private struct UpcomingRow: View {
    let snap: PlayerSnapshot
    var body: some View {
        if let title = snap.nextEventTitle, let ms = snap.nextEventDateMs {
            let date = Date(timeIntervalSince1970: ms / 1000)
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: iconFor(type: snap.nextEventType))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(.brand)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.bone)
                        .lineLimit(1)
                    HStack(spacing: 5) {
                        Text(date, style: .relative)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(.boneSoft)
                        if let rsvp = snap.nextEventRsvp {
                            RsvpPill(status: rsvp)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
        } else if let title = snap.lastResultTitle, let score = snap.lastResultScore {
            HStack(spacing: 8) {
                Image(systemName: "trophy.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(.brand)
                VStack(alignment: .leading, spacing: 0) {
                    Text(title)
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.bone)
                        .lineLimit(1)
                    Text(score)
                        .font(.system(size: 10, weight: .black))
                        .foregroundColor(.brand)
                }
                Spacer(minLength: 0)
            }
        } else {
            HStack(spacing: 8) {
                Image(systemName: "moon.zzz.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(.boneDim)
                Text("No upcoming events")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.boneSoft)
                Spacer(minLength: 0)
            }
        }
    }

    private func iconFor(type: String?) -> String {
        switch (type ?? "").lowercased() {
        case "game":      return "sportscourt.fill"
        case "practice":  return "figure.soccer"
        case "tournament": return "trophy.fill"
        default:          return "calendar"
        }
    }
}

// MARK: - State views

struct NeedsSetupView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            BrandKicker()
            Spacer(minLength: 0)
            Text("Tap to\nset up")
                .font(.system(size: 22, weight: .black))
                .foregroundColor(.bone)
                .lineSpacing(-2)
            Text("Long-press, Edit Widget, paste your code.")
                .font(.system(size: 10))
                .foregroundColor(.boneSoft)
                .lineLimit(3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(12)
    }
}

struct ErrorView: View {
    let code: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            BrandKicker()
            Spacer(minLength: 0)
            Text(code == "invalid-code" ? "Code\nexpired" : "Offline")
                .font(.system(size: 22, weight: .black))
                .foregroundColor(.bone)
            Text(code == "invalid-code"
                 ? "Open app, copy new code, paste here."
                 : "Trying again automatically.")
                .font(.system(size: 10))
                .foregroundColor(.boneSoft)
                .lineLimit(3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(12)
    }
}

// MARK: - Small layout (158x158)

struct SmallPlayerView: View {
    let snap: PlayerSnapshot
    let photo: UIImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                BrandKicker()
                Spacer(minLength: 0)
                StreakBadge(days: snap.streakDays)
            }
            Spacer(minLength: 0)
            HStack(alignment: .bottom, spacing: 10) {
                AvatarView(snap: snap, photo: photo, size: 56, showJersey: true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(firstName(snap.playerName))
                        .font(.system(size: 20, weight: .black))
                        .foregroundColor(.bone)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    if let last = lastName(snap.playerName) {
                        Text(last)
                            .font(.system(size: 13, weight: .heavy))
                            .foregroundColor(.boneSoft)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    } else if let team = snap.teamName {
                        Text(team)
                            .font(.system(size: 11, weight: .heavy))
                            .foregroundColor(.boneSoft)
                            .lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 6)
            // Bottom row: upcoming or last result. Always present.
            UpcomingRow(snap: snap)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(12)
    }

    private func firstName(_ n: String) -> String {
        n.split(separator: " ").first.map(String.init) ?? n
    }
    private func lastName(_ n: String) -> String? {
        let parts = n.split(separator: " ")
        guard parts.count > 1 else { return nil }
        return String(parts[1...].joined(separator: " "))
    }
}

// MARK: - Medium layout (~329x158)

struct MediumPlayerView: View {
    let snap: PlayerSnapshot
    let photo: UIImage?

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            AvatarView(snap: snap, photo: photo, size: 72, showJersey: true)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    BrandKicker()
                    Spacer(minLength: 0)
                }
                Text(snap.playerName)
                    .font(.system(size: 20, weight: .black))
                    .foregroundColor(.bone)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if let team = snap.teamName {
                    Text(team)
                        .font(.system(size: 11, weight: .heavy))
                        .kerning(0.4)
                        .foregroundColor(.boneSoft)
                        .lineLimit(1)
                }
                HStack(spacing: 6) {
                    StreakBadge(days: snap.streakDays)
                    if let n = snap.potmCount, n > 0 {
                        PotmBadge(count: n)
                    }
                    Spacer(minLength: 0)
                }
                Spacer(minLength: 0)
                Rectangle()
                    .fill(Color.bone.opacity(0.08))
                    .frame(height: 1)
                UpcomingRow(snap: snap)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(14)
    }
}

// MARK: - Entry view + Widget

struct PlayerWidgetEntryView: View {
    var entry: Provider.Entry
    @Environment(\.widgetFamily) var family

    var body: some View {
        Group {
            if entry.configuration.setupCode.isEmpty {
                NeedsSetupView()
            } else if let snap = entry.snapshot {
                switch family {
                case .systemSmall: SmallPlayerView(snap: snap, photo: entry.photo)
                default:           MediumPlayerView(snap: snap, photo: entry.photo)
                }
            } else if let code = entry.errorCode {
                ErrorView(code: code)
            } else {
                NeedsSetupView()
            }
        }
    }
}

struct PlayerWidget: Widget {
    let kind: String = "PlayerWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: ConfigurationAppIntent.self, provider: Provider()) { entry in
            PlayerWidgetEntryView(entry: entry)
                // Full-bleed branded background. `.containerBackground`
                // is the iOS 17 API that paints the widget chrome —
                // without it the system fills with .fill.quaternary
                // (the pale translucent default).
                .containerBackground(for: .widget) {
                    BRAND_GRADIENT
                }
        }
        .configurationDisplayName("Player")
        .description("Photo, streak, and next event for your player.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

#Preview(as: .systemSmall) {
    PlayerWidget()
} timeline: {
    PlayerEntry(date: .now, snapshot: PlayerSnapshot.placeholder, photo: nil, errorCode: nil, configuration: ConfigurationAppIntent())
}

#Preview(as: .systemMedium) {
    PlayerWidget()
} timeline: {
    PlayerEntry(date: .now, snapshot: PlayerSnapshot.placeholder, photo: nil, errorCode: nil, configuration: ConfigurationAppIntent())
}
