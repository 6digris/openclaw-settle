import { writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { expect, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createConfigIO } from "../config/io.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import type { GatewayRequestHandlerOptions } from "../plugin-sdk/core.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { startGatewayConfigReloader } from "./config-reload.js";
import { createChatRunState } from "./server-chat-state.js";
import type { GatewayServerLiveState } from "./server-live-state.js";
import type { createGatewayRequestContext } from "./server-request-context.js";

type GatewayRequestContextParams = Parameters<typeof createGatewayRequestContext>[0];
type TestCronState = GatewayServerLiveState["cronState"];
type RequestRuntime = GatewayRequestContextParams["runtime"];

export function makeCronState(overrides: Partial<TestCronState> = {}): TestCronState {
  return {
    cron: { start: vi.fn(), stop: vi.fn() } as never,
    storePath: "/tmp/cron",
    cronEnabled: true,
    reconcileExitWatchers: vi.fn(async () => {}),
    reconcileStreamWatchers: vi.fn(async () => {}),
    stopStreamWatchers: vi.fn(async () => {}),
    reconcileSystemJobs: vi.fn(async () => "converged" as const),
    ...overrides,
  };
}

export function makeContextParams(
  overrides: Partial<RequestRuntime> = {},
): GatewayRequestContextParams {
  const config = {} as never;
  return {
    runtime: {
      connectionWork: { track: trackAsyncWork },
      deps: {} as never,
      runtimeState: {
        cronState: makeCronState(),
        configReloader: { isConfigReloadSettled: vi.fn(() => true) },
      },
      lifecycle: { closePreludeStarted: false },
      getAttachedGatewayMethodRegistry: vi.fn(() => ({}) as never),
      gatewayTls: { enabled: false },
      sessionCompanion: {} as never,
      sessionObserver: { removeConnection: vi.fn() } as never,
      mentionInbox: undefined,
      transportBridge: {
        getPortalService: vi.fn(() => undefined),
        getMcpAppSandboxPort: vi.fn(() => undefined),
        ensureSandboxHostPort: vi.fn(async () => 18790),
      },
      terminalLaunchPolicy: {
        resolve: vi.fn(() => ({ ok: false as const, block: { kind: "disabled" as const } })),
        isEnabled: vi.fn(() => false),
      },
      execApprovalManager: undefined,
      questionManager: undefined,
      cancelRunBoundApprovals: undefined,
      forwardPluginApprovalRequest: undefined,
      approvalWebPushDelivery: undefined,
      pluginApprovalIosPushDelivery: undefined,
      pluginApprovalManager: undefined,
      placementStandingGrants: undefined,
      systemAgentApprovalManager: undefined,
      approvalSessionEvents: { replay: undefined },
      validateAgentRuntimeApprovalAuthority: () => false,
      loadGatewayModelCatalog: vi.fn(async () => []),
      loadGatewayModelCatalogSnapshot: vi.fn(async () => ({
        agentId: "main",
        agentDir: "/tmp/model-catalog-agent",
        catalogComplete: false,
        workspaceDir: "/tmp/model-catalog-workspace",
        config,
        entries: [],
        routeVariants: [],
      })),
      readPreparedGatewayModelCatalog: undefined,
      refreshGatewayHealthSnapshotWithRuntime: vi.fn(async () => ({}) as never),
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      nodeSendToSession: vi.fn(),
      nodeSendToAllSubscribed: vi.fn(),
      nodeSubscribe: vi.fn(),
      nodeUnsubscribe: vi.fn(),
      nodeUnsubscribeAll: vi.fn(),
      hasTalkNodeConnected: vi.fn(async () => false),
      clients: new Set(),
      isConnectionActive: vi.fn(() => false),
      watchNodeHttpRuntime: {
        invalidateSessionsForDevice: vi.fn(),
        disconnectSessionsForDevice: vi.fn(),
      },
      sharedGatewaySessionGenerationState: {} as never,
      resolveSharedGatewaySessionGenerationForRuntimeSnapshot: vi.fn(() => undefined),
      nodeRegistry: { invalidateConnectionForPairingChange: vi.fn() } as never,
      nodeDesktopService: undefined,
      workerEnvironmentService: undefined,
      hostDesktopService: undefined,
      workerEnvironmentStartup: undefined,
      workerPlacementRuntime: undefined,
      workerPlacementControlAvailable: undefined,
      githubPublicationService: undefined,
      terminalSessions: undefined,
      agentRunSeq: new Map(),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      chatRunState: createChatRunState(),
      addChatRun: vi.fn(),
      removeChatRun: vi.fn(),
      sessionEventSubscribers: {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        getAll: vi.fn(() => new Set<string>()),
      },
      subscribeSessionMessageEvents: vi.fn(),
      unsubscribeSessionMessageEvents: vi.fn(),
      sessionMessageSubscribers: { unsubscribeAll: vi.fn() },
      toolEventRecipients: { add: vi.fn() },
      dedupe: new Map(),
      wizardSessions: new Map(),
      systemAgentSessions: new Map(),
      findRunningWizard: vi.fn(() => null),
      purgeWizardSession: vi.fn(),
      getRuntimeSnapshot: vi.fn(() => ({}) as never),
      readinessEventLoopHealth: { snapshot: vi.fn(() => undefined) },
      startChannel: vi.fn(async () => new Map()),
      stopChannel: vi.fn(async () => undefined),
      markChannelLoggedOut: vi.fn(),
      wizardRunner: vi.fn(async () => undefined),
      channelWizardRunner: vi.fn(async () => undefined),
      broadcastVoiceWakeChanged: vi.fn(),
      broadcastVoiceWakeRoutingChanged: vi.fn(),
      kernel: {
        notifyPluginMetadataChanged: vi.fn(),
        applyPluginLifecycleChange: vi.fn(async () => ({
          operationId: "fixture",
          generation: 1,
          pluginIds: [],
        })),
        getConfigReloaderHotReloadStatus: vi.fn(() => undefined),
      },
      unavailableGatewayMethods: new Set(),
      ...overrides,
    },
    chatMetadataLifecycle: {
      read: vi.fn(async () => ({ swarmEnabled: false })),
      readStartup: undefined,
    },
    logHealth: { error: vi.fn() },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
    configRevisionProjector: {
      projectRawHash: (hash) => hash,
      projectResolvedHash: (hash) => hash,
    },
  };
}

/** A real config reader, watcher, and managed plugin registration for the SDK call. */
export async function createGatewayNotifierFixture(root: string) {
  const configPath = nodePath.join(root, "openclaw.json");
  await writeFile(configPath, JSON.stringify({ gateway: { reload: { mode: "hybrid" } } }));
  const io = createConfigIO({
    configPath,
    env: { HOME: root, OPENCLAW_STATE_DIR: root },
    homedir: () => root,
    observe: false,
    pluginValidation: "skip",
  });
  const snapshot = await io.readConfigFileSnapshot();
  expect(snapshot.valid).toBe(true);
  const onConfigCandidateObserved = vi.fn();
  const readSnapshot = vi.fn(() => io.readConfigFileSnapshot());
  const readPluginInstallRecords = vi.fn(async () => ({}));
  const onRestart = vi.fn();
  const onHotReload = vi.fn(async () => "applied" as const);
  const reloader = startGatewayConfigReloader({
    initialConfig: snapshot.config,
    initialCompareConfig: snapshot.sourceConfig,
    initialSnapshotRawHash: hashConfigRaw(snapshot.raw),
    initialAuthoredConfig: snapshot.parsed,
    initialSnapshotValid: snapshot.valid,
    initialSnapshotIssues: snapshot.issues,
    initialPluginInstallRecords: {},
    readPluginInstallRecords,
    readSnapshot,
    onConfigCandidateObserved,
    onNoopConfigCommit: async () => {},
    onHotReload,
    onRestart,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    watchPath: configPath,
    testDebounceMs: 0,
  });
  onTestFinished(() => reloader.stop());
  await reloader.ready;
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "shipped-notifier",
    source: "test",
    origin: "global",
    enabled: true,
    configSchema: true,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: snapshot.config });
  const instance = getPluginInstance(record);
  if (!instance) {
    throw new Error("expected managed plugin instance");
  }
  onTestFinished(async () => {
    await instance.dispose();
  });
  return {
    reloader,
    onRestart,
    onHotReload,
    onConfigCandidateObserved,
    readSnapshot,
    readPluginInstallRecords,
    api,
    registry: builder.registry,
    instance,
  };
}

