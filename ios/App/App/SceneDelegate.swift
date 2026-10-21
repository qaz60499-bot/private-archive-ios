import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = PrivateArchiveBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        // This app enables scenes, so UIKit delivers UI lifecycle transitions here
        // instead of the corresponding UIApplicationDelegate callbacks.
        NativeBackgroundUploadManager.shared.startForegroundRecoveryWatchdog()
    }

    func sceneWillResignActive(_ scene: UIScene) {
        NativeBackgroundUploadManager.shared.stopForegroundRecoveryWatchdog()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        NativeBackgroundUploadManager.shared.resumePendingTransfers()
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
