import Foundation
import OpenClawChatUI
import Testing

struct ChatGatewayAgentCatalogTests {
    @Test func `ownerless roster keeps its display default separate from the existing routing guard`() throws {
        let data = Data(
            #"{"defaultId":"main","mainKey":"main","scope":"per-sender","ownership":"explicit","selectionRequired":true,"agents":[{"id":"main"},{"id":"primary"}]}"#
                .utf8)
        let catalog = try OpenClawChatGatewayPayloadCodec.decodeAgentsList(data)
        let identity = try OpenClawChatGatewayPayloadCodec.decodeSessionRoutingIdentity(data)

        #expect(catalog.defaultId == "main")
        // Catalog projection remains navigation metadata, not the send guard.
        #expect(catalog.sessionRoutingContract == "per-sender|main|main")
        #expect(identity.defaultAgentID == "main")
        #expect(identity.selectionRequired)
        #expect(!identity.canPersistLegacyProjection)
        #expect(identity.contract == "per-sender|main|unowned")
    }

    @Test func `owned non-first primary preserves the upstream fixed routing projection`() throws {
        let data = Data(
            #"{"defaultId":"primary","mainKey":"main","scope":"per-sender","ownership":"explicit","selectionRequired":false,"agents":[{"id":"main"},{"id":"primary"}]}"#
                .utf8)
        let catalog = try OpenClawChatGatewayPayloadCodec.decodeAgentsList(data)
        let identity = try OpenClawChatGatewayPayloadCodec.decodeSessionRoutingIdentity(data)

        #expect(catalog.defaultId == "primary")
        #expect(catalog.sessionRoutingContract == "per-sender|main|primary")
        #expect(identity.contract == "per-sender|main|primary")
    }

    @Test func `scoped legacy session rows retain their owner without rewriting global keys`() throws {
        let data = Data(#"{"sessions":[{"key":"global"},{"key":"agent:research:global"}]}"#.utf8)
        let result = try OpenClawChatGatewayPayloadCodec.decodeSessionsList(data, agentID: "main")
        #expect(result.sessions.map(\.key) == ["global", "agent:research:global"])
        #expect(result.sessions.map(\.agentId) == ["main", "research"])
    }

    @Test(arguments: ["[]", #"[{"id":"system","kind":"system"}]"#])
    func `empty selectable rosters preserve the server default`(agents: String) throws {
        let data = Data("""
        {"defaultId":"system","mainKey":"main","scope":"per-sender","agents":\(agents)}
        """.utf8)

        #expect(try OpenClawChatGatewayPayloadCodec.decodeAgentsList(data) ==
            OpenClawChatAgentsListResponse(
                defaultId: "system",
                agents: [],
                sessionRoutingContract: "per-sender|main|system"))
    }

    @Test func `agent navigation retains identity and configured main routing`() throws {
        let data = Data(
            #"{"defaultId":"ops","mainKey":"inbox","scope":"global","agents":[{"id":"ops","name":"Operations","identity":{"emoji":"🛠️"},"workspaceGit":true}]}"#
                .utf8)

        let catalog = try OpenClawChatGatewayPayloadCodec.decodeAgentsList(data)

        #expect(catalog.sessionRoutingContract == "global|inbox|ops")
        #expect(catalog.agents == [
            OpenClawChatAgentChoice(id: "ops", name: "Operations", emoji: "🛠️", workspaceGit: true),
        ])
    }

    @Test(arguments: [
        #"{"defaultId":"main","scope":"per-sender","agents":[]}"#,
        #"{"defaultId":"main","mainKey":"main","agents":[]}"#,
        #"{"defaultId":"main","mainKey":"main","scope":"per-sender","agents":[{"id":"main","kind":"unknown"}]}"#,
    ])
    func `malformed gateway rosters retain protocol decoding failures`(payload: String) {
        #expect(throws: DecodingError.self) {
            try OpenClawChatGatewayPayloadCodec.decodeAgentsList(Data(payload.utf8))
        }
    }
}
