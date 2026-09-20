import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct MacTabLoginNavigationTests {
    private func wait(_ condition: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(condition())
    }

    private func open(_ controller: DashboardWindowController, url: URL, id: String) async throws -> Bool {
        let value = try await controller.webView.callAsyncJavaScript(
            "return await webkit.messageHandlers.openclawBrowser.postMessage({type:'open',tabId:id,url,sessionKey:''})",
            arguments: ["url": url.absoluteString, "id": id], in: nil, contentWorld: .page)
        return (value as? [String: Any])?["ok"] as? Bool == true
    }

    @Test(arguments: [false, true])
    func `first real link waits for consented cookies and later links reuse them`(_ manual: Bool) async throws {
        let dashboard = try await DashboardHTTPFixture.start()
        var requests: [String] = []
        let website = try await DashboardHTTPFixture.start(requestHandler: { request in requests.append(request)
            return nil
        })
        defer { dashboard.stop()
            website.stop()
        }
        var destination: DashboardNativeBrowserHost?
        var release: CheckedContinuation<Void, Never>?
        var preparations = 0
        let controller = DashboardWindowController(
            url: dashboard.url(), auth: .init(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(), windowAutosaveName: "",
            requestBrowserProfileImportOffer: { isCurrent in
                preparations += 1
                await withCheckedContinuation { release = $0 }
                guard isCurrent(), let destination else { return false }
                let cookie = MacTabCookieImport.Cookie(
                    domain: "localhost",
                    name: "synthetic-session",
                    value: "synthetic-login",
                    path: "/",
                    expires: nil,
                    secure: false,
                    httpOnly: true,
                    sameSite: 1)
                let result = try? await destination.importChromeCookies(
                    .init(cookies: [cookie], total: 1), protectedHost: "127.0.0.1", isCurrent: isCurrent)
                return result?.imported == 1
            })
        destination = controller.nativeBrowser
        defer { controller.closeDashboard()
            release?.resume()
        }
        controller.show()
        try await self.wait { !controller.webView.isLoading && controller.webView.url == dashboard.url() }
        var components = try #require(URLComponents(url: website.url("/first"), resolvingAgainstBaseURL: false))
        components.host = "localhost"
        let url = try #require(components.url)
        let manualImport: Task<Void, Never>? = manual ? Task { await controller.importChromeLoginsIntoMacTabs() } : nil
        if manual { try await self.wait { release != nil } }
        let navigation = Task { try await self.open(controller, url: url, id: "first") }
        try await self.wait { release != nil }
        #expect(requests.isEmpty)
        #expect(!controller.nativeBrowser.hasTabs)
        release?.resume()
        release = nil
        await manualImport?.value
        #expect(try await navigation.value)
        try await self.wait { !requests.isEmpty }
        #expect(requests[0].contains("synthetic-session=synthetic-login"))
        requests.removeAll()
        #expect(try await self.open(controller, url: url.appendingPathComponent("next"), id: "next"))
        try await self.wait { !requests.isEmpty }
        #expect(requests[0].contains("synthetic-session=synthetic-login"))
        #expect(preparations == 1)
        let repeated = Task { await controller.importChromeLoginsIntoMacTabs() }
        try await self.wait { release != nil }
        #expect(preparations == 2)
        release?.resume()
        release = nil
        await repeated.value
    }

    @Test func `retiring the document during consent prevents navigation and subsequent writes`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        var release: CheckedContinuation<Void, Never>?
        var couldWrite = false
        let controller = DashboardWindowController(
            url: server.url(), auth: .init(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(), windowAutosaveName: "",
            requestBrowserProfileImportOffer: { isCurrent in
                await withCheckedContinuation { release = $0 }
                couldWrite = isCurrent()
                return couldWrite
            })
        defer { controller.closeDashboard()
            release?.resume()
        }
        controller.show()
        try await self.wait { !controller.webView.isLoading && controller.webView.url == server.url() }
        let navigation = Task { try? await self.open(controller, url: server.url("/reader"), id: "retired") }
        try await self.wait { release != nil }
        controller.invalidateBrowserSession()
        release?.resume()
        release = nil
        _ = await navigation.value
        #expect(!couldWrite)
        #expect(!controller.nativeBrowser.hasTabs)
    }

    @Test func `an iframe cannot initiate native login setup`() async throws {
        let server = try await DashboardHTTPFixture
            .start(contentSecurityPolicy: "default-src 'self'; script-src 'unsafe-inline'; frame-src 'self'")
        defer { server.stop() }
        var preparations = 0
        let controller = DashboardWindowController(
            url: server.url(), auth: .init(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(), windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in preparations += 1
                return true
            })
        defer { controller.closeDashboard() }
        controller.show()
        try await self.wait { !controller.webView.isLoading && controller.webView.url == server.url() }
        let value = try await controller.webView.callAsyncJavaScript("""
        return await new Promise(resolve => {
          addEventListener('message', e => resolve(e.data), {once:true});
          const frame = document.createElement('iframe');
          frame.srcdoc = '<script>webkit.messageHandlers.openclawBrowser.postMessage({type:"open",tabId:"untrusted",url:"https://example.test",sessionKey:""}).then(r=>parent.postMessage(r,"*"))</script>';
          document.body.append(frame);
        });
        """, arguments: [:], in: nil, contentWorld: .page)
        #expect((value as? [String: Any])?["ok"] as? Bool == false)
        #expect(preparations == 0)
        #expect(!controller.nativeBrowser.hasTabs)
    }
}
