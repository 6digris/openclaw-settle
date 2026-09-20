import Foundation
import GRDB
import Testing
@testable import OpenClawChatUI

struct SessionGroupImportClaimTests {
    @Test func `claim survives reopen and rejects every changed destination component`() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let original = try OpenClawClientDatabases(directoryURL: directory)
        let importID = try original.claimLegacySessionGroupImport(
            gatewayID: "gateway", profileID: "profile", agentID: "primary")
        try original.close()

        let reopened = try OpenClawClientDatabases(directoryURL: directory)
        defer { try? reopened.close() }
        #expect(try reopened.claimLegacySessionGroupImport(
            gatewayID: "gateway", profileID: "profile", agentID: "primary") == importID)
        for (gateway, profile, agent) in [
            ("other", "profile", "primary"),
            ("gateway", "other", "primary"),
            ("gateway", "profile", "other"),
        ] {
            #expect(throws: OpenClawChatSessionGroupImportError.self) {
                try reopened.claimLegacySessionGroupImport(gatewayID: gateway, profileID: profile, agentID: agent)
            }
        }
    }

    @Test func `additive import migration preserves previous client state on reopen`() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let legacy = try DatabaseQueue(
            path: directory.appendingPathComponent(OpenClawClientDatabases.clientStateFilename).path)
        var migrator = DatabaseMigrator()
        OpenClawClientDatabases.registerClientStateMigrationsV1ThroughV5(&migrator)
        OpenClawClientDatabases.registerClientStateMigrationsV6ThroughV8(&migrator)
        OpenClawClientDatabases.registerWatchMessageJournalMigration(&migrator)
        try migrator.migrate(legacy)
        try legacy.write { db in
            try db.execute(sql: """
            INSERT INTO gateway_routing_identity(gateway_id, scope, main_session_key, default_agent_id, updated_at)
            VALUES ('gateway', 'per-sender', 'agent:primary:main', 'primary', 1)
            """)
        }
        try legacy.close()
        let upgraded = try OpenClawClientDatabases(directoryURL: directory)
        defer { try? upgraded.close() }
        #expect(upgraded.loadSessionRoutingIdentity(gatewayID: "gateway")?.defaultAgentID == "primary")
        let importID = try upgraded.claimLegacySessionGroupImport(
            gatewayID: "gateway", profileID: "profile", agentID: "primary")
        #expect(!importID.isEmpty)
    }

    @Test func `forgetting a gateway cannot release an uncertain import for another destination`() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        defer { try? databases.close() }
        let importID = try databases.claimLegacySessionGroupImport(
            gatewayID: "gateway", profileID: "profile", agentID: "primary")
        try databases.removeGatewayData(gatewayID: "gateway")
        #expect(throws: OpenClawChatSessionGroupImportError.self) {
            try databases.claimLegacySessionGroupImport(
                gatewayID: "other", profileID: "profile", agentID: "primary")
        }
        #expect(try databases.claimLegacySessionGroupImport(
            gatewayID: "gateway", profileID: "profile", agentID: "primary") == importID)
    }
}
