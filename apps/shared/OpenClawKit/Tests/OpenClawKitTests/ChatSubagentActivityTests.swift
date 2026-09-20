import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@Suite("Chat subagent activity")
struct ChatSubagentActivityTests {
    @Test func `terminal snapshot retains live fields and expires after sixty seconds`() throws {
        var state = ChatSubagentActivityState()
        state.upsert(
            self.task(
                id: "task-1",
                status: "running",
                title: "  Layout review  ",
                lastActivity: "Applying patch",
                diffStat: ["files": 1, "added": 7, "removed": 2]),
            nowMilliseconds: 1000)
        #expect(state.presentation().rows.first?.title == "Layout review")
        state.upsert(
            self.task(
                id: "task-1",
                status: "completed",
                title: "Final layout review",
                progressSummary: "Earlier milestone",
                terminalSummary: "Done",
                endedAt: 2000),
            nowMilliseconds: 2000)

        let retained = try #require(state.presentation().rows.first)
        #expect(retained.status == .completed)
        #expect(retained.title == "Final layout review")
        #expect(retained.snippet == "Applying patch")
        #expect(retained.diffStat == ChatToolDiffStat(files: 1, added: 7, removed: 2))

        state.upsert(
            self.task(id: "task-1", status: "completed", title: "Final layout review", endedAt: 2000),
            nowMilliseconds: 5000,
            source: .snapshot)
        #expect(state.presentation().rows.first?.terminalObservedAt == 2000)

        state.removeExpired(nowMilliseconds: 61999)
        #expect(state.presentation().rows.count == 1)
        state.removeExpired(nowMilliseconds: 62000)
        #expect(state.presentation().rows.isEmpty)
    }

    @Test(arguments: [nil, "", " \n "] as [String?])
    func `unnamed activity keeps the generic label available`(title: String?) throws {
        var state = ChatSubagentActivityState()
        state.upsert(self.task(id: "unnamed", status: "running", title: title), nowMilliseconds: 1000)
        let activity = try #require(state.presentation().rows.first)
        #expect(activity.title == nil)
        #expect(activity.status == .running)
    }

    @Test(arguments: ["running", "queued", "waiting", "finished", "unknown", nil] as [String?])
    func `active ledger rows remain visible but animate only confirmed execution`(execution: String?) throws {
        var state = ChatSubagentActivityState()
        state.upsert(
            self.task(id: "active", status: "running", updatedAt: 1000, executionState: execution),
            nowMilliseconds: 1000)
        state.removeExpired(nowMilliseconds: 120000)
        let activity = try #require(state.presentation().rows.first)
        #expect(activity.status.isWorking)
        #expect(activity.isExecuting == (execution == "running"))
    }

    @Test(arguments: ["queued", "completed"])
    func `ledger status overrides stale running execution`(status: String) throws {
        var state = ChatSubagentActivityState()
        state.upsert(
            self.task(id: "task", status: status, executionState: "running"),
            nowMilliseconds: 1000)
        let activity = try #require(state.presentation().rows.first)
        #expect(activity.status.rawValue == status)
        #expect(activity.status.isWorking == (status == "queued"))
        #expect(!activity.isExecuting)
    }

    @Test func `caps rows at five and counts only hidden working tasks`() {
        var state = ChatSubagentActivityState()
        for index in 0..<7 {
            state.upsert(
                self.task(id: "working-\(index)", status: "running", startedAt: Double(index)),
                nowMilliseconds: Double(index))
        }
        state.upsert(
            self.task(id: "finished", status: "completed", endedAt: 10),
            nowMilliseconds: 10)

        let presentation = state.presentation()
        #expect(presentation.rows.map(\.id) == (2..<7).reversed().map { "working-\($0)" })
        #expect(presentation.hiddenWorkingCount == 2)
    }

