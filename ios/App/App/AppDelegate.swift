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

        // Force the window + root view controller backgrounds to white.
        // Capacitor's ios.backgroundColor only paints the WKWebView itself;
        // when Keyboard.resize: 'native' shrinks the WebView the area
        // BEHIND the keyboard belongs to these parent views, not the
        // WebView. Without this override that area renders in the iOS
        // default (often dark), and bleeds through the keyboard's
        // rounded-corner blur as the "dark blue" Patrick saw.
        // Brand color paint at every layer we can reach. Hit:
        //   (1) UIWindow.backgroundColor — fallback when WebView shrinks
        //   (2) rootViewController.view.backgroundColor — same
        //   (3) A native UIView pinned at the very top of the window,
        //       ABOVE every Capacitor plugin's subview, painting the
        //       safe-area-inset-top region directly. This is the only
        //       way to guarantee a color in that region on iOS 17+ —
        //       Capacitor's StatusBar plugin can't paint there
        //       regardless of overlay mode, and the navy Patrick kept
        //       seeing was a Capacitor-internal subview we couldn't
        //       reach from the WebView side.
        DispatchQueue.main.async {
            let brand = UIColor(red: 0.549, green: 0.098, blue: 0.133, alpha: 1.0) // crimson-800 #8c1922
            self.window?.backgroundColor = brand
            self.window?.rootViewController?.view.backgroundColor = brand

            if let window = self.window {
                let topStrip = UIView()
                topStrip.backgroundColor = brand
                topStrip.translatesAutoresizingMaskIntoConstraints = false
                window.addSubview(topStrip)
                NSLayoutConstraint.activate([
                    topStrip.leadingAnchor.constraint(equalTo: window.leadingAnchor),
                    topStrip.trailingAnchor.constraint(equalTo: window.trailingAnchor),
                    topStrip.topAnchor.constraint(equalTo: window.topAnchor),
                    topStrip.bottomAnchor.constraint(equalTo: window.safeAreaLayoutGuide.topAnchor),
                ])
                window.bringSubviewToFront(topStrip)
            }
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
