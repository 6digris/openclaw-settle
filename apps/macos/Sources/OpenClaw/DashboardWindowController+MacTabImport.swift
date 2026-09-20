import AppKit
import Foundation

extension DashboardWindowController {
    func importChromeLoginsIntoMacTabs() async {
        do {
            try await self.macTabLoginPreparation.prepare(force: true) {
                try await self.prepareMacTabLogins()
            }
        } catch {
            // The queued settings caller rejects retired requests separately.
        }
    }

    func prepareMacTabLogins() async throws {
        let sourceID = self.notificationSourceID
        let isCurrent: @MainActor () -> Bool = { self.canUseDeviceSettings(sourceID: sourceID) }
        guard isCurrent() else { throw CancellationError() }
        if let prepare = self.requestBrowserProfileImportOffer {
            _ = await prepare(isCurrent)
            guard isCurrent() else { throw CancellationError() }
            return
        }
        do {
            let discovery = try await CookieSyncManager.readForMacTabs(.init(action: "list"), isCurrent: isCurrent)
            guard isCurrent() else { throw CancellationError() }
            guard let profiles = discovery.profiles, !profiles.isEmpty else {
                await self.deviceSettingsMessageHandler
                    .showMacTabImportResult(
                        String(
                            localized: """
                            No Chrome, Brave, Edge, or Chromium profile with cookies was found. \
                            Continue to sign in directly in this tab.
                            """))
                guard isCurrent() else { throw CancellationError() }
                return
            }
            guard let profile = await self.deviceSettingsMessageHandler.chooseMacTabChromeProfile(
                profiles, persistent: self.nativeBrowser.usesPersistentCookieStore)
            else {
                guard isCurrent() else { throw CancellationError() }
                return
            }
            guard isCurrent() else { throw CancellationError() }
            let reply = try await CookieSyncManager.readForMacTabs(
                .init(action: "read", browser: profile.browser, profile: profile.id), isCurrent: isCurrent)
            guard isCurrent(), let batch = reply.batch else { throw CancellationError() }
            let result = try await self.nativeBrowser.importChromeCookies(
                batch, protectedHost: self.currentURL.host, isCurrent: isCurrent)
            guard isCurrent() else { throw CancellationError() }
            // Completion is acknowledged before navigation. No implicit reload can discard a form.
            await self.deviceSettingsMessageHandler.showMacTabImportResult(String(
                format: String(localized: """
                %lld of %lld cookies imported. %lld skipped; %lld failed. \
                New links use these logins. Reload an existing tab when ready. \
                Some sites require fresh sign-in; passwords and passkeys were not imported.
                """),
                result.imported,
                result.total,
                result.skipped,
                result.failed))
            guard isCurrent() else { throw CancellationError() }
        } catch {
            guard isCurrent(), !Task.isCancelled else { throw CancellationError() }
            await self.deviceSettingsMessageHandler
                .showMacTabImportResult(MacTabCookieImport.ImportError.unavailable.localizedDescription)
            guard isCurrent() else { throw CancellationError() }
            // The native alert explains the failure; normal browsing remains available.
        }
    }
}
