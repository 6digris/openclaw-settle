import Foundation
import OpenClawChatUI
import OpenClawKit
import SwiftUI

struct MobileBackgroundTask: Decodable, Identifiable, Equatable {
    struct Timestamp: Decodable, Equatable {
        let milliseconds: Double

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let number = try? container.decode(Double.self) {
                self.milliseconds = number
                return
            }
            let value = try container.decode(String.self)
            let fractionalFormatter = ISO8601DateFormatter()
            fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let date = fractionalFormatter.date(from: value) ?? ISO8601DateFormatter().date(from: value) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Expected a millisecond timestamp or ISO-8601 date")
            }
            self.milliseconds = date.timeIntervalSince1970 * 1000
        }
    }

    struct Execution: Decodable, Equatable {
        let state: String
    }

    let id: String
    let runId: String?
    let status: String
    let runtime: String?
    let title: String?
    let agentId: String?
    let sessionKey: String?
    let childSessionKey: String?
    let createdAt: Timestamp?
    let updatedAt: Timestamp?
    let startedAt: Timestamp?
    let endedAt: Timestamp?
    let lastActivity: String?
    let progressSummary: String?
    let terminalSummary: String?
    let error: String?
    var prompt: String?
    let progress: OpenClawTaskProgress?
    let execution: Execution?

    var displayTitle: String {
        self.title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            ?? self.id.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            ?? String(localized: "Background task")
    }

    var isActive: Bool {
        self.status == "queued" || self.status == "running"
    }

    var statusLabel: String {
        switch self.status {
        case "queued": String(localized: "Queued")
        case "running":
            switch self.execution?.state {
            case "running": String(localized: "Running")
            case "queued": String(localized: "Queued")
            case "waiting": String(localized: "Waiting")
            case "finished": String(localized: "Finished")
            default: String(localized: "Execution unknown")
            }
        case "completed": String(localized: "Completed")
        case "cancelled": String(localized: "Cancelled")
        case "timed_out": String(localized: "Timed out")
        default: String(localized: "Failed")
        }
    }

    var runtimeLabel: String {
        switch self.runtime {
        case "subagent": String(localized: "Subagent")
        case "cron": String(localized: "Cron")
        case "acp": "ACP"
        case "cli": "CLI"
        default: String(localized: "Task")
        }
    }

    var output: String? {
        if self.isActive, let progress = self.progress {
            return progress.items.last?.progressDisplayText
        }
        let candidates = if self.status == "failed" || self.status == "timed_out" {
            [self.error, self.terminalSummary, self.lastActivity, self.progressSummary]
        } else {
            [self.terminalSummary, self.error, self.lastActivity, self.progressSummary]
        }
        return candidates.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty }.first
    }

    var activityMilliseconds: Double {
        self.updatedAt?.milliseconds ?? self.endedAt?.milliseconds
            ?? self.startedAt?.milliseconds ?? self.createdAt?.milliseconds ?? 0
    }
}

extension String {
    fileprivate var nilIfEmpty: String? {
        self.isEmpty ? nil : self
    }
}

private struct MobileBackgroundTasksEnvelope: Decodable {
    let tasks: [MobileBackgroundTask]
}

private struct MobileBackgroundTaskEnvelope: Decodable {
    let task: MobileBackgroundTask
}

private struct MobileBackgroundTasksListParams: Encodable {
    let agentId: String
    let status: [String]?
    let limit: Int
}

private struct MobileBackgroundTaskGetParams: Encodable {
    let taskId: String
}

private struct MobileBackgroundTaskEvent: Decodable {
    let action: String
    let task: MobileBackgroundTask?
    let taskId: String?
}

