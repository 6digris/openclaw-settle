import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

struct MacTabCookieImportTests {
    private static let now = Date(timeIntervalSince1970: 1_800_000_000)

    static func cookie(
        domain: String = ".example.test", expires: Date? = nil,
        secure: Bool = true, sameSite: Int = 2) -> MacTabCookieImport.Cookie
    {
        .init(
            domain: domain,
            name: "synthetic-session",
            value: "synthetic-cookie-value",
            path: "/",
            expires: expires,
            secure: secure,
            httpOnly: true,
            sameSite: sameSite)
    }

    @Test func `cookie security and lifetime survive the Foundation conversion`() throws {
        let session = try #require(Self.cookie().httpCookie(protectedHost: "gateway.invalid", now: Self.now))
        #expect(session.isSecure)
        #expect(session.isHTTPOnly)
        #expect(session.isSessionOnly)
        #expect(session.domain == ".example.test")
        #expect(session.sameSitePolicy == .sameSiteStrict)
        let expiry = Self.now.addingTimeInterval(3600)
        let persistent = try #require(Self.cookie(domain: "example.test", expires: expiry, sameSite: 1)
            .httpCookie(protectedHost: nil, now: Self.now))
        #expect(!persistent.isSessionOnly)
        #expect(persistent.expiresDate == expiry)
        #expect(persistent.domain == "example.test")
        #expect(persistent.sameSitePolicy == .sameSiteLax)
        let crossSite = try #require(Self.cookie(sameSite: 0).httpCookie(protectedHost: nil, now: Self.now))
        #expect(crossSite.sameSitePolicy?.rawValue == "none")
    }

    @Test func `expired insecure None and Gateway-scoped cookies are not imported`() {
        #expect(Self.cookie(expires: Self.now).httpCookie(protectedHost: nil, now: Self.now) == nil)
        #expect(Self.cookie(secure: false, sameSite: 0).httpCookie(protectedHost: nil, now: Self.now) == nil)
        #expect(Self.cookie().httpCookie(protectedHost: "gateway.example.test", now: Self.now) == nil)
        #expect(Self.cookie(domain: "gateway.example.test")
            .httpCookie(protectedHost: "gateway.example.test", now: Self.now) == nil)
        #expect(Self.cookie(domain: "example.test")
            .httpCookie(protectedHost: "gateway.example.test", now: Self.now) != nil)
        #expect(Self.cookie().httpCookie(protectedHost: "notexample.test", now: Self.now) != nil)
        #expect(Self.cookie(sameSite: -1).httpCookie(protectedHost: nil, now: Self.now)?.sameSitePolicy == .sameSiteLax)
    }
}

@Suite(.serialized)
@MainActor
struct MacTabCookieStoreTests {
    @Test func `import targets the existing and future Mac tab store not the dashboard`() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let dashboard = WKWebView(frame: .zero, configuration: configuration)
        let container = NSView()
        let store = WKWebsiteDataStore.nonPersistent()
        let host = DashboardNativeBrowserHost(
            dashboardWebView: dashboard, container: container, websiteDataStore: store, onStateChange: { _ in })
        defer { host.dispose() }
        let url = try #require(URL(string: "about:blank"))
        try host.open(tabId: "before", url: url, sessionKey: nil)
        let batch = MacTabCookieImport.Batch(cookies: [MacTabCookieImportTests.cookie()], total: 1)
        let result = try await host.importChromeCookies(batch, protectedHost: "gateway.invalid", isCurrent: { true })
        #expect(result.imported == 1)
        #expect(!result.persistent)
        try host.open(tabId: "after", url: url, sessionKey: nil)
        for id in ["before", "after"] {
            let webView = try #require(host.webView(for: id))
            #expect(webView.configuration.websiteDataStore === store)
            let cookies = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
            #expect(cookies.contains { $0.name == "synthetic-session" && $0.isHTTPOnly && $0.isSecure })
        }
        let dashboardCookies = await dashboard.configuration.websiteDataStore.httpCookieStore.allCookies()
        #expect(!dashboardCookies.contains { $0.name == "synthetic-session" })
    }

    @Test func `retired document cannot write cookies`() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let dashboard = WKWebView(frame: .zero, configuration: configuration)
        let container = NSView()
        let store = WKWebsiteDataStore.nonPersistent()
        let host = DashboardNativeBrowserHost(
            dashboardWebView: dashboard, container: container, websiteDataStore: store, onStateChange: { _ in })
        defer { host.dispose() }
        do {
            _ = try await host.importChromeCookies(
                .init(cookies: [MacTabCookieImportTests.cookie()], total: 1),
                protectedHost: nil, isCurrent: { false })
            Issue.record("Retired import must fail")
        } catch is CancellationError {}
        #expect(await store.httpCookieStore.allCookies().isEmpty)
    }

    @Test(arguments: [false, true])
    func `retirement after asynchronous write restores prior cookie or removes new cookie`(
        _ hadPrevious: Bool) async throws
    {
        let store = WKWebsiteDataStore.nonPersistent()
        let imported = MacTabCookieImportTests.cookie()
        if hadPrevious {
            let prior = try #require(HTTPCookie(properties: [
                .domain: ".example.test", .path: "/", .name: "synthetic-session", .value: "synthetic-original",
            ]))
            await store.httpCookieStore.setCookie(prior)
        }
        var checks = 0
        do {
            _ = try await MacTabCookieWriter.write(
                .init(cookies: [imported], total: 1),
                to: store,
                protectedHost: nil,
                isCurrent: {
                    checks += 1
                    // Retire after lock acquisition, selection and the prior-cookie read,
                    // when the asynchronous setCookie has completed.
                    return checks < 4
                })
            Issue.record("Retired write must fail")
        } catch is CancellationError {}
        let remaining = await store.httpCookieStore.allCookies()
        if hadPrevious {
            #expect(remaining.count == 1)
            #expect(remaining.first?.value == "synthetic-original")
        } else {
            #expect(remaining.isEmpty)
        }
    }

    @Test func `a retired import cannot roll back a queued import of the same cookie`() async throws {
        let store = WKWebsiteDataStore.nonPersistent()
        let batch = MacTabCookieImport.Batch(cookies: [MacTabCookieImportTests.cookie()], total: 1)
        var second: Task<MacTabCookieImport.ImportResult, Error>?
        var checks = 0
        do {
            _ = try await MacTabCookieWriter.write(batch, to: store, protectedHost: nil, isCurrent: {
                checks += 1
                if checks == 3 {
                    second = Task {
                        try await MacTabCookieWriter.write(batch, to: store, protectedHost: nil, isCurrent: { true })
                    }
                }
                return checks < 4
            })
            Issue.record("First import must retire after its write")
        } catch is CancellationError {}
        let next = try #require(second)
        #expect(try await next.value.imported == 1)
        let cookies = await store.httpCookieStore.allCookies()
        #expect(cookies.first?.value == "synthetic-cookie-value")
    }
}
