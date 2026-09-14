import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

struct ChatNativeRunFilesTests {
    private let run = OpenClawNativeRunRef(
        session: .init(
            owner: .init(gatewayID: "gateway-a", profileID: "profile-a"),
            agentID: "reviewer",
            sessionKey: "agent:reviewer:main"),
        runID: "run-e\u{301}")

    @Test(arguments: ["visible", "silent", "empty", "missing"])
    func `successful file replies do not depend on text previews`(disposition: String) async throws {
        let requests = FileRequests(run: self.run, disposition: disposition)
        let gateway = self.gateway(requests)
        let reply = try await gateway.waitForReply(self.run)
        #expect(reply.completedSuccessfully)
        let result = try await gateway.files(for: reply) { response, limit in
            try await requests.load(response, limit: limit)
        }
        #expect(result.run == self.run)
        #expect(result.files.count == 1)
        #expect(result.files.first?.data == Data(repeating: 65, count: 8192))
        #expect(result.files.first?.filename == "report.csv")
        #expect(result.files.first?.mimeType == "text/csv")
        #expect(await requests.methods == ["agent.wait", "artifacts.list", "artifacts.download"])
    }

    @Test(arguments: ["error", "timeout", "pending"])
    func `unsuccessful or pending runs never retrieve files`(status: String) async throws {
        let requests = FileRequests(run: self.run, status: status)
        let gateway = self.gateway(requests)
        let reply = try await gateway.waitForReply(self.run)
        let result = try await gateway.files(for: reply) { response, limit in
            try await requests.load(response, limit: limit)
        }
        #expect(result.files.isEmpty)
        #expect(!result.dialog.isEmpty)
        #expect(await requests.methods == ["agent.wait"])
    }

    @Test(arguments: [
        "missing",
        "too-many",
        "duplicate",
        "wrong-run",
        "oversize",
        "truncated",
        "unsupported",
        "profile",
        "retired-list",
        "changed-id",
        "wrong-download-run",
    ])
    func `file failures return a visible continuation without partial output`(failure: String) async throws {
        let requests = FileRequests(run: self.run, failure: failure)
        let gateway = self.gateway(requests)
        let reply = try await gateway.waitForReply(self.run)
        let result = try await gateway.files(for: reply) { response, limit in
            try await requests.load(response, limit: limit)
        }
        #expect(result.run == self.run)
        #expect(result.files.isEmpty)
        #expect(result.dialog.contains("chat"))
        if failure == "unsupported" || failure == "profile" || failure == "retired-list" {
            #expect(await requests.methods == ["agent.wait", "artifacts.list"])
        }
    }

    @Test(arguments: [false, true])
    func `retirement or cancellation during bytes prevents exported output`(cancel: Bool) async throws {
        let requests = FileRequests(run: self.run)
        let gateway = self.gateway(requests)
        let reply = try await gateway.waitForReply(self.run)
        let task = Task {
            try await gateway.files(for: reply) { response, limit in
                await requests.suspendLoad()
                return try await requests.load(response, limit: limit)
            }
        }
        await requests.waitForLoad()
        if cancel { task.cancel() }
        await requests.finishLoad(retire: !cancel)
        if cancel {
            await #expect(throws: CancellationError.self) { try await task.value }
        } else {
            #expect(try await task.value.files.isEmpty)
        }
    }

    @Test(arguments: ["complete", "over-limit", "underreported"])
    func `multiple files share one byte budget and never return partial collections`(outcome: String) async throws {
        let requests = FileRequests(run: self.run, failure: "two-" + outcome)
        let gateway = self.gateway(requests)
        let reply = try await gateway.waitForReply(self.run)
        let result = try await gateway.files(for: reply) { response, limit in
            try await requests.load(response, limit: limit)
        }
        #expect(await requests.limits == [16 * 1024 * 1024, 8 * 1024 * 1024])
        if outcome == "complete" {
            #expect(result.files.map(\.data.count) == [8 * 1024 * 1024, 8192])
            #expect(result.files.map(\.filename) == ["report.csv", "second.csv"])
        } else {
            #expect(result.files.isEmpty)
            #expect(result.dialog.contains("chat"))
        }
    }

    private func gateway(_ requests: FileRequests) -> OpenClawChatNativeActionGateway {
        .init(
            gatewayID: "gateway-a",
            gatewayName: "Gateway",
            supportsProfileBinding: { true },
            request: { try await requests.respond($0, profile: $1) },
            isCurrent: { await requests.current })
    }
}

