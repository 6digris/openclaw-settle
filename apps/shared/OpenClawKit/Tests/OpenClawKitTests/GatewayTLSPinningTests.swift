import CryptoKit
import Foundation
import Security
import Testing
@testable import OpenClawKit

private let gatewayTLSTestCertificateDER =
    Data(
        base64Encoded: "MIIDWDCCAkCgAwIBAgIUauCyPszeo0mp5lDu/ldJ80BblyAwDQYJKoZIhvcNAQELBQAwHTEbMBkGA1UEAwwST3BlbkNsYXcgVGVzdCBSb290MB4XDTI2MDkxNjIzMzgwMloXDTM2MDkxMzIzMzgwMlowGjEYMBYGA1UEAwwPZ2F0ZXdheS5leGFtcGxlMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzMAA6Buy59e7+eLCThjP6wfRy8iCsgiYkgnmfr41C1tv0FZ2g2Ng2NI1BySn06uf+NFa9t9PasRNre0bLWcYfHeCdcGn4nIV5MaplcW27ZFT88wjH7ay3tWOUA/rW15lyS64EGNZIl5oRdVSJAUQPZcbPklqDpwdJD+ioLRhs+TRcZjhWb/UjgQNIY3h/rYeqtp7vMjEOd0uOAKhGl3fOP6nVK+lkVhCrrSc6gzwmUtWLiWdIxajHYtkKrn1d6wRiHZzc9S/aJdRq1Hvw/HcI03wiGI6vwzaiJLCEb1NmQjqFEor9u9IShCP8tL2gBd2SflULOZkkw63c+PZvmx7qwIDAQABo4GSMIGPMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgWgMBMGA1UdJQQMMAoGCCsGAQUFBwMBMBoGA1UdEQQTMBGCD2dhdGV3YXkuZXhhbXBsZTAdBgNVHQ4EFgQUNn5BHr8qcKvE5igQZbwZ8J6vM/swHwYDVR0jBBgwFoAUts+usfxRB5GLIT7C+nW6UvhThd0wDQYJKoZIhvcNAQELBQADggEBADU0SYCRtlYyq91SNqk2VcVagcE5KwtCrxbJ+UGy81wPgNmo8ADlsHteYCeicV8ssYiS7y03y50glhZmMBwoHVmJVYxvIHJRvflTMxIDEsL5buTPBu+DHpm+NzYGB5WjsKuIstAMmplw0VNuen5cWYXa7RO2C9+Y8nLs8epSjMjfjpzwiOTGLXKvbh5gvz43eiE45gxZAaJTFTgVyP66jAS9c35Zom5ySpmJb158xTLGOt5KuMIvdyGThhIrO07+/Xf98LjOZlXeUkSriPf+HpCYQ2GHEISr9nny76aLSFYicxK83+1hLpZ5RLNnriQd4zWVUQ9Fwap7PU7wMvxkFFc=")!

private let gatewayTLSTestRootCertificateDER =
    Data(
        base64Encoded: "MIIDLjCCAhagAwIBAgIUC9JAVNvGBIDo2BS+V7G99pN8GyUwDQYJKoZIhvcNAQELBQAwHTEbMBkGA1UEAwwST3BlbkNsYXcgVGVzdCBSb290MB4XDTI2MDkxNjIzMzgwMloXDTM2MDkxMzIzMzgwMlowHTEbMBkGA1UEAwwST3BlbkNsYXcgVGVzdCBSb290MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxQiaBno9MfYvVIp3a1nFfqzjtysdvTjKCk+pkhuc5sZtbI+hc78vGtlhgEOM3qXYcJB+xamL3Hq3kL4h4gcQ5jdIeyDTiXYqyx2ZOfBv5YJqqruDEhhYkpn8Aui3qM+wXUwRvzv3z7ILoIKu0coerNEi1rd439OeRDagnG+9/XQWsTiVzUkU/NQz49qHVypwD6vjIVmQrtdqekAujZUR2CQQRSq4VALsW68SJKgo9WRWzru84iVbOl/9QD4BYTmlWN4MBXF22c5sHzab/r0gz09hHMt0iZXZ/B/ySnCgx5qDVV6pGktsdAKwIe1131evGQ8/4h3mZp28aYYwRnPUlwIDAQABo2YwZDAdBgNVHQ4EFgQUts+usfxRB5GLIT7C+nW6UvhThd0wHwYDVR0jBBgwFoAUts+usfxRB5GLIT7C+nW6UvhThd0wEgYDVR0TAQH/BAgwBgEB/wIBADAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBAH85J98/+qyMBscExFiH7qcsRRKrusm402S5V0A7rpSWvjB3v80zTT/tU35e24fo4oEkmwFAWzQ8wWcBzuEpUw/ZMcOATJwZu7oZ6m0+XNQg4qnDVqF3K6j7jzj15cXy1aq/rF+9qyepWvzcB8AZrDOxz7Yg48fMeDoiLBLOiOv2XxECRb/DKoRfoqimTBFbNuvjvkatsxTgB2V8pBE4xcqgM94pMO6EztFGMySmRI0PqYAlgguw4q/gmeWy/anAEhSRb8sZp+2XrrKKa0xbzbNsO7TrUlQ+vN5LdmDh//UYbHWeX5MxQi2J05gQWKJb6Fuxy5jh6C7HpgIBDZwIu6A=")!