enum MobileBackgroundTaskList {
    @MainActor
    static func load(
        request: (_ status: [String], _ limit: Int) async throws -> [MobileBackgroundTask]) async throws
        -> [MobileBackgroundTask]
    {
        // Active first, terminal second: a monotonic active-to-terminal transition
        // is then present in at least one snapshot instead of falling between calls.
        let active = try await request(["queued", "running"], 200)
        let finished = try await request(["completed", "failed", "cancelled", "timed_out"], 100)
        return self.merge(recent: finished, active: active)
    }

    static func merge(
        recent: [MobileBackgroundTask],
        active: [MobileBackgroundTask]) -> [MobileBackgroundTask]
    {
        var byId: [String: MobileBackgroundTask] = [:]
        for task in recent + active {
            guard let current = byId[task.id] else {
                byId[task.id] = task
                continue
            }
            byId[task.id] = self.newest(task, replacing: current)
        }
        return byId.values.sorted {
            if $0.activityMilliseconds != $1.activityMilliseconds {
                return $0.activityMilliseconds > $1.activityMilliseconds
            }
            return $0.id < $1.id
        }
    }

    static func newest(_ task: MobileBackgroundTask, replacing current: MobileBackgroundTask) -> MobileBackgroundTask {
        if task.activityMilliseconds > current.activityMilliseconds { return task }
        if task.activityMilliseconds < current.activityMilliseconds { return current }
        if task.isActive != current.isActive { return task.isActive ? current : task }
        guard task.isActive else { return current }
        if task.status == "running", current.status == "queued" { return task }
        if task.status == "queued", current.status == "running" { return current }
        if task.runId == current.runId,
           let incoming = task.progress, let previous = current.progress,
           incoming.revision != previous.revision
        {
            return incoming.revision > previous.revision ? task : current
        }
        return current
    }
}