private actor FileRequests {
    let run: OpenClawNativeRunRef
    let disposition: String
    let status: String
    let failure: String?
    var methods: [String] = []
    var current = true
    var limits: [Int] = []
    private var loadEntered: CheckedContinuation<Void, Never>?
    private var loadRelease: CheckedContinuation<Void, Never>?

    init(run: OpenClawNativeRunRef, disposition: String = "empty", status: String = "ok", failure: String? = nil) {
        self.run = run
        self.disposition = disposition
        self.status = status
        self.failure = failure
    }

    func respond(_ request: OpenClawChatGatewayRequest, profile: String?) throws -> Data {
        self.methods.append(request.method)
        #expect(profile == self.run.session.owner.profileID)
        #expect((request.params["runId"]?.value as? String)?.utf8.elementsEqual(self.run.runID.utf8) == true)
        if request.method == "agent.wait" {
            var reply: [String: Any] = ["runId": self.run.runID, "status": self.status]
            if self.status != "pending" { reply["endedAt"] = 100 }
            if self.disposition != "missing" {
                reply["terminalReply"] = ["disposition": self.disposition, "text": "Short preview"]
            }
            return try JSONSerialization.data(withJSONObject: reply)
        }
        #expect(request.params["sessionKey"]?.value as? String == self.run.session.sessionKey)
        #expect(request.params["agentId"]?.value as? String == self.run.session.agentID)
        #expect(request.params["messageRole"]?.value as? String == "assistant")
        if self.failure == "unsupported" || self.failure == "profile" {
            throw GatewayResponseError(
                method: request.method,
                code: "INVALID_REQUEST",
                message: "unsupported query",
                details: nil)
        }
        let multiple = self.failure?.hasPrefix("two-") == true
        let second = request.params["artifactId"]?.value as? String == "artifact-second"
        let count = self.failure == "too-many" ? 5 : self.failure == "duplicate" ? 2 : self.failure == "missing" ? 0 : 1
        let downloading = request.method == "artifacts.download"
        func makeArtifact(second: Bool) -> ArtifactSummary {
            let size: Int? = if multiple {
                second && self.failure == "two-underreported" ? 1 : nil
            } else {
                self.failure == "oversize" ? 16 * 1024 * 1024 + 1 : 8192
            }
            return ArtifactSummary(
                id: second ? "artifact-second" : downloading && self.failure == "changed-id"
                    ? "other-file" : "artifact-report",
                type: "file",
                title: second ? "second.csv" : "report.csv",
                mimetype: "text/csv",
                sizebytes: size,
                sessionkey: self.run.session.sessionKey,
                runid: self.failure == "wrong-run" || (downloading && self.failure == "wrong-download-run")
                    ? "run-\u{E9}" : self.run.runID,
                source: "session-transcript",
                download: ["mode": AnyCodable("bytes")])
        }
        let artifact = makeArtifact(second: second)
        if request.method == "artifacts.list" {
            if multiple {
                return try JSONEncoder().encode(ArtifactsListResult(artifacts: [artifact, makeArtifact(second: true)]))
            }
            if self.failure == "retired-list" { self.current = false }
            return try JSONEncoder().encode(ArtifactsListResult(artifacts: Array(repeating: artifact, count: count)))
        }
        #expect(request.method == "artifacts.download")
        #expect(request.params["artifactId"]?.value as? String == (second ? "artifact-second" : "artifact-report"))
        return try JSONEncoder().encode(ArtifactsDownloadResult(artifact: artifact, encoding: "base64", data: ""))
    }

    func load(_ response: ArtifactsDownloadResult, limit: Int) throws -> Data {
        self.limits.append(limit)
        if self.failure?.hasPrefix("two-") == true {
            let second = response.artifact.id == "artifact-second"
            let count = !second ? 8 * 1024 * 1024 : self.failure == "two-complete" ? 8192 : limit + 1
            return Data(repeating: second ? 66 : 65, count: count)
        }
        #expect(response.artifact.id == "artifact-report")
        #expect(limit == 16 * 1024 * 1024)
        return Data(repeating: 65, count: self.failure == "truncated" ? 8191 : 8192)
    }

    func suspendLoad() async {
        await withCheckedContinuation { continuation in
            self.loadRelease = continuation
            self.loadEntered?.resume()
            self.loadEntered = nil
        }
    }

    func waitForLoad() async {
        if self.loadRelease != nil { return }
        await withCheckedContinuation { self.loadEntered = $0 }
    }

    func finishLoad(retire: Bool) {
        self.current = !retire
        self.loadRelease?.resume()
        self.loadRelease = nil
    }
}