/** Capture inside the real registered invocation, not from a host-side context read. */
export async function verifyRetainedGatewayNotifier(
  fixture: Awaited<ReturnType<typeof createGatewayNotifierFixture>>,
  context: GatewayRequestHandlerOptions["context"],
) {
  const {
    reloader,
    instance,
    api,
    registry,
    onRestart,
    onHotReload,
    onConfigCandidateObserved,
    readSnapshot,
    readPluginInstallRecords,
  } = fixture;
  const releaseDetachedRead = createDeferred();
  let retained: (() => void) | undefined;
  let detachedRead: Promise<void> | undefined;
  api.registerGatewayMethod("shipped-notifier.retained", ({ context: handlerContext, respond }) => {
    expect(handlerContext).toBe(context);
    retained = handlerContext.notifyPluginMetadataChanged;
    expect(handlerContext.notifyPluginMetadataChanged).toBe(retained);
    // This continuation keeps the invocation's async scope, but no active call lease.
    detachedRead = releaseDetachedRead.promise.then(() =>
      handlerContext.notifyPluginMetadataChanged(),
    );
    expect(retained()).toBeUndefined();
    respond(true);
  });
  const handler = registry.gatewayHandlers["shipped-notifier.retained"];
  if (!handler) {
    throw new Error("expected registered Gateway method");
  }
  await handler({
    req: { type: "req", id: "sdk-retained", method: "shipped-notifier.retained" },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    context,
    respond: vi.fn(),
  });
  if (!retained || !detachedRead) {
    throw new Error("expected callbacks captured by plugin handler");
  }
  // Accepted synchronous work transfers to the live reloader even when its notifier retires.
  expect(await instance.dispose()).toEqual({ errors: [] });
  await vi.waitFor(() => expect(onRestart).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(reloader.isReloading()).toBe(false));
  expect(reloader.isReady()).toBe(true);
  expect(reloader.hotReloadStatus()).toBe("active");
  onConfigCandidateObserved.mockClear();
  readSnapshot.mockClear();
  readPluginInstallRecords.mockClear();
  onRestart.mockClear();
  // Both copies must reject before observation, source reads, or restart scheduling.
  expect(retained).toThrow(/reloaded or disabled/i);
  const rejectedRead = expect(detachedRead).rejects.toThrow(/reloaded or disabled/i);
  releaseDetachedRead.resolve();
  await rejectedRead;
  expect(onConfigCandidateObserved).not.toHaveBeenCalled();
  expect(readSnapshot).not.toHaveBeenCalled();
  expect(readPluginInstallRecords).not.toHaveBeenCalled();
  expect(onRestart).not.toHaveBeenCalled();
  expect(onHotReload).not.toHaveBeenCalled();
  // Host access is still closure-bound to the original, live reloader.
  expect(context.notifyPluginMetadataChanged()).toBeUndefined();
  await vi.waitFor(() => expect(onRestart).toHaveBeenCalledOnce());
}