    @Test func `prepared task progress retracts resets and preserves unknown command outcomes`() throws {
        func snapshot(
            runID: String = "child", revision: Int, items: [[String: Any]], lastActivityAt: Int = 1000) throws -> TaskSummary
        {
            let data = try JSONSerialization.data(withJSONObject: [
                "id": "task", "runId": "logical", "status": "running", "runtime": "subagent", "updatedAt": 1000,
                "execution": ["state": "running", "lastActivityAt": lastActivityAt],
                "progress": ["runId": runID, "revision": revision, "items": items],
            ])
            return try JSONDecoder().decode(TaskSummary.self, from: data)
        }
        let visible: [String: Any] = [
            "itemId": "command", "kind": "tool", "phase": "end", "title": "Command outcome unknown",
        ]
        let hidden: [String: Any] = [
            "itemId": "hidden", "kind": "tool", "phase": "start", "title": "Private payload",
            "hideFromChannelProgress": true,
        ]
        let commentary: [String: Any] = [
            "itemId": "commentary", "kind": "preamble", "phase": "update", "title": "Internal label",
            "progressText": "Waiting for the public build result",
        ]
        let reasoning: [String: Any] = [
            "itemId": "reasoning", "kind": "preamble", "phase": "update", "title": "Private reasoning",
            "text": "Raw private thought", "summary": "Private summary",
        ]
        let hiddenCommentary: [String: Any] = [
            "itemId": "hidden-commentary", "kind": "preamble", "phase": "update", "title": "Hidden label",
            "progressText": "Hidden commentary", "suppressChannelProgress": true,
        ]
        var state = ChatSubagentActivityState()
        state.upsert(
            try snapshot(revision: 4, items: [visible, hidden, commentary, reasoning, hiddenCommentary]),
            nowMilliseconds: 1000)
        let progress = try #require(state.presentation().rows.first?.progress)
        #expect(progress.items.compactMap(\.progressDisplayText) == [
            "Command outcome unknown", "Waiting for the public build result",
        ])
        #expect(progress.items.first?.status == nil)

        state.upsert(try snapshot(revision: 5, items: []), nowMilliseconds: 1001)
        state.upsert(try snapshot(revision: 4, items: [visible]), nowMilliseconds: 1002)
        #expect(state.presentation().rows.first?.progress?.items == [])

        state.upsert(
            try snapshot(runID: "replacement", revision: 6, items: [visible], lastActivityAt: 500),
            nowMilliseconds: 1003)
        state.upsert(try snapshot(revision: 5, items: []), nowMilliseconds: 1004)
        #expect(state.presentation().rows.first?.progress?.runId == "replacement")
        #expect(state.presentation().rows.first?.progress?.revision == 6)
        state.removeAll()
        state.upsert(try snapshot(runID: "restored", revision: 0, items: [visible]), nowMilliseconds: 1005)
        #expect(state.presentation().rows.first?.progress?.runId == "restored")
        #expect(state.presentation().rows.first?.progress?.revision == 0)
        state.upsert(self.task(id: "task", status: "running", updatedAt: 2000), nowMilliseconds: 2000)
        #expect(state.presentation().rows.first?.progress == nil)
    }

    private func task(
        id: String,
        status: String,
        title: String? = nil,
        lastActivity: String? = nil,
        progressSummary: String? = nil,
        terminalSummary: String? = nil,
        diffStat: [String: Int]? = nil,
        startedAt: Double = 0,
        updatedAt: Double? = nil,
        endedAt: Double? = nil,
        executionState: String? = nil) -> TaskSummary
    {
        TaskSummary(
            id: id,
            runtime: "subagent",
            status: AnyCodable(status),
            title: title,
            agentid: "main",
            sessionkey: "agent:main:main",
            updatedat: AnyCodable(updatedAt ?? startedAt),
            startedat: AnyCodable(startedAt),
            endedat: endedAt.map(AnyCodable.init),
            execution: executionState.map { ["state": AnyCodable($0)] },
            lastactivity: lastActivity,
            diffstat: diffStat?.mapValues(AnyCodable.init),
            progresssummary: progressSummary,
            terminalsummary: terminalSummary)
    }
}
