import Foundation
import Testing
@testable import OpenClaw

struct ChromeExtensionSetupTests {
    private static let pending = """
    {"action":"install","target":{"kind":"local-host","platform":"darwin","hostname":"Example Mac",
    "profile":"chrome","relayPort":18792},"phase":"needs_browser_action","reason":"chrome_approval_required",
    "installation":{"nativeHostRegistered":true,"installRequested":true,"discoveredProfiles":0,
    "awaitingApproval":true,"automaticBootstrapSupported":true},"connection":{"state":"not_checked"},
    "nextAction":"approve_extension","privatePath":"must not cross bridge"}
    """

    @Test func `registration and pending approval preserve controller state without claiming connected`() throws {
        let result = try ChromeExtensionSetup.readResult(Self.pending, action: .install)
        #expect(result.installation.nativeHostRegistered)
        #expect(result.installation.awaitingApproval)
        #expect(result.phase == .needsBrowserAction)
        #expect(result.connection.state == .notChecked)
        #expect(result.nextAction == .approveExtension)
        let json = try #require(String(data: JSONEncoder().encode(result), encoding: .utf8))
        #expect(!json.contains("privatePath"))
    }

    @Test(arguments: [
        ("local-host", "remote-host"), ("darwin", "linux"), ("18792", "0"),
        ("needs_browser_action", "unknown"), ("chrome_approval_required", "raw private diagnostic"),
    ])
    func `rejects invalid host targets and controller states`(_ replacement: (String, String)) {
        #expect(throws: (any Error).self) {
            try ChromeExtensionSetup.readResult(
                Self.pending.replacingOccurrences(of: replacement.0, with: replacement.1), action: .install)
        }
    }

    @Test func `rejects a result belonging to another action`() {
        #expect(throws: (any Error).self) {
            try ChromeExtensionSetup.readResult(Self.pending, action: .verify)
        }
    }
}
