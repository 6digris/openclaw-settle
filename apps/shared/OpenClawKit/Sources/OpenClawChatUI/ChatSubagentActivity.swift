import Foundation
import OpenClawKit
import OpenClawProtocol

/// Read-only projection of the task owner's bounded, public activity snapshot.
public struct OpenClawTaskProgress: Decodable, Equatable, Sendable {
    public let runId: String
    public let revision: Int
    public let items: [OpenClawAgentActivityItem]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.runId = try container.decode(String.self, forKey: .runId)
        self.revision = try container.decode(Int.self, forKey: .revision)
        self.items = try container.decode([OpenClawAgentActivityItem].self, forKey: .items)
            .prefix(64).filter { $0.progressDisplayText != nil }
    }

    private enum CodingKeys: String, CodingKey {
        case runId, revision, items
    }
}

enum ChatSubagentActivityStatus: String, Sendable {
    case queued
    case running
    case completed
    case failed
    case cancelled
    case timedOut = "timed_out"

    var isWorking: Bool {
        self == .queued || self == .running
    }
}

enum ChatSubagentActivitySource: Sendable {
    case event
    case snapshot
}

struct ChatSubagentActivity: Identifiable, Equatable, Sendable {
    let id: String
    let runID: String?
    let title: String?
    let status: ChatSubagentActivityStatus
    let snippet: String?
    let diffStat: ChatToolDiffStat?
    let updatedAt: Double
    let terminalObservedAt: Double?
    let terminalSummary: String?
    let progress: OpenClawTaskProgress?
    let executionState: String?

    var isExecuting: Bool {
        self.status == .running && self.executionState == "running"
    }
}

struct ChatSubagentActivityPresentation: Equatable, Sendable {
    let rows: [ChatSubagentActivity]
    let hiddenWorkingCount: Int
}

struct ChatSubagentActivityState: Equatable, Sendable {
    private(set) var activitiesByID: [String: ChatSubagentActivity] = [:]

    mutating func upsert(
        _ task: TaskSummary,
        nowMilliseconds: Double,
        source: ChatSubagentActivitySource = .event)
    {
        guard let status = task.status.stringValue.flatMap(ChatSubagentActivityStatus.init(rawValue:))
        else { return }
        let previous = self.activitiesByID[task.id]
        let updatedAt = Self.timestampMilliseconds(task.updatedat)
            ?? previous?.updatedAt
            ?? Self.timestampMilliseconds(task.endedat)
            ?? nowMilliseconds
        let progress = task.progress.flatMap {
            try? ChatPayloadDecoding.decode(AnyCodable($0), as: OpenClawTaskProgress.self)
        }
        if let previous {
            guard updatedAt >= previous.updatedAt else { return }
            if updatedAt == previous.updatedAt {
                if !previous.status.isWorking, status.isWorking { return }
                if previous.status == .running, status == .queued { return }
                if status.isWorking, previous.status == status,
                   task.runid == previous.runID,
                   let progress, let previousProgress = previous.progress,
                   progress.revision < previousProgress.revision
                {
                    return
                }
            }
        }
        let fallbackSnippet = Self.firstNonBlank(task.lastactivity, task.progresssummary, task.lasttoolname)
        let snippet = if !status.isWorking,
                         previous != nil,
                         ChatPayloadDecoding.trimmedNonEmptyString(task.lastactivity) == nil
        {
            previous?.snippet
        } else {
            fallbackSnippet ?? previous?.snippet
        }
        let endedAt = Self.timestampMilliseconds(task.endedat)
        let terminalObservedAt: Double? = if status.isWorking {
            nil
        } else if let previous, !previous.status.isWorking {
            previous.terminalObservedAt
        } else {
            source == .event ? nowMilliseconds : endedAt ?? updatedAt
        }
        self.activitiesByID[task.id] = ChatSubagentActivity(
            id: task.id,
            runID: task.runid,
            title: ChatPayloadDecoding.trimmedNonEmptyString(task.title),
            status: status,
            snippet: snippet,
            diffStat: Self.diffStat(task.diffstat) ?? previous?.diffStat,
            updatedAt: updatedAt,
            terminalObservedAt: terminalObservedAt,
            terminalSummary: ChatPayloadDecoding.trimmedNonEmptyString(task.terminalsummary)
                ?? previous?.terminalSummary,
            progress: progress,
            executionState: task.execution?["state"]?.stringValue)
    }

    mutating func remove(taskID: String) {
        self.activitiesByID[taskID] = nil
    }

    mutating func removeAll() {
        self.activitiesByID.removeAll()
    }

    mutating func removeExpired(
        nowMilliseconds: Double,
        retentionMilliseconds: Double = 60000)
    {
        self.activitiesByID = self.activitiesByID.filter { _, activity in
            activity.status.isWorking ||
                (activity.terminalObservedAt.map { nowMilliseconds - $0 < retentionMilliseconds } ?? false)
        }
    }

    func presentation(limit: Int = 5) -> ChatSubagentActivityPresentation {
        let sorted = self.activitiesByID.values.sorted { lhs, rhs in
            if lhs.updatedAt != rhs.updatedAt {
                return lhs.updatedAt > rhs.updatedAt
            }
            return lhs.id < rhs.id
        }
        let ordered = sorted.filter(\.status.isWorking) + sorted.filter { !$0.status.isWorking }
        let rows = Array(ordered.prefix(limit))
        let visibleIDs = Set(rows.map(\.id))
        let hiddenWorkingCount = ordered.count { activity in
            activity.status == .running && !visibleIDs.contains(activity.id)
        }
        return ChatSubagentActivityPresentation(
            rows: rows,
            hiddenWorkingCount: hiddenWorkingCount)
    }

