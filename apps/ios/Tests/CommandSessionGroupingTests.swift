import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

struct CommandSessionGroupingTests {
    @Test func `groups pinned categories and ungrouped in display order`() {
        let sections = CommandSessionGrouping.sections(from: [
            self.entry("ungrouped", activity: 2),
            self.entry("beta", category: "Beta", activity: 3),
            self.entry("alpha-old", category: "Alpha", activity: 1),
            self.entry("pinned", category: "Beta", pinned: true, activity: 4),
            self.entry("alpha-new", category: "Alpha", activity: 5),
        ])

        #expect(sections.map(\.id) == [
            .pinned,
            .category("Alpha"),
            .category("Beta"),
            .ungrouped,
        ])
        #expect(sections[0].entries.map(\.key) == ["pinned"])
        #expect(sections[1].entries.map(\.key) == ["alpha-new", "alpha-old"])
        #expect(sections[3].showsHeader)
    }

    @Test func `known groups render empty sections in alphabetical merge`() {
        let sections = CommandSessionGrouping.sections(
            from: [
                self.entry("beta", category: "Beta", activity: 2),
                self.entry("plain", activity: 1),
            ],
            knownGroups: ["Zulu", "Alpha"])

        #expect(sections.map(\.id) == [
            .category("Alpha"),
            .category("Beta"),
            .category("Zulu"),
            .ungrouped,
        ])
        #expect(sections[0].entries.isEmpty)
        #expect(sections[1].entries.map(\.key) == ["beta"])
        #expect(sections[2].entries.isEmpty)
        #expect(sections[3].showsHeader)
    }

    @Test func `known groups ignore blanks and duplicates`() {
        let sections = CommandSessionGrouping.sections(
            from: [self.entry("beta", category: "Beta", activity: 1)],
            knownGroups: ["  ", "Beta", "Beta", "Alpha"])

        #expect(sections.map(\.id) == [.category("Alpha"), .category("Beta")])

        let categories = CommandSessionGrouping.categories(
            from: [self.entry("beta", category: "Beta", activity: 1)],
            knownGroups: ["", "Beta", "Alpha", "Alpha"])
        #expect(categories == ["Alpha", "Beta"])
    }

    @Test func `hides ungrouped header without category sections`() {
        let sections = CommandSessionGrouping.sections(from: [self.entry("plain", activity: 1)])

        #expect(sections.count == 1)
        #expect(sections[0].id == .ungrouped)
        #expect(!sections[0].showsHeader)
    }

    @Test func `preview puts pinned sessions before recent activity`() {
        let entries = CommandSessionGrouping.previewOrder([
            self.entry("recent", activity: 20),
            self.entry("pinned-old", pinned: true, activity: 1),
            self.entry("older", activity: 10),
        ])

        #expect(entries.map(\.key) == ["pinned-old", "recent", "older"])
    }

    @Test func `preview selection keeps the open chat visible past the cap`() {
        let entries = [
            self.entry("a", activity: 40),
            self.entry("b", activity: 30),
            self.entry("c", activity: 20),
            self.entry("current", activity: 10),
        ]

        let selection = CommandSessionGrouping.previewSelection(entries, currentKey: "current")
        #expect(selection.map(\.key) == ["current", "a", "b"])

        // Natural order wins when the current session already fits the cap.
        let natural = CommandSessionGrouping.previewSelection(entries, currentKey: "a")
        #expect(natural.map(\.key) == ["a", "b", "c"])

        // Unknown or empty keys fall back to the plain capped ordering.
        let fallback = CommandSessionGrouping.previewSelection(entries, currentKey: "")
        #expect(fallback.map(\.key) == ["a", "b", "c"])
    }

    private func entry(
        _ key: String,
        category: String? = nil,
        pinned: Bool = false,
        activity: Double) -> OpenClawChatSessionEntry
    {
        OpenClawChatSessionEntry(
            key: key,
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: nil,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            modelProvider: nil,
            model: nil,
            contextTokens: nil,
            category: category,
            pinned: pinned,
            lastActivityAt: activity)
    }
}

