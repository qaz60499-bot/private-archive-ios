import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Recreate the background URLSession early so iOS can reconnect pending
        // transfers after suspending or terminating the app process.
        _ = NativeBackgroundUploadManager.shared
        return true
    }

    func application(_ application: UIApplication,
                     handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        if !NativeBackgroundUploadManager.shared.handleBackgroundEvents(identifier: identifier, completionHandler: completionHandler) {
            completionHandler()
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        NativeBackgroundUploadManager.shared.stopForegroundRecoveryWatchdog()
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Make sure every already-staged original remains attached to the durable
        // background URLSession before the WebView is suspended.
        NativeBackgroundUploadManager.shared.resumePendingTransfers()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Reconcile immediately and keep rechecking while the app is foregrounded.
        // This prevents a task that was not yet stale at launch from remaining frozen
        // forever at values such as 34% after the app is reopened.
        NativeBackgroundUploadManager.shared.startForegroundRecoveryWatchdog()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
