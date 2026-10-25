//
//  SceneDelegate.swift
//  App
//
//  2026-10-25: iOS 27 SDK requires scene-based lifecycle. Capacitor's
//  template was AppDelegate-only, which crashes on first launch with
//  "UIScene life cycle is required for apps built with this SDK."
//  Added this SceneDelegate + the matching UIApplicationSceneManifest
//  in Info.plist to opt into the scene lifecycle. The AppDelegate's
//  window/rootVC setup is still the real paint source — Capacitor's
//  CAPBridgeViewController remains the root — this just hands scene
//  callbacks (connect, foreground, background, URL opens, universal
//  links) through to Capacitor's existing proxy.
//

import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = (scene as? UIWindowScene) else { return }

        // Build the window on this scene, root it on the storyboard-
        // defined CAPBridgeViewController. Capacitor's Main.storyboard
        // is still the entry point — we just attach it to the scene
        // instead of letting UIApplicationMain do it on the AppDelegate.
        let window = UIWindow(windowScene: windowScene)
        let storyboard = UIStoryboard(name: "Main", bundle: nil)
        window.rootViewController = storyboard.instantiateInitialViewController()

        // Same baseline background painting the AppDelegate used to do.
        // Lives here now because window creation moved into the scene.
        let baseline = UIColor { traits in
            switch traits.userInterfaceStyle {
            case .light: return UIColor.white
            default: return UIColor.black
            }
        }
        window.backgroundColor = baseline
        window.rootViewController?.view.backgroundColor = baseline

        self.window = window
        window.makeKeyAndVisible()

        // Handle a cold-launch URL (universal link / custom scheme). Hot
        // launches route through scene(_:openURLContexts:) below.
        if let urlContext = connectionOptions.urlContexts.first {
            _ = ApplicationDelegateProxy.shared.application(
                UIApplication.shared,
                open: urlContext.url,
                options: [:]
            )
        }
        if let userActivity = connectionOptions.userActivities.first {
            _ = ApplicationDelegateProxy.shared.application(
                UIApplication.shared,
                continue: userActivity,
                restorationHandler: { _ in }
            )
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            open: url,
            options: [:]
        )
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            continue: userActivity,
            restorationHandler: { _ in }
        )
    }

    func sceneDidDisconnect(_ scene: UIScene) {}
    func sceneDidBecomeActive(_ scene: UIScene) {}
    func sceneWillResignActive(_ scene: UIScene) {}
    func sceneWillEnterForeground(_ scene: UIScene) {}
    func sceneDidEnterBackground(_ scene: UIScene) {}
}