@MainActor
struct SessionGroupStoreTests {
    @Test func `normalizes trims dedupes and drops blanks`() {
        #expect(SessionGroupStore.normalized([" Ops ", "Ops", "", "  ", "Dev"]) == ["Ops", "Dev"])
    }

    @Test func `acknowledged import removes only the unchanged legacy source`() throws {
        let suite = "SessionGroupStoreTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set([" Dev ", "Dev", "Ops"], forKey: SessionGroupStore.defaultsKey)
        let imported = SessionGroupStore.legacyNames(defaults: defaults)
        #expect(imported == ["Dev", "Ops"])
        defaults.set(["Dev", "Ops", "Later"], forKey: SessionGroupStore.defaultsKey)
        SessionGroupStore.acknowledgeLegacyImport(imported, defaults: defaults)
        #expect(SessionGroupStore.legacyNames(defaults: defaults) == ["Dev", "Ops", "Later"])
        SessionGroupStore.acknowledgeLegacyImport(["Dev", "Ops", "Later"], defaults: defaults)
        #expect(defaults.object(forKey: SessionGroupStore.defaultsKey) == nil)
    }
}

private actor SessionGroupRequestProbe {
    var requests: [OpenClawChatGatewayRequest] = []
    var groups = ["Owned"]
    var consumed: [String: Set<String>] = [:]
    var profileID = "profile-1"
    var failAppend = false
    var loseAcknowledgement = false
    var appendGate: CheckedContinuation<Void, Never>?
    var suspendAppend = false
    var appendStarted: CheckedContinuation<Void, Never>?
    var listGate: CheckedContinuation<Void, Never>?
    var suspendList = false
    var listStarted: CheckedContinuation<Void, Never>?

    func configure(
        failAppend: Bool = false, loseAcknowledgement: Bool = false,
        suspendAppend: Bool = false, suspendList: Bool = false, profileID: String = "profile-1")
    {
        self.failAppend = failAppend
        self.loseAcknowledgement = loseAcknowledgement
        self.suspendAppend = suspendAppend
        self.suspendList = suspendList
        self.profileID = profileID
    }

    func deleteGroup(_ name: String) { self.groups.removeAll { $0 == name } }

    func waitForAppend() async {
        if self.appendGate != nil { return }
        await withCheckedContinuation { self.appendStarted = $0 }
    }

    func releaseAppend() {
        self.appendGate?.resume()
        self.appendGate = nil
    }

    func waitForList() async {
        if self.listGate != nil { return }
        await withCheckedContinuation { self.listStarted = $0 }
    }

    func releaseList() {
        self.listGate?.resume()
        self.listGate = nil
    }

    func send(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        self.requests.append(request)
        if request.method == "users.self" {
            return try JSONSerialization.data(withJSONObject: ["profile": ["id": self.profileID]])
        }
        if request.params["append"]?.value as? Bool == true {
            if self.failAppend { throw URLError(.cannotConnectToHost) }
            let names = request.params["names"]?.value as? [String] ?? []
            // Model the Gateway receipt contract: consumed names survive user deletion.
            if let importID = request.params["importId"]?.value as? String {
                var consumed = self.consumed[importID] ?? []
                for name in names where consumed.insert(name).inserted {
                    if !self.groups.contains(name) { self.groups.append(name) }
                }
                self.consumed[importID] = consumed
            } else {
                for name in names where !self.groups.contains(name) { self.groups.append(name) }
            }
            if self.suspendAppend {
                await withCheckedContinuation { continuation in
                    self.appendGate = continuation
                    self.appendStarted?.resume()
                    self.appendStarted = nil
                }
            }
            if self.loseAcknowledgement { throw URLError(.networkConnectionLost) }
        }
        let groupRows: [[String: Any]] = self.groups.enumerated().map {
            ["name": $0.element, "position": $0.offset]
        }
        let response = try JSONSerialization.data(withJSONObject: ["ok": true, "groups": groupRows])
        if request.method == "sessions.groups.list", self.suspendList {
            await withCheckedContinuation { continuation in
                self.listGate = continuation
                self.listStarted?.resume()
                self.listStarted = nil
            }
        }
        return response
    }
}

