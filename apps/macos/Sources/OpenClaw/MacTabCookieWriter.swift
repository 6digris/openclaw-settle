import Foundation
import WebKit

@MainActor
enum MacTabCookieWriter {
    // Windows can share a persistent store, even through distinct wrappers.
    // Serialize write/rollback process-wide; discovery, consent and reading
    // do not hold this lock.
    private static var writing = false
    private static var waiters: [CheckedContinuation<Void, Never>] = []

    private static func acquire() async {
        if self.writing {
            await withCheckedContinuation { self.waiters.append($0) }
        } else {
            self.writing = true
        }
    }

    private static func release() {
        if self.waiters.isEmpty {
            self.writing = false
        } else {
            self.waiters.removeFirst().resume()
        }
    }

    private struct Identity: Hashable {
        let name: String
        let domain: String
        let path: String
        init(_ cookie: HTTPCookie) {
            self.name = cookie.name
            self.domain = cookie.domain
            self.path = cookie.path
        }
    }

    private static func matches(_ actual: HTTPCookie, _ expected: HTTPCookie) -> Bool {
        let expiryMatches: Bool = if let expectedExpiry = expected.expiresDate,
                                     let actualExpiry = actual.expiresDate
        {
            abs(expectedExpiry.timeIntervalSince(actualExpiry)) < 1
        } else {
            expected.expiresDate == nil && actual.expiresDate == nil
        }
        return Identity(actual) == Identity(expected) && actual.value == expected.value &&
            actual.isSecure == expected.isSecure && actual.isHTTPOnly == expected.isHTTPOnly &&
            actual.isSessionOnly == expected.isSessionOnly && actual.sameSitePolicy == expected.sameSitePolicy &&
            expiryMatches
    }

    static func write(
        _ batch: MacTabCookieImport.Batch,
        to dataStore: WKWebsiteDataStore,
        protectedHost: String?,
        isCurrent: @MainActor () -> Bool) async throws -> MacTabCookieImport.ImportResult
    {
        await self.acquire()
        defer { self.release() }
        guard isCurrent(), !Task.isCancelled else { throw CancellationError() }
        let store = dataStore.httpCookieStore
        var skipped = batch.skipped
        var writes: [(cookie: HTTPCookie, previous: HTTPCookie?)] = []
        do {
            for source in batch.cookies {
                guard isCurrent(), !Task.isCancelled else { throw CancellationError() }
                guard let cookie = source.httpCookie(protectedHost: protectedHost, now: Date()) else {
                    skipped += 1
                    continue
                }
                let previous = await store.allCookies().first { Identity($0) == Identity(cookie) }
                guard isCurrent(), !Task.isCancelled else { throw CancellationError() }
                await store.setCookie(cookie)
                writes.append((cookie, previous))
                guard isCurrent(), !Task.isCancelled else { throw CancellationError() }
            }
            let stored = await store.allCookies()
            guard isCurrent(), !Task.isCancelled else { throw CancellationError() }
            let imported = writes.filter { write in stored.contains { self.matches($0, write.cookie) } }.count
            return .init(
                total: batch.total,
                imported: imported,
                skipped: skipped,
                failed: batch.failed + writes.count - imported,
                persistent: dataStore.isPersistent)
        } catch {
            // WKHTTPCookieStore has no transaction/cancel API. Complete compensating
            // writes before releasing the navigation gate. Do not overwrite a cookie
            // changed independently since this operation wrote it.
            for write in writes.reversed() {
                let current = await store.allCookies().first { Identity($0) == Identity(write.cookie) }
                guard let current, self.matches(current, write.cookie) else { continue }
                if let previous = write.previous {
                    await store.setCookie(previous)
                } else {
                    await store.delete(current)
                }
            }
            throw error
        }
    }
}
