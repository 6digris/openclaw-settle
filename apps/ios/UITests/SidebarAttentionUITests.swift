import UIKit
import XCTest

@MainActor
final class SidebarAttentionUITests: XCTestCase {
    func testPendingDetailsSurviveNavigationAndClearWithGatewayEvents() async throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_ATTENTION_FIXTURE_URL"] != nil,
            "Requires an isolated synthetic Gateway")
        let fixture = try XCTUnwrap(environment["OPENCLAW_IOS_ATTENTION_FIXTURE_URL"].flatMap(URL.init(string:)))
        let setupCode = try XCTUnwrap(environment["OPENCLAW_IOS_LIVE_SETUP_CODE"])
        continueAfterFailure = false
        try await self.changeFixture(fixture, path: "reset")
        let app = XCUIApplication()
        defer { app.terminate() }
        self.launchConnectedChat(app, setupCode: setupCode)
        self.openSidebar(app)
        let review = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Pending review")).firstMatch
        XCTAssertTrue(review.waitForExistence(timeout: 15), app.debugDescription)
        let parent = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Website refresh")).firstMatch
        XCTAssertTrue(parent.waitForExistence(timeout: 10))
        self.capture(app, named: "sidebar-pending")

        let question = app.buttons.matching(identifier: "sidebar-attention-question").firstMatch
        let approval = app.buttons.matching(identifier: "sidebar-attention-approval").firstMatch
        XCTAssertTrue(
            question.waitForExistence(timeout: 10),
            "Inactive thread questions must be discoverable in the sidebar")
        XCTAssertFalse(approval.exists, "Each row must show only its oldest pending request kind")
        XCTAssertTrue(question.label.contains("Which draft should we review first?"))
        XCTAssertTrue(question.label.contains("2 more questions"))
        let threadQuestion = try XCTUnwrap(
            app.buttons.matching(identifier: "sidebar-attention-question")
                .allElementsBoundByIndex.first { $0.isHittable && abs($0.frame.midY - review.frame.midY) < 2 },
            "The inactive Pending review row must expose its own question details button")
        let historyBefore = try await historyRequests(fixture)
        let parentQuestion = try XCTUnwrap(
            app.buttons.matching(identifier: "sidebar-attention-question")
                .allElementsBoundByIndex.first { $0.isHittable && abs($0.frame.midY - parent.frame.midY) < 2 },
            "The Website refresh parent row must expose pending questions from its child")
        XCTAssertTrue(parentQuestion.label.contains("Which draft should we review first?"))
        XCTAssertTrue(parentQuestion.label.contains("2 more questions"))
        try await self.changeFixture(fixture, path: "questions/add-parent")
        let parentPreview = XCTNSPredicateExpectation(
            predicate: NSPredicate(
                format: "label CONTAINS %@ AND label CONTAINS %@",
                "Which page should we refresh first?",
                "3 more questions"), object: parentQuestion)
        XCTAssertEqual(XCTWaiter.wait(for: [parentPreview], timeout: 10), .completed)
        XCTAssertTrue(threadQuestion.label.contains("Which draft should we review first?"))
        XCTAssertTrue(threadQuestion.label.contains("2 more questions"))
        parentQuestion.tap()
        XCTAssertTrue(app.staticTexts["Which page should we refresh first?"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["3 more questions"].exists)
        self.capture(app, named: "parent-question-details")
        try await self.changeFixture(fixture, path: "questions/cancel-parent")
        XCTAssertTrue(
            app.staticTexts["Waiting for answer"].waitForNonExistence(timeout: 10),
            "Cancelling the parent's oldest request must dismiss its popup")
        XCTAssertTrue(parentQuestion.label.contains("Which draft should we review first?"))
        XCTAssertTrue(parentQuestion.label.contains("2 more questions"))
        threadQuestion.tap()
        XCTAssertTrue(app.staticTexts["Waiting for answer"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Which draft should we review first?"].exists)
        XCTAssertTrue(app.staticTexts["2 more questions"].exists)
        self.capture(app, named: "question-details")
        self.dismissPopover(app)
        let historyAfter = try await historyRequests(fixture)
        XCTAssertEqual(
            historyAfter,
            historyBefore,
            "Opening attention details must not navigate to the inactive conversation")
        app.buttons["RootTabs.Sidebar.Destination.overview"].tap()
        XCTAssertTrue(app.staticTexts["Agent session"].waitForExistence(timeout: 10), app.debugDescription)
        self.openSidebar(app)
        XCTAssertTrue(
            question.waitForExistence(timeout: 10),
            "Questions must stay available after navigating away from Chat")
        question.tap()
        XCTAssertTrue(app.staticTexts["Which draft should we review first?"].waitForExistence(timeout: 5))
        self.capture(app, named: "overview-question-details")
        let priorReadbacks = try await self.approvalReadbackCount(fixture, id: "attention-approval-6")
        try await self.changeFixture(fixture, path: "approvals/expire-last")
        try await self.waitForApprovalReadback(fixture, id: "attention-approval-6", after: priorReadbacks)
        XCTAssertTrue(
            app.staticTexts["Waiting for answer"].exists,
            "Settling another request kind must preserve the open question details")
        XCTAssertTrue(app.staticTexts["2 more questions"].exists)
        self.capture(app, named: "question-details-after-other-kind-expiry")
        try await self.changeFixture(fixture, path: "questions/expire-newer")
        XCTAssertTrue(
            app.staticTexts["1 more question"].waitForExistence(timeout: 10),
            "The open details must update the total number of pending questions")
        XCTAssertTrue(app.staticTexts["Which draft should we review first?"].exists)
        self.capture(app, named: "question-details-after-newer-expiry")
        try await self.changeFixture(fixture, path: "questions/answer-oldest")
        XCTAssertTrue(
            app.staticTexts["Waiting for answer"].waitForNonExistence(timeout: 10),
            "Answering the oldest request must dismiss its details")
        XCTAssertFalse(
            app.staticTexts["Waiting for approval"].exists,
            "The dismissed popover must not turn into another request's details")
        XCTAssertTrue(question.waitForNonExistence(timeout: 10))
        XCTAssertTrue(
            approval.waitForExistence(timeout: 10),
            "The next request kind must appear after questions settle")
        XCTAssertTrue(approval.label.contains("Inspect the synthetic review folder"))
        let loadedApprovals = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label CONTAINS %@", "4 more approvals"), object: approval)
        XCTAssertEqual(XCTWaiter.wait(for: [loadedApprovals], timeout: 10), .completed)
        let threadApproval = try XCTUnwrap(
            app.buttons.matching(identifier: "sidebar-attention-approval")
                .allElementsBoundByIndex.first { $0.isHittable && abs($0.frame.midY - review.frame.midY) < 2 },
            "The inactive Pending review row must expose its own approval details button")
        threadApproval.tap()
        XCTAssertTrue(app.staticTexts["Waiting for approval"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Inspect the synthetic review folder"].exists)
        XCTAssertTrue(app.staticTexts["4 more approvals"].exists)
        self.capture(app, named: "approval-details")
        self.dismissPopover(app)
        try await self.changeFixture(fixture, path: "approvals/cancel")
        XCTAssertTrue(approval.waitForNonExistence(timeout: 10))
        self.capture(app, named: "sidebar-cleared")
    }

    func testYieldedParentRetainsWorkerProgressAndEditableDraft() async throws {
        try await self.exerciseWorkerProgress(completedDelivery: false)
    }

    func testCompletedWorkerDeliveryStaysIndependentFromExecution() async throws {
        try await self.exerciseWorkerProgress(completedDelivery: true)
    }

    private func exerciseWorkerProgress(completedDelivery: Bool) async throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_ATTENTION_FIXTURE_URL"] != nil,
            "Requires an isolated synthetic Gateway")
        let fixture = try XCTUnwrap(environment["OPENCLAW_IOS_ATTENTION_FIXTURE_URL"].flatMap(URL.init(string:)))
        let setupCode = try XCTUnwrap(environment["OPENCLAW_IOS_LIVE_SETUP_CODE"])
        continueAfterFailure = false
        try await self.changeFixture(fixture, path: "task-progress/reset")
        let app = XCUIApplication()
        defer { app.terminate() }
        self.launchConnectedChat(app, setupCode: setupCode)

        let input = app.descendants(matching: .any)["chat-message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap()
        input.typeText("Run the synthetic worker scenario.")
        self.dismissKeyboard(app)
        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        XCTAssertTrue(send.isEnabled)
        send.tap()
        XCTAssertTrue(app.staticTexts["Parent yielded; synthetic worker continues."].waitForExistence(timeout: 20))
        self.waitForLabel(app, containing: "Prepared worker commentary: reviewing synthetic notes.")

        let draft = "Keep this unsent native draft."
        input.tap()
        input.typeText(draft)
        XCTAssertEqual(input.value as? String, draft)
        self.dismissKeyboard(app)
        XCTAssertTrue(send.isEnabled, "The yielded parent must leave an editable, sendable composer")
        let plan = app.buttons[
            "Plan, 0 of 2 steps done, In progress: Review synthetic notes",
        ]
        XCTAssertTrue(plan.waitForExistence(timeout: 10))
        plan.tap()
        self.assertAuthoredChecklist(app)
        let yielded = try await self.captureTaskProgress(app, fixture: fixture, stage: "yielded-editable")
        XCTAssertEqual(yielded.stage, "yielded")
        XCTAssertTrue(yielded.parentYielded)
        XCTAssertEqual(yielded.task.runtime, "subagent")
        XCTAssertEqual(yielded.task.agentId, "worker")
        XCTAssertEqual(yielded.task.sessionKey, "agent:main:main")
        XCTAssertEqual(yielded.task.ownerKey, "agent:main:main")
        XCTAssertTrue(yielded.connections.contains { $0.role == "operator" && $0.taskProgress })

        try await self.changeFixture(fixture, path: "task-progress/advance", body: ["stage": "working"])
        self.waitForLabel(app, containing: "printf synthetic-progress-check")
        XCTAssertEqual(input.value as? String, draft, "Worker updates must not replace the draft")
        self.assertAuthoredChecklist(app)
        let working = try await self.captureTaskProgress(app, fixture: fixture, stage: "working")
        XCTAssertEqual(working.card, yielded.card)
        XCTAssertEqual(working.task.status, "running")

        try await self.changeFixture(fixture, path: "task-progress/advance", body: ["stage": "unknown"])
        self.waitForLabel(app, containing: "Execution unknown")
        let activity = app.buttons["Activity"]
        XCTAssertTrue(activity.waitForExistence(timeout: 10))
        activity.tap()
        let unknownCommand = app.descendants(matching: .any).matching(NSPredicate(
            format: "label CONTAINS %@ AND label CONTAINS %@",
            "Outcome unknown", "printf synthetic-outcome-unavailable")).firstMatch
        XCTAssertTrue(unknownCommand.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(input.value as? String, draft)
        self.assertAuthoredChecklist(app)
        let unknown = try await self.captureTaskProgress(app, fixture: fixture, stage: "unknown")
        let unknownTool = try XCTUnwrap(unknown.task.progress?.items.first { $0.kind == "tool" })
        XCTAssertNil(unknownTool.status, "The fixture must not invent a command outcome")
        XCTAssertEqual(unknown.card, yielded.card)

        if completedDelivery {
            try await self.assertCompletedTaskDelivery(app, fixture: fixture, draft: draft, card: yielded.card)
            return
        }

        try await self.changeFixture(fixture, path: "task-progress/advance", body: ["stage": "failed"])
        self.waitForLabel(app, containing: "Synthetic worker failed; no command was executed.")
        self.waitForLabel(app, containing: "Synthetic final: failed fixture result; no command was executed.")
        XCTAssertEqual(input.value as? String, draft)
        XCTAssertTrue(send.isEnabled)
        self.assertAuthoredChecklist(app)
        let terminal = try await self.captureTaskProgress(app, fixture: fixture, stage: "failed")
        XCTAssertEqual(terminal.stage, "failed")
        XCTAssertEqual(terminal.task.status, "failed")
        XCTAssertEqual(terminal.card, yielded.card, "Task completion must not rewrite the authored plan")
        XCTAssertEqual(terminal.requests.filter { $0.method == "chat.send" }.count, 1, "The draft was never sent")
        XCTAssertTrue(terminal.requests.contains { $0.method == "tasks.list" && $0.sessionKey == "agent:main:main" })
        XCTAssertTrue(terminal.requests.contains { $0.method == "progressCard.get" })
        let yieldIndex = try XCTUnwrap(terminal.events.firstIndex { $0.event == "chat" && $0.yielded == true })
        let workingIndex = try XCTUnwrap(terminal.events.firstIndex { $0.event == "task" && $0.stage == "working" })
        XCTAssertLessThan(yieldIndex, workingIndex, "Worker activity must arrive after the parent yielded")
        XCTAssertTrue(terminal.events.filter { $0.event == "task" }.allSatisfy { $0.taskProgressRecipients > 0 })
        XCTAssertTrue(zip(terminal.events, terminal.events.dropFirst()).allSatisfy { $0.0.seq < $0.1.seq })
    }

    private func assertCompletedTaskDelivery(
        _ app: XCUIApplication,
        fixture: URL,
        draft: String,
        card: TaskProgressEvidence.Card) async throws
    {
        try await self.changeFixture(
            fixture, path: "task-progress/advance", body: ["stage": "completed", "deliveryStatus": "pending"])
        self.waitForLabel(app, containing: "Synthetic worker completed; no command was executed.")
        XCTAssertFalse(app.staticTexts["Synthetic final: completed fixture result; no command was executed."].exists)
        XCTAssertEqual(app.descendants(matching: .any)["chat-message-input"].value as? String, draft)
        self.assertAuthoredChecklist(app)
        let pending = try await self.captureTaskProgress(app, fixture: fixture, stage: "completed-pending-chat")
        XCTAssertEqual(pending.card, card)

        self.selectAgent(app, named: "Synthetic worker")
        app.buttons["Chat actions"].tap()
        let tasks = app.buttons["Background tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 5))
        tasks.tap()
        let row = app.buttons["background-task-native-progress-child"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), app.debugDescription)

        for (status, label) in [
            ("pending", "Pending"),
            ("session_queued", "Queued for conversation"),
            ("failed", "Delivery failed"),
            ("delivered", "Delivered"),
        ] {
            if status != "pending" {
                try await self.changeFixture(
                    fixture, path: "task-progress/advance", body: ["stage": "completed", "deliveryStatus": status])
            }
            let deliveryText = "Final delivery: \(label)"
            let updated = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Completed", deliveryText),
                object: row)
            XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 10), .completed)
            let evidence = try await self.captureTaskProgress(
                app, fixture: fixture, stage: "completed-\(status)-list")
            XCTAssertEqual(evidence.task.status, "completed")
            XCTAssertEqual(evidence.card, card, "Delivery must not rewrite the authored checklist")
            XCTAssertEqual(
                evidence.assistantMessages.filter { $0.id == "native-progress-final" }.count,
                status == "delivered" ? 1 : 0,
                "Only confirmed delivery may put the result in the parent conversation")
            row.tap()
            XCTAssertTrue(app.staticTexts[deliveryText].waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertTrue(app.staticTexts["Completed"].exists)
            _ = try await self.captureTaskProgress(app, fixture: fixture, stage: "completed-\(status)-detail")
            app.navigationBars["Task Details"].buttons.firstMatch.tap()
            XCTAssertTrue(row.waitForExistence(timeout: 10))
        }

        try await self.changeFixture(
            fixture, path: "task-progress/advance", body: ["stage": "completed", "deliveryStatus": "delivered"])
        app.navigationBars["Background Tasks"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        self.selectAgent(app, named: "Research assistant")
        self.waitForLabel(app, containing: "Synthetic final: completed fixture result; no command was executed.")
        XCTAssertEqual(app.descendants(matching: .any)["chat-message-input"].value as? String, draft)
        XCTAssertTrue(app.buttons["chat-send-message"].isEnabled)
        let checklist = app.descendants(matching: .any).matching(NSPredicate(
            format: "label CONTAINS %@", "In progress, Review synthetic notes")).firstMatch
        if !checklist.exists {
            app.buttons["Plan, 0 of 2 steps done, In progress: Review synthetic notes"].tap()
        }
        self.assertAuthoredChecklist(app)
        let delivered = try await self.captureTaskProgress(app, fixture: fixture, stage: "completed-delivered-chat")
        XCTAssertEqual(delivered.card, card)
        XCTAssertEqual(delivered.assistantMessages.filter { $0.id == "native-progress-final" }.count, 1)
        XCTAssertEqual(delivered.requests.filter { $0.method == "chat.send" }.count, 1, "The draft was never sent")
    }

    private func selectAgent(_ app: XCUIApplication, named name: String) {
        self.openSidebar(app)
        app.buttons["RootTabs.Sidebar.AgentSelector"].tap()
        let agent = app.buttons[name]
        XCTAssertTrue(agent.waitForExistence(timeout: 5))
        agent.tap()
        app.buttons["RootTabs.Sidebar.Destination.chat"].tap()
        XCTAssertTrue(app.buttons["Chat actions"].waitForExistence(timeout: 10))
    }

    private func launchConnectedChat(_ app: XCUIApplication, setupCode: String) {
        addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        app.launchArguments = [
            "--openclaw-reset-onboarding", "--openclaw-initial-tab", "chat",
            "--openclaw-initial-destination", "chat", "-AppleLanguages", "(en)",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 15))
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.buttons["Connect Manually"].waitForExistence(timeout: 10))
        app.buttons["Connect Manually"].tap()
        let setupField = app.textFields["Enter setup code"]
        XCTAssertTrue(setupField.waitForExistence(timeout: 5))
        setupField.tap()
        setupField.typeText(setupCode)
        app.buttons["Apply"].tap()
        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 60))
        app.buttons["Go to Chat"].tap()
        XCTAssertTrue(app.staticTexts["Your research workspace is ready."].waitForExistence(timeout: 30))
    }

    private func dismissKeyboard(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    }

    private func waitForLabel(_ app: XCUIApplication, containing text: String) {
        let element = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text))
            .firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: 15), app.debugDescription)
    }

    private func assertAuthoredChecklist(_ app: XCUIApplication) {
        self.waitForLabel(app, containing: "In progress, Review synthetic notes")
        self.waitForLabel(app, containing: "Pending, Report synthetic result")
    }

    private func captureTaskProgress(
        _ app: XCUIApplication,
        fixture: URL,
        stage: String) async throws -> TaskProgressEvidence
    {
        self.capture(app, named: "shared-progress-\(stage)")
        var request = URLRequest(url: fixture.appendingPathComponent("task-progress/evidence"))
        request.timeoutInterval = 10
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "apple-ios-shared-progress-\(stage)-gateway-evidence"
        attachment.lifetime = .keepAlways
        add(attachment)
        return try JSONDecoder().decode(TaskProgressEvidence.self, from: data)
    }

    private func openSidebar(_ app: XCUIApplication) {
        let show = app.buttons["RootTabs.Sidebar.Show"]
        if show.exists, show.isHittable {
            show.tap()
        }
        XCTAssertTrue(app.buttons["RootTabs.Sidebar.Destination.chat"].waitForExistence(timeout: 10))
    }

    private func dismissPopover(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.88)).tap()
        XCTAssertTrue(app.staticTexts["Waiting for answer"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Waiting for approval"].waitForNonExistence(timeout: 5))
    }

    private func changeFixture(_ fixture: URL, path: String, body: [String: String]? = nil) async throws {
        var request = URLRequest(url: fixture.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    private func historyRequests(_ fixture: URL) async throws -> [String] {
        let state = try await self.fixtureState(fixture)
        return state.requests.filter { $0.method == "chat.history" }.compactMap(\.sessionKey)
    }

    private func fixtureState(_ fixture: URL) async throws -> FixtureState {
        let (data, _) = try await URLSession.shared.data(from: fixture)
        return try JSONDecoder().decode(FixtureState.self, from: data)
    }

    private func approvalReadbackCount(_ fixture: URL, id: String) async throws -> Int {
        let state = try await self.fixtureState(fixture)
        return state.requests.filter { $0.method == "approval.get" && $0.id == id }.count
    }

    private func waitForApprovalReadback(_ fixture: URL, id: String, after priorCount: Int) async throws {
        let deadline = ContinuousClock().now + .seconds(10)
        while ContinuousClock().now < deadline {
            if try await self.approvalReadbackCount(fixture, id: id) > priorCount { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("Native approval owner did not read the fixture's terminal record")
    }

    private func capture(_ app: XCUIApplication, named name: String) {
        let captured = app.screenshot()
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("apple-ios-\(name).png")
        do {
            try captured.pngRepresentation.write(to: output)
            print("Sidebar attention screenshot: \(output.path)")
        } catch {
            XCTFail("Could not save sidebar screenshot: \(error)")
        }
        let screenshot = XCTAttachment(screenshot: captured)
        screenshot.name = "apple-ios-\(name)"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "apple-ios-\(name)-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }

    private struct FixtureState: Decodable {
        struct Request: Decodable {
            let method: String
            let sessionKey: String?
            let id: String?
            let stage: String?
        }

        let requests: [Request]
    }

    private struct TaskProgressEvidence: Decodable {
        struct Connection: Decodable {
            let role: String
            let taskProgress: Bool
        }

        struct Event: Decodable {
            let seq: Int
            let event: String
            let stage: String
            let yielded: Bool?
            let taskProgressRecipients: Int
        }

        struct TaskSnapshot: Decodable {
            struct Progress: Decodable {
                struct Item: Decodable {
                    let kind: String
                    let status: String?
                }

                let items: [Item]
            }

            let runtime: String
            let status: String
            let agentId: String
            let sessionKey: String
            let ownerKey: String
            let progress: Progress?
        }

        struct Card: Decodable, Equatable {
            struct Step: Decodable, Equatable {
                let step: String
                let status: String
            }

            let revision: Int
            let markdown: String
            let steps: [Step]
        }

        struct AssistantMessage: Decodable {
            let id: String
        }

        let stage: String
        let parentYielded: Bool
        let task: TaskSnapshot
        let card: Card
        let connections: [Connection]
        let requests: [FixtureState.Request]
        let events: [Event]
        let assistantMessages: [AssistantMessage]
    }
}