@MainActor
private final class SessionGroupMigrationFixture {
    let suite = "SessionGroupMigrationTests-\(UUID().uuidString)"
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let defaults: UserDefaults
    let databases: OpenClawClientDatabases
    let store = SessionGroupStore()
    let probe = SessionGroupRequestProbe()
    let primary = SessionGroupStore.Scope(identity: "one:primary", gatewayID: "one", agentID: "primary")

    init() throws {
        self.defaults = try #require(UserDefaults(suiteName: self.suite))
        self.databases = try OpenClawClientDatabases(directoryURL: self.directory)
        self.defaults.set(["Legacy"], forKey: SessionGroupStore.defaultsKey)
    }

    func close() {
        try? self.databases.close()
        self.defaults.removePersistentDomain(forName: self.suite)
        try? FileManager.default.removeItem(at: self.directory)
    }

    func refresh(
        scope: SessionGroupStore.Scope? = nil,
        defaultAgentID: @MainActor () -> String? = { "primary" },
        store: SessionGroupStore? = nil,
        probe: SessionGroupRequestProbe? = nil,
        isCurrent: @MainActor () -> Bool = { true },
        isImportRouteCurrent: @MainActor () async -> Bool = { true }) async
    {
        let scope = scope ?? self.primary
        let probe = probe ?? self.probe
        await (store ?? self.store).refresh(
            scope: scope, defaultAgentID: defaultAgentID,
            acquireLease: {
                try OpenClawChatSessionGroupsRouteLease(
                    agentID: scope.agentID, supportsAgentScope: true, request: { try await probe.send($0) })
            },
            claimImport: {
                try self.databases.claimLegacySessionGroupImport(
                    gatewayID: scope.gatewayID, profileID: $0, agentID: scope.agentID)
            },
            defaults: self.defaults, isCurrent: isCurrent, isImportRouteCurrent: isImportRouteCurrent)
    }
}

