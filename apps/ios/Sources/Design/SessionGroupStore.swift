import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit

/// A disposable projection, never another catalog writer. The only durable
/// input is the shipped preferences list and its SQLite-backed import claim.
@MainActor
@Observable
final class SessionGroupStore {
    static let defaultsKey = "openclaw:sessions:custom-groups"

    struct Scope: Equatable {
        let identity: String
        let gatewayID: String
        let agentID: String
    }

    private(set) var scope: Scope?
    private(set) var groups: [OpenClawChatSessionGroup] = []
    private(set) var errorText: String?
    private var generation = 0
    private var connectionRoute: GatewayNodeSessionRoute?
    private var importingLegacy = false
    private var legacyImportWaiters: [CheckedContinuation<Void, Never>] = []

    func names(for scope: Scope?) -> [String] {
        guard let scope, self.scope == scope else { return [] }
        return self.groups.map(\.name)
    }

    func refresh(
        scope: Scope,
        defaultAgentID: @MainActor () -> String?,
        connectionRoute: GatewayNodeSessionRoute? = nil,
        acquireLease: @MainActor () async throws -> OpenClawChatSessionGroupsRouteLease,
        claimImport: @MainActor (_ profileID: String) throws -> String,
        defaults: UserDefaults = .standard,
        isCurrent: @MainActor () -> Bool,
        isImportRouteCurrent: @MainActor () async -> Bool = { true }) async
    {
        self.generation += 1
        let generation = self.generation
        if self.scope != scope || self.connectionRoute != connectionRoute {
            self.groups = []
            self.errorText = nil
            self.scope = scope
            self.connectionRoute = connectionRoute
        }
        do {
            let lease = try await acquireLease()
            guard generation == self.generation, isCurrent(), !Task.isCancelled else { return }
            var importError: String?
            do {
                if scope.agentID == defaultAgentID()?.lowercased() {
                    try await self.importLegacyIfNeeded(
                        generation: generation, lease: lease, claimImport: claimImport, defaults: defaults,
                        isCurrent: isCurrent, isImportRouteCurrent: {
                            guard await isImportRouteCurrent() else { return false }
                            return scope.agentID == defaultAgentID()?.lowercased()
                        })
                }
            } catch {
                // Migration never hides the canonical catalog. A failed or mismatched
                // claim keeps its source and error while ordinary reads continue.
                importError = error.localizedDescription
            }
            guard generation == self.generation, isCurrent(), !Task.isCancelled else { return }
            let response = try await lease.listGroups()
            guard generation == self.generation, isCurrent(), !Task.isCancelled else { return }
            self.groups = (response?.groups ?? []).sorted { $0.position < $1.position }
            self.errorText = importError
        } catch {
            guard generation == self.generation, isCurrent(), !Task.isCancelled else { return }
            self.errorText = error.localizedDescription
        }
    }

    private func importLegacyIfNeeded(
        generation: Int,
        lease: OpenClawChatSessionGroupsRouteLease,
        claimImport: @MainActor (_ profileID: String) throws -> String,
        defaults: UserDefaults,
        isCurrent: @MainActor () -> Bool,
        isImportRouteCurrent: @MainActor () async -> Bool) async throws
    {
        guard !Self.legacyNames(defaults: defaults).isEmpty else { return }
        while self.importingLegacy {
            await withCheckedContinuation { self.legacyImportWaiters.append($0) }
            guard generation == self.generation, isCurrent(), !Task.isCancelled else { return }
        }
        self.importingLegacy = true
        defer {
            self.importingLegacy = false
            let waiters = self.legacyImportWaiters
            self.legacyImportWaiters.removeAll()
            for waiter in waiters { waiter.resume() }
        }
        guard !Self.legacyNames(defaults: defaults).isEmpty else { return }
        let profileID = try await lease.importProfileID()
        guard await isImportRouteCurrent(), generation == self.generation,
              isCurrent(), !Task.isCancelled else { return }
        let legacy = Self.legacyNames(defaults: defaults)
        guard !legacy.isEmpty else { return }
        // Synchronous durable claim finishes before the first write dispatch.
        // The same receipt survives restart, lost acks, deletion, and added names.
        let importID = try claimImport(profileID)
        let response = try await lease.importGroups(names: legacy, importID: importID)
        guard response.ok else { throw OpenClawChatSessionGroupImportError.notAcknowledged }
        // The profile owner can change independently of the socket (for example a
        // profile merge). An uncertain identity read must not clear the source.
        let acknowledgedProfileID = try await lease.importProfileID()
        guard acknowledgedProfileID == profileID else { throw OpenClawChatSessionGroupImportError.destinationChanged }
        guard await isImportRouteCurrent(), !Task.isCancelled else { return }
        Self.acknowledgeLegacyImport(legacy, defaults: defaults)
    }

    static func legacyNames(defaults: UserDefaults = .standard) -> [String] {
        self.normalized(defaults.stringArray(forKey: self.defaultsKey) ?? [])
    }

    static func acknowledgeLegacyImport(_ imported: [String], defaults: UserDefaults = .standard) {
        // Do not erase a source changed while its request was in flight.
        guard self.legacyNames(defaults: defaults) == imported else { return }
        defaults.removeObject(forKey: self.defaultsKey)
    }

    static func normalized(_ groups: [String]) -> [String] {
        var seen = Set<String>()
        return groups.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}

extension NodeAppModel {
    var sessionGroupScope: SessionGroupStore.Scope? {
        guard let gatewayID = self.chatTranscriptCacheGatewayID, let agentID = self.chatDeliveryAgentId else {
            return nil
        }
        return .init(identity: self.chatViewModelIdentityID, gatewayID: gatewayID, agentID: agentID)
    }

    var sessionGroupNames: [String] {
        self.sessionGroupStore.names(for: self.sessionGroupScope)
    }

    func sessionGroupNames(for session: OpenClawChatSessionEntry, in sessions: [OpenClawChatSessionEntry]) -> [String] {
        guard let owner = session.agentId ?? OpenClawChatSessionKey.agentID(from: session.key) ??
            self.chatDeliveryAgentId else { return [] }
        return CommandSessionGrouping.categories(
            from: sessions.filter {
                ChatSessionSidebarModel.isSessionInActiveAgentScope(
                    key: $0.key, agentID: $0.agentId, activeAgentID: owner)
            },
            knownGroups: owner == self.chatDeliveryAgentId ? self.sessionGroupNames : [])
    }

    func refreshSessionGroups() async {
        guard self.isOperatorGatewayConnected, let scope = self.sessionGroupScope else { return }
        let transport = self.makeChatTransport(outboxGatewayID: scope.gatewayID)
        guard let route = await self.operatorSession.currentRoute(ifGatewayID: scope.gatewayID),
              self.sessionGroupScope == scope else { return }
        await self.sessionGroupStore.refresh(
            scope: scope,
            defaultAgentID: { self.gatewayDefaultAgentId },
            connectionRoute: route,
            acquireLease: {
                let lease = try await transport.acquireSessionGroupsRouteLease(agentID: scope.agentID)
                guard await self.operatorSession.currentRoute(ifGatewayID: scope.gatewayID) == route else {
                    throw OpenClawChatTransportSendError.notDispatched
                }
                return lease
            },
            claimImport: { profileID in
                try self.claimLegacySessionGroupImport(
                    gatewayID: scope.gatewayID, profileID: profileID, agentID: scope.agentID)
            },
            isCurrent: { self.sessionGroupScope == scope },
            isImportRouteCurrent: {
                await self.operatorSession.currentGatewayID(ifCurrentRoute: route) == scope.gatewayID
            })
    }
}
