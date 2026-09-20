import AuthenticationServices
import Foundation
import OpenClawKit
import Security

/// WKWebView owns WebAuthn challenges, RP/origin validation and the credential UI.
/// This owner only exposes Apple's browser-level platform-credential permission.
@MainActor
enum MacTabPasskeys {
    typealias State = DeviceSettingsSnapshot.Browser.Passkeys

    static var hasBrowserEntitlement: Bool {
        guard let task = SecTaskCreateFromSelf(nil),
              let value = SecTaskCopyValueForEntitlement(
                  task, "com.apple.developer.web-browser.public-key-credential" as CFString, nil) else { return false }
        return (value as? Bool) == true
    }

    static var state: State {
        guard self.hasBrowserEntitlement else { return .requiresSigning }
        return self
            .state(ASAuthorizationWebBrowserPublicKeyCredentialManager().authorizationStateForPlatformCredentials)
    }

    static func state(_ authorization: ASAuthorizationWebBrowserPublicKeyCredentialManager
        .AuthorizationState) -> State
    {
        switch authorization {
        case .authorized: .authorized
        case .denied: .denied
        case .notDetermined: .notDetermined
        @unknown default: .denied
        }
    }

    static func requestAccess(isCurrent: @MainActor () -> Bool) async {
        guard isCurrent(), !Task.isCancelled, self.state == .notDetermined else { return }
        let manager = ASAuthorizationWebBrowserPublicKeyCredentialManager()
        // No credential metadata, private keys, website challenges or assertions
        // cross the Dashboard bridge. WebKit continues to handle website requests.
        await withCheckedContinuation { continuation in
            manager.requestAuthorizationForPublicKeyCredentials { _ in continuation.resume() }
        }
    }
}
