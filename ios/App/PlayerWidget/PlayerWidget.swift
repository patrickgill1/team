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
    let nextEventArriveByMs: Double?
    let nextEventArriveOffsetMinutes: Int?
    let nextEventLocation: String?
    let nextEventDevelopmentFocus: String?
    let nextEventRsvp: String?    // "going" | "maybe" | "no" | nil
    let nextEventNeedsRsvp: Bool?
    let postEventFeedbackEventId: String?
    let postEventFeedbackTitle: String?
    let postEventFeedbackDateMs: Double?
    let postEventFeedbackFocus: String?
    let needsPostEventFeedback: Bool?
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
        nextEventArriveByMs: Date().addingTimeInterval(60 * 60 * 23.5).timeIntervalSince1970 * 1000,
        nextEventArriveOffsetMinutes: 30,
        nextEventLocation: "West Field",
        nextEventDevelopmentFocus: "First touch",
        nextEventRsvp: "going",
        nextEventNeedsRsvp: false,
        postEventFeedbackEventId: nil,
        postEventFeedbackTitle: nil,
        postEventFeedbackDateMs: nil,
        postEventFeedbackFocus: nil,
        needsPostEventFeedback: true,
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

private struct SnapshotErrorResponse: Codable {
    let ok: Bool?
    let error: String?
}

// MARK: - Networking

private let WIDGET_ENDPOINT = "https://api.goalkickr.com/widget/snapshot"
private let APP_GROUP_ID = "group.com.goalkickr.widget"
private let WIDGET_TOKEN_KEY = "global_token"

private func widgetRequest(setupCode: String, includeTokenQuery: Bool) -> URLRequest {
    let nonce = Int(Date().timeIntervalSince1970)
    var components = URLComponents(string: WIDGET_ENDPOINT)!
    var queryItems = [URLQueryItem(name: "t", value: String(nonce))]
    if includeTokenQuery {
        queryItems.append(URLQueryItem(name: "token", value: setupCode))
    }
    components.queryItems = queryItems
    var req = URLRequest(url: components.url!)
    req.httpMethod = "GET"
    req.setValue("Bearer \(setupCode)", forHTTPHeaderField: "Authorization")
    req.cachePolicy = .reloadIgnoringLocalCacheData
    req.timeoutInterval = 20
    return req
}

// Resolve the effective setup code with this priority:
//   1. ConfigurationAppIntent.setupCode if the user manually pasted one
//   2. App Group UserDefaults if WidgetBridgePlugin wrote one
// Lets the user drop the widget on the home screen without ever
// pasting — the React app's Settings -> Widget call to setToken()
// populates the App Group container.
private func resolveSetupCode(intent: ConfigurationAppIntent) -> String {
    if !intent.setupCode.isEmpty { return intent.setupCode }
    let shared = UserDefaults(suiteName: APP_GROUP_ID)
    return shared?.string(forKey: WIDGET_TOKEN_KEY) ?? ""
}

private func fetchSnapshot(setupCode: String) async -> (PlayerSnapshot?, String?) {
    guard !setupCode.isEmpty else { return (nil, "needs-setup") }
    // Cache-bust: append a per-second nonce AND set URLSession to
    // skip the local cache. Two layers of defense because iOS
    // widget extensions are aggressive about caching responses to
    // save battery, and a stale 'no events' payload can hang
    // around for hours otherwise.
    do {
        var (data, resp) = try await URLSession.shared.data(for: widgetRequest(setupCode: setupCode, includeTokenQuery: false))
        var status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        var serverError = (try? JSONDecoder().decode(SnapshotErrorResponse.self, from: data).error) ?? ""

        if status == 401 && serverError == "missing-token" {
            (data, resp) = try await URLSession.shared.data(for: widgetRequest(setupCode: setupCode, includeTokenQuery: true))
            status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            serverError = (try? JSONDecoder().decode(SnapshotErrorResponse.self, from: data).error) ?? ""
        }

        if status == 401 { return (nil, serverError == "missing-token" ? "needs-setup" : "invalid-code") }
        if status == 404 { return (nil, serverError.isEmpty ? "not-found" : serverError) }
        if status != 200 { return (nil, serverError.isEmpty ? "server" : serverError) }

        let decoded: SnapshotResponse
        do {
            decoded = try JSONDecoder().decode(SnapshotResponse.self, from: data)
        } catch {
            return (nil, "decode")
        }
        if !decoded.ok { return (nil, decoded.error ?? "server") }
        return (decoded.snapshot, nil)
    } catch {
        return (nil, "offline")
    }
}

