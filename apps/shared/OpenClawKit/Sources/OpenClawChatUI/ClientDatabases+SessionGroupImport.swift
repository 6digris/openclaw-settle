import CryptoKit
import Foundation
import GRDB

public enum OpenClawChatSessionGroupImportError: LocalizedError {
    case unavailable
    case missingProfile
    case destinationChanged
    case notAcknowledged

    public var errorDescription: String? {
        switch self {
        case .unavailable:
            "Legacy groups are waiting for local storage to become available. Gateway groups remain available."
        case .missingProfile:
            "Legacy groups need an authenticated profile before import. Gateway groups remain available."
        case .destinationChanged:
            "Legacy groups belong to their original Gateway, profile, and agent. Reconnect there to finish importing."
        case .notAcknowledged:
            "Legacy group import was not acknowledged. The local source has been kept for retry."
        }
    }
}

extension OpenClawClientDatabases {
    static func registerSessionGroupImportMigration(_ migrator: inout DatabaseMigrator) {
        migrator.registerMigration("client-state-session-group-import-v10") { db in
            try db.execute(sql: """
            CREATE TABLE session_group_legacy_import(
                id INTEGER NOT NULL PRIMARY KEY CHECK(id = 1),
                import_id TEXT NOT NULL,
                destination_hash BLOB NOT NULL
            );
            """)
        }
    }

    /// One shipped, installation-wide source has one permanent destination claim.
    /// Commit before dispatch, and retain it even after acknowledgement or Gateway
    /// removal: a lost acknowledgement must never let old preferences retarget.
    /// Only the digest is retained, not forgotten Gateway/profile identifiers.
    public func claimLegacySessionGroupImport(gatewayID: String, profileID: String, agentID: String) throws -> String {
        guard !gatewayID.isEmpty, !profileID.isEmpty, !agentID.isEmpty, agentID != "*" else {
            throw OpenClawChatSessionGroupImportError.missingProfile
        }
        // Length-prefixed bytes preserve exact identities and avoid separator collisions.
        var destination = Data()
        for component in [gatewayID, profileID, agentID] {
            let bytes = Data(component.utf8)
            destination.append(contentsOf: "\(bytes.count):".utf8)
            destination.append(bytes)
        }
        let destinationHash = Data(SHA256.hash(data: destination))
        return try self.stateQueue.write { db in
            if let row = try Row.fetchOne(
                db, sql: "SELECT import_id, destination_hash FROM session_group_legacy_import")
            {
                let existingHash: Data = row["destination_hash"]
                guard existingHash == destinationHash else {
                    throw OpenClawChatSessionGroupImportError.destinationChanged
                }
                return row["import_id"]
            }
            let importID = UUID().uuidString
            try db.execute(
                sql: "INSERT INTO session_group_legacy_import(id, import_id, destination_hash) VALUES (1, ?, ?)",
                arguments: [importID, destinationHash])
            return importID
        }
    }
}
