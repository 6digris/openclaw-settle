import AppKit
import CoreGraphics
import Observation
import OpenClawChatUI
import SwiftUI
import XCTest
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
final class QuickChatCatalogPresentationTests: XCTestCase {
    private var guestCueLabel: NSTextField?
    private var guestInvalidation: (@Sendable () -> Void)?

    func testRenderedPickerUsesCatalogAvailabilityReasoningAndSpeed() async throws {
        let application = AppKitTestSupport.application
        XCTAssertTrue(AppKitTestSupport.didSetActivationPolicy)
        if ProcessInfo.processInfo.environment["OPENCLAW_TEST_QUICKCHAT_APPEARANCE"] == "dark" {
            application.appearance = NSAppearance(named: .darkAqua)
        }
        let fixture = QuickChatCatalogFixture()
        let gateway = Self.makeGateway(fixture: fixture)
        let model = Self.makeModel(gateway: gateway)
        let controller = QuickChatController(
            enableUI: true, model: model, monitoringEnabled: false,
            hotkeyRegistrar: { _ in }, hotkeyRemover: {})
        defer { controller.stop() }
        do {
            application.deactivate()
            controller.present()
            try await self.waitForModel { model.canUseModelControls }
            XCTAssertTrue(model.speed.supportsFastMode)
            model.selectModel("fixture/current")
            XCTAssertNil(model.selectedModelSelectionID, "Retained metadata does not permit manual selection")
            let panel = try XCTUnwrap(application.windows.first {
                ($0.contentView as? NSHostingView<QuickChatView>)?.rootView.model === model
            })
            XCTAssertTrue(panel.isVisible)
            let content = try XCTUnwrap(panel.contentView)
            content.layoutSubtreeIfNeeded()
            let elements = try await AppKitTestSupport.accessibilityElements(in: content)
            let button = try XCTUnwrap(elements.first {
                $0.accessibilityRole?() == .button &&
                    $0.accessibilityLabel?() == "Model"
            })

            try await AppKitTestSupport.openMenu(button, in: panel) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "catalog")
                let provider = try XCTUnwrap(menu.items.first { $0.submenu != nil })
                let choices = try XCTUnwrap(provider.submenu)
                XCTAssertFalse(choices.items.contains { $0.title.hasPrefix("Current fixture") })
                let unavailable = try XCTUnwrap(choices.items.first { $0.title.hasPrefix("Locked fixture") })
                XCTAssertFalse(unavailable.isEnabled, "The catalog requires sign-in before this model can be selected")
                XCTAssertTrue(unavailable.title.contains("Sign-in needed"))
                let unknown = try XCTUnwrap(choices.items.first { $0.title.hasPrefix("Unknown fixture") })
                XCTAssertTrue(unknown.isEnabled, "Missing availability must not refuse a model")
                let allowed = try XCTUnwrap(choices.items.firstIndex { $0.title.hasPrefix("Allowed fixture") })
                XCTAssertTrue(choices.items[allowed].isEnabled)
                choices.performActionForItem(at: allowed)
            }
            try await self.waitForModel { !model.isUpdatingModel }
            XCTAssertEqual(model.selectedModelSelectionID, "fixture/allowed")
            XCTAssertEqual(model.displayedModelSelectionID, "fixture/allowed")

