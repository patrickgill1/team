//
//  WidgetBridgePlugin.swift
//  App
//
//  iOS counterpart of the Android WidgetBridgePlugin. Reads/writes
//  the user's long-lived widget token into a UserDefaults instance
//  backed by the shared App Group container (group.com.goalkickr.widget).
//
//  The widget extension reads the same App Group container in
//  PlayerWidget.swift's fetchSnapshot. When the React app has a
//  widget token, it calls setToken() here; the widget then picks up
//  the token on next refresh, so the user never has to copy/paste.
//
//  Requires the App Group capability to be enabled on BOTH the App
//  target AND the PlayerWidget extension target in Xcode, with the
//  same group ID. See README / commit message for the Xcode setup
//  steps.
//

import Foundation
import Capacitor
import WidgetKit
import WatchConnectivity

public let APP_GROUP_ID = "group.com.goalkickr.widget"
public let WIDGET_TOKEN_KEY = "global_token"
private let WATCH_ACTION_QUEUE_KEY = "watch_game_action_queue"

@objc(WidgetBridgePlugin)
public class WidgetBridgePlugin: CAPPlugin, CAPBridgedPlugin, WCSessionDelegate {
    public let identifier = "WidgetBridgePlugin"
    public let jsName = "WidgetBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setGameSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearGameSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drainWatchGameActions", returnType: CAPPluginReturnPromise)
    ]

    private var watchSessionActivated = false
    // Serial queue serialising every mutation of the watch action
    // queue in UserDefaults. Two Watch messages arriving in the same
    // second could otherwise both read the same starting queue,
    // append, and write back — the second write clobbers the first
    // and silently loses a tap.
    private let watchActionQueueLock = DispatchQueue(label: "com.firefc.team.watchActionQueue")

    private func defaults() -> UserDefaults? {
        return UserDefaults(suiteName: APP_GROUP_ID)
    }

    @objc func setToken(_ call: CAPPluginCall) {
        let token = call.getString("token") ?? ""
        guard let d = defaults() else {
            call.reject("App Group not configured. Check Xcode capabilities.")
            return
        }
        d.set(token, forKey: WIDGET_TOKEN_KEY)
        // WidgetCenter reload so the widget picks up the new token
        // immediately instead of waiting for the next 1-hour timeline
        // refresh. Pre-iOS 14 fallbacks unnecessary — widget extension
        // requires iOS 14+ anyway.
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadAllTimelines()
        }
        call.resolve()
    }

    @objc func getToken(_ call: CAPPluginCall) {
        let token = defaults()?.string(forKey: WIDGET_TOKEN_KEY) ?? ""
        call.resolve(["token": token])
    }

    @objc func clearToken(_ call: CAPPluginCall) {
        defaults()?.removeObject(forKey: WIDGET_TOKEN_KEY)
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadAllTimelines()
        }
        call.resolve()
    }

    @objc func setGameSession(_ call: CAPPluginCall) {
        guard let payload = call.getObject("session") else {
            call.reject("Missing game session")
            return
        }
        guard let session = ensureWatchSession() else {
            call.resolve(["available": false])
            return
        }

        let message: [String: Any] = ["kind": "gameSession", "session": payload]
        do {
            try session.updateApplicationContext(message)
        } catch {
            // Non-fatal. updateApplicationContext can throw before the
            // watch session finishes activation; sendMessage below may
            // still work when the watch is reachable.
        }
        if session.isReachable {
            session.sendMessage(message, replyHandler: nil, errorHandler: nil)
        }
        call.resolve(["available": true, "reachable": session.isReachable])
    }

    @objc func clearGameSession(_ call: CAPPluginCall) {
        guard let session = ensureWatchSession() else {
            call.resolve(["available": false])
            return
        }
        let message: [String: Any] = ["kind": "clearGameSession"]
        do { try session.updateApplicationContext(message) } catch { }
        if session.isReachable {
            session.sendMessage(message, replyHandler: nil, errorHandler: nil)
        }
        call.resolve(["available": true])
    }

    @objc func drainWatchGameActions(_ call: CAPPluginCall) {
        let actions = drainQueuedWatchActions()
        call.resolve(["actions": actions])
    }

    private func ensureWatchSession() -> WCSession? {
        guard WCSession.isSupported() else { return nil }
        let session = WCSession.default
        if !watchSessionActivated {
            session.delegate = self
            session.activate()
            watchSessionActivated = true
        }
        return session
    }

    private func enqueueWatchAction(_ action: [String: Any]) {
        var enriched = action
        enriched["id"] = enriched["id"] ?? "\(Int(Date().timeIntervalSince1970 * 1000))_\(UUID().uuidString.prefix(8))"
        enriched["receivedAt"] = enriched["receivedAt"] ?? Int(Date().timeIntervalSince1970 * 1000)

        // Serialise the read-modify-write against the shared UserDefaults
        // slot so two concurrent Watch messages can't lose one another.
        watchActionQueueLock.sync {
            let d = UserDefaults.standard
            var queue = d.array(forKey: WATCH_ACTION_QUEUE_KEY) as? [[String: Any]] ?? []
            queue.append(enriched)
            if queue.count > 50 { queue = Array(queue.suffix(50)) }
            d.set(queue, forKey: WATCH_ACTION_QUEUE_KEY)
        }

        notifyListeners("watchGameAction", data: enriched)
    }

    private func drainQueuedWatchActions() -> [[String: Any]] {
        return watchActionQueueLock.sync {
            let d = UserDefaults.standard
            let queue = d.array(forKey: WATCH_ACTION_QUEUE_KEY) as? [[String: Any]] ?? []
            d.removeObject(forKey: WATCH_ACTION_QUEUE_KEY)
            return queue
        }
    }

    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    public func sessionDidBecomeInactive(_ session: WCSession) {}

    public func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    public func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
        handleWatchMessage(message)
    }

    public func session(_ session: WCSession, didReceiveMessage message: [String : Any], replyHandler: @escaping ([String : Any]) -> Void) {
        handleWatchMessage(message)
        replyHandler(["ok": true])
    }

    private func handleWatchMessage(_ message: [String: Any]) {
        guard let kind = message["kind"] as? String, kind == "gameAction" else { return }
        guard let action = message["action"] as? String, !action.isEmpty else { return }
        var payload: [String: Any] = ["action": action]
        if let eventId = message["eventId"] as? String { payload["eventId"] = eventId }
        if let id = message["id"] as? String { payload["id"] = id }
        DispatchQueue.main.async { self.enqueueWatchAction(payload) }
    }
}

