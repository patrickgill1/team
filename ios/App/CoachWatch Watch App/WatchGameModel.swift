import Foundation
import Combine
import SwiftUI
import WatchConnectivity
import WatchKit

struct WatchBenchPlayer: Equatable, Identifiable {
    let id: String
    let name: String
    let jerseyNumber: Int?
}

// Same shape, different semantic use. The stat picker walks the
// full roster; the sub picker walks the bench subset. Aliased for
// clarity at call sites.
typealias WatchRosterPlayer = WatchBenchPlayer

struct WatchGameSession: Equatable {
    var eventId: String
    var homeName: String
    var opponentName: String
    var ourScore: Int
    var oppScore: Int
    var status: String
    var periodLabel: String
    var clockOffsetSeconds: Int
    var clockStartedAtMs: Double?
    var shiftSeconds: Int?
    var lastBellAtSec: Int?
    var bellEnabled: Bool
    var suggestedNextPlayerName: String?
    var bench: [WatchBenchPlayer]
    var roster: [WatchRosterPlayer]
    var updatedAt: Double

    static let empty = WatchGameSession(
        eventId: "",
        homeName: "GoalKickr",
        opponentName: "Opponent",
        ourScore: 0,
        oppScore: 0,
        status: "scheduled",
        periodLabel: "1",
        clockOffsetSeconds: 0,
        clockStartedAtMs: nil,
        shiftSeconds: nil,
        lastBellAtSec: nil,
        bellEnabled: false,
        suggestedNextPlayerName: nil,
        bench: [],
        roster: [],
        updatedAt: 0
    )

    var isLive: Bool { status == "live" }
}

final class WatchGameModel: NSObject, ObservableObject, WCSessionDelegate {
    @Published var session: WatchGameSession?
    @Published var now = Date()
    @Published var lastActionStatus = ""

    private var timer: Timer?
    private var lastSubAlertBucket: Int?

    override init() {
        super.init()
        activateSession()
        startTimer()
    }

    deinit { timer?.invalidate() }

    func liveClockSeconds() -> Int {
        guard let session else { return 0 }
        if session.isLive, let started = session.clockStartedAtMs {
            let elapsed = max(0, Int((now.timeIntervalSince1970 * 1000 - started) / 1000))
            return session.clockOffsetSeconds + elapsed
        }
        return session.clockOffsetSeconds
    }

    func secondsUntilSub() -> Int? {
        guard let session, session.bellEnabled, let shift = session.shiftSeconds, shift > 0 else { return nil }
        let last = session.lastBellAtSec ?? 0
        return max(0, shift - (liveClockSeconds() - last))
    }

    func send(_ action: String, playerId: String? = nil, stat: String? = nil) {
        guard WCSession.isSupported() else { return }
        let id = "\(Int(Date().timeIntervalSince1970 * 1000))_\(UUID().uuidString.prefix(8))"
        var payload: [String: Any] = [
            "kind": "gameAction",
            "action": action,
            "id": id,
            "eventId": session?.eventId ?? ""
        ]
        if let playerId, !playerId.isEmpty {
            payload["playerId"] = playerId
        }
        if let stat, !stat.isEmpty {
            payload["stat"] = stat
        }
        WCSession.default.sendMessage(payload, replyHandler: { [weak self] _ in
            DispatchQueue.main.async { self?.lastActionStatus = "Sent" }
        }, errorHandler: { [weak self] _ in
            DispatchQueue.main.async { self?.lastActionStatus = "Queued" }
        })
        WKInterfaceDevice.current().play(.click)
    }

