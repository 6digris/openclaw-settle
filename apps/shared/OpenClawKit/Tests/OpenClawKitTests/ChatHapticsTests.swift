import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

private final class HapticRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedEvents: [OpenClawChatHaptics.Event] = []

    var events: [OpenClawChatHaptics.Event] {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.recordedEvents
    }

    func record(_ event: OpenClawChatHaptics.Event) {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.recordedEvents.append(event)
    }
}

private final class HapticsTestTransport: @unchecked Sendable, OpenClawChatTransport {
    private let response: OpenClawChatSendResponse
    // History rows are built per fetch so fixtures can stamp timestamps at
    // request time; every fetch in the send flow happens after the optimistic
    // user echo exists, which keeps fixture rows ordered after the user turn
    // regardless of how long the test was starved before sending.
    private let historyMessages: @Sendable () -> [AnyCodable]
    private let stream: AsyncStream<OpenClawChatTransportEvent>
    private let continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation

    init(status: String, historyMessages: @escaping @Sendable () -> [AnyCodable] = { [] }) {
        self.response = OpenClawChatSendResponse(runId: "run-1", status: status)
        self.historyMessages = historyMessages
        var continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation!
        self.stream = AsyncStream { continuation = $0 }
        self.continuation = continuation
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        OpenClawChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: "session-1",
            messages: self.historyMessages(),
            thinkingLevel: "off")
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        self.response
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        self.stream
    }

    func emit(_ event: OpenClawChatTransportEvent) {
        self.continuation.yield(event)
    }
}

private func makeHapticsViewModel(
    status: String,
    historyMessages: @escaping @Sendable () -> [AnyCodable] = { [] }) async -> (
    HapticsTestTransport,
    OpenClawChatViewModel,
    HapticRecorder)
{
    let transport = HapticsTestTransport(status: status, historyMessages: historyMessages)
    let recorder = HapticRecorder()
    let haptics = OpenClawChatHaptics(performer: recorder.record)
    let viewModel = await MainActor.run {
        OpenClawChatViewModel(sessionKey: "main", transport: transport, haptics: haptics)
    }
    return (transport, viewModel, recorder)
}

private func sendHapticsTestMessage(_ viewModel: OpenClawChatViewModel) async {
    await MainActor.run {
        viewModel.input = "hello"
        viewModel.send()
    }
}

struct ChatHapticsTests {
    @Test func `send acceptance fires message sent exactly once`() async throws {
        let (_, viewModel, recorder) = await makeHapticsViewModel(status: "started")
        await sendHapticsTestMessage(viewModel)
        try await waitUntil("message sent haptic") { recorder.events == [.messageSent] }
        try await Task.sleep(for: .milliseconds(20))
        #expect(recorder.events == [.messageSent])
    }

    @Test func `completion fires once for duplicate terminal events`() async throws {
        let (transport, viewModel, recorder) = await makeHapticsViewModel(status: "started")
        await sendHapticsTestMessage(viewModel)
        try await waitUntil("message accepted") { recorder.events == [.messageSent] }

        let final = OpenClawChatTransportEvent.chat(OpenClawChatEventPayload(
            runId: "run-1",
            sessionKey: "main",
            state: "final",
            message: nil,
            errorMessage: nil))
        transport.emit(final)
        transport.emit(final)
        try await waitUntil("completion haptic") {
            recorder.events == [.messageSent, .runCompleted]
        }
        try await Task.sleep(for: .milliseconds(20))
        #expect(recorder.events == [.messageSent, .runCompleted])
    }

    @Test @MainActor func `yield retires foreground without completion and task observations continue`() throws {
        let recorder = HapticRecorder()
        let viewModel = OpenClawChatViewModel(
            sessionKey: "agent:main:main",
            transport: HapticsTestTransport(status: "started"),
            activeAgentId: "main",
            haptics: OpenClawChatHaptics(performer: recorder.record))
        viewModel.pendingRuns = ["parent"]
        viewModel.applyProgressCard(ProgressCard(
            sessionkey: "agent:main:main", revision: 1, updatedat: 1000,
            steps: [ProgressCardStep(step: "Child work", status: .inProgress)]))
        let yielded = try JSONDecoder().decode(OpenClawChatEventPayload.self, from: Data(#"""
        {"runId":"parent","sessionKey":"agent:main:main","state":"final","yielded":true,"stopReason":"end_turn"}
        """#.utf8))
        viewModel.handleTransportEvent(.chat(yielded))
        #expect(viewModel.pendingRunCount == 0)
        #expect(viewModel.lastTurnYielded)
        #expect(recorder.events.isEmpty)
        #expect(viewModel.progressCard?.steps?.first?.status == .inProgress)

        let task = try JSONDecoder().decode(TaskSummary.self, from: Data(#"""
        {"id":"child-task","runtime":"subagent","status":"running","agentId":"main",
         "sessionKey":"agent:main:main","execution":{"state":"waiting"},
         "progress":{"runId":"child-run","revision":2,"items":[
           {"itemId":"tool","kind":"tool","phase":"end","title":"Command outcome unknown"}]}}
        """#.utf8))
        viewModel.handleTransportEvent(.task(.upserted(task)))
        #expect(viewModel.subagentActivities.first?.progress?.items.first?.title == "Command outcome unknown")
        #expect(viewModel.subagentActivities.first?.executionState == "waiting")
        viewModel.adoptRun(runId: "parent", bufferedText: "Late parent delta")
        #expect(viewModel.pendingRunCount == 0)
        #expect(recorder.events.isEmpty)
        viewModel.handleTransportEvent(.task(.deleted(taskID: "child-task")))
        #expect(viewModel.subagentActivities.isEmpty)
    }

    @Test @MainActor func `yielded lifecycle and wait result are not successful completion`() {
        let recorder = HapticRecorder()
        let viewModel = OpenClawChatViewModel(
            sessionKey: "main",
            transport: HapticsTestTransport(status: "started"),
            haptics: OpenClawChatHaptics(performer: recorder.record))
        viewModel.pendingRuns = ["parent"]
        viewModel.handleTransportEvent(.agent(OpenClawAgentEventPayload(
            runId: "parent", seq: nil, stream: "lifecycle", ts: nil,
            data: ["phase": AnyCodable("end"), "yielded": AnyCodable(true), "stopReason": AnyCodable("end_turn")])))
        #expect(viewModel.pendingRunCount == 0)
        #expect(recorder.events.isEmpty)
        #expect(OpenClawChatRunObservation.fromWaitResponse(
            status: "ok", stopReason: "end_turn", yielded: true) == .terminal(.yielded))
    }

    @Test(arguments: ["error", "aborted"])
    func `durable assistant failure fires run failed`(stopReason: String) async throws {
        // The run-failed drain only fires for assistant rows timestamped at or
        // after the optimistic user echo. Stamp the durable failure when history
        // is fetched (always post-send) instead of at test start, where a >1s
        // scheduling stall before send() left the row permanently "older" than
        // the user turn and the wait timed out on loaded CI runners.
        let (_, viewModel, recorder) = await makeHapticsViewModel(status: "started") {
            [AnyCodable([
                "role": "assistant",
                "content": [],
                "timestamp": Date().timeIntervalSince1970 * 1000,
                "stopReason": stopReason,
                "errorMessage": "provider failed",
            ] as [String: Any])]
        }
        await sendHapticsTestMessage(viewModel)
        try await waitUntil("run failed haptic") {
            recorder.events == [.messageSent, .runFailed]
        }
        #expect(recorder.events == [.messageSent, .runFailed])
    }
}
