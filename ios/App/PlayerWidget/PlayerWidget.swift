//
//  PlayerWidget.swift
//  PlayerWidget
//
//  Home-screen widget that shows a single player's snapshot:
//  photo, name, jersey, streak, and next event. Fetches every
//  ~60 minutes from api.goalkickr.com/widget/snapshot using a
//  long-lived setup code the user pastes in the widget config.
//

import WidgetKit
import SwiftUI

// MARK: - Snapshot model (matches worker /widget/snapshot response)

struct PlayerSnapshot: Codable {
    let playerId: String
    let playerName: String
    let jerseyNumber: Int?
    let photoUrl: String?
    let streakDays: Int
    let nextEventTitle: String?
    let nextEventDateMs: Double?
    let nextEventLocation: String?
    let potmCount: Int?
    let generatedAt: Double

    static let placeholder = PlayerSnapshot(
        playerId: "preview",
        playerName: "Your player",
        jerseyNumber: 9,
        photoUrl: nil,
        streakDays: 7,
        nextEventTitle: "Practice",
        nextEventDateMs: Date().addingTimeInterval(60 * 60 * 24).timeIntervalSince1970 * 1000,
        nextEventLocation: "West Field",
        potmCount: 2,
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
    var req = URLRequest(url: URL(string: WIDGET_ENDPOINT)!)
    req.httpMethod = "GET"
    req.setValue("Bearer \(setupCode)", forHTTPHeaderField: "Authorization")
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
        // Refresh hourly. iOS coalesces; treat as a hint, not a guarantee.
        let next = Calendar.current.date(byAdding: .hour, value: 1, to: now)!
        return Timeline(entries: [entry], policy: .after(next))
    }
}

// MARK: - Brand colors (match the app's --brand-primary defaults)

private extension Color {
    static let brand = Color(red: 220 / 255, green: 38 / 255, blue: 38 / 255)
    static let brandDeep = Color(red: 153 / 255, green: 27 / 255, blue: 27 / 255)
    static let bone = Color(red: 245 / 255, green: 242 / 255, blue: 232 / 255)
}

// MARK: - Views

struct NeedsSetupView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("GoalKickr")
                .font(.system(size: 11, weight: .heavy)).kerning(1.5)
                .foregroundColor(.brand)
            Text("Tap to set up")
                .font(.system(size: 18, weight: .bold))
                .foregroundColor(.bone)
            Text("Long-press, Edit Widget, then paste the setup code from the app.")
                .font(.system(size: 11))
                .foregroundColor(.bone.opacity(0.65))
                .lineLimit(4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct ErrorView: View {
    let code: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("GoalKickr").font(.system(size: 11, weight: .heavy)).kerning(1.5).foregroundColor(.brand)
            Text(code == "invalid-code" ? "Setup code expired" : "Can't connect")
                .font(.system(size: 16, weight: .bold)).foregroundColor(.bone)
            Text(code == "invalid-code"
                 ? "Open GoalKickr, Settings, Widget, and paste the latest code."
                 : "We'll try again automatically.")
                .font(.system(size: 11)).foregroundColor(.bone.opacity(0.6)).lineLimit(3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct AvatarView: View {
    let snap: PlayerSnapshot
    let photo: UIImage?
    var size: CGFloat = 48
    var body: some View {
        ZStack {
            Circle().fill(Color.brand.opacity(0.18)).frame(width: size, height: size)
            if let img = photo {
                Image(uiImage: img).resizable().scaledToFill().frame(width: size, height: size).clipShape(Circle())
            } else {
                Text(initials(snap.playerName))
                    .font(.system(size: size * 0.4, weight: .heavy))
                    .foregroundColor(.brand)
            }
            if let n = snap.jerseyNumber {
                Text("#\(n)")
                    .font(.system(size: 10, weight: .heavy))
                    .foregroundColor(.bone)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(Color.brand))
                    .offset(x: size * 0.32, y: size * 0.32)
            }
        }
        .frame(width: size + 16, height: size + 16)
    }

    private func initials(_ name: String) -> String {
        let parts = name.split(separator: " ")
        let first = parts.first.map { String($0.prefix(1)) } ?? ""
        let last = parts.count > 1 ? String(parts.last!.prefix(1)) : ""
        return (first + last).uppercased()
    }
}

struct SmallPlayerView: View {
    let snap: PlayerSnapshot
    let photo: UIImage?
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            AvatarView(snap: snap, photo: photo, size: 44)
            Text(snap.playerName)
                .font(.system(size: 13, weight: .bold))
                .foregroundColor(.bone)
                .lineLimit(1)
            HStack(spacing: 4) {
                Image(systemName: "flame.fill").font(.system(size: 10)).foregroundColor(.brand)
                Text("\(snap.streakDays) day streak")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.bone.opacity(0.8))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct MediumPlayerView: View {
    let snap: PlayerSnapshot
    let photo: UIImage?
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            AvatarView(snap: snap, photo: photo, size: 56)
            VStack(alignment: .leading, spacing: 6) {
                Text(snap.playerName)
                    .font(.system(size: 18, weight: .heavy))
                    .foregroundColor(.bone)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Image(systemName: "flame.fill").font(.system(size: 11)).foregroundColor(.brand)
                    Text("\(snap.streakDays)d")
                        .font(.system(size: 12, weight: .heavy)).foregroundColor(.bone)
                    if let n = snap.potmCount, n > 0 {
                        Text("·").foregroundColor(.bone.opacity(0.3))
                        Image(systemName: "star.fill").font(.system(size: 11)).foregroundColor(.brand)
                        Text("\(n) POTM").font(.system(size: 12, weight: .heavy)).foregroundColor(.bone)
                    }
                }
                Divider().background(Color.bone.opacity(0.15)).padding(.vertical, 1)
                NextEventRow(snap: snap)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct NextEventRow: View {
    let snap: PlayerSnapshot
    var body: some View {
        if let title = snap.nextEventTitle, let ms = snap.nextEventDateMs {
            let date = Date(timeIntervalSince1970: ms / 1000)
            VStack(alignment: .leading, spacing: 2) {
                Text("Next up").font(.system(size: 9, weight: .heavy)).kerning(1.2).foregroundColor(.bone.opacity(0.45))
                Text(title).font(.system(size: 13, weight: .bold)).foregroundColor(.bone).lineLimit(1)
                Text(date, style: .relative)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.brand)
            }
        } else {
            Text("Nothing on the schedule")
                .font(.system(size: 11)).foregroundColor(.bone.opacity(0.55))
        }
    }
}

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
                .containerBackground(.fill.quaternary, for: .widget)
        }
        .configurationDisplayName("Player")
        .description("Photo, streak, and next event for your player.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

#Preview(as: .systemMedium) {
    PlayerWidget()
} timeline: {
    PlayerEntry(date: .now, snapshot: PlayerSnapshot.placeholder, photo: nil, errorCode: nil, configuration: ConfigurationAppIntent())
    PlayerEntry(date: .now, snapshot: nil, photo: nil, errorCode: nil, configuration: ConfigurationAppIntent())
}