@MainActor
struct SessionGroupMigrationTests {
    @Test func `legacy names import only to default agent and only once`() async throws {
        let fixture = try SessionGroupMigrationFixture()
        defer { fixture.close() }
        let research = SessionGroupStore.Scope(identity: "one:research", gatewayID: "one", agentID: "research")
        await fixture.refresh(scope: research)
        #expect(await fixture.probe.requests.count == 1)
        #expect(SessionGroupStore.legacyNames(defaults: fixture.defaults) == ["Legacy"])
        await fixture.refresh()
        let requests = await fixture.probe.requests
        #expect(requests.map(\.method) == [
            "sessions.groups.list", "users.self", "sessions.groups.put", "users.self", "sessions.groups.list",
        ])
        #expect(requests[2].params["agentId"]?.value as? String == "primary")
        #expect(requests[2].params["importId"]?.value as? String != nil)
        #expect(SessionGroupStore.legacyNames(defaults: fixture.defaults).isEmpty)
        await fixture.refresh()
        #expect(await fixture.probe.requests.count == 6)
        #expect(fixture.store.names(for: research).isEmpty)
    }

    @Test func `failed migration preserves source but still reads canonical catalog`() async throws {
        let fixture = try SessionGroupMigrationFixture()
        defer { fixture.close() }
        await fixture.probe.configure(failAppend: true)
        await fixture.refresh()
        #expect(SessionGroupStore.legacyNames(defaults: fixture.defaults) == ["Legacy"])
        #expect(fixture.store.errorText != nil)
        #expect(fixture.store.groups.map(\.name) == ["Owned"])
        #expect(await fixture.probe.requests.count == 3)
    }

    @Test func `missing authenticated profile preserves source without blocking catalog`() async throws {
        let fixture = try SessionGroupMigrationFixture()
        defer { fixture.close() }
        await fixture.probe.configure(profileID: "")
        await fixture.refresh()
        #expect(SessionGroupStore.legacyNames(defaults: fixture.defaults) == ["Legacy"])
        #expect(fixture.store.errorText != nil)
        #expect(fixture.store.groups.map(\.name) == ["Owned"])
        #expect(await fixture.probe.requests.map(\.method) == ["users.self", "sessions.groups.list"])
    }

    @Test func `lost ack then deletion and restart retry never resurrects consumed names`() async throws {
        let fixture = try SessionGroupMigrationFixture()
        defer { fixture.close() }
        await fixture.probe.configure(loseAcknowledgement: true)
        await fixture.refresh()
        #expect(SessionGroupStore.legacyNames(defaults: fixture.defaults) == ["Legacy"])
        await fixture.probe.deleteGroup("Legacy")
        await fixture.probe.configure()
        let restarted = SessionGroupStore()
        await fixture.refresh(store: restarted)
        let imports = await fixture.probe.requests.filter { $0.method == "sessions.groups.put" }
        try #require(imports.count == 2)
        #expect(imports[0].params["importId"] == imports[1].params["importId"])
        #expect(restarted.groups.map(\.name) == ["Owned"])
        #expect(SessionGroupStore.legacyNames(defaults: fixture.defaults).isEmpty)
    }

    @Test func `changed default gateway or profile cannot retarget or block catalog reads`() async throws {
        let fixture = try SessionGroupMigrationFixture()
        defer { fixture.close() }
        await fixture.probe.configure(loseAcknowledgement: true)
        await fixture.refresh()
        for (scope, profile) in [
            (SessionGroupStore.Scope(identity: "one:other", gatewayID: "one", agentID: "other"), "profile-1"),
            (SessionGroupStore.Scope(identity: "two:primary", gatewayID: "two", agentID: "primary"), "profile-1"),
            (fixture.primary, "profile-2"),
        ] {
            let probe = SessionGroupRequestProbe()
            await probe.configure(profileID: profile)
            await fixture.refresh(scope: scope, defaultAgentID: { scope.agentID }, probe: probe)
            #expect(await probe.requests.map(\.method) == ["users.self", "sessions.groups.list"])
            #expect(fixture.store.groups.map(\.name) == ["Owned"])
            #expect(fixture.store.errorText != nil)
            #expect(SessionGroupStore.legacyNames(defaults: fixture.defaults) == ["Legacy"])
        }
    }

    @Test func `source additions during pending acknowledgement reuse claim and import new names only`() async throws {
        let fixture = try SessionGroupMigrationFixture()
        defer { fixture.close() }
        await fixture.probe.configure(suspendAppend: true)
        let refresh = Task { await fixture.refresh() }
        await fixture.probe.waitForAppend()
        fixture.defaults.set(["Legacy", "Later"], forKey: SessionGroupStore.defaultsKey)
        await fixture.probe.releaseAppend()
        await refresh.value
        #expect(SessionGroupStore.legacyNames(defaults: fixture.defaults) == ["Legacy", "Later"])
        await fixture.probe.deleteGroup("Legacy")
        await fixture.probe.configure()
        await fixture.refresh()
        let imports = await fixture.probe.requests.filter { $0.method == "sessions.groups.put" }
        try #require(imports.count == 2)
        #expect(imports[0].params["importId"] == imports[1].params["importId"])
        #expect(fixture.store.groups.map(\.name) == ["Owned", "Later"])
        #expect(SessionGroupStore.legacyNames(defaults: fixture.defaults).isEmpty)
    }

    @Test func `stale authenticated route cannot claim or clear legacy source`() async throws {
        let fixture = try SessionGroupMigrationFixture()
        defer { fixture.close() }
        await fixture.refresh(isImportRouteCurrent: { false })
        #expect(await fixture.probe.requests.map(\.method) == ["users.self", "sessions.groups.list"])
        await fixture.probe.configure(suspendAppend: true)
        var routeIsCurrent = true
        let refresh = Task { await fixture.refresh(isImportRouteCurrent: { routeIsCurrent }) }
        await fixture.probe.waitForAppend()
        routeIsCurrent = false
        await fixture.probe.releaseAppend()
        await refresh.value
        #expect(SessionGroupStore.legacyNames(defaults: fixture.defaults) == ["Legacy"])
    }

    @Test func `default owner changing during route validation prevents import dispatch`() async throws {
        let fixture = try SessionGroupMigrationFixture()
        defer { fixture.close() }
        var defaultAgentID = "primary"
        await fixture.refresh(defaultAgentID: { defaultAgentID }, isImportRouteCurrent: {
            defaultAgentID = "other"
            return true
        })
        #expect(await fixture.probe.requests.map(\.method) == ["users.self", "sessions.groups.list"])
        #expect(SessionGroupStore.legacyNames(defaults: fixture.defaults) == ["Legacy"])
        #expect(fixture.store.groups.map(\.name) == ["Owned"])
    }

    @Test func `default owner changing before acknowledgement preserves legacy source`() async throws {
        let fixture = try SessionGroupMigrationFixture()
        defer { fixture.close() }
        await fixture.probe.configure(suspendAppend: true)
        var defaultAgentID = "primary"
        let refresh = Task { await fixture.refresh(defaultAgentID: { defaultAgentID }) }
        await fixture.probe.waitForAppend()
        defaultAgentID = "other"
        await fixture.probe.releaseAppend()
        await refresh.value
        #expect(SessionGroupStore.legacyNames(defaults: fixture.defaults) == ["Legacy"])
        #expect(fixture.store.groups.map(\.name) == ["Owned", "Legacy"])
        #expect(await fixture.probe.requests.filter { $0.method == "sessions.groups.put" }.count == 1)
    }

    @Test func `changed profile before acknowledgement preserves source and keeps catalog readable`() async throws {
        let fixture = try SessionGroupMigrationFixture()
        defer { fixture.close() }
        await fixture.probe.configure(suspendAppend: true)
        let refresh = Task { await fixture.refresh() }
        await fixture.probe.waitForAppend()
        await fixture.probe.configure(profileID: "profile-2")
        await fixture.probe.releaseAppend()
        await refresh.value
        #expect(SessionGroupStore.legacyNames(defaults: fixture.defaults) == ["Legacy"])
        #expect(fixture.store.groups.map(\.name) == ["Owned", "Legacy"])
        await fixture.refresh()
        #expect(fixture.store.errorText != nil)
        #expect(await fixture.probe.requests.filter { $0.method == "sessions.groups.put" }.count == 1)
    }

    @Test func `late acknowledgement clears only captured source without replacing new owner catalog`() async throws {
        let fixture = try SessionGroupMigrationFixture()
        defer { fixture.close() }
        await fixture.probe.configure(suspendAppend: true)
        var primaryIsCurrent = true
        let refresh = Task { await fixture.refresh(isCurrent: { primaryIsCurrent }) }
        await fixture.probe.waitForAppend()
        primaryIsCurrent = false
        let research = SessionGroupStore.Scope(identity: "two:research", gatewayID: "two", agentID: "research")
        await fixture.refresh(scope: research, probe: SessionGroupRequestProbe())
        await fixture.probe.releaseAppend()
        await refresh.value
        #expect(SessionGroupStore.legacyNames(defaults: fixture.defaults).isEmpty)
        #expect(fixture.store.names(for: research) == ["Owned"])
        #expect(fixture.store.names(for: fixture.primary).isEmpty)
    }

    @Test func `stale list generation cannot overwrite newer catalog on same owner`() async throws {
        let fixture = try SessionGroupMigrationFixture()
        defer { fixture.close() }
        fixture.defaults.removeObject(forKey: SessionGroupStore.defaultsKey)
        await fixture.probe.configure(suspendList: true)
        let refresh = Task { await fixture.refresh() }
        await fixture.probe.waitForList()
        let currentProbe = SessionGroupRequestProbe()
        await currentProbe.deleteGroup("Owned")
        await fixture.refresh(probe: currentProbe)
        await fixture.probe.releaseList()
        await refresh.value
        #expect(fixture.store.groups.isEmpty)
    }
}