// Aggressive downscale before the image enters the timeline entry.
// WidgetKit caps archived images at ~1.2M total pixels; a full-res
// 1600x1500 player photo blows past that and silently kills the
// entry render (the widget goes blank with a console error like
// 'Widget archival failed due to image being too large'). Pre-scale
// to <= 192 on the long edge — that's twice the small-widget
// avatar at @2x, plenty for crisp Retina rendering on any size.
private let WIDGET_PHOTO_MAX: CGFloat = 192

private func fetchImage(urlString: String?) async -> UIImage? {
    guard let urlString = urlString, let url = URL(string: urlString) else { return nil }
    do {
        let (data, _) = try await URLSession.shared.data(from: url)
        guard let raw = UIImage(data: data) else { return nil }
        return downscale(raw, maxEdge: WIDGET_PHOTO_MAX)
    } catch {
        return nil
    }
}

private func downscale(_ image: UIImage, maxEdge: CGFloat) -> UIImage {
    let w = image.size.width
    let h = image.size.height
    let longEdge = max(w, h)
    if longEdge <= maxEdge { return image }
    let scale = maxEdge / longEdge
    let newSize = CGSize(width: w * scale, height: h * scale)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1   // already targeting a fixed pixel size; don't double via screen scale
    format.opaque = false
    let renderer = UIGraphicsImageRenderer(size: newSize, format: format)
    return renderer.image { _ in
        image.draw(in: CGRect(origin: .zero, size: newSize))
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
        let code = resolveSetupCode(intent: configuration)
        let (snap, err) = await fetchSnapshot(setupCode: code)
        let img = await fetchImage(urlString: snap?.photoUrl)
        return PlayerEntry(date: Date(), snapshot: snap, photo: img, errorCode: err, configuration: configuration)
    }

    func timeline(for configuration: ConfigurationAppIntent, in context: Context) async -> Timeline<PlayerEntry> {
        let code = resolveSetupCode(intent: configuration)
        let (snap, err) = await fetchSnapshot(setupCode: code)
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

// Shown next to the relative-date label when the player hasn't
// RSVPed yet. Outlined bone capsule, no fill — reads as a nudge,
// not a CTA. Lower weight than the 'Going' pill so the parent who
// HAS responded still sees their status first when glancing at
// the widget.
private struct RsvpPrompt: View {
    var body: some View {
        Text("Please RSVP")
            .font(.system(size: 9, weight: .black))
            .kerning(0.4)
            .foregroundColor(.boneSoft)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(Capsule().fill(Color.bone.opacity(0.05)))
            .overlay(Capsule().stroke(Color.bone.opacity(0.30), lineWidth: 1))
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

private struct FeedbackPrompt: View {
    var body: some View {
        Text("How'd it go?")
            .font(.system(size: 9, weight: .black))
            .kerning(0.3)
            .foregroundColor(.brand)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(Capsule().fill(Color.brand.opacity(0.16)))
            .overlay(Capsule().stroke(Color.brand.opacity(0.38), lineWidth: 1))
    }
}

private struct UpcomingRow: View {
    let snap: PlayerSnapshot
    var body: some View {
        if let title = snap.nextEventTitle, let ms = snap.nextEventDateMs {
            let date = Date(timeIntervalSince1970: (snap.nextEventArriveByMs ?? ms) / 1000)
            let isArrival = (snap.nextEventArriveOffsetMinutes ?? 0) > 0
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
                        if isArrival {
                            Text("Arrive")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(.boneSoft)
                            Text(date, style: .relative)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(.boneSoft)
                        } else {
                            Text(date, style: .relative)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(.boneSoft)
                        }
                        if let focus = snap.nextEventDevelopmentFocus, !focus.isEmpty {
                            Text("·")
                                .font(.system(size: 10, weight: .heavy))
                                .foregroundColor(.boneDim)
                            Text(focus)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(.boneSoft)
                                .lineLimit(1)
                        }
                        if snap.nextEventNeedsRsvp == true {
                            RsvpPrompt()
                        } else if snap.needsPostEventFeedback == true {
                            FeedbackPrompt()
                        } else if let rsvp = snap.nextEventRsvp {
                            RsvpPill(status: rsvp)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
        } else if snap.needsPostEventFeedback == true, let title = snap.postEventFeedbackTitle {
            HStack(spacing: 8) {
                Image(systemName: "bubble.left.and.text.bubble.right.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(.brand)
                VStack(alignment: .leading, spacing: 0) {
                    Text("How did it go?")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.bone)
                        .lineLimit(1)
                    Text(title)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(.boneSoft)
                            .lineLimit(1)
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

    private var title: String {
        switch code {
        case "invalid-code": return "Code\nexpired"
        case "needs-setup": return "Tap to\nset up"
        case "no-player": return "No\nplayer"
        case "decode": return "Update\nneeded"
        case "server", "firestore-not-configured": return "Server\nerror"
        default: return "Offline"
        }
    }

    private var message: String {
        switch code {
        case "invalid-code": return "Open app, copy new code, paste here."
        case "needs-setup": return "Open app once, then edit the widget."
        case "no-player": return "Open the app and pick a player."
        case "decode": return "The widget response changed. Rebuild the app."
        case "server", "firestore-not-configured": return "Trying again automatically."
        default: return "Trying again automatically."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            BrandKicker()
            Spacer(minLength: 0)
            Text(title)
                .font(.system(size: 22, weight: .black))
                .foregroundColor(.bone)
            Text(message)
                .font(.system(size: 10))
                .foregroundColor(.boneSoft)
                .lineLimit(3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(12)
    }
}

// MARK: - Small layout (158x158)
//
// At 158pt² the previous design crammed brand kicker, streak,
// avatar, name, team, AND next event into the box. Each item got
// 18-22pt of vertical space and the kicker word ("GOALKICKR")
// literally wrapped to two lines because the streak pill was
// pushing it over the edge. Result: nothing was readable.
//
// New approach: do ONE thing per widget size. The small is an
// at-a-glance identity card — big avatar + big name + streak.
// No event row, no team subtitle, no kicker. If you want next
// event you use the medium widget.

struct SmallPlayerView: View {
    let snap: PlayerSnapshot
    let photo: UIImage?

    var body: some View {
        VStack(spacing: 8) {
            // Top: avatar centered, taking most of the visual weight.
            // Jersey badge is the secondary identity signal.
            AvatarView(snap: snap, photo: photo, size: 72, showJersey: true)
            // Name fills horizontally, scaled down only if necessary.
            Text(firstName(snap.playerName))
                .font(.system(size: 19, weight: .black))
                .foregroundColor(.bone)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .frame(maxWidth: .infinity)
            // Streak as the SINGLE supporting stat. Day count drops
            // gracefully (0d still shows; the consistency itself is
            // the metric).
            StreakBadge(days: snap.streakDays)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
    }

    private func firstName(_ n: String) -> String {
        n.split(separator: " ").first.map(String.init) ?? n
    }
}

// MARK: - Medium layout (~329x158)
//
// Two-row design instead of the old avatar-left / column-right
// layout that left a big empty patch under the right column.
//
// Top row (60% height): compact identity strip with avatar, name,
// team, plus streak / POTM badges. Reads in one glance.
//
// Bottom row (40% height): a substantial upcoming-event card with
// icon, title, location, and the RSVP status. The bigger footprint
// fills the previously-dead horizontal-bottom area and makes the
// "is my kid going to practice today" question instantly answerable.

struct MediumPlayerView: View {
    let snap: PlayerSnapshot
    let photo: UIImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Identity strip
            HStack(alignment: .center, spacing: 12) {
                AvatarView(snap: snap, photo: photo, size: 60, showJersey: true)
                VStack(alignment: .leading, spacing: 2) {
                    BrandKicker()
                    Text(snap.playerName)
                        .font(.system(size: 18, weight: .black))
                        .foregroundColor(.bone)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    if let team = snap.teamName {
                        Text(team)
                            .font(.system(size: 10, weight: .heavy))
                            .kerning(0.4)
                            .foregroundColor(.boneSoft)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                // Streak as the right-side stat — vertical stack lets
                // us add POTM under it when present without crowding
                // the identity column.
                VStack(alignment: .trailing, spacing: 4) {
                    StreakBadge(days: snap.streakDays)
                    if let n = snap.potmCount, n > 0 {
                        PotmBadge(count: n)
                    }
                }
            }

            Rectangle()
                .fill(Color.bone.opacity(0.08))
                .frame(height: 1)

            // Upcoming event card — fills the bottom of the widget
            // so the previously-dead area carries real information.
            UpcomingCard(snap: snap)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(14)
    }
}

// Bigger upcoming-event view used by the medium widget. Two-line
// body (title + location/time) with RSVP pill aligned right so the
// parent's status is the at-a-glance answer.
private struct UpcomingCard: View {
    let snap: PlayerSnapshot

    var body: some View {
        if let title = snap.nextEventTitle, let ms = snap.nextEventDateMs {
            let date = Date(timeIntervalSince1970: (snap.nextEventArriveByMs ?? ms) / 1000)
            let isArrival = (snap.nextEventArriveOffsetMinutes ?? 0) > 0
            HStack(alignment: .center, spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.brand.opacity(0.18))
                    Image(systemName: iconFor(type: snap.nextEventType))
                        .font(.system(size: 14, weight: .heavy))
                        .foregroundColor(.brand)
                }
                .frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.system(size: 13, weight: .heavy))
                        .foregroundColor(.bone)
                        .lineLimit(1)
                    HStack(spacing: 5) {
                        if isArrival {
                            Text("Arrive")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundColor(.boneSoft)
                                .lineLimit(1)
                            Text(date, style: .relative)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundColor(.boneSoft)
                                .lineLimit(1)
                        } else {
                            Text(date, style: .relative)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundColor(.boneSoft)
                                .lineLimit(1)
                        }
                        if let focus = snap.nextEventDevelopmentFocus, !focus.isEmpty {
                            Text("·")
                                .font(.system(size: 11, weight: .heavy))
                                .foregroundColor(.boneDim)
                            Text(focus)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundColor(.boneSoft)
                                .lineLimit(1)
                        } else if let loc = snap.nextEventLocation, !loc.isEmpty {
                            Text("·")
                                .font(.system(size: 11, weight: .heavy))
                                .foregroundColor(.boneDim)
                            Text(loc)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundColor(.boneSoft)
                                .lineLimit(1)
                        }
                    }
                }
                Spacer(minLength: 4)
                if snap.nextEventNeedsRsvp == true {
                    RsvpPrompt()
                } else if snap.needsPostEventFeedback == true {
                    FeedbackPrompt()
                } else if let rsvp = snap.nextEventRsvp {
                    RsvpPill(status: rsvp)
                }
            }
        } else if snap.needsPostEventFeedback == true, let title = snap.postEventFeedbackTitle {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.brand.opacity(0.18))
                    Image(systemName: "bubble.left.and.text.bubble.right.fill")
                        .font(.system(size: 14, weight: .heavy))
                        .foregroundColor(.brand)
                }
                .frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text("How did it go?")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.bone)
                        .lineLimit(1)
                    Text(snap.postEventFeedbackFocus ?? title)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(.boneSoft)
                            .lineLimit(1)
                }
                Spacer(minLength: 0)
                FeedbackPrompt()
            }
        } else if let title = snap.lastResultTitle, let score = snap.lastResultScore {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.brand.opacity(0.18))
                    Image(systemName: "trophy.fill")
                        .font(.system(size: 14, weight: .heavy))
                        .foregroundColor(.brand)
                }
                .frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Last match")
                        .font(.system(size: 9, weight: .black))
                        .kerning(0.8)
                        .foregroundColor(.boneDim)
                    Text("\(score) — \(title)")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.bone)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
        } else {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.bone.opacity(0.08))
                    Image(systemName: "moon.zzz.fill")
                        .font(.system(size: 14, weight: .heavy))
                        .foregroundColor(.boneDim)
                }
                .frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Up next")
                        .font(.system(size: 9, weight: .black))
                        .kerning(0.8)
                        .foregroundColor(.boneDim)
                    Text("Nothing on the calendar")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundColor(.boneSoft)
                        .lineLimit(1)
                }
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

// MARK: - Entry view + Widget

struct PlayerWidgetEntryView: View {
    var entry: Provider.Entry
    @Environment(\.widgetFamily) var family

    var body: some View {
        Group {
            // Resolve the same way fetchSnapshot did. If both the
            // configuration setupCode AND the App Group token are
            // blank, the widget is genuinely unconfigured — show the
            // setup placeholder. Otherwise we rely on the snapshot /
            // errorCode pair below.
            if resolveSetupCode(intent: entry.configuration).isEmpty {
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