    private func activateSession() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    private func startTimer() {
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.now = Date()
            self.checkSubAlert()
            self.expireStaleSession()
        }
    }

    // A session applied while the Watch was open can go stale in
    // place — the coach ended the game on the phone but the app
    // was force-quit before a clearGameSession fired. Every second
    // we check: if the current session's updatedAt is more than
    // 6 hours old, drop it. Belt to the applyApplicationContext
    // suspenders.
    private func expireStaleSession() {
        guard let s = session, s.updatedAt > 0 else { return }
        let sixHoursMs: Double = 6 * 60 * 60 * 1000
        let nowMs = Date().timeIntervalSince1970 * 1000
        if nowMs - s.updatedAt > sixHoursMs {
            DispatchQueue.main.async { self.session = nil }
        }
    }

    private func checkSubAlert() {
        guard let remaining = secondsUntilSub(), remaining == 0 else { return }
        let clock = liveClockSeconds()
        let bucket = session?.shiftSeconds.map { clock / max(1, $0) } ?? clock
        if lastSubAlertBucket == bucket { return }
        lastSubAlertBucket = bucket
        WKInterfaceDevice.current().play(.notification)
    }

    private func applyApplicationContext(_ context: [String: Any]) {
        guard let kind = context["kind"] as? String else { return }
        if kind == "clearGameSession" {
            DispatchQueue.main.async { self.session = nil }
            return
        }
        guard kind == "gameSession", let raw = context["session"] as? [String: Any] else { return }
        let next = WatchGameSession.from(raw)
        // Zombie session guard: if the phone pushed a session whose
        // updatedAt is more than 6 hours old, don't apply it. This
        // catches the "Patrick opened the Watch app days later and
        // it showed a game he ended yesterday" case. The Watch keeps
        // its last-known session across app relaunches, so without a
        // freshness check we surface stale state.
        let sixHoursMs: Double = 6 * 60 * 60 * 1000
        let nowMs = Date().timeIntervalSince1970 * 1000
        if next.updatedAt > 0, nowMs - next.updatedAt > sixHoursMs {
            DispatchQueue.main.async { self.session = nil }
            return
        }
        DispatchQueue.main.async { self.session = next }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {
        applyApplicationContext(applicationContext)
    }

    func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
        applyApplicationContext(message)
    }

    func sessionReachabilityDidChange(_ session: WCSession) {}
}

extension WatchGameSession {
    static func from(_ raw: [String: Any]) -> WatchGameSession {
        let suggested = raw["suggestedNextPlayer"] as? [String: Any]
        let period: String
        if let value = raw["period"] { period = String(describing: value) } else { period = "1" }
        let benchRaw = raw["bench"] as? [[String: Any]] ?? []
        let bench: [WatchBenchPlayer] = benchRaw.compactMap { entry in
            guard let id = entry["id"] as? String, !id.isEmpty else { return nil }
            return WatchBenchPlayer(
                id: id,
                name: entry["name"] as? String ?? "Player",
                jerseyNumber: entry["jerseyNumber"] as? Int
            )
        }
        let rosterRaw = raw["roster"] as? [[String: Any]] ?? []
        let roster: [WatchRosterPlayer] = rosterRaw.compactMap { entry in
            guard let id = entry["id"] as? String, !id.isEmpty else { return nil }
            return WatchRosterPlayer(
                id: id,
                name: entry["name"] as? String ?? "Player",
                jerseyNumber: entry["jerseyNumber"] as? Int
            )
        }
        return WatchGameSession(
            eventId: raw["eventId"] as? String ?? "",
            homeName: raw["homeName"] as? String ?? "Us",
            opponentName: raw["opponentName"] as? String ?? "Opponent",
            ourScore: raw["ourScore"] as? Int ?? 0,
            oppScore: raw["oppScore"] as? Int ?? 0,
            status: raw["status"] as? String ?? "scheduled",
            periodLabel: period,
            clockOffsetSeconds: raw["clockOffsetSeconds"] as? Int ?? 0,
            clockStartedAtMs: raw["clockStartedAtMs"] as? Double,
            shiftSeconds: raw["shiftSeconds"] as? Int,
            lastBellAtSec: raw["lastBellAtSec"] as? Int,
            bellEnabled: raw["bellEnabled"] as? Bool ?? false,
            suggestedNextPlayerName: suggested?["name"] as? String,
            bench: bench,
            roster: roster,
            updatedAt: raw["updatedAt"] as? Double ?? 0
        )
    }
}

func formatWatchClock(_ seconds: Int) -> String {
    let clamped = max(0, seconds)
    return "\(clamped / 60):\(String(format: "%02d", clamped % 60))"
}