struct BackgroundTasksScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    let agentID: String

    @State private var tasks: [MobileBackgroundTask] = []
    @State private var loading = true
    @State private var errorMessage: String?
    @State private var route: GatewayNodeSessionRoute?
    @State private var requestID: UInt64 = 0

    private var observationID: String {
        "\(self.appModel.chatViewModelIdentityID)|\(self.appModel.operatorAuthorityGeneration)|\(self.agentID)"
    }

    private var activeTasks: [MobileBackgroundTask] {
        self.tasks.filter(\.isActive)
    }

    private var finishedTasks: [MobileBackgroundTask] {
        self.tasks.filter { !$0.isActive }.prefix(50).map(\.self)
    }

    var body: some View {
        NavigationStack {
            Group {
                if self.loading, self.tasks.isEmpty {
                    ProgressView {
                        Text("Loading background tasks…")
                            .font(OpenClawType.body)
                    }
                } else if let errorMessage, self.tasks.isEmpty {
                    ContentUnavailableView(
                        "Couldn’t Load Tasks",
                        systemImage: "exclamationmark.triangle",
                        description: Text(errorMessage).font(OpenClawType.body))
                } else if self.tasks.isEmpty {
                    ContentUnavailableView(
                        "No Background Tasks",
                        systemImage: "clock.arrow.circlepath",
                        description: Text("Tasks for this agent will appear here.")
                            .font(OpenClawType.body))
                } else {
                    List {
                        if let errorMessage {
                            Text(errorMessage)
                                .font(OpenClawType.footnote)
                                .foregroundStyle(OpenClawBrand.warn)
                        }
                        Section {
                            if self.activeTasks.isEmpty {
                                Text("No running tasks")
                                    .font(OpenClawType.body)
                                    .foregroundStyle(.secondary)
                            } else {
                                ForEach(self.activeTasks) { task in
                                    self.taskLink(task)
                                }
                            }
                        } header: {
                            Text("Running").font(OpenClawType.captionMedium)
                        }
                        Section {
                            if self.finishedTasks.isEmpty {
                                Text("No finished tasks")
                                    .font(OpenClawType.body)
                                    .foregroundStyle(.secondary)
                            } else {
                                ForEach(self.finishedTasks) { task in
                                    self.taskLink(task)
                                }
                            }
                        } header: {
                            Text("Finished").font(OpenClawType.captionMedium)
                        }
                    }
                    .listStyle(.insetGrouped)
                    .refreshable { await self.loadTasks() }
                }
            }
            .navigationTitle("Background Tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await self.loadTasks() }
                    } label: {
                        Label {
                            Text("Refresh").font(OpenClawType.body)
                        } icon: {
                            Image(systemName: "arrow.clockwise")
                        }
                    }
                    .disabled(self.loading)
                }
            }
        }
        .id(self.observationID)
        .task(id: self.observationID) { await self.observeTasks() }
    }

    private func taskLink(_ task: MobileBackgroundTask) -> some View {
        NavigationLink {
            BackgroundTaskDetailScreen(task: task, route: self.route)
        } label: {
            VStack(alignment: .leading, spacing: 7) {
                Text(task.displayTitle)
                    .font(OpenClawType.subheadMedium)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                HStack(spacing: 7) {
                    Text(task.statusLabel)
                        .font(OpenClawType.captionMedium)
                        .foregroundStyle(self.statusColor(task))
                    Text(task.runtimeLabel)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                if let output = task.output {
                    Text(output)
                        .font(OpenClawType.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .padding(.vertical, 3)
        }
        .accessibilityIdentifier("background-task-\(task.id)")
    }

    private func statusColor(_ task: MobileBackgroundTask) -> Color {
        switch task.status {
        case "completed": OpenClawBrand.ok
        case "failed", "timed_out": OpenClawBrand.warn
        case "queued", "running": OpenClawBrand.accent
        default: .secondary
        }
    }

    @MainActor
    private func observeTasks() async {
        self.tasks = []
        let observationID = self.observationID
        let route = await self.appModel.operatorSession.currentRoute()
        guard !Task.isCancelled, observationID == self.observationID else { return }
        self.route = route
        let subscription = await self.appModel.operatorSession.makeServerEventSubscription {
            $0.event == "task"
        }
        defer { subscription.cancel() }
        await self.loadTasks()
        for await event in subscription.events {
            guard !Task.isCancelled, let route, observationID == self.observationID,
                  await self.appModel.operatorSession.currentRoute() == route
            else { return }
            guard let payload = event.payload,
                  let change = try? GatewayPayloadDecoding.decode(payload, as: MobileBackgroundTaskEvent.self)
            else { continue }
            self.requestID &+= 1
            self.loading = false
            switch change.action {
            case "upserted":
                guard let task = change.task, task.agentId == self.agentID else { continue }
                self.tasks = MobileBackgroundTaskList.merge(recent: [task], active: self.tasks)
            case "deleted":
                self.tasks.removeAll { $0.id == change.taskId }
            case "restored":
                self.tasks = []
                await self.loadTasks()
            default:
                break
            }
        }
    }

    @MainActor
    private func loadTasks() async {
        self.requestID &+= 1
        let requestID = self.requestID
        let observationID = self.observationID
        self.loading = true
        self.errorMessage = nil
        do {
            guard let route = self.route else { throw CancellationError() }
            let tasks = try await MobileBackgroundTaskList.load { status, limit in
                let params = MobileBackgroundTasksListParams(agentId: self.agentID, status: status, limit: limit)
                let data = try await self.appModel.operatorSession.request(
                    method: "tasks.list",
                    paramsJSON: String(decoding: JSONEncoder().encode(params), as: UTF8.self),
                    timeoutSeconds: 12,
                    ifCurrentRoute: route)
                return try JSONDecoder().decode(MobileBackgroundTasksEnvelope.self, from: data).tasks
            }
            guard !Task.isCancelled, observationID == self.observationID, requestID == self.requestID else { return }
            self.tasks = tasks.filter { $0.agentId == nil || $0.agentId == self.agentID }
        } catch {
            guard !Task.isCancelled, observationID == self.observationID, requestID == self.requestID else { return }
            self.errorMessage = error.localizedDescription
        }
        self.loading = false
    }
}

private struct BackgroundTaskDetailScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var task: MobileBackgroundTask
    @State private var loading = true
    @State private var errorMessage: String?
    @State private var unavailable = false
    private let route: GatewayNodeSessionRoute?

    init(task: MobileBackgroundTask, route: GatewayNodeSessionRoute?) {
        self._task = State(initialValue: task)
        self.route = route
    }

    var body: some View {
        Group {
            if self.unavailable {
                ContentUnavailableView(
                    "Task unavailable",
                    systemImage: "clock.arrow.circlepath",
                    description: Text(self.errorMessage ?? String(localized: "This task is no longer available."))
                        .font(OpenClawType.body))
            } else {
                self.taskContent
            }
        }
        .navigationTitle("Task Details")
        .navigationBarTitleDisplayMode(.inline)
        .task { await self.observeTask() }
    }

    private var taskContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(self.task.displayTitle)
                        .font(OpenClawType.title3)
                    HStack(spacing: 8) {
                        Text(self.task.statusLabel).font(OpenClawType.captionMedium)
                        Text(self.task.runtimeLabel)
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let progress = self.task.progress, !progress.items.isEmpty {
                        OpenClawTaskProgressView(progress: progress)
                    }
                }
                self.detailBlock(
                    title: String(localized: "Prompt"),
                    body: self.task.prompt ?? (self.loading
                        ? String(localized: "Loading…")
                        : String(localized: "Prompt unavailable.")))
                self.detailBlock(
                    title: String(localized: "Output"),
                    body: self.task.output ?? String(localized: "No output yet."))
                if let errorMessage {
                    Text(errorMessage)
                        .font(OpenClawType.footnote)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
    }

    private func detailBlock(title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(OpenClawType.captionMedium)
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Text(body)
                .font(OpenClawType.monoFootnote)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    @MainActor
    private func observeTask() async {
        let subscription = await self.appModel.operatorSession.makeServerEventSubscription {
            $0.event == "task"
        }
        defer { subscription.cancel() }
        await self.loadDetail()
        for await event in subscription.events {
            guard !Task.isCancelled, let route = self.route,
                  await self.appModel.operatorSession.currentRoute() == route
            else { return }
            guard let payload = event.payload,
                  let change = try? GatewayPayloadDecoding.decode(payload, as: MobileBackgroundTaskEvent.self)
            else { continue }
            if change.action == "deleted", change.taskId == self.task.id {
                self.unavailable = true
                // Deletion hides the record, not the view's registry observation.
                continue
            }
            if change.action == "restored" {
                self.unavailable = true
                await self.loadDetail()
            } else if let task = change.task, task.id == self.task.id {
                if self.unavailable {
                    await self.loadDetail()
                    continue
                }
                var updated = MobileBackgroundTaskList.newest(self.task, replacing: task)
                // List/event summaries omit the bounded prompt returned by tasks.get.
                updated.prompt = updated.prompt ?? self.task.prompt
                self.task = updated
            }
        }
    }

    @MainActor
    private func loadDetail() async {
        self.loading = true
        self.errorMessage = nil
        do {
            guard let route = self.route else { throw CancellationError() }
            let params = MobileBackgroundTaskGetParams(taskId: self.task.id)
            let payload = try JSONEncoder().encode(params)
            guard let paramsJSON = String(data: payload, encoding: .utf8) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            let data = try await self.appModel.operatorSession.request(
                method: "tasks.get",
                paramsJSON: paramsJSON,
                timeoutSeconds: 12,
                ifCurrentRoute: route)
            guard !Task.isCancelled else { return }
            self.task = try JSONDecoder().decode(MobileBackgroundTaskEnvelope.self, from: data).task
            self.unavailable = false
        } catch {
            guard !Task.isCancelled else { return }
            self.errorMessage = error.localizedDescription
        }
        self.loading = false
    }
}
