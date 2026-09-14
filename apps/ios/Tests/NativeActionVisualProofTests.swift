import OpenClawChatUI
import OpenClawKit
import SwiftUI
import UIKit
import XCTest
@testable import OpenClaw

@MainActor
final class NativeActionVisualProofTests: XCTestCase {
    func testInspectionRetiresWhenSelectedAgentChanges() async throws {
        try await withUserDefaults([
            "talk.enabled": false, "talk.background.enabled": false, VoiceWakePreferences.enabledKey: false,
            "gateway.onboardingComplete": true, "gateway.hasConnectedOnce": true,
            "onboarding.quickSetupDismissed": true, "screen.preventSleep": false,
        ]) {
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            let controller = GatewayConnectionController(appModel: model, startDiscovery: false)
            let router = NativeActionRouter(appModel: model, gatewayController: controller)
            let gatewayID = "visual-fixture-\(UUID().uuidString)"
            let session = OpenClawNativeSessionRef(
                owner: .init(gatewayID: gatewayID, profileID: "demo-account"),
                agentID: "main", sessionKey: "global")
            let run = OpenClawNativeRunRef(session: session, runID: "visual-run-a")
            var sends = 0
            var inspectedRuns: [[String]] = []
            var historyTargets: Set<String> = []
            let fixture = try await NativeGatewayWebSocketFixture.start(
                issuedDeviceTokens: [],
                hello: .init(role: "operator", scopes: ["operator.read", "operator.write"], capabilities: [
                    GatewayServerCapability.profileBinding.rawValue,
                    GatewayServerCapability.chatSendRoutingContract.rawValue,
                    GatewayServerCapability.sessionSettingsCAS.rawValue,
                ]),
                rpcHandler: { request in
                    let method = request["method"] as? String ?? ""
                    let params = request["params"] as? [String: Any] ?? [:]
                    let profile = request["expectedProfileId"] as? String
                    // RootTabs also owns ordinary UI reads on this connection. Inspection's
                    // inputRunIds request below must still carry its exact account binding.
                    XCTAssertTrue(profile == nil || profile == session.owner.profileID)
                    switch method {
                    case "users.self":
                        XCTAssertEqual(profile, session.owner.profileID)
                        return .success(["profile": ["id": session.owner.profileID]])
                    case "agents.list":
                        return .success([
                            "defaultId": "main", "mainKey": "main", "scope": "per-sender",
                            "agents": [["id": "main", "name": "Main"], ["id": "research", "name": "Research"]],
                        ])
                    case "chat.history":
                        let key = params["sessionKey"] as? String ?? ""
                        let agent = params["agentId"] as? String ?? OpenClawChatSessionKey.agentID(from: key) ?? "main"
                        historyTargets.insert("\(agent)|\(key)")
                        if let runIDs = params["inputRunIds"] as? [String] {
                            XCTAssertEqual(profile, session.owner.profileID)
                            XCTAssertEqual(runIDs, [run.runID])
                            XCTAssertEqual(key, session.sessionKey)
                            XCTAssertEqual(agent, session.agentID)
                            inspectedRuns.append(runIDs)
                        }
                        return .success([
                            "sessionKey": key, "messages": [],
                            "sessionInfo": [
                                "key": key, "agentId": agent, "sessionId": "visual-session-\(agent)",
                                "permissionMode": "guarded", "toolOverrides": [:],
                                "activeRunIds": agent == "main" ? [run.runID] : [],
                            ],
                        ])
                    case "sessions.list":
                        return .success(["ts": 0, "count": 2, "sessions": ["main", "research"].map {
                            [
                                "key": "global",
                                "agentId": $0,
                                "displayName": "\($0.capitalized) conversation",
                                "permissionMode": "guarded",
                                "toolOverrides": [:],
                            ]
                        }])
                    case "sessions.messages.subscribe":
                        return .success(["subscribed": true, "key": params["key"] as? String ?? ""])
                    case "sessions.subscribe", "sessions.observer.visibility":
                        XCTAssertNil(profile)
                        return .success([:])
                    case "usage.cost":
                        XCTAssertNil(profile)
                        return .success(["daily": [], "totals": ["totalCost": 0]])
                    case "cron.list":
                        XCTAssertNil(profile)
                        return .success(["jobs": [], "total": 0, "hasMore": false])
                    case "health": return .success(["ok": true])
                    case "models.list": return .success(["models": []])
                    case "commands.list": return .success(["commands": []])
                    case "chat.metadata": return .success(["swarmEnabled": false])
                    case "tasks.list": return .success(["tasks": []])
                    case "chat.send":
                        sends += 1
                        XCTFail("Visual inspection must never send")
                        return .failure(code: "INVALID_REQUEST", message: "No send is permitted")
                    default:
                        XCTFail("Unexpected visual fixture method: \(method)")
                        return .failure(code: "INVALID_REQUEST", message: "Unexpected fixture method")
                    }
                })
            var window: UIWindow?
            let cleanup: () async -> Void = {
                window?.isHidden = true
                window?.rootViewController = nil
                window = nil
                await model.operatorSession.disconnect()
                fixture.stop()
                model.setOperatorConnected(false)
                model.activeGatewayConnectConfig = nil
                model.voiceWake.stop()
                await model.purgeChatTranscriptCache(gatewayID: gatewayID)
            }
            do {
                var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
                options.allowStoredDeviceAuth = false
                options.deviceAuthGatewayID = gatewayID
                try await model.operatorSession.connect(
                    url: fixture.url(), credentials: .init(), connectOptions: options, sessionBox: nil,
                    onConnected: {}, onDisconnected: { _ in }, onInvoke: { .init(id: $0.id, ok: true) })
                model.activeGatewayConnectConfig = GatewayConnectConfig(
                    url: fixture.url(), stableID: gatewayID, tls: nil, token: nil,
                    bootstrapToken: nil, password: nil, nodeOptions: options)
                model.connectedGatewayID = gatewayID
                model.gatewayServerName = "Demo Gateway"
                model.setOperatorConnected(true)
                let root = RootTabs(initialSidebarVisibility: false)
                    .environment(AppAppearanceModel())
                    .environment(model)
                    .environment(model.voiceWake)
                    .environment(controller)
                    .environment(router)
                    .environment(\.scenePhase, .active)
                    .environment(\.accessibilityReduceMotion, true)
                    .preferredColorScheme(.light)
                let hosting = UIHostingController(rootView: root)
                let ownedWindow = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
                window = ownedWindow
                ownedWindow.rootViewController = hosting
                ownedWindow.makeKeyAndVisible()
                hosting.view.layoutIfNeeded()
                // Open waits for RootTabs' real onAppear registration, after its initial
                // session adoption. No test presentation handler or demo mode is used.
                XCTAssertEqual(UIApplication.shared.applicationState, .active)
                let opened = await router.open(.session(session))
                XCTAssertEqual(opened, .opened)
                guard opened == .opened else { throw OpenClawNativeActionError("Visual chat did not open") }
                XCTAssertEqual(model.chatSessionKey, session.sessionKey)
                XCTAssertEqual(model.chatDeliveryAgentId, session.agentID)
                XCTAssertNil(hosting.presentedViewController)
                try self.attach(ownedWindow, name: "native-action-before-inspection")

                // This awaited call only returns after the actual Run sheet acknowledges
                // its exact presentation identity through onAppear.
                let inspection = try await router.inspect(run)
                XCTAssertEqual(inspection.run, run)
                XCTAssertEqual(inspection.summary, "Active.")
                try await self.waitUntil { hosting.presentedViewController?.view.window === ownedWindow }
                try self.attach(ownedWindow, name: "native-action-after-inspection")

                model.focusChatSession(.init(sessionKey: "global", agentID: "research"))
                try await self.waitUntil {
                    hosting.presentedViewController == nil && model.chatSessionKey == "global" &&
                        model.chatDeliveryAgentId == "research" && historyTargets.contains("research|global")
                }
                try self.attach(ownedWindow, name: "native-action-after-agent-change")
                XCTAssertEqual(inspectedRuns, [[run.runID]])
                XCTAssertEqual(sends, 0)
                await cleanup()
            } catch {
                await cleanup()
                throw error
            }
        }
    }

    private func waitUntil(_ ready: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !ready(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        guard ready() else { throw OpenClawNativeActionError("Native visual presentation did not settle") }
    }

    private func attach(_ window: UIWindow, name: String) throws {
        XCTAssertFalse(window.isHidden)
        window.layoutIfNeeded()
        var rendered = false
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            rendered = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        guard rendered else { throw OpenClawNativeActionError("Native window capture failed") }
        let attachment = XCTAttachment(image: image, quality: .original)
        attachment.name = name
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }
}
