import AppKit
import Foundation
import Network
import Testing
import WebKit
@testable import OpenClaw

@MainActor
private final class CookieProxyCapture {
    var text = ""
}

@Suite(.serialized)
@MainActor
struct MacTabCookieDeliveryTests {
    @Test(arguments: [false, true])
    func `WebKit enforces host-only and Secure delivery and preserves protected cookies`(
        _ persistent: Bool) async throws
    {
        let identifier = UUID()
        do {
            try await self
                .exercise(store: persistent ? WKWebsiteDataStore(forIdentifier: identifier) : .nonPersistent())
        } catch {
            if persistent { try? await WKWebsiteDataStore.remove(forIdentifier: identifier) }
            throw error
        }
        if persistent { try await WKWebsiteDataStore.remove(forIdentifier: identifier) }
    }

    private func exercise(store: WKWebsiteDataStore) async throws {
        let capture = CookieProxyCapture()
        let proxy = try await DashboardHTTPFixture.start(rawResponseHandler: { request in
            if request.hasPrefix("CONNECT ") {
                return .init(data: Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8), keepConnectionOpen: true)
            }
            capture.text += request
            return nil
        }, onPostResponseData: { data in
            Task { @MainActor in capture.text += String(decoding: data, as: UTF8.self) }
        })
        defer { proxy.stop() }
        store.proxyConfigurations = [ProxyConfiguration(httpCONNECTProxy: .hostPort(
            host: "127.0.0.1", port: NWEndpoint.Port(rawValue: proxy.port)!))]
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let dashboard = WKWebView(frame: .zero, configuration: config)
        let container = NSView()
        let host = DashboardNativeBrowserHost(
            dashboardWebView: dashboard,
            container: container,
            websiteDataStore: store,
            onStateChange: { _ in })
        defer { host.dispose() }
        let protected = try #require(HTTPCookie(properties: [
            .domain: "gateway.example.test", .path: "/", .name: "gateway-session", .value: "synthetic-original",
        ]))
        await store.httpCookieStore.setCookie(protected)
        let cookies = [
            MacTabCookieImport.Cookie(
                domain: "login.example.test",
                name: "session",
                value: "synthetic-login",
                path: "/",
                expires: nil,
                secure: false,
                httpOnly: true,
                sameSite: 1),
            MacTabCookieImport.Cookie(
                domain: "login.example.test",
                name: "secure-session",
                value: "synthetic-secure",
                path: "/",
                expires: nil,
                secure: true,
                httpOnly: true,
                sameSite: 1),
            MacTabCookieImport.Cookie(
                domain: "gateway.example.test",
                name: "gateway-session",
                value: "synthetic-replacement",
                path: "/",
                expires: nil,
                secure: false,
                httpOnly: true,
                sameSite: 1),
        ]
        let result = try await host.importChromeCookies(
            .init(cookies: cookies, total: cookies.count),
            protectedHost: "gateway.example.test",
            isCurrent: { true })
        #expect(result.imported == 2)
        #expect(result.skipped == 1)
        #expect(await store.httpCookieStore.allCookies().first { $0.name == "gateway-session" }?
            .value == "synthetic-original")
        for (index, name) in ["login.example.test", "sibling.login.example.test"].enumerated() {
            capture.text = ""
            let id = "delivery-\(index)"
            try host.open(tabId: id, url: #require(URL(string: "http://\(name)/")), sessionKey: nil)
            let deadline = ContinuousClock.now + .seconds(10)
            while !capture.text.contains("\r\n\r\n"), ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            try #require(capture.text.contains("\r\n\r\n"), "No complete HTTP request reached the local proxy")
            #expect(capture.text.lowercased().contains("host: " + name))
            #expect(capture.text.contains("session=synthetic-login") == (index == 0))
            #expect(!capture.text.contains("synthetic-secure"))
            try host.close(tabId: id)
        }
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }
}
