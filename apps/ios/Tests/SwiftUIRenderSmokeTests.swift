import Observation
import OpenClawKit
import OpenClawProtocol
import SwiftUI
import Testing
import UIKit
@testable import OpenClaw
@testable import OpenClawChatUI

struct SwiftUIRenderSmokeTests {
    @MainActor @Observable
    fileprivate final class NativeChatPresentation {
        var binding: IOSNativeActionBinding?
    }

    private struct NativeChatHost: View {
        let presentation: NativeChatPresentation
        let presentationID: UUID?

        var body: some View {
            ChatProTab(
                nativeBinding: self.presentation.binding,
                nativePresentationID: self.presentationID)
        }
    }

    @MainActor private static func host(_ view: some View, size: CGSize? = nil) -> UIWindow {
        let frame = CGRect(origin: .zero, size: size ?? UIScreen.main.bounds.size)
        let window = UIWindow(frame: frame)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        window.rootViewController?.view.setNeedsLayout()
        window.rootViewController?.view.layoutIfNeeded()
        return window
    }

    @MainActor private static func hostNativeChat(
        _ view: some View,
        previousKeyWindow: inout UIWindow?) throws -> UIWindow
    {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }
        try #require(scenes.count == 1)
        let scene = try #require(scenes.first)
        previousKeyWindow = scene.windows.first { $0.isKeyWindow && !$0.isHidden }
        // A frame-only window has no scene and need not materialize its SwiftUI editor.
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        window.rootViewController?.view.setNeedsLayout()
        window.rootViewController?.view.layoutIfNeeded()
        return window
    }

    @MainActor private static func composer(
        in window: UIWindow,
        expectedText: String) async throws -> ChatComposerUITextView
    {
        let deadline = ContinuousClock.now + .seconds(2)
        repeat {
            var pending: [UIView] = [window]
            var inputs: [ChatComposerUITextView] = []
            var visited = 0
            while let view = pending.popLast() {
                visited += 1
                try #require(visited <= 512)
                if let input = view as? ChatComposerUITextView { inputs.append(input) }
                pending.append(contentsOf: view.subviews)
            }
            try #require(inputs.count <= 1)
            if let input = inputs.first, input.window === window,
               input.bounds.width > 0, input.bounds.height > 0,
               (input.text ?? "").utf8.elementsEqual(expectedText.utf8)
            {
                return input
            }
            try await Task.sleep(for: .milliseconds(10))
        } while ContinuousClock.now < deadline
        throw OpenClawNativeActionError("Native chat editor did not materialize its expected text")
    }

    @Test @MainActor func `settings hub fallback builds in light and dark mode`() {
        var windows: [UIWindow] = []
        defer { windows.forEach { $0.isHidden = true } }

        for scheme in [ColorScheme.light, ColorScheme.dark] {
            let appModel = NodeAppModel()
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let root = SettingsHubScreen(navigationPath: .constant([]))
                .environment(AppAppearanceModel())
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)
                .preferredColorScheme(scheme)

            windows.append(Self.host(root))
        }
    }

    @Test @MainActor func `settings About destination builds in light and dark mode`() {
        for scheme in [ColorScheme.light, ColorScheme.dark] {
            for typeSize in [DynamicTypeSize.large, .accessibility2] {
                let appModel = NodeAppModel()
                let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

                let root = NavigationStack {
                    SettingsProTab(directRoute: .about)
                }
                .environment(AppAppearanceModel())
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)
                .environment(\.dynamicTypeSize, typeSize)
                .preferredColorScheme(scheme)

                _ = Self.host(root, size: CGSize(width: 320, height: 852))
            }
        }
    }

    @Test @MainActor func `settings Licenses destination builds in light and dark mode`() {
        var windows: [UIWindow] = []
        defer { windows.forEach { $0.isHidden = true } }

        for scheme in [ColorScheme.light, ColorScheme.dark] {
            let appModel = NodeAppModel()
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let root = NavigationStack {
                SettingsProTab(directRoute: .licenses)
            }
            .environment(AppAppearanceModel())
            .environment(appModel)
            .environment(appModel.voiceWake)
            .environment(gatewayController)
            .preferredColorScheme(scheme)

            windows.append(Self.host(root, size: CGSize(width: 393, height: 852)))
        }
    }

    @Test @MainActor func `display math builds valid and fallback view hierarchies`() {
        for typeSize in [DynamicTypeSize.large, .accessibility2] {
            let root = VStack {
                ChatMarkdownRenderer(
                    text: #"Inline math \(E = mc^2\) stays inside prose."#,
                    context: .assistant,
                    variant: .standard,
                    textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: #"\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}"#,
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: #"\notARealCommand{"#,
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: "α + β = γ",
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: String(repeating: "{", count: 65) + "x",
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: String(repeating: #"\bar"#, count: 129) + "x",
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: #"x\textcolor{#fff}{}"#,
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
            }
            .environment(\.dynamicTypeSize, typeSize)

            _ = Self.host(root, size: CGSize(width: 393, height: 240))
        }
    }

    @Test @MainActor func `long user prompt disclosure builds across dynamic type sizes`() {
        let text = Array(repeating: "A long user-authored prompt line.", count: 13).joined(separator: "\n")
        let message = OpenClawChatMessage(
            role: "user",
            content: [OpenClawChatMessageContent(
                type: "text",
                text: text,
                mimeType: nil,
                fileName: nil,
                content: nil)],
            timestamp: nil)

        for typeSize in [DynamicTypeSize.large, .accessibility2] {
            let root = ChatMessageBubble(
                message: message,
                style: .standard,
                markdownVariant: .standard,
                userAccent: nil,
                displayOptions: [],
                assistantName: "OpenClaw",
                assistantAvatarText: "OC",
                assistantAvatarTint: nil,
                showsAssistantAvatar: true,
                isClean: false,
                contextWindowTokens: nil,
                userMessageExpanded: false,
                onToggleUserMessageExpanded: {},
                inlineWidgetResolverReady: true,
                inlineWidgetResourceResolver: { _, _ in nil },
                mediaArtifactResolverReady: false,
                mediaPlaybackAllowed: { true },
                loadMediaArtifact: { _, _, _ in nil })
                .environment(\.dynamicTypeSize, typeSize)

            _ = Self.host(root, size: CGSize(width: 320, height: 420))
        }
    }

    @Test @MainActor func `managed assistant image starts its artifact load`() async throws {
        let artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111"
        let message = OpenClawChatMessage(
            role: "assistant",
            content: [OpenClawChatMessageContent(
                type: "image",
                text: nil,
                mimeType: "image/png",
                fileName: nil,
                artifactId: artifactId,
                url: "/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full",
                alt: "Managed preview",
                content: nil)],
            timestamp: 1)
        var requestedArtifactId: String?
        let root = ChatMessageBubble(
            message: message,
            style: .standard,
            markdownVariant: .standard,
            userAccent: nil,
            displayOptions: [],
            assistantName: "OpenClaw",
            assistantAvatarText: "OC",
            assistantAvatarTint: nil,
            showsAssistantAvatar: true,
            isClean: false,
            contextWindowTokens: nil,
            userMessageExpanded: false,
            onToggleUserMessageExpanded: {},
            inlineWidgetResolverReady: true,
            inlineWidgetResourceResolver: { _, _ in nil },
            mediaArtifactResolverReady: true,
            mediaPlaybackAllowed: { true },
            loadMediaArtifact: { requested, kind, _ in
                requestedArtifactId = requested
                #expect(kind == .image)
                return OpenClawChatLoadedMedia.data(OpenClawChatMediaData(
                    data: Data(base64Encoded:
                        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8A" +
                            "AusB9Y9Zl1sAAAAASUVORK5CYII=")!,
                    mimeType: "image/png"))
            })
        let window = Self.host(root, size: CGSize(width: 393, height: 420))
        defer { window.isHidden = true }

        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while requestedArtifactId == nil, ContinuousClock().now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }

        #expect(requestedArtifactId == artifactId)
    }

    @Test(arguments: ["new-chat", "send", "reopen", "profile-reopen"])
    @MainActor func `native chat owns routing across activation and explicit reopen`(action: String) async throws {
        try await Self.nativeChatFixture(action: action)
    }

    @Test(arguments: ["pending", "reserved"])
    @MainActor func `native compose preserves dictation`(capturePhase: String) async throws {
        try await Self.nativeChatFixture(action: "dictation-\(capturePhase)")
    }

    @Test @MainActor func `unbound chat adopts a new session without native registration`() async throws {
        try await Self.nativeChatFixture(action: "unbound-new-chat")
    }

    @Test @MainActor func `retired native chat ignores late session creation and releases its router`() async throws {
        try await Self.nativeChatFixture(action: "retired-new-chat")
    }

    @MainActor private static func nativeChatFixture(action: String) async throws {
        weak var routerLifetime: NativeActionRouter?
        try await withUserDefaults([
            "talk.enabled": false, "talk.background.enabled": false, VoiceWakePreferences.enabledKey: false,
        ]) {
            let isDictation = action == "dictation-pending" || action == "dictation-reserved"
            let isUnbound = action == "unbound-new-chat"
            let retiresDuringCreate = action == "retired-new-chat"
            let session = OpenClawNativeSessionRef(
                owner: .init(gatewayID: "chat-activation-\(UUID().uuidString)", profileID: "profile-b"),
                agentID: "main",
                sessionKey: "agent:main:native-b")
            let expectedProfile = isUnbound ? nil : session.owner.profileID
            var createdProfiles: [String?] = []
            var createdKeys: [String] = []
            var beforeCreateResponse: (@MainActor () -> Void)?
            var sentParams: [[String: Any]] = []
            var issuedRunIDs: Set<String> = []
            var routingReads = 0
            var rpcCount = 0
            var phase = "setup"
            var callbackViolations: [String] = []
            var callbackViolationCount = 0
            weak var diagnosticAppModel: NodeAppModel?
            weak var diagnosticCreatingModel: OpenClawChatViewModel?
            weak var ordinaryReplacementModel: OpenClawChatViewModel?
            var hasObservedOrdinaryReplacement = false
            var hasObservedOrdinaryCommands = false
            var creatingAtResponse: Bool?
            @MainActor func modelFacts(_ model: OpenClawChatViewModel?) -> String {
                "present=\(model != nil),detached=\(model?.isTransportDetached == true)," +
                    "native=\((model?.transport as? IOSGatewayChatTransport)?.nativeBinding != nil)," +
                    "original=\(model?.sessionKey == session.sessionKey)," +
                    "created=\(model.map { createdKeys.contains($0.sessionKey) } == true)," +
                    "agent=\(model?.activeAgentId == session.agentID)"
            }
            @MainActor func observeCallback(
                _ condition: Bool,
                rule: String,
                method: String,
                profile: String? = nil,
                params: [String: Any] = [:])
            {
                guard !condition else { return }
                callbackViolationCount += 1
                guard callbackViolations.count < 16 else { return }
                let profileClass = profile == nil ? "nil" : (profile == expectedProfile ? "expected" : "other")
                let published = diagnosticAppModel?.presentedChatViewModel
                let same = diagnosticCreatingModel != nil && diagnosticCreatingModel === published
                let commandsShape = Set(params.keys) == ["scope", "includeArgs", "agentId"]
                let subscribeShape = Set(params.keys).isSubset(of: ["key", "agentId"]) && params["key"] is String
                // Record only fixed scalar facts at the callback, never a model,
                // request dictionary, raw key, profile ID, or a later-state closure.
                callbackViolations.append(
                    "action=\(action) method=\(method) phase=\(phase) rule=\(rule) profile=\(profileClass) " +
                        "commandsShape=\(commandsShape) text=\(params["scope"] as? String == "text") args=\(params["includeArgs"] as? Bool == true) " +
                        "subscribeShape=\(subscribeShape) keyOriginal=\(params["key"] as? String == session.sessionKey) " +
                        "keyCreated=\((params["key"] as? String).map { createdKeys.contains($0) } == true) agent=\(params["agentId"] as? String == session.agentID) " +
                        "sameModel=\(same) creating[\(modelFacts(diagnosticCreatingModel))] published[\(modelFacts(published))]")
            }
            let fixture = try await NativeGatewayWebSocketFixture.start(
                issuedDeviceTokens: [],
                hello: .init(
                    role: "operator",
                    scopes: ["operator.read", "operator.write"],
                    capabilities: [
                        GatewayServerCapability.profileBinding.rawValue,
                        GatewayServerCapability.chatSendRoutingContract.rawValue,
                        GatewayServerCapability.sessionSettingsCAS.rawValue,
                    ]),
                rpcHandler: { frame in
                    rpcCount += 1
                    guard let method = frame["method"] as? String else {
                        observeCallback(false, rule: "missing-method", method: "unknown")
                        return .failure(code: "INVALID_REQUEST", message: "Missing method")
                    }
                    let profile = frame["expectedProfileId"] as? String
                    let params = frame["params"] as? [String: Any] ?? [:]
                    let methodLabel: String = switch method {
                    case "users.self", "agents.list", "chat.history", "sessions.messages.subscribe", "health",
                         "sessions.list", "chat.send", "models.list", "commands.list", "chat.metadata", "tasks.list",
                         "sessions.create", "agent.wait": method
                    default: "unknown"
                    }
                    var ordinaryReplacementBootstrap = false
                    if retiresDuringCreate, frame["expectedProfileId"] == nil,
                       let appModel = diagnosticAppModel,
                       let creating = diagnosticCreatingModel,
                       let published = appModel.presentedChatViewModel,
                       !hasObservedOrdinaryReplacement || ordinaryReplacementModel === published,
                       creating !== published, creating.isTransportDetached, !published.isTransportDetached,
                       let creatingTransport = creating.transport as? IOSGatewayChatTransport,
                       let publishedTransport = published.transport as? IOSGatewayChatTransport,
                       let binding = creatingTransport.nativeBinding, binding.session == session,
                       publishedTransport.nativeBinding == nil,
                       creatingTransport.gateway === appModel.operatorSession,
                       publishedTransport.gateway === appModel.operatorSession,
                       creating.sessionKey.utf8.elementsEqual(session.sessionKey.utf8),
                       published.sessionKey.utf8.elementsEqual(session.sessionKey.utf8),
                       creating.activeAgentId?.utf8.elementsEqual(session.agentID.utf8) == true,
                       published.activeAgentId?.utf8.elementsEqual(session.agentID.utf8) == true
                    {
                        // Retiring the mounted native presentation can publish an ordinary
                        // replacement. Only its two initial read shapes may omit the profile;
                        // the detached native capture and every mutation remain pinned.
                        ordinaryReplacementBootstrap = switch method {
                        case "commands.list":
                            !hasObservedOrdinaryCommands && Set(params.keys) == ["scope", "includeArgs", "agentId"] &&
                                params["scope"] as? String == "text" && params["includeArgs"] as? Bool == true &&
                                (params["agentId"] as? String)?.utf8.elementsEqual(session.agentID.utf8) == true
                        case "sessions.messages.subscribe":
                            Set(params.keys) == ["key"] &&
                                (params["key"] as? String)?.utf8.elementsEqual(session.sessionKey.utf8) == true
                        default: false
                        }
                        if ordinaryReplacementBootstrap {
                            ordinaryReplacementModel = published
                            hasObservedOrdinaryReplacement = true
                            // The fixture returns a successful catalog and never requests a refresh.
                            // A duplicate unpinned command read must still fail the native oracle.
                            if method == "commands.list" { hasObservedOrdinaryCommands = true }
                        }
                    }
                    if method == "sessions.list", params["limit"] as? Int == 80 {
                        // This is the ordinary share-route refresh scheduled by agent selection.
                        observeCallback(
                            profile == nil,
                            rule: "share-profile",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                        observeCallback(
                            Set(params.keys) == ["limit", "includeGlobal", "includeUnknown", "agentId"],
                            rule: "share-shape",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                        observeCallback(
                            params["includeGlobal"] as? Bool == true,
                            rule: "share-global",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                        observeCallback(
                            params["includeUnknown"] as? Bool == false,
                            rule: "share-unknown",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                        observeCallback(
                            params["agentId"] as? String == session.agentID,
                            rule: "share-agent",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                    } else {
                        observeCallback(
                            profile == expectedProfile || ordinaryReplacementBootstrap,
                            rule: "selected-profile",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                    }
                    switch method {
                    case "users.self":
                        return .success(["profile": ["id": session.owner.profileID]])
                    case "agents.list":
                        routingReads += 1
                        return .success([
                            "defaultId": "main", "mainKey": "main", "scope": "per-sender",
                            "agents": [["id": "main"]],
                        ])
                    case "chat.history":
                        guard let key = params["sessionKey"] as? String else {
                            observeCallback(
                                false,
                                rule: "missing-history-key",
                                method: methodLabel,
                                profile: profile,
                                params: params)
                            return .failure(code: "INVALID_REQUEST", message: "Missing session key")
                        }
                        return .success([
                            "sessionKey": key, "messages": [],
                            "sessionInfo": [
                                "key": key, "agentId": session.agentID, "sessionId": "native-session",
                                "permissionMode": "guarded", "toolOverrides": [:],
                            ],
                        ])
                    case "sessions.messages.subscribe":
                        guard let key = params["key"] as? String else {
                            observeCallback(
                                false,
                                rule: "missing-subscribe-key",
                                method: methodLabel,
                                profile: profile,
                                params: params)
                            return .failure(code: "INVALID_REQUEST", message: "Missing session key")
                        }
                        return .success(["subscribed": true, "key": key])
                    case "health":
                        return .success(["ok": true])
                    case "sessions.list":
                        return .success(["ts": 0, "count": 1, "sessions": [[
                            "key": session.sessionKey, "agentId": session.agentID, "sessionId": "native-session",
                            "permissionMode": "guarded", "toolOverrides": [:],
                        ]]])
                    case "chat.send":
                        sentParams.append(params)
                        let runID = "native-run"
                        issuedRunIDs.insert(runID)
                        return .success(["runId": runID, "status": "ok"])
                    case "agent.wait":
                        // Run adoption may start a waiter before terminal-ACK reconciliation.
                        // Only this fixture's successfully issued runs have a completed result.
                        let valid = Set(params.keys) == ["runId", "timeoutMs"] &&
                            issuedRunIDs.contains(params["runId"] as? String ?? "") &&
                            (params["timeoutMs"] as? Int ?? 0) > 0
                        observeCallback(
                            valid,
                            rule: "issued-run-wait",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                        guard valid else { return .failure(code: "INVALID_REQUEST", message: "Invalid fixture wait") }
                        return .success(["status": "ok"])
                    case "models.list":
                        return .success(["models": []])
                    case "commands.list":
                        return .success(["commands": []])
                    case "chat.metadata":
                        return .success(["swarmEnabled": false])
                    case "tasks.list":
                        return .success(["tasks": []])
                    case "sessions.create":
                        createdProfiles.append(profile)
                        guard let key = params["key"] as? String else {
                            observeCallback(
                                false,
                                rule: "missing-create-key",
                                method: methodLabel,
                                profile: profile,
                                params: params)
                            return .failure(code: "INVALID_REQUEST", message: "Missing session key")
                        }
                        createdKeys.append(key)
                        beforeCreateResponse?()
                        beforeCreateResponse = nil
                        return .success(["ok": true, "key": key])
                    default:
                        observeCallback(
                            false,
                            rule: "unexpected-method",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                        return .failure(code: "INVALID_REQUEST", message: "Unexpected fixture method: \(method)")
                    }
                })
            let appModel = NodeAppModel(audioAdmissionInitiallyAllowed: isDictation)
            diagnosticAppModel = appModel
            let gateway = appModel.operatorSession
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let router = NativeActionRouter(appModel: appModel, gatewayController: gatewayController)
            routerLifetime = router
            let presentation = NativeChatPresentation()
            let presentationID = router
                .registerPresentation(onRetire: { presentation.binding = nil }) { request, binding, _ in
                    appModel.setSelectedAgentId(request.session.agentID)
                    appModel.focusChatSession(request.session.sessionKey)
                    presentation.binding = binding
                }
            var releaseRestore: CheckedContinuation<Void, Never>?
            var restoreReturned = false
            appModel.testChatSessionRoutingRestoreHandler = {
                await withCheckedContinuation { releaseRestore = $0 }
                restoreReturned = true
            }
            var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
            options.deviceAuthGatewayID = session.owner.gatewayID
            options.allowStoredDeviceAuth = false
            var window: UIWindow?
            var previousKeyWindow: UIWindow?
            let releaseWindow: () -> Void = {
                // Restore only while this fixture still owns key status. Teardown can
                // synchronously install a successor that must not be overridden.
                if let window, window.isKeyWindow, let scene = window.windowScene,
                   let previousKeyWindow, !previousKeyWindow.isHidden,
                   previousKeyWindow.windowScene === scene
                {
                    previousKeyWindow.makeKey()
                }
                window?.isHidden = true
                window?.rootViewController = nil
                window = nil
                previousKeyWindow = nil
            }
            let outcome: Result<Void, Error>
            do {
                defer {
                    phase = "cleanup"
                    releaseRestore?.resume()
                    releaseRestore = nil
                    appModel.testChatSessionRoutingRestoreHandler = nil
                    beforeCreateResponse = nil
                    releaseWindow()
                    router.unregisterPresentation(presentationID)
                    appModel.setOperatorConnected(false)
                    appModel.activeGatewayConnectConfig = nil
                    appModel.voiceWake.stop()
                }
                try await gateway.connect(
                    url: fixture.url(),
                    credentials: .init(),
                    connectOptions: options,
                    sessionBox: nil,
                    onConnected: {},
                    onDisconnected: { _ in },
                    onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
                appModel.activeGatewayConnectConfig = GatewayConnectConfig(
                    url: fixture.url(),
                    stableID: session.owner.gatewayID,
                    tls: nil,
                    token: nil,
                    bootstrapToken: nil,
                    password: nil,
                    nodeOptions: options)
                appModel.connectedGatewayID = session.owner.gatewayID
                appModel.setOperatorConnected(true)
                appModel.focusChatSession(session.sessionKey)
                window = try Self.hostNativeChat(
                    NativeChatHost(presentation: presentation, presentationID: isUnbound ? nil : presentationID)
                        .environment(appModel)
                        .environment(gatewayController)
                        .environment(router),
                    previousKeyWindow: &previousKeyWindow)
                let restoreDeadline = ContinuousClock.now + .seconds(2)
                while releaseRestore == nil, ContinuousClock.now < restoreDeadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                let release = try #require(releaseRestore)

                if !isUnbound {
                    phase = "opening"
                    let opening: OpenClawNativeOpenRequest = (action == "reopen" || action == "profile-reopen")
                        ? .compose(session, draft: "retained idle text") : .session(session)
                    #expect(await router.open(opening) == .opened)
                    #expect(presentation.binding?.session == session)
                } else {
                    #expect(presentation.binding == nil)
                }
                releaseRestore = nil
                release.resume()
                let releaseDeadline = ContinuousClock.now + .seconds(2)
                while !restoreReturned, ContinuousClock.now < releaseDeadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try #require(restoreReturned)
                phase = "presented"
                try #require(createdProfiles.isEmpty)
                #expect(restoreReturned)
                if action == "new-chat" || isUnbound || retiresDuringCreate {
                    let prepared: OpenClawNativePreparedSend? = if retiresDuringCreate {
                        try await router.prepareSend(to: session, message: "retired confirmation")
                    } else {
                        nil
                    }
                    let creatingModel = try #require(appModel.presentedChatViewModel)
                    diagnosticCreatingModel = creatingModel
                    if retiresDuringCreate {
                        beforeCreateResponse = {
                            creatingAtResponse = creatingModel.isCreatingSession
                            phase = "retiring"
                            // Retire while sessions.create is in flight, before the fixture sends its reply.
                            router.unregisterPresentation(presentationID)
                            releaseWindow()
                            phase = "retired"
                        }
                    }
                    // A's suspended restore cannot consume the native command.
                    phase = "creating"
                    appModel.requestNewChat()
                    let commandDeadline = ContinuousClock.now + .seconds(2)
                    while ContinuousClock.now < commandDeadline {
                        if retiresDuringCreate {
                            if !createdKeys.isEmpty, !creatingModel.isCreatingSession { break }
                        } else if appModel.chatSessionKey != session.sessionKey {
                            break
                        }
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    let createdKey = try #require(createdKeys.first)
                    #expect(createdProfiles == [expectedProfile])
                    if let prepared {
                        // The original owner's defer settles even when retirement suppresses
                        // bootstrap. A history request does not define create completion.
                        try #require(!creatingModel.isCreatingSession)
                        #expect(appModel.chatSessionKey == session.sessionKey)
                        await #expect(throws: Error.self) { try await prepared.submit() }
                        #expect(sentParams.isEmpty)
                    } else {
                        #expect(appModel.chatSessionKey == createdKey)
                    }
                } else if isDictation {
                    let reserved = action == "dictation-reserved"
                    let originalBinding = try #require(presentation.binding)
                    var releaseDictation: CheckedContinuation<Void, Never>?
                    let suspendDictation: @MainActor () async -> Void = {
                        await withCheckedContinuation { releaseDictation = $0 }
                    }
                    if reserved {
                        appModel.talkMode._test_setPTTReservedHandler(suspendDictation)
                    } else {
                        appModel.testTalkCapturePreparationHandler = suspendDictation
                    }
                    defer {
                        appModel.testTalkCapturePreparationHandler = nil
                        appModel.talkMode._test_setPTTReservedHandler(nil)
                    }
                    let transcription = Task { @MainActor in try await appModel.transcribeChatDraft() }
                    let verification: Result<Void, Error>
                    do {
                        let deadline = ContinuousClock.now + .seconds(2)
                        while releaseDictation == nil, ContinuousClock.now < deadline {
                            try await Task.sleep(for: .milliseconds(10))
                        }
                        try #require(releaseDictation != nil)
                        try #require(appModel.isChatDictationPending == !reserved)
                        try #require(appModel.isChatDictationActive == reserved)
                        let captureID = appModel.talkMode._test_activePushToTalkCaptureId()
                        #expect((captureID != nil) == reserved)
                        #expect(!appModel.talkMode._test_audioSessionIsActive())

                        #expect(await router.open(.compose(session, draft: nil)) == .opened)
                        let outcome = await router.open(.compose(session, draft: "must not join dictation"))
                        if case let .unavailable(reason) = outcome {
                            #expect(!reason.isEmpty)
                        } else {
                            Issue.record("Compose must reject a draft while dictation owns the composer")
                        }
                        #expect(presentation.binding?.canReuse(originalBinding) == true)
                        #expect(appModel.isChatDictationPending == !reserved)
                        #expect(appModel.isChatDictationActive == reserved)
                        #expect(appModel.talkMode._test_activePushToTalkCaptureId() == captureID)
                        #expect(!appModel.talkMode._test_audioSessionIsActive())
                        verification = .success(())
                    } catch {
                        verification = .failure(error)
                    }
                    // Both barriers precede permission/audio work. Cancel the owner
                    // before releasing either barrier, including on assertion failure.
                    transcription.cancel()
                    appModel.cancelChatDictation()
                    releaseDictation?.resume()
                    releaseDictation = nil
                    await #expect(throws: Error.self) { try await transcription.value }
                    try verification.get()
                    #expect(!appModel.isChatDictationPending)
                    #expect(!appModel.isChatDictationActive)
                    #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
                    #expect(await router.open(.compose(session, draft: "after dictation")) == .opened)
                    #expect(sentParams.isEmpty)
                    #expect(createdProfiles.isEmpty)
                } else {
                    if action == "reopen" || action == "profile-reopen" {
                        let oldBinding = try #require(presentation.binding)
                        let oldConfirmation = try await router.prepareSend(to: session, message: "old confirmation")
                        if action == "profile-reopen" {
                            let reused = try #require(presentation.binding)
                            #expect(reused !== oldBinding && oldBinding.canReuse(reused))
                            let input = try await Self.composer(
                                in: #require(window),
                                expectedText: "retained idle text")
                            phase = "retiring"
                            #expect(await oldBinding.accepts(EventFrame(
                                type: "event", event: "presence", payload: nil, recipientprofileid: "other-profile")) ==
                                false)
                            #expect(await reused.isCurrent() == false)
                            phase = "retired"
                            let countBeforeSync = rpcCount
                            #expect(input.text == "retained idle text")
                            let coordinator = try #require(input.delegate as? ChatComposerTextViewIOS.Coordinator)
                            // Change the actual editor binding. Its protected-composer observer
                            // must not turn a pre-retirement presentation into a fresh connection.
                            coordinator.parent.text = ""
                            let syncDeadline = ContinuousClock.now + .seconds(2)
                            while input.text != "", ContinuousClock.now < syncDeadline {
                                try await Task.sleep(for: .milliseconds(10))
                            }
                            try #require(input.text == "")
                            #expect(presentation.binding === reused)
                            #expect(await reused.isCurrent() == false)
                            #expect(rpcCount == countBeforeSync)
                        } else {
                            await gateway.disconnect()
                            try await gateway.connect(
                                url: fixture.url(), credentials: .init(), connectOptions: options, sessionBox: nil,
                                onConnected: {}, onDisconnected: { _ in },
                                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
                        }
                        let reopening: OpenClawNativeOpenRequest = action == "profile-reopen"
                            ? .compose(session, draft: "retained idle text") : .session(session)
                        phase = "reopening"
                        #expect(await router.open(reopening) == .opened)
                        #expect(presentation.binding !== oldBinding)
                        #expect((presentation.binding?.route == oldBinding.route) == (action == "profile-reopen"))
                        #expect(await oldBinding.isCurrent() == false)
                        let overwrite = await router.open(.compose(session, draft: "must not replace idle text"))
                        if case let .unavailable(reason) = overwrite {
                            #expect(reason.contains("current draft"))
                        } else {
                            Issue.record("Explicit reopen must preserve the original idle text")
                        }
                        await #expect(throws: Error.self) { try await oldConfirmation.submit() }
                        #expect(sentParams.isEmpty)
                    }
                    let prepared = try await router.prepareSend(to: session, message: "native submission")
                    let run = try await prepared.submit()
                    #expect(run.session == session)
                    #expect(run.runID == "native-run")
                    #expect(routingReads > 0)
                    let contract = try #require(presentation.binding?.sessionRoutingContract)
                    #expect(sentParams.count == 1)
                    #expect(sentParams.first?["expectedSessionRoutingContract"] as? String == contract)
                    #expect(sentParams.first?["expectedPermissionMode"] as? String == "guarded")
                    #expect(sentParams.first?["expectedToolOverrides"] as? [String: Bool] == [:])
                }
                outcome = .success(())
            } catch {
                outcome = .failure(error)
            }
            await gateway.disconnect()
            await fixture.stopAndWait()
            await appModel.purgeChatTranscriptCache(gatewayID: session.owner.gatewayID)
            // NW callbacks have no originating Swift Testing task. Assert after
            // admission closes and all retained reply writers join, even on body failure.
            #expect(
                callbackViolationCount == 0,
                "count=\(callbackViolationCount) overflow=\(callbackViolationCount > 16) \(callbackViolations.joined(separator: " | "))")
            if let creatingAtResponse { #expect(creatingAtResponse) }
            try outcome.get()
        }
        if action == "retired-new-chat" {
            // Hosting, registration, restore, and prepared-send references have left scope.
            let deadline = ContinuousClock.now + .seconds(2)
            while routerLifetime != nil, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(routerLifetime == nil)
        }
    }

    @Test @MainActor func `streaming assistant bubble builds mixed prose and code`() {
        let text = """
        Earlier prose stays visible.

        ```swift
        let answer = 42
        ```

        Trailing streamed words fade in.
        """

        let root = ChatStreamingAssistantBubble(
            text: text,
            markdownVariant: .standard,
            showsReasoning: false,
            assistantName: "OpenClaw",
            assistantAvatarText: "OC",
            assistantAvatarTint: nil,
            showsAssistantAvatar: true,
            isClean: false)

        _ = Self.host(root, size: CGSize(width: 393, height: 400))
    }

    @Test @MainActor func `assistant usage footer builds across dynamic type sizes`() throws {
        let usage = try JSONDecoder().decode(
            OpenClawChatUsage.self,
            from: Data(#"{"input":12000,"output":300,"cacheRead":438400,"cacheWrite":307000,"cost":{"total":0.0123}}"#
                .utf8))
        let message = OpenClawChatMessage(
            role: "assistant",
            content: [OpenClawChatMessageContent(
                type: "text",
                text: "A completed assistant response with per-run usage.",
                thinking: nil,
                thinkingSignature: nil,
                mimeType: nil,
                fileName: nil,
                content: nil,
                id: nil,
                name: nil,
                arguments: nil)],
            timestamp: nil,
            usage: usage)

        for typeSize in [DynamicTypeSize.large, .accessibility2] {
            let root = ChatMessageBubble(
                message: message,
                style: .standard,
                markdownVariant: .standard,
                userAccent: nil,
                displayOptions: [],
                assistantName: "OpenClaw",
                assistantAvatarText: "OC",
                assistantAvatarTint: nil,
                showsAssistantAvatar: true,
                isClean: false,
                contextWindowTokens: 1_000_000,
                userMessageExpanded: false,
                onToggleUserMessageExpanded: {},
                inlineWidgetResolverReady: true,
                inlineWidgetResourceResolver: { _, _ in nil },
                mediaArtifactResolverReady: false,
                mediaPlaybackAllowed: { true },
                loadMediaArtifact: { _, _, _ in nil })
                .environment(\.dynamicTypeSize, typeSize)

            _ = Self.host(root, size: CGSize(width: 320, height: 280))
        }
    }

    @Test @MainActor func `gateway trust prompt alert presents when prompt appears after initial render`() async {
        let appModel = NodeAppModel()
        let gatewayController = Self.gatewayControllerWithCapturedTLSFingerprint(appModel: appModel)
        let root = Color.clear
            .gatewayTrustPromptAlert()
            .environment(gatewayController)

        let window = Self.host(root)
        await Self.triggerGatewayTrustPrompt(controller: gatewayController)
        await Self.waitForPresentedAlert(in: window)

        #expect(window.rootViewController?.presentedViewController is UIAlertController)
    }

    @Test @MainActor func `exec approval dialog builds on compact screens with accessibility text`() throws {
        var windows: [UIWindow] = []
        defer { windows.forEach { $0.isHidden = true } }

        let layouts: [(CGSize, DynamicTypeSize)] = [
            (CGSize(width: 320, height: 568), .accessibility5),
            (CGSize(width: 568, height: 320), .accessibility3),
        ]
        for (size, typeSize) in layouts {
            let appModel = NodeAppModel()
            let prompt = try #require(NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-layout",
                commandText: String(repeating: "/usr/bin/find /private/var/mobile/Documents ", count: 12),
                warningText: String(
                    repeating: "This command can modify files outside the current workspace. ",
                    count: 12),
                allowedDecisions: ["allow-once", "allow-always", "deny"],
                host: "gateway.example.com",
                nodeId: "node-mobile",
                agentId: "main",
                expiresAtMs: Int64.max))
            appModel._test_presentExecApprovalPrompt(prompt)

            let root = Color.clear
                .execApprovalPromptDialog()
                .environment(appModel)
                .environment(\.dynamicTypeSize, typeSize)
            windows.append(Self.host(root, size: size))
        }
    }

    @Test @MainActor func `root prompt alert stack presents gateway trust prompt`() async {
        let appModel = NodeAppModel()
        let gatewayController = Self.gatewayControllerWithCapturedTLSFingerprint(appModel: appModel)
        let root = Color.clear
            .gatewayTrustPromptAlert()
            .deepLinkAgentPromptAlert()
            .environment(appModel)
            .environment(gatewayController)

        let window = Self.host(root)
        await Self.triggerGatewayTrustPrompt(controller: gatewayController)
        await Self.waitForPresentedAlert(in: window)

        #expect(window.rootViewController?.presentedViewController is UIAlertController)
    }

    @Test @MainActor func `root prompt alert stack still presents deep link prompt`() async throws {
        let appModel = NodeAppModel()
        appModel.gatewayConnected = true
        let gatewayController = Self.gatewayControllerWithCapturedTLSFingerprint(appModel: appModel)
        let root = Color.clear
            .gatewayTrustPromptAlert()
            .deepLinkAgentPromptAlert()
            .environment(appModel)
            .environment(gatewayController)

        let window = Self.host(root)
        let url = try #require(URL(string: "openclaw://agent?message=hello%20from%20deep%20link"))
        await appModel.handleDeepLink(url: url)
        await Self.waitForPresentedAlert(in: window)

        #expect(window.rootViewController?.presentedViewController is UIAlertController)
    }

    @MainActor private static func gatewayControllerWithCapturedTLSFingerprint(
        appModel: NodeAppModel)
        -> GatewayConnectionController
    {
        GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint("abc123") })
    }

    @MainActor private static func triggerGatewayTrustPrompt(controller: GatewayConnectionController) async {
        let host = "gateway-\(UUID().uuidString).example.com"
        let port = 18789
        let stableID = "manual|\(host.lowercased())|\(port)"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        GatewayTLSStore.clearFingerprint(stableID: stableID)
        await controller.connectManual(host: host, port: port, useTLS: true)
    }

    @MainActor private static func waitForPresentedAlert(in window: UIWindow) async {
        for _ in 0..<10 {
            if window.rootViewController?.presentedViewController != nil { return }
            await Task.yield()
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
    }
}
