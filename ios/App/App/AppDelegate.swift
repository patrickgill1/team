import UIKit
import Capacitor
import FirebaseCore

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Initialize Firebase iOS SDK from GoogleService-Info.plist so the
        // Capacitor Firebase plugins (Auth, Messaging) can find their config.
        FirebaseApp.configure()

        // Force-load custom Capacitor plugin classes. Swift classes
        // annotated with @objc are only registered with the Objective-C
        // runtime when they're referenced; Capacitor's plugin discovery
        // depends on that runtime to find CAPPlugin subclasses. Touching
        // .self here is enough to trigger the load. Avoids needing a
        // separate ObjC .m registration shim per plugin.
        _ = WidgetBridgePlugin.self

        // Window + root view controller backgrounds painted with a
        // theme-aware baseline ONLY. Capacitor's StatusBar plugin
        // runs in overlay mode (see nativeShell.ts) so the WebView
        // extends edge-to-edge of the screen, including under the
        // notch / Dynamic Island. Each React page paints its own
        // safe-area-inset-top region via its container bg — that's
        // the source of truth for the top color, and lets us pick a
        // different color per page (crimson on dashboard, gradient
        // on login, etc.). These window/rootVC colors only become
        // visible if the WebView temporarily shrinks (e.g. during a
        // native keyboard resize) OR around the bottom safe area in
        // light mode where the page bg flips to white but our window
        // would stay black underneath.
        //
        // dynamicProvider matches the system trait (UIUserInterfaceStyle).
        // We let iOS pick because at native paint time the user's
        // in-app theme choice (localStorage) isn't readable from Swift
        // without a JS bridge; following the system is the closest
        // honest default and rarely diverges from the in-app picker
        // for users who keep both on system.
        //
        // The earlier implementation added a top UIView strip that
        // painted the safe-area region from Swift. It worked but
        // forced ONE color for the strip app-wide — no way to vary
        // it per route without a native bridge. Removed in favor of
        // per-page React control. Patrick confirmed 2026-06-18.
        DispatchQueue.main.async {
            let baseline = UIColor { traits in
                switch traits.userInterfaceStyle {
                case .light:
                    return UIColor.white
                default:
                    return UIColor.black
                }
            }
            self.window?.backgroundColor = baseline
            self.window?.rootViewController?.view.backgroundColor = baseline
        }

        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