    func nextExpiryMilliseconds(retentionMilliseconds: Double = 60000) -> Double? {
        self.activitiesByID.values
            .filter { !$0.status.isWorking }
            .compactMap(\.terminalObservedAt)
            .map { $0 + retentionMilliseconds }
            .min()
    }

    private static func diffStat(_ value: [String: AnyCodable]?) -> ChatToolDiffStat? {
        guard let added = value?["added"]?.intValue,
              let removed = value?["removed"]?.intValue,
              added >= 0,
              removed >= 0
        else { return nil }
        let files = value?["files"]?.intValue
        return ChatToolDiffStat(
            files: files.map { max(0, $0) },
            added: added,
            removed: removed)
    }

    private static func timestampMilliseconds(_ value: AnyCodable?) -> Double? {
        if let number = value?.doubleValue, number >= 0 { return number }
        guard let raw = value?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty
        else { return nil }
        if let number = Double(raw), number >= 0 { return number }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = fractional.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
        return date.map { $0.timeIntervalSince1970 * 1000 }
    }

    private static func firstNonBlank(_ values: String?...) -> String? {
        values.lazy.compactMap(ChatPayloadDecoding.trimmedNonEmptyString).first
    }
}

extension OpenClawChatViewModel {
    func handleTaskEvent(_ event: OpenClawChatTaskEvent) {
        switch event {
        case let .upserted(task):
            self.subagentActivitySnapshotChanges?.insert(task.id)
            self.foldSubagentTask(task)
        case let .deleted(taskID):
            self.subagentActivitySnapshotChanges?.insert(taskID)
            self.updateSubagentActivityState { $0.remove(taskID: taskID) }
        case .restored:
            self.clearSubagentActivities()
            let session = self.currentSessionSnapshot()
            Task { await self.refreshSubagentActivities(sessionSnapshot: session) }
        }
    }

    func refreshSubagentActivities(sessionSnapshot: SessionSnapshot) async {
        let generation = self.subagentActivityGeneration
        self.subagentActivityRequestID &+= 1
        let requestID = self.subagentActivityRequestID
        self.subagentActivitySnapshotChanges = []
        defer {
            if requestID == self.subagentActivityRequestID {
                self.subagentActivitySnapshotChanges = nil
            }
        }
        let tasks: [TaskSummary]
        do {
            tasks = try await self.transport.listTasks(
                sessionKey: sessionSnapshot.key,
                agentID: sessionSnapshot.deliveryAgentID)
        } catch {
            return
        }
        guard self.isCurrentSession(sessionSnapshot),
              generation == self.subagentActivityGeneration,
              requestID == self.subagentActivityRequestID
        else { return }
        self.updateSubagentActivityState { state in
            let now = Date().timeIntervalSince1970 * 1000
            for task in tasks where self.isCurrentSubagentTask(task) {
                // Live events win over a list response, including deleted rows.
                guard self.subagentActivitySnapshotChanges?.contains(task.id) != true else { continue }
                state.upsert(task, nowMilliseconds: now, source: .snapshot)
            }
            state.removeExpired(nowMilliseconds: now)
        }
    }

    func clearSubagentActivities() {
        self.subagentActivityGeneration &+= 1
        self.subagentActivitySnapshotChanges = nil
        self.subagentActivityCleanupTask?.cancel()
        self.subagentActivityCleanupTask = nil
        self.subagentActivityState.removeAll()
        self.subagentActivities = []
        self.hiddenWorkingSubagentCount = 0
    }

    private func foldSubagentTask(_ task: TaskSummary) {
        guard self.isCurrentSubagentTask(task) else { return }
        self.updateSubagentActivityState { state in
            let now = Date().timeIntervalSince1970 * 1000
            state.upsert(task, nowMilliseconds: now)
            state.removeExpired(nowMilliseconds: now)
        }
    }

    private func isCurrentSubagentTask(_ task: TaskSummary) -> Bool {
        guard task.runtime == "subagent",
              let requesterSessionKey = task.sessionkey
        else { return false }
        return self.matchesCurrentSessionKey(
            incoming: requesterSessionKey,
            agentId: task.agentid,
            current: self.sessionKey)
    }

    private func updateSubagentActivityState(
        _ update: (inout ChatSubagentActivityState) -> Void)
    {
        let previous = self.subagentActivityState
        update(&self.subagentActivityState)
        guard self.subagentActivityState != previous else { return }
        let presentation = self.subagentActivityState.presentation()
        self.subagentActivities = presentation.rows
        self.hiddenWorkingSubagentCount = presentation.hiddenWorkingCount
        self.scheduleSubagentActivityCleanup()
        self.markTimelineChanged()
    }

    private func scheduleSubagentActivityCleanup() {
        self.subagentActivityCleanupTask?.cancel()
        guard let expiry = self.subagentActivityState.nextExpiryMilliseconds() else {
            self.subagentActivityCleanupTask = nil
            return
        }
        let now = Date().timeIntervalSince1970 * 1000
        let delay = max(0, Int64((expiry - now).rounded(.up)))
        self.subagentActivityCleanupTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.updateSubagentActivityState { state in
                state.removeExpired(nowMilliseconds: Date().timeIntervalSince1970 * 1000)
            }
        }
    }
}
