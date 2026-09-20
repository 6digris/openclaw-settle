import Foundation

private struct SessionGroupImportProfileResponse: Decodable {
    struct Profile: Decodable {
        let id: String
    }

    let profile: Profile
}

public enum OpenClawChatSessionGroupsError: LocalizedError {
    case upgradeRequired
    case missingAgent

    public var errorDescription: String? {
        switch self {
        case .upgradeRequired:
            "Update this Gateway to manage agent-owned groups. Chat remains available."
        case .missingAgent:
            "Select a verified agent before managing groups."
        }
    }
}

extension OpenClawChatSessionGroupsRouteLease {
    /// Capability is read from the same captured connection as every request.
    /// Never retry a rejected scoped call without its owner or append semantics.
    public init(
        agentID: String,
        supportsAgentScope: Bool,
        request: @escaping @Sendable (OpenClawChatGatewayRequest) async throws -> Data) throws
    {
        let owner = agentID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !owner.isEmpty, owner != "*" else { throw OpenClawChatSessionGroupsError.missingAgent }
        guard supportsAgentScope else { throw OpenClawChatSessionGroupsError.upgradeRequired }
        self.init(
            listGroups: {
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsList(agentID: owner))
                return try JSONDecoder().decode(OpenClawChatSessionGroupsResponse.self, from: data)
            },
            putGroups: { names in
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsPut(names: names, agentID: owner))
                return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
            },
            renameGroup: { name, to in
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsRename(
                    name: name, to: to, agentID: owner))
                return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
            },
            deleteGroup: { name in
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsDelete(
                    name: name, agentID: owner))
                return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
            },
            agentID: owner,
            appendGroups: { names in
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsPut(
                    names: names, agentID: owner, append: true))
                return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
            },
            importGroups: { names, importID in
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsPut(
                    names: names, agentID: owner, append: true, importID: importID))
                return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
            },
            importProfileID: {
                let data = try await request(OpenClawChatGatewayRequest(method: "users.self", timeoutMs: 15000))
                let response = try JSONDecoder().decode(SessionGroupImportProfileResponse.self, from: data)
                guard !response.profile.id.isEmpty else { throw OpenClawChatSessionGroupImportError.missingProfile }
                return response.profile.id
            })
    }
}
