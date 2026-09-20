import Foundation
import Testing
@testable import OpenClaw

struct BackgroundTasksScreenTests {
    @Test func `decodes bounded prompt and derives terminal output`() throws {
        let data = Data(#"""
        {
          "id":"task-1",
          "taskId":"task-1",
          "status":"failed",
          "runtime":"subagent",
          "title":"Audit tasks",
          "updatedAt":"2026-07-16T09:00:00.000Z",
          "prompt":"Review the background task UI",
          "terminalSummary":"Partial result",
          "error":"Worker failed"
        }
        """#.utf8)

        let task = try JSONDecoder().decode(MobileBackgroundTask.self, from: data)

        #expect(task.displayTitle == "Audit tasks")
        #expect(task.statusLabel == "Failed")
        #expect(task.runtimeLabel == "Subagent")
        #expect(task.prompt == "Review the background task UI")
        #expect(task.output == "Worker failed")
        #expect(task.activityMilliseconds > 0)
    }

    @Test func `running task prefers live activity over progress summary`() throws {
        let data = Data(#"""
        {
          "id":"task-live",
          "status":"running",
          "runtime":"subagent",
          "lastActivity":"Editing the shared transcript",
          "progressSummary":"Earlier milestone"
        }
        """#.utf8)

        let task = try JSONDecoder().decode(MobileBackgroundTask.self, from: data)

        #expect(task.output == "Editing the shared transcript")
    }

    @Test(arguments: [
        ("running", "running", "Running", true),
        ("running", "queued", "Queued", true),
        ("running", "waiting", "Waiting", true),
        ("running", "finished", "Finished", true),
        ("running", "unknown", "Execution unknown", true),
        ("running", nil, "Execution unknown", true),
        ("queued", "running", "Queued", true),
        ("completed", "running", "Completed", false),
    ] as [(String, String?, String, Bool)])
    func `task labels require execution evidence and preserve ledger precedence`(
        status: String, execution: String?, label: String, active: Bool) throws
    {
        var payload: [String: Any] = ["id": "task", "status": status]
        if let execution { payload["execution"] = ["state": execution] }
        let task = try JSONDecoder().decode(
            MobileBackgroundTask.self,
            from: JSONSerialization.data(withJSONObject: payload))
        #expect(task.statusLabel == label)
        #expect(task.isActive == active)
    }

    @Test func `prepared progress replaces legacy activity without inventing execution success`() throws {
        let task = try JSONDecoder().decode(MobileBackgroundTask.self, from: Data(#"""
        {"id":"continuing","status":"running","execution":{"state":"waiting"},
         "lastActivity":"Stale activity",
         "progress":{"runId":"child","revision":7,"items":[
           {"itemId":"command","kind":"tool","phase":"end","title":"Command outcome unknown"},
           {"itemId":"private","kind":"tool","phase":"start","title":"Private","suppressChannelProgress":true},
           {"itemId":"commentary","kind":"preamble","phase":"update","title":"Internal label",
            "progressText":"Checking the public build result"},
           {"itemId":"reasoning","kind":"preamble","phase":"update","title":"Private thought","text":"Raw reasoning"}]}}
        """#.utf8))
        #expect(task.isActive)
        #expect(task.statusLabel == "Waiting")
        #expect(task.output == "Checking the public build result")
        #expect(task.progress?.items.map(\.itemId) == ["command", "commentary"])
        #expect(task.progress?.items.first?.status == nil)

        let retracted = try JSONDecoder().decode(MobileBackgroundTask.self, from: Data(#"""
        {"id":"continuing","status":"running","lastActivity":"Stale activity",
         "progress":{"runId":"child","revision":8,"items":[]}}
        """#.utf8))
        let merged = MobileBackgroundTaskList.merge(recent: [retracted], active: [task])
        #expect(merged.first?.output == nil)
        #expect(merged.first?.progress?.items == [])
    }

    @Test func `task progress revisions order replacement executions before activity clocks`() throws {
        let predecessor = try JSONDecoder().decode(MobileBackgroundTask.self, from: Data(#"""
        {"id":"task","runId":"logical","status":"running","updatedAt":1000,
         "execution":{"state":"running","lastActivityAt":900},
         "progress":{"runId":"physical-1","revision":1,"items":[
           {"itemId":"old","kind":"tool","phase":"start","title":"Predecessor"}]}}
        """#.utf8))
        let resumed = try JSONDecoder().decode(MobileBackgroundTask.self, from: Data(#"""
        {"id":"task","runId":"logical","status":"running","updatedAt":1000,
         "execution":{"state":"running","lastActivityAt":500},
         "progress":{"runId":"physical-2","revision":2,"items":[
           {"itemId":"new","kind":"tool","phase":"start","title":"Resumed work"}]}}
        """#.utf8))
        #expect(MobileBackgroundTaskList.newest(resumed, replacing: predecessor).output == "Resumed work")
        #expect(MobileBackgroundTaskList.newest(predecessor, replacing: resumed).output == "Resumed work")
    }


    @Test func `groups active work and deduplicates newest task snapshot`() throws {
        let recent = try self.task(id: "finished", status: "completed", updatedAt: 4000)
        let stale = try self.task(id: "running", status: "running", updatedAt: 2000)
        let current = try self.task(id: "running", status: "running", updatedAt: 6000)

        let merged = MobileBackgroundTaskList.merge(recent: [recent, stale], active: [current])

        #expect(merged.map(\.id) == ["running", "finished"])
        #expect(merged.filter(\.isActive).map(\.id) == ["running"])
        #expect(merged.filter { !$0.isActive }.map(\.id) == ["finished"])
    }

    @Test func `untitled task uses canonical ledger id`() throws {
        let data = Data(#"""
        {
          "id":"ledger-1",
          "taskId":"runtime-1",
          "status":"running",
          "runtime":"cli",
          "kind":"exec"
        }
        """#.utf8)

        let task = try JSONDecoder().decode(MobileBackgroundTask.self, from: data)

        #expect(task.displayTitle == "ledger-1")
        #expect(task.isActive)
        #expect(task.runtimeLabel == "CLI")
    }

    @Test func `terminal snapshot wins a timestamp tie`() throws {
        let running = try self.task(id: "same", status: "running", updatedAt: 4000)
        let finished = try self.task(id: "same", status: "completed", updatedAt: 4000)

        let merged = MobileBackgroundTaskList.merge(recent: [finished], active: [running])

        #expect(merged.map(\.status) == ["completed"])
    }

    @Test func `loads active before terminal without overlapping status queries`() async throws {
        let running = try self.task(id: "same", status: "running", updatedAt: 2000)
        let completed = try self.task(id: "same", status: "completed", updatedAt: 3000)
        let probe = OrderedBackgroundTaskRequestProbe(active: [running], finished: [completed])

        let tasks = try await MobileBackgroundTaskList.load { status, limit in
            await probe.request(status: status, limit: limit)
        }
        let snapshot = await probe.snapshot()

        #expect(tasks.map(\.status) == ["completed"])
        #expect(snapshot.calls == [
            "queued,running|200",
            "completed,failed,cancelled,timed_out|100",
        ])
        #expect(!snapshot.overlapped)
    }

    private func task(id: String, status: String, updatedAt: Int) throws -> MobileBackgroundTask {
        let data = Data(#"""
        {
          "id":"\#(id)",
          "taskId":"\#(id)",
          "status":"\#(status)",
          "runtime":"cli",
          "title":"\#(id)",
          "updatedAt":\#(updatedAt)
        }
        """#.utf8)
        return try JSONDecoder().decode(MobileBackgroundTask.self, from: data)
    }
}

private actor OrderedBackgroundTaskRequestProbe {
    private let active: [MobileBackgroundTask]
    private let finished: [MobileBackgroundTask]
    private var calls: [String] = []
    private var inFlight = 0
    private var overlapped = false

    init(active: [MobileBackgroundTask], finished: [MobileBackgroundTask]) {
        self.active = active
        self.finished = finished
    }

    func request(status: [String], limit: Int) async -> [MobileBackgroundTask] {
        self.calls.append("\(status.joined(separator: ","))|\(limit)")
        self.inFlight += 1
        self.overlapped = self.overlapped || self.inFlight > 1
        await Task.yield()
        self.inFlight -= 1
        return status.contains("running") ? self.active : self.finished
    }

    func snapshot() -> (calls: [String], overlapped: Bool) {
        (self.calls, self.overlapped)
    }
}