/** Retirement closes new callers while an admitted handler retains its exact lease. */
export async function verifyInflightGatewayNotifier(
  fixture: Awaited<ReturnType<typeof createGatewayNotifierFixture>>,
  context: GatewayRequestHandlerOptions["context"],
) {
  const entered = createDeferred();
  const release = createDeferred();
  let retained: (() => void) | undefined;
  fixture.api.registerGatewayMethod(
    "shipped-notifier.inflight",
    async ({ context: current, respond }) => {
      retained = current.notifyPluginMetadataChanged;
      entered.resolve();
      await release.promise;
      expect(retained()).toBeUndefined();
      expect(current.notifyPluginMetadataChanged()).toBeUndefined();
      respond(true);
    },
  );
  const handler = fixture.registry.gatewayHandlers["shipped-notifier.inflight"];
  if (!handler) {
    throw new Error("expected registered Gateway method");
  }
  const running = handler({
    req: { type: "req", id: "sdk-inflight", method: "shipped-notifier.inflight" },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    context,
    respond: vi.fn(),
  });
  await entered.promise;
  const stopping = fixture.instance.dispose();
  try {
    expect(fixture.instance.acceptingCalls).toBe(false);
    if (!retained) {
      throw new Error("expected notifier captured by active handler");
    }
    expect(retained).toThrow(/reloaded or disabled/i);
    release.resolve();
    await running;
    expect(await stopping).toEqual({ errors: [] });
    await vi.waitFor(() => expect(fixture.onRestart).toHaveBeenCalledOnce());
    expect(retained).toThrow(/reloaded or disabled/i);
    expect(fixture.onHotReload).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await running;
    await stopping;
  }
}

export function registerGatewayNotifierFixtureHandler(
  {
    api,
    registry,
  }: Pick<Awaited<ReturnType<typeof createGatewayNotifierFixture>>, "api" | "registry">,
  context: GatewayRequestHandlerOptions["context"],
) {
  api.registerGatewayMethod(
    "shipped-notifier.changed",
    ({ context: handlerContext, respond }: GatewayRequestHandlerOptions) => {
      const result: void = handlerContext.notifyPluginMetadataChanged();
      expect(result).toBeUndefined();
      respond(true, { notified: true });
    },
  );
  const handler = registry.gatewayHandlers["shipped-notifier.changed"];
  if (!handler) {
    throw new Error("expected registered Gateway method");
  }
  const request = {
    req: { type: "req" as const, id: "sdk-notify", method: "shipped-notifier.changed" },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    context,
    respond: vi.fn(),
  };
  return { handler, request };
}
