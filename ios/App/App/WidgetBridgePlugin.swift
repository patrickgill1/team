//
//  WidgetBridgePlugin.swift
//  App
//
//  iOS counterpart of the Android WidgetBridgePlugin. Reads/writes
//  the user's long-lived widget token into a UserDefaults instance
//  backed by the shared App Group container (group.com.firefc.team.widget).
//
//  The widget extension reads the same App Group container in
//  PlayerWidget.swift's fetchSnapshot. When the user generates a
//  token in Settings -> Widget the React app calls setToken() here;
//  the widget then auto-fills its setupCode on next refresh, so the
//  user never has to copy/paste.
//
//  Requires the App Group capability to be enabled on BOTH the App
//  target AND the PlayerWidget extension target in Xcode, with the
//  same group ID. See README / commit message for the Xcode setup
//  steps.
//

import Foundation
import Capacitor
import WidgetKit

public let APP_GROUP_ID = "group.com.firefc.team.widget"
public let WIDGET_TOKEN_KEY = "global_token"

@objc(WidgetBridgePlugin)
public class WidgetBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WidgetBridgePlugin"
    public let jsName = "WidgetBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearToken", returnType: CAPPluginReturnPromise),
    ]

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
}