            try await AppKitTestSupport.openMenu(button, in: panel) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "selected")
                let provider = try XCTUnwrap(menu.items.first { $0.submenu != nil })
                let selected = try XCTUnwrap(provider.submenu?.items.first {
                    $0.title.hasPrefix("Allowed fixture")
                })
                XCTAssertEqual(selected.state, .on)
            }

            var effort = try await self.waitForEffort(in: panel, value: "Inherited Brief")
            XCTAssertEqual(model.thinkingOptions.map(\.label), ["Brief", "Thorough"])
            XCTAssertTrue(effort.accessibilityPerformPress?() == true)
            let popover = try await self.waitForEffortPopover(application: application)
            let slider = try XCTUnwrap(popover.elements.first {
                $0.accessibilityRole?() == .slider && $0.accessibilityLabel?() == "Thinking effort"
            })
            XCTAssertTrue(slider.accessibilityPerformIncrement?() == true)
            try await self.waitForModel { model.selectedThinkingLevel == "high" }
            effort = try await self.waitForEffort(in: panel, value: "Thorough")
            let effortValue: Any? = effort.accessibilityValue?()
            XCTAssertEqual(effortValue as? String, "Thorough")
            try await self.captureEffortPopover(popover.window, name: "effort")
            let fast = try await AppKitTestSupport.waitForAccessibilityElement(
                in: popover.window, description: "the enabled Fast mode control")
            { elements in
                elements.first { $0.accessibilityLabel?() == "Fast mode" && $0.isAccessibilityEnabled?() == true }
            }
            XCTAssertTrue(fast.isAccessibilityEnabled?() == true)
            _ = fast.accessibilityPerformPress?()
            try await self.waitForModel { model.speed.isEnabled && !model.isUpdatingModel }
            XCTAssertTrue(model.speed.isEnabled)
            XCTAssertEqual(model.speed.override, .on)
            effort = try await self.waitForEffort(in: panel, value: "Thorough, Fast")
            let fastEffortValue: Any? = effort.accessibilityValue?()
            XCTAssertEqual(fastEffortValue as? String, "Thorough, Fast")
            let defaults = try await AppKitTestSupport.accessibilityElements(in: popover.window)
                .filter { $0.accessibilityRole?() == .button && $0.accessibilityLabel?() == "Use session default" }
            XCTAssertEqual(defaults.count, 2, "Thinking and speed each have their own inheritance control")
            XCTAssertTrue(try XCTUnwrap(defaults.last).accessibilityPerformPress?() == true)
            try await self.waitForModel { !model.isUpdatingModel }
            XCTAssertNil(model.speed.override)
            XCTAssertFalse(model.speed.isEnabled)
            XCTAssertEqual(model.selectedThinkingLevel, "high")
            effort = try await self.waitForEffort(in: panel, value: "Thorough")
            XCTAssertTrue(effort.accessibilityPerformPress?() == true)
            try await AppKitTestSupport.openMenu(button, in: panel) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "inherited")
                let choices = try XCTUnwrap(menu.items.first { $0.title == "Fixture" }?.submenu)
                let unknown = try XCTUnwrap(choices.items.firstIndex { $0.title == "Unknown fixture" })
                choices.performActionForItem(at: unknown)
            }
            try await self.waitForModel { !model.isUpdatingModel }
            XCTAssertEqual(model.displayedModelSelectionID, "fixture/unknown")
            let patches = await fixture.patches
            XCTAssertEqual(patches, ["model=fixture/allowed", "fast=true", "fast=null", "model=fixture/unknown"])
            controller.stop()
            await gateway.shutdown()
        } catch {
            controller.stop()
            await gateway.shutdown()
            throw error
        }
    }

    func testGuestModelPolicyRetiresRenderedChoicesAndOpenMenu() async throws {
        let application = AppKitTestSupport.application
        let appearance = application.appearance
        defer { application.appearance = appearance }
        application.appearance = NSAppearance(named: .aqua)
        let pointer = try XCTUnwrap(CGEvent(source: nil)?.location)
        defer { XCTAssertEqual(CGWarpMouseCursorPosition(pointer), .success) }
        let fixture = QuickChatCatalogFixture(guestCatalog: .permitted)
        let gateway = Self.makeGateway(
            fixture: fixture, scopes: ["operator.sessions.read", "operator.sessions.write"])
        let model = Self.makeModel(gateway: gateway)
        let controller = QuickChatController(
            enableUI: true, model: model, monitoringEnabled: false,
            hotkeyRegistrar: { _ in }, hotkeyRemover: {})
        var recording: (task: Task<Void, Never>, started: AsyncStream<Void>, bounds: CGRect)?
        var invalidationTimer: Timer?
        var cueWindow: NSPanel?
        defer {
            invalidationTimer?.invalidate()
            self.guestInvalidation = nil
            self.guestCueLabel = nil
            cueWindow?.orderOut(nil)
            controller.stop()
        }
        do {
            controller.present()
            try await self.waitForModel { model.canUseModelControls }
            model.dismissPermissionsForSession()
            model.text = "Unsent fixture draft"
            let panel = try XCTUnwrap(application.windows.first {
                ($0.contentView as? NSHostingView<QuickChatView>)?.rootView.model === model
            })
            let content = try XCTUnwrap(panel.contentView)
            var button = try await self.guestModelButton(in: panel, model: model)
            var sceneBounds = CGRect.null
            try AppKitTestSupport.pointAtModelButton(button, in: panel)
            try await AppKitTestSupport.openMenu(button, in: panel) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "guest-model-permitted")
                sceneBounds = sceneBounds.union(try XCTUnwrap(Self.guestSceneBounds(panel: panel)).scene)
                let choices = try XCTUnwrap(menu.items.first { $0.title == "Fixture" }?.submenu)
                XCTAssertEqual(choices.items.map(\.title), ["Primary fixture", "Fallback fixture", "Custom fixture"])
                XCTAssertTrue(menu.items.contains { $0.title == "Session default" })
                XCTAssertEqual(model.modelControlLabel, "Primary fixture")
                let fallback = try XCTUnwrap(choices.items.firstIndex { $0.title == "Fallback fixture" })
                choices.performActionForItem(at: fallback)
            }
            try await self.waitForModel { !model.isUpdatingModel && !model.isLoadingModelControls }
            XCTAssertEqual(model.displayedModelSelectionID, "fixture/fallback")

            let noDefault = try await fixture.prepareModelChange(.noDefault)
            noDefault()
            try await self.waitForModel { model.modelChoices.map(\.modelID) == ["custom"] && model.canUseModelControls }
            button = try await self.guestModelButton(in: panel, model: model)
            try AppKitTestSupport.pointAtModelButton(button, in: panel)
            try await AppKitTestSupport.openMenu(button, in: panel) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "guest-model-null")
                sceneBounds = sceneBounds.union(try XCTUnwrap(Self.guestSceneBounds(panel: panel)).scene)
                XCTAssertFalse(menu.items.contains { $0.title == "Session default" })
                XCTAssertNil(model.displayedModelSelectionID)
            }
            model.selectModel(OpenClawChatViewModel.defaultModelSelectionID)
            XCTAssertFalse(model.isUpdatingModel, "An old reset action cannot bypass a null permitted default")
            try await self.waitForModel { !model.isUpdatingModel && !model.isLoadingModelControls }

            let held = XCTestExpectation(description: "replacement catalog read held")
            let invalidate = try await fixture.prepareModelChange(.holding, onHeldRead: { held.fulfill() })
            button = try await self.guestModelButton(in: panel, model: model)
            let panelBounds = try AppKitTestSupport.screenCaptureRect(for: panel.frame)
            // This fixture's one-line status band measured 112 -> 143 points on the baseline runner.
            // Reserve only that downward growth; the assertions below reject any larger scene.
            let panelEnvelope = CGRect(
                x: panelBounds.minX,
                y: panelBounds.minY,
                width: panelBounds.width,
                height: panelBounds.height + 31)
            let cue = Self.makeGuestCue(above: panel)
            cueWindow = cue.window
            self.guestCueLabel = cue.label
            self.guestInvalidation = invalidate
            sceneBounds = sceneBounds.union(panelEnvelope)
                .union(try AppKitTestSupport.screenCaptureRect(for: cue.window.frame)).integral
            recording = Self.recordGuestModelMenu(bounds: sceneBounds)
            let captureBounds = recording?.bounds ?? sceneBounds
            if let recording {
                for await _ in recording.started {
                    // Camera startup occurs before the unchanged menu deadline starts.
                    try await Task.sleep(for: .seconds(1))
                    break
                }
            }
            try AppKitTestSupport.pointAtModelButton(button, in: panel)
            var dismissalError: Error?
            do {
                try await AppKitTestSupport.openMenu(button, in: panel, waitForDismissal: true) { menu in
                    cue.label.stringValue = "PROOF · Resting menu; update signal pending"
                    cue.window.displayIfNeeded()
                    try AppKitTestSupport.record(menu: menu, content: content, name: "guest-model-open")
                    self.assertGuestSceneContained(panel: panel, bounds: captureBounds)
                    // Keep the already-asserted resting state legible in the bounded recording.
                    let timer = Timer(
                        timeInterval: 1,
                        target: self,
                        selector: #selector(self.emitGuestInvalidation),
                        userInfo: nil,
                        repeats: false)
                    invalidationTimer = timer
                    for mode in [RunLoop.Mode.eventTracking, .common] {
                        RunLoop.main.add(timer, forMode: mode)
                    }
                }
            } catch {
                // Preserve the real stale rendering on an unchanged baseline before reporting the failed contract.
                dismissalError = error
            }
            let heldResult = await XCTWaiter.fulfillment(of: [held], timeout: 5)
            XCTAssertEqual(heldResult, .completed)
            await fixture.releaseHeldCatalog()
            try await self.waitForModel { model.modelControlStatusMessage != nil && !model.isLoadingModelControls }
            button = try await self.guestModelButton(in: panel, model: model)
            cue.label.stringValue = "PROOF · Catalog refresh failed"
            try AppKitTestSupport.pointAtModelButton(button, in: panel)
            try await AppKitTestSupport.openMenu(button, in: panel) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "guest-model-invalidated")
                self.assertGuestSceneContained(panel: panel, bounds: captureBounds)
                XCTAssertTrue(menu.items.allSatisfy { $0.action == nil && $0.submenu == nil })
            }
            XCTAssertTrue(model.modelChoices.isEmpty)
            XCTAssertEqual(model.text, "Unsent fixture draft")
            if let dismissalError { XCTFail("Policy invalidation did not dismiss the owned menu: \(dismissalError)") }
            // Hold the asserted failure state for reading, independently of request or menu deadlines.
            try await Task.sleep(for: .seconds(1))

            let recover = try await fixture.prepareModelChange(.permitted)
            recover()
            try await self.waitForModel { model.modelChoices.count == 3 && model.canUseModelControls }
            button = try await self.guestModelButton(in: panel, model: model)
            cue.label.stringValue = "PROOF · Catalog recovered"
            try AppKitTestSupport.pointAtModelButton(button, in: panel)
            try await AppKitTestSupport.openMenu(button, in: panel) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "guest-model-recovered")
                self.assertGuestSceneContained(panel: panel, bounds: captureBounds)
                XCTAssertTrue(menu.items.contains { $0.title == "Session default" })
            }
            let patches = await fixture.patches
            XCTAssertEqual(patches, ["model=fixture/fallback"])
            await recording?.task.value
            controller.stop()
            await gateway.shutdown()
        } catch {
            invalidationTimer?.invalidate()
            recording?.task.cancel()
            await recording?.task.value
            await fixture.releaseHeldCatalog()
            controller.stop()
            await gateway.shutdown()
            throw error
        }
    }

    @objc private func emitGuestInvalidation() {
        self.guestCueLabel?.stringValue = "PROOF · Policy change signal; fresh catalog held"
        self.guestCueLabel?.window?.displayIfNeeded()
        let invalidate = self.guestInvalidation
        self.guestInvalidation = nil
        invalidate?()
    }

    private func guestModelButton(in panel: NSWindow, model: QuickChatModel) async throws -> AnyObject {
        try await AppKitTestSupport.waitForAccessibilityElement(
            in: panel, description: "the Model button after its owned panel settles")
        { elements in
            guard let content = panel.contentView, let screen = panel.screen else { return nil }
            let fitting = content.fittingSize
            guard fitting.width > 0, fitting.height > 0 else { return nil }
            let target = QuickChatPlacement.barFrame(
                contentSize: NSSize(width: fitting.width, height: ceil(fitting.height)),
                visibleFrame: screen.visibleFrame)
            guard let expected = try? AppKitTestSupport.screenCaptureRect(for: target),
                  let actual = Self.guestSceneBounds(panel: panel)?.panel,
                  abs(expected.minX - actual.minX) < 0.5,
                  abs(expected.minY - actual.minY) < 0.5,
                  abs(expected.width - actual.width) < 0.5,
                  abs(expected.height - actual.height) < 0.5
            else { return nil }
            return elements.first {
                let value: Any? = $0.accessibilityValue?()
                return $0.accessibilityLabel?() == "Model" && $0.isAccessibilityEnabled?() == true &&
                    value as? String == model.modelControlLabel
            }
        }
    }

    private static func makeGuestCue(above panel: NSWindow) -> (window: NSPanel, label: NSTextField) {
        let frame = NSRect(x: panel.frame.minX, y: panel.frame.maxY + 6, width: panel.frame.width, height: 24)
        let window = NSPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false)
        window.level = .floating
        window.hidesOnDeactivate = false
        window.ignoresMouseEvents = true
        window.hasShadow = false
        window.backgroundColor = .windowBackgroundColor
        let label = NSTextField(labelWithString: "PROOF · Preparing model menu")
        label.font = .monospacedSystemFont(ofSize: 11, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.frame = NSRect(x: 8, y: 4, width: frame.width - 16, height: 16)
        let content = NSView(frame: NSRect(origin: .zero, size: frame.size))
        content.addSubview(label)
        window.contentView = content
        window.orderFront(nil)
        window.displayIfNeeded()
        return (window, label)
    }

    private func assertGuestSceneContained(panel: NSWindow, bounds: CGRect) {
        guard let actual = Self.guestSceneBounds(panel: panel) else {
            XCTFail("The owned panel has no Window Server bounds")
            return
        }
        XCTAssertTrue(
            bounds.contains(actual.scene.integral),
            "Owned scene \(actual.scene) exceeds recording crop \(bounds)")
    }

    private static func guestSceneBounds(panel: NSWindow) -> (panel: CGRect, scene: CGRect)? {
        let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0)
            as? [[String: Any]] ?? []).filter {
                $0[kCGWindowOwnerPID as String] as? Int32 == ProcessInfo.processInfo.processIdentifier &&
                    ($0[kCGWindowNumber as String] as? Int == panel.windowNumber ||
                        $0[kCGWindowLayer as String] as? Int == NSWindow.Level.popUpMenu.rawValue)
            }
        var panelBounds: CGRect?
        var scene = CGRect.null
        for window in windows {
            guard let fields = window[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: fields as CFDictionary) else { continue }
            scene = scene.union(bounds)
            if window[kCGWindowNumber as String] as? Int == panel.windowNumber { panelBounds = bounds }
        }
        return panelBounds.map { ($0, scene) }
    }

    private static func recordGuestModelMenu(bounds: CGRect)
        -> (task: Task<Void, Never>, started: AsyncStream<Void>, bounds: CGRect)?
    {
        guard let directory = ProcessInfo.processInfo.environment["OPENCLAW_TEST_MENU_CAPTURE_DIR"] else { return nil }
        let output = URL(fileURLWithPath: directory, isDirectory: true)
        let movie = output.appendingPathComponent("guest-model-policy-recording.mov")
        let statusFile = output.appendingPathComponent("guest-model-policy-recording-capture-status.json")
        let region: String? = if !bounds.isEmpty, !bounds.isNull {
            [bounds.minX, bounds.minY, bounds.width, bounds.height].map { String(Int($0)) }.joined(separator: ",")
        } else {
            nil
        }
        let (started, signal) = AsyncStream<Void>.makeStream()
        let task = Task.detached {
            defer { signal.finish() }
            var status: [String: Any] = [
                "method": "/usr/sbin/screencapture",
                "file": movie.lastPathComponent,
                "durationLimitSeconds": 8,
                "statusBandGrowthPoints": 31,
                "requiresVisualInspection": true,
            ]
            do {
                guard let region else {
                    throw NSError(domain: "GuestModelRecording", code: 1, userInfo: [
                        NSLocalizedDescriptionKey: "The owned panel and popup did not expose capture bounds.",
                    ])
                }
                status["region"] = region
                let result = try await BoundedProcess.run(
                    path: "/usr/sbin/screencapture",
                    arguments: ["-x", "-v", "-V", "8", "-R\(region)", movie.path],
                    whileRunning: { _ in
                        signal.yield(())
                        signal.finish()
                    },
                    timeout: 10)
                status["exitCode"] = result.terminationStatus
                status["diagnostic"] = String(decoding: result.output.prefix(4096), as: UTF8.self)
            } catch {
                status["failure"] = error.localizedDescription
            }
            let attributes = try? FileManager.default.attributesOfItem(atPath: movie.path)
            status["bytes"] = (attributes?[.size] as? NSNumber)?.intValue ?? 0
            do {
                try JSONSerialization.data(withJSONObject: status, options: [.prettyPrinted, .sortedKeys])
                    .write(to: statusFile, options: .atomic)
            } catch {
                XCTFail("Could not preserve the bounded recording result: \(error)")
            }
        }
        return (task, started, bounds)
    }

    private func waitForEffort(in window: NSWindow, value expectedValue: String) async throws -> AnyObject {
        // Model observation can complete before SwiftUI publishes its current accessibility tree.
        try await AppKitTestSupport.waitForAccessibilityElement(
            in: window, description: "the enabled effort control with value \(expectedValue)")
        { elements in
            elements.first { element in
                let value: Any? = element.accessibilityValue?()
                return element.accessibilityLabel?() == "Effort" && element.accessibilityRole?() == .button &&
                    element.isAccessibilityEnabled?() == true && value as? String == expectedValue
            }
        }
    }

    private func waitForEffortPopover(application: NSApplication) async throws
        -> (window: NSWindow, elements: [AnyObject])
    {
        let deadline = ContinuousClock.now + .seconds(5)
        repeat {
            for window in application.windows where window.isVisible {
                let elements = try await AppKitTestSupport.accessibilityElements(in: window)
                if elements.contains(where: { $0.accessibilityRole?() == .slider }) {
                    return (window, elements)
                }
            }
            try await Task.sleep(for: .milliseconds(20))
        } while ContinuousClock.now < deadline
        throw NSError(
            domain: "QuickChatCatalogPresentation", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "The rendered effort popover did not expose its slider"])
    }

    private func captureEffortPopover(_ window: NSWindow, name: String) async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["OPENCLAW_TEST_QUICKCHAT_EXTERNAL_CAPTURE"] == "1",
              let directory = environment["OPENCLAW_TEST_MENU_CAPTURE_DIR"] else { return }
        try await AppKitTestSupport.recordCompositedWindow(
            window, name: name, directory: URL(fileURLWithPath: directory, isDirectory: true))
    }

    private func waitForModel(_ condition: @escaping @MainActor () -> Bool) async throws {
        let ready = XCTestExpectation(description: "Quick Chat model state settled")
        let observation = QuickChatCatalogObservation(condition: condition, ready: ready)
        observation.observe()
        let result = await XCTWaiter.fulfillment(of: [ready], timeout: 5)
        observation.stop()
        XCTAssertEqual(result, .completed)
        XCTAssertTrue(condition())
    }

    private static func makeModel(gateway: GatewayConnection) -> QuickChatModel {
        let transport = MacGatewayChatTransport(connection: gateway, defaultGlobalAgentID: "main")
        return QuickChatModel(
            sessionKeyProvider: { "agent:main:main" },
            agentsProvider: { try await gateway.agentsList() },
            agentIdentityProvider: { _ in .placeholder },
            permissionStatusProvider: { _ in [:] },
            connectionGateProvider: { .available },
            modelControlsProvider: { target in
                async let catalog = transport.loadModelCatalog(sessionKey: target.sessionKey, agentID: target.agentID)
                async let sessions = transport.listSessions(limit: 200, search: target.sessionKey, archived: false)
                async let agents = gateway.agentsList()
                return try await QuickChatModelControlLogic.snapshot(
                    target: target, models: catalog.choices, sessions: sessions, agents: agents,
                    modelSelectionPolicy: catalog.modelSelectionPolicy)
            },
            modelCatalogEventsProvider: { await gateway.subscribe() },
            settingsPatchProvider: { target, settings in
                let routeLease = await transport.acquireSessionSettingsRouteLease()
                let lease = try XCTUnwrap(routeLease)
                return try await lease.patchSessionSettings(
                    sessionKey: target.sessionKey, agentID: target.agentID, patch: settings)
            })
    }

    private static func makeGateway(fixture: QuickChatCatalogFixture, scopes: [String] = []) -> GatewayConnection {
        // Real request encoding and payload decoding stop at the owner's in-memory WebSocket fake.
        // This does not exercise a network listener, device authentication, or a live Gateway.
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                let data: Data = switch message {
                case let .data(bytes): bytes
                case let .string(text): Data(text.utf8)
                @unknown default: throw URLError(.badServerResponse)
                }
                try await socket.emitReceiveSuccess(.data(fixture.response(to: data)))
            }, receiveHook: { socket, receiveIndex in
                if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                await fixture.attach(socket: socket)
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect",
                    capabilities: ["published-model-catalog"], scopes: scopes))
            })
        })
        return GatewayConnection(
            configProvider: { (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
    }
}

private enum QuickChatGuestCatalog: Equatable, Sendable {
    case permitted
    case noDefault
    case holding
    case failed
}

private actor QuickChatCatalogFixture {
    private var model = "current"
    private var fastMode: Bool?
    private var guestCatalog: QuickChatGuestCatalog?
    private weak var socket: GatewayTestWebSocketTask?
    private var sequence = 0
    private var heldReads: [CheckedContinuation<Void, Never>] = []
    private var onHeldRead: (@Sendable () -> Void)?
    private(set) var patches: [String] = []

    init(guestCatalog: QuickChatGuestCatalog? = nil) {
        self.guestCatalog = guestCatalog
        if guestCatalog != nil { self.model = "excluded" }
    }

    func attach(socket: GatewayTestWebSocketTask) {
        self.socket = socket
    }

    func prepareModelChange(
        _ mode: QuickChatGuestCatalog,
        onHeldRead: (@Sendable () -> Void)? = nil) throws -> @Sendable () -> Void
    {
        self.guestCatalog = mode
        self.onHeldRead = onHeldRead
        self.sequence += 1
        let socket = try XCTUnwrap(self.socket)
        let frame = Data(
            """
            {"type":"event","event":"chat.metadata.changed","payload":{"modelSelectionChanged":true},"seq":\(self.sequence)}
            """.utf8)
        return { socket.emitReceiveSuccess(.data(frame)) }
    }

    func releaseHeldCatalog() {
        self.guestCatalog = .failed
        let reads = self.heldReads
        self.heldReads.removeAll()
        reads.forEach { $0.resume() }
    }

    func response(to data: Data) async throws -> Data {
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let id = try XCTUnwrap(request["id"] as? String)
        let method = try XCTUnwrap(request["method"] as? String)
        let payload: String
        switch method {
        case "health": payload = "{}"
        case "agents.list":
            payload = #"{"defaultId":"main","mainKey":"main","scope":"per-sender","agents":[{"id":"main","kind":"agent","name":"Fixture"}]}"#
        case "models.list":
            let params = try XCTUnwrap(request["params"] as? [String: Any])
            XCTAssertEqual(params["sessionKey"] as? String, "agent:main:main")
            if self.guestCatalog == .holding {
                await withCheckedContinuation { continuation in
                    self.heldReads.append(continuation)
                    self.onHeldRead?()
                    self.onHeldRead = nil
                }
            }
            if self.guestCatalog == .failed {
                return Data(#"{"type":"res","id":"\#(id)","ok":false,"error":{"code":"UNAVAILABLE","message":"Fixture catalog unavailable"}}"#.utf8)
            }
            if let guestCatalog {
                let models: String
                let defaultModel: String
                switch guestCatalog {
                case .permitted:
                    models = #"[{"id":"primary","name":"Primary fixture","provider":"fixture"},{"id":"fallback","name":"Fallback fixture","provider":"fixture"},{"id":"custom","name":"Custom fixture","provider":"fixture"}]"#
                    defaultModel = #""fixture/primary""#
                case .noDefault:
                    models = #"[{"id":"custom","name":"Custom fixture","provider":"fixture"}]"#
                    defaultModel = "null"
                case .holding, .failed:
                    throw CancellationError()
                }
                payload = """
                {"models":\(models),"modelSelectionPolicy":{"restricted":true,"defaultModel":\(defaultModel)}}
                """
                break
            }
            payload = """
            {"models":[
              {"id":"current","name":"Current fixture","provider":"fixture","available":true,"manualSelectionAllowed":false,
               "thinkingLevels":[{"id":"low","label":"Brief"},{"id":"high","label":"Thorough"}],
               "thinkingDefault":"low","supportsFastMode":true,"effectiveFastMode":false},
              {"id":"allowed","name":"Allowed fixture","provider":"fixture","available":true,"manualSelectionAllowed":true,
               "thinkingLevels":[{"id":"low","label":"Brief"},{"id":"high","label":"Thorough"}],
               "thinkingDefault":"low","supportsFastMode":true,"effectiveFastMode":false},
              {"id":"locked","name":"Locked fixture","provider":"fixture","available":false,
               "unavailableReason":"missing-auth"},
              {"id":"unknown","name":"Unknown fixture","provider":"fixture"}
            ]}
            """
        case "sessions.list":
            let fast = self.fastMode.map { ",\"fastMode\":\($0),\"effectiveFastMode\":\($0)" } ?? ""
            payload = """
            {"sessions":[{"key":"agent:main:main","modelProvider":"fixture","model":"\(self.model)"\(fast)}]}
            """
        case "sessions.patch":
            let params = try XCTUnwrap(request["params"] as? [String: Any])
            XCTAssertEqual(params["key"] as? String, "agent:main:main")
            if let model = params["model"] as? String {
                let allowed = self.guestCatalog == nil ? ["fixture/allowed", "fixture/unknown"] : ["fixture/fallback"]
                XCTAssertTrue(allowed.contains(model))
                self.model = model
                self.patches.append("model=\(model)")
            } else if params["model"] is NSNull {
                self.patches.append("model=null")
                if let guestCatalog, guestCatalog != .permitted {
                    return Data(#"{"type":"res","id":"\#(id)","ok":false,"error":{"code":"FORBIDDEN","message":"No permitted default"}}"#.utf8)
                }
                self.model = self.guestCatalog == nil ? "current" : "primary"
            } else {
                let fast = try XCTUnwrap(params["fastMode"])
                XCTAssertTrue(fast is Bool || fast is NSNull)
                self.fastMode = fast as? Bool
                self.patches.append(self.fastMode.map { "fast=\($0)" } ?? "fast=null")
            }
            payload = #"{"ok":true,"key":"agent:main:main","entry":{}}"#
        default:
            throw NSError(
                domain: "QuickChatCatalogFixture", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Unexpected request: \(method)"])
        }
        return Data(#"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#.utf8)
    }
}

@MainActor
private final class QuickChatCatalogObservation {
    let condition: @MainActor () -> Bool
    let ready: XCTestExpectation
    private var stopped = false

    init(condition: @escaping @MainActor () -> Bool, ready: XCTestExpectation) {
        self.condition = condition
        self.ready = ready
    }

    func observe() {
        guard !self.stopped else { return }
        let satisfied = withObservationTracking { self.condition() } onChange: { [weak self] in
            Task { @MainActor in self?.observe() }
        }
        if satisfied {
            self.stopped = true
            self.ready.fulfill()
        }
    }

    func stop() {
        self.stopped = true
    }
}
