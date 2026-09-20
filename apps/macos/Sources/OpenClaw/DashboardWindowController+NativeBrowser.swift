import Foundation
import WebKit

extension DashboardWindowController {
    func receiveBrowserMessage(
        _ message: WKScriptMessage,
        replyHandler: @escaping DashboardBrowserMessageHandler.ReplyHandler)
    {
        guard message.name == DashboardBrowserMessageHandler.name,
              message.webView === self.webView,
              message.frameInfo.isMainFrame,
              Self.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL),
              self.canUseBrowserDocument(sourceID: self.notificationSourceID)
        else {
            replyHandler(["ok": false, "error": DashboardBrowserError.unavailable.localizedDescription], nil)
            return
        }
        do {
            let request = try DashboardBrowserMessageHandler.decode(message.body)
            switch request {
            case .open, .navigate:
                let sourceID = self.notificationSourceID
                Task { @MainActor [weak self] in
                    do {
                        guard let self else { throw DashboardBrowserError.unavailable }
                        let tabId = try await self.performBrowserNavigation(request, sourceID: sourceID)
                        replyHandler(["ok": true, "tabId": tabId], nil)
                    } catch {
                        replyHandler(
                            ["ok": false, "error": DashboardBrowserError.unavailable.localizedDescription],
                            nil)
                    }
                }
                return
            case let .action(.download, tabId):
                self.downloadBrowserReply(tabId: tabId, replyHandler: replyHandler)
                return
            case let .action(.snapshot, tabId):
                self.captureBrowserReply(tabId: tabId, point: nil, replyHandler: replyHandler)
                return
            case let .action(action, tabId):
                try self.nativeBrowser.perform(action, tabId: tabId)
            case let .present(scope, tabId, rect, visible):
                try self.nativeBrowser.present(scope: scope, tabId: tabId, rect: rect, visible: visible)
            case let .releaseScope(scope):
                self.nativeBrowser.releaseScope(scope)
            case let .inspect(tabId, x, y):
                self.captureBrowserReply(tabId: tabId, point: (x, y), replyHandler: replyHandler)
                return
            }
            replyHandler(["ok": true], nil)
        } catch {
            replyHandler(["ok": false, "error": error.localizedDescription], nil)
        }
    }

    func performBrowserNavigation(_ request: DashboardBrowserRequest, sourceID: String) async throws -> String {
        let url: URL
        switch request {
        case let .open(_, requested, _, _), let .navigate(_, requested): url = requested
        default: throw DashboardBrowserError.invalidRequest
        }
        let isCurrent: @MainActor () -> Bool = { self.canUseBrowserDocument(sourceID: sourceID) && !Task.isCancelled }
        guard isCurrent() else { throw DashboardBrowserError.unavailable }
        if ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            try await self.macTabLoginPreparation.prepare {
                try await self.prepareMacTabLogins()
                guard isCurrent() else { throw CancellationError() }
            }
        }
        guard isCurrent() else { throw DashboardBrowserError.unavailable }
        switch request {
        case let .open(tabId, url, sessionKey, _):
            return try self.nativeBrowser.open(tabId: tabId, url: url, sessionKey: sessionKey)
        case let .navigate(tabId, url):
            try self.nativeBrowser.navigate(tabId: tabId, url: url)
            return tabId
        default: throw DashboardBrowserError.invalidRequest
        }
    }

    func publishBrowserState(_ state: DashboardBrowserState) {
        guard self.canUseBrowserDocument(sourceID: self.notificationSourceID),
              let data = try? JSONEncoder().encode(state), let json = String(data: data, encoding: .utf8)
        else { return }
        let script = """
        window.__OPENCLAW_NATIVE_BROWSER__ = \(json);
        window.dispatchEvent(new CustomEvent("openclaw:native-browser-state", {
          detail: window.__OPENCLAW_NATIVE_BROWSER__
        }));
        """
        // The JavaScript guard rechecks the destination if a sign-in redirect
        // commits between this call and WebKit's queued main-frame evaluation.
        self.webView.evaluateJavaScript(Self.scopedDashboardScript(script, url: self.currentURL))
    }

    private func canUseBrowserDocument(sourceID: String) -> Bool {
        self.isWindowOpen && !self.isHiddenForExperience && self.canDeliverNativeCommands &&
            self.notificationSourceID == sourceID && self.hasCurrentBrowserSession &&
            Self.isTrustedLinkSource(self.webView.url, dashboardURL: self.currentURL)
    }

    private func downloadBrowserReply(
        tabId: String,
        replyHandler: @escaping DashboardBrowserMessageHandler.ReplyHandler)
    {
        let sourceID = self.notificationSourceID
        Task { @MainActor [weak self] in
            do {
                guard let self, self.canUseBrowserDocument(sourceID: sourceID) else {
                    throw DashboardBrowserError.unavailable
                }
                let cancelled = try await self.nativeBrowser.download(tabId: tabId) { [weak self] in
                    self?.canUseBrowserDocument(sourceID: sourceID) == true
                }
                guard self.canUseBrowserDocument(sourceID: sourceID) else {
                    throw DashboardBrowserError.unavailable
                }
                replyHandler(["ok": true, "cancelled": cancelled], nil)
            } catch {
                replyHandler(["ok": false, "error": error.localizedDescription], nil)
            }
        }
    }

    private func captureBrowserReply(
        tabId: String,
        point: (Double, Double)?,
        replyHandler: @escaping DashboardBrowserMessageHandler.ReplyHandler)
    {
        let sourceID = self.notificationSourceID
        Task { @MainActor [weak self] in
            do {
                guard let self, self.canUseBrowserDocument(sourceID: sourceID) else {
                    throw DashboardBrowserError.unavailable
                }
                let reply: [String: Any] = if let point {
                    try await self.nativeBrowser.inspect(tabId: tabId, x: point.0, y: point.1)
                } else {
                    try await self.nativeBrowser.snapshot(tabId: tabId)
                }
                guard self.canUseBrowserDocument(sourceID: sourceID) else {
                    throw DashboardBrowserError.unavailable
                }
                replyHandler(reply, nil)
            } catch {
                replyHandler(["ok": false, "error": error.localizedDescription], nil)
            }
        }
    }
}
