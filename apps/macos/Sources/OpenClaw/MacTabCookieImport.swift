import Foundation

/// WebKit adapter for the canonical Browser plugin producer; no profile or crypto ownership.
enum MacTabCookieImport {
    struct Profile: Codable, Equatable, Sendable {
        let browser: String
        let id: String
        let name: String
        let hasCookies: Bool
    }

    struct Cookie: Sendable {
        let domain: String
        let name: String
        let value: String
        let path: String
        let expires: Date?
        let secure: Bool
        let httpOnly: Bool
        let sameSite: Int

        func httpCookie(protectedHost: String?, now: Date) -> HTTPCookie? {
            let host = self.domain.lowercased()
            let bareHost = host.hasPrefix(".") ? String(host.dropFirst()) : host
            guard !bareHost.isEmpty, self.path.hasPrefix("/"),
                  self.expires.map({ $0 > now }) ?? true,
                  [-1, 0, 1, 2].contains(self.sameSite),
                  self.sameSite != 0 || self.secure else { return nil }
            if let protectedHost = protectedHost?.lowercased(),
               protectedHost == bareHost || (host.hasPrefix(".") && protectedHost.hasSuffix("." + bareHost))
            {
                // Ordinary local dashboards may share this store. An import must
                // never replace the Gateway account that authorized the action.
                return nil
            }
            var properties: [HTTPCookiePropertyKey: Any] = [
                .domain: self.domain, .path: self.path, .name: self.name, .value: self.value,
            ]
            if let expires = self.expires {
                properties[.expires] = expires
            } else {
                properties[.discard] = "TRUE"
            }
            if self.secure { properties[.secure] = "TRUE" }
            if self.httpOnly { properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
            // Foundation has no public sameSiteNone constant. WebKit's Cocoa
            // cookie adapter accepts the explicit "none" policy string.
            if self.sameSite == 0 {
                properties[.sameSitePolicy] = "none"
            } else if self.sameSite == 2 {
                properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict.rawValue
            } else {
                // Chrome's unspecified policy is Lax by default, not None.
                properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteLax.rawValue
            }
            return HTTPCookie(properties: properties)
        }
    }

    struct ImportResult: Equatable {
        let total: Int
        let imported: Int
        let skipped: Int
        let failed: Int
        let persistent: Bool
    }

    struct Batch: Decodable, Sendable {
        var cookies: [Cookie] = []
        var total = 0
        var skipped = 0
        var failed = 0
    }

    enum ImportError: LocalizedError {
        case unavailable
        var errorDescription: String? {
            String(
                localized: """
                Browser login import could not finish. Use a matching packaged OpenClaw app, \
                allow its Keychain prompt, and retry.
                """)
        }
    }
}

extension MacTabCookieImport.Cookie: Decodable {
    private enum CodingKeys: String, CodingKey { case domain, name, value, path, expires, secure, httpOnly, sameSite }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.domain = try c.decode(String.self, forKey: .domain)
        self.name = try c.decode(String.self, forKey: .name)
        self.value = try c.decode(String.self, forKey: .value)
        self.path = try c.decode(String.self, forKey: .path)
        self.expires = try c.decodeIfPresent(Double.self, forKey: .expires).map(Date.init(timeIntervalSince1970:))
        self.secure = try c.decode(Bool.self, forKey: .secure)
        self.httpOnly = try c.decode(Bool.self, forKey: .httpOnly)
        switch try c.decodeIfPresent(String.self, forKey: .sameSite) {
        case "None": self.sameSite = 0
        case "Strict": self.sameSite = 2
        case "Lax", nil: self.sameSite = 1
        default: throw MacTabCookieImport.ImportError.unavailable
        }
    }
}