private func gatewayTLSTestTrust(systemTrusted: Bool) throws -> SecTrust {
    let certificate = try #require(SecCertificateCreateWithData(nil, gatewayTLSTestCertificateDER as CFData))
    let rootCertificate = try #require(
        SecCertificateCreateWithData(nil, gatewayTLSTestRootCertificateDER as CFData))
    let policy = systemTrusted
        ? SecPolicyCreateBasicX509()
        : SecPolicyCreateSSL(true, "gateway.example" as CFString)
    var trust: SecTrust?
    let certificateChain = [certificate, rootCertificate]
    try #require(SecTrustCreateWithCertificates(certificateChain as CFArray, policy, &trust) == errSecSuccess)
    let trustValue = try #require(trust)
    // Both trust outcomes use explicit fixture anchors, without default roots or issuer downloads.
    let anchors = systemTrusted ? [rootCertificate] : []
    try #require(SecTrustSetAnchorCertificates(trustValue, anchors as CFArray) == errSecSuccess)
    try #require(SecTrustSetAnchorCertificatesOnly(trustValue, true) == errSecSuccess)
    try #require(SecTrustSetNetworkFetchAllowed(trustValue, false) == errSecSuccess)
    return trustValue
}

@Suite(.gatewayTLSStoreIsolated)
struct GatewayTLSPinningTests {
    @Test(
        arguments: [true, false],
        ["https://other.example/", "http://gateway.example/", "https://gateway.example/login"])
    func `credential routes can refuse every transport redirect`(
        _ allowsRedirects: Bool,
        destination: String) async throws
    {
        let originalURL = try #require(URL(string: "https://gateway.example/artifact"))
        let targetURL = try #require(URL(string: destination))
        let policy = GatewayTLSPinningSession(
            params: .init(required: true, expectedFingerprint: nil, allowTOFU: false, storeKey: nil),
            allowsRedirects: allowsRedirects)
        let transport = URLSession(configuration: .ephemeral)
        let task = transport.dataTask(with: originalURL)
        defer {
            task.cancel()
            transport.invalidateAndCancel()
        }
        let response = try #require(HTTPURLResponse(
            url: originalURL, statusCode: 302, httpVersion: nil, headerFields: ["Location": destination]))
        var request = URLRequest(url: targetURL)
        request.setValue("synthetic-session", forHTTPHeaderField: "CF-Access-Token")
        let redirected = await withCheckedContinuation { continuation in
            policy.urlSession(
                transport,
                task: task,
                willPerformHTTPRedirection: response,
                newRequest: request,
                completionHandler: { continuation.resume(returning: $0) })
        }
        #expect(redirected?.url == (allowsRedirects ? targetURL : nil))
    }

    @Test func `keychain namespace configures once and fails closed after use`() {
        var state = GatewayTLSKeychainNamespaceState()
        let configuredWork = state.configure(suffix: ".profile.work")
        let reconfiguredWork = state.configure(suffix: ".profile.work")
        let configuredOther = state.configure(suffix: ".profile.other")
        let workService = state.service(base: "ai.openclaw.tls-pinning")
        let configuredWorkAfterUse = state.configure(suffix: ".profile.work")
        let configuredDefaultAfterUse = state.configure(suffix: "")
        #expect(configuredWork)
        #expect(reconfiguredWork)
        #expect(!configuredOther)
        #expect(workService == "ai.openclaw.tls-pinning.profile.work")
        #expect(configuredWorkAfterUse)
        #expect(!configuredDefaultAfterUse)

        var usedDefault = GatewayTLSKeychainNamespaceState()
        let defaultService = usedDefault.service(base: "ai.openclaw.tls-pinning")
        let configuredDefault = usedDefault.configure(suffix: "")
        let configuredProfileAfterDefaultUse = usedDefault.configure(suffix: ".profile.work")
        #expect(defaultService == "ai.openclaw.tls-pinning")
        #expect(configuredDefault)
        #expect(!configuredProfileAfterDefaultUse)
    }

    @Test func `first use pinning requires system trust`() {
        #expect(GatewayTLSFirstUsePolicy.allowsFirstUsePin(systemTrustOk: true))
        #expect(!GatewayTLSFirstUsePolicy.allowsFirstUsePin(systemTrustOk: false))
    }

    @Test func `TLS authority includes normalized host and effective port`() throws {
        let url = try #require(URL(string: "wss://Gateway.Example.com/path"))
        let route = try #require(GatewayTLSAuthority(url: url))
        let explicitPortURL = try #require(URL(string: "wss://gateway.example.com:8443/path"))
        let explicitPort = try #require(GatewayTLSAuthority(url: explicitPortURL))

        #expect(route.host == "gateway.example.com")
        #expect(route.port == 443)
        #expect(route.matches(host: "gateway.example.com", port: 0))
        #expect(route.matches(host: "gateway.example.com", port: 443))
        #expect(!route.matches(host: "redirect.example.com", port: 443))
        #expect(!route.matches(host: "gateway.example.com", port: 8443))
        #expect(!explicitPort.matches(host: "gateway.example.com", port: 0))
        #expect(explicitPort.matches(host: "gateway.example.com", port: 8443))
    }

    @Test func `matching explicit pin overrides system trust`() {
        let decision = GatewayTLSValidationPolicy.decide(
            expectedFingerprint: "expected",
            observedFingerprint: "expected",
            allowTOFU: false,
            required: true,
            systemTrustOk: false)

        #expect(decision == .accept(
            fingerprint: "expected",
            enforcePin: true,
            saveFirstUse: false))
    }

    @Test func `server trust evaluator accepts matching pin and rejects mismatch`() throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: false)
        let fingerprint = SHA256.hash(data: gatewayTLSTestCertificateDER)
            .map { String(format: "%02x", $0) }.joined()
        let matching = GatewayTLSParams(
            required: true,
            expectedFingerprint: fingerprint,
            allowTOFU: false,
            storeKey: "profile:matching")
        let mismatch = GatewayTLSParams(
            required: true,
            expectedFingerprint: String(repeating: "0", count: 64),
            allowTOFU: false,
            storeKey: "profile:mismatch")

        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: matching) == .accept)
        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: mismatch) == .reject)
    }

    @Test func `server trust evaluator rejects a different system-trusted certificate after pinning`() throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: true)
        let pinnedFingerprint = SHA256.hash(data: Data("previous certificate".utf8))
            .map { String(format: "%02x", $0) }.joined()
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: pinnedFingerprint,
            allowTOFU: false,
            storeKey: "profile:pinned")

        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: params) == .reject)
    }

    @Test func `server trust evaluator claims trusted first use`() throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: true)
        let fingerprint = SHA256.hash(data: gatewayTLSTestCertificateDER)
            .map { String(format: "%02x", $0) }.joined()
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: nil,
            allowTOFU: true,
            storeKey: "profile:first-use")

        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: params) == .accept)
        #expect(GatewayTLSStore.loadFingerprint(stableID: "profile:first-use") == fingerprint)
    }

    @Test func `server trust evaluator binds system trust to the requested hostname`() throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: true)
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: nil,
            allowTOFU: true,
            storeKey: "profile:wrong-host")

        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "other.example",
            port: 443,
            params: params) == .reject)
        #expect(GatewayTLSStore.loadFingerprint(stableID: "profile:wrong-host") == nil)
    }

    @Test func `server trust evaluator reuses persisted first use pin`() throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: false)
        let fingerprint = SHA256.hash(data: gatewayTLSTestCertificateDER)
            .map { String(format: "%02x", $0) }.joined()
        let storeKey = "profile:reconnect"
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: nil,
            allowTOFU: true,
            storeKey: storeKey)
        let claimed = GatewayTLSStore.claimFirstUseFingerprint(fingerprint, stableID: storeKey)
        #expect(claimed == fingerprint)

        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: params) == .accept)
    }

    @Test func `server trust evaluator rejects required untrusted first use`() throws {
        let trust = try gatewayTLSTestTrust(systemTrusted: false)
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: nil,
            allowTOFU: true,
            storeKey: "profile:untrusted")

        #expect(GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: "gateway.example",
            port: 443,
            params: params) == .reject)
    }

    @Test func `explicit pin mismatch and unavailable certificate fail closed`() {
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: "expected",
            observedFingerprint: "different",
            allowTOFU: false,
            required: true,
            systemTrustOk: true) == .reject(.pinMismatch))
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: "expected",
            observedFingerprint: nil,
            allowTOFU: false,
            required: true,
            systemTrustOk: true) == .reject(.certificateUnavailable))
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: nil,
            observedFingerprint: nil,
            allowTOFU: true,
            required: true,
            systemTrustOk: true) == .reject(.certificateUnavailable))
    }

    @Test func `trusted first use is saved and enforced`() {
        let decision = GatewayTLSValidationPolicy.decide(
            expectedFingerprint: nil,
            observedFingerprint: "observed",
            allowTOFU: true,
            required: true,
            systemTrustOk: true)

        #expect(decision == .accept(
            fingerprint: "observed",
            enforcePin: true,
            saveFirstUse: true))
    }

    @Test func `concurrent first use sessions share one durable fingerprint`() async {
        let stableID = "test-first-use-claim"
        let results = await withTaskGroup(of: String?.self, returning: [String?].self) { group in
            for fingerprint in ["first", "second"] {
                group.addTask {
                    GatewayTLSStore.claimFirstUseFingerprint(fingerprint, stableID: stableID)
                }
            }
            var results: [String?] = []
            for await result in group {
                results.append(result)
            }
            return results
        }
        let claimed = results.compactMap(\.self)

        #expect(claimed.count == 2)
        #expect(Set(claimed).count == 1)
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == claimed.first)
    }

    @Test func `first use claim fails closed without a storage owner`() {
        #expect(GatewayTLSStore.claimFirstUseFingerprint("observed", stableID: "") == nil)
    }

    @Test func `losing first use session adopts the shared winner`() {
        var state = GatewayTLSPinningState(expectedFingerprint: nil)

        state.enforceFingerprint("winner")

        #expect(state.enforcedFingerprint == "winner")
        #expect(state.acceptedFingerprint == nil)
    }

    @Test func `pin replacement compares the stored value atomically`() {
        let stableID = "test-pin-cas"
        GatewayTLSStore.saveFingerprint("old", stableID: stableID)

        #expect(!GatewayTLSStore.replaceFingerprint("wrong", ifCurrent: "missing", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "old")
        #expect(GatewayTLSStore.replaceFingerprint("new", ifCurrent: "old", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
    }

    @Test func `pin storage canonicalizes accepted fingerprint spelling`() {
        let stableID = "test-pin-canonical-spelling"
        let uppercase = String(repeating: "AB", count: 32)
        let lowercase = uppercase.lowercased()

        GatewayTLSStore.saveFingerprint("SHA256: \(uppercase)", stableID: stableID)

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == lowercase)
        #expect(GatewayTLSStore.replaceFingerprint(
            String(repeating: "c", count: 64),
            ifCurrent: uppercase,
            stableID: stableID))
    }

    @Test func `canonical pin without comparison metadata is upgraded for replacement`() throws {
        let stableID = "测试-pin-canonical-migration"
        let component = Data(stableID.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        try #require(GatewayTLSStoreFixture.current).seed(
            account: "fingerprint.v2.\(component)",
            data: Data("old".utf8))

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "old")
        #expect(GatewayTLSStore.replaceFingerprint("new", ifCurrent: "old", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
    }

    @Test func `unreadable v2 pin blocks a new first use claim`() throws {
        let stableID = "test-pin-unreadable-v2"
        let component = Data(stableID.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        try #require(GatewayTLSStoreFixture.current).seed(account: "fingerprint.v2.\(component)", data: Data([0xFF]))

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == nil)
        #expect(GatewayTLSStore.claimFirstUseFingerprint("new", stableID: stableID) == nil)
    }

    @Test func `legacy raw pin is migrated before conditional replacement`() throws {
        let stableID = "test-pin-legacy-migration"
        try #require(GatewayTLSStoreFixture.current).seed(account: stableID, data: Data("old".utf8))

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "old")
        #expect(GatewayTLSStore.replaceFingerprint("new", ifCurrent: "old", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
    }

    @Test func `first use fingerprint remains enforced for reconnects`() {
        var state = GatewayTLSPinningState(expectedFingerprint: nil)

        state.recordAcceptance("first", enforcePin: true)

        #expect(state.acceptedFingerprint == "first")
        #expect(state.enforcedFingerprint == "first")
    }

    @Test func `untrusted first use is rejected`() {
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: nil,
            observedFingerprint: "observed",
            allowTOFU: true,
            required: true,
            systemTrustOk: false) == .reject(.untrustedCertificate))
    }

    @Test func `clear all fingerprints removes every canonical pin without live storage`() {
        GatewayTLSStore.saveFingerprint("11", stableID: "gateway-1")
        GatewayTLSStore.saveFingerprint("22", stableID: "gateway-2")

        #expect(GatewayTLSStore.clearAllFingerprints())
        #expect(GatewayTLSStore.loadFingerprint(stableID: "gateway-1") == nil)
        #expect(GatewayTLSStore.loadFingerprint(stableID: "gateway-2") == nil)
    }
}
