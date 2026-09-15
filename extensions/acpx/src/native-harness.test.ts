import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createAcpxRuntimeService } from "../register.runtime.js";
import type { AcpRuntimeHandle } from "../runtime-api.js";
import type { runAcpxNativeAttempt } from "./native-attempt.js";
import type { AcpxNativeRuntime } from "./native-types.js";
import type { CompleteAcpRuntime } from "./runtime-proxy.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<typeof createAcpxRuntimeService>(),
  executable: vi.fn<() => { executable: string } | undefined>(),
  attempt: vi.fn<typeof runAcpxNativeAttempt>(),
}));

vi.mock("../register.runtime.js", () => ({ createAcpxRuntimeService: mocks.service }));
vi.mock("openclaw/plugin-sdk/node-host", () => ({
  resolveNodeHostExecutable: mocks.executable,
}));
vi.mock("./native-attempt.js", () => ({ runAcpxNativeAttempt: mocks.attempt }));

import plugin from "../index.js";

type RegisteredHarness = Parameters<OpenClawPluginApi["registerAgentHarness"]>[0];

const catalogInput = {
  config: {},
  agentId: "main",
  agentDir: "/test/agents/main",
  workspaceDir: "/test/workspace",
};
const deletionInput = {
  agentId: "main",
  sessionId: "openclaw-session",
  sessionKey: "agent:main:session",
  assertCurrent: vi.fn(),
};
const handle: AcpRuntimeHandle = {
  backend: "acpx",
  sessionKey: "catalog-session",
  runtimeSessionName: "catalog-session",
  backendSessionId: "native-backend-session",
};

function registerHarness() {
  const closeSession = vi.fn<AcpxNativeRuntime["closeSession"]>(async () => {});
  const getStatus = vi.fn<AcpxNativeRuntime["getStatus"]>(async () => ({
    models: { availableModelIds: ["vendor/model-a"] },
  }));
  const runtime: CompleteAcpRuntime = {
    ensureSession: vi.fn(async () => handle),
    startTurn() {
      throw new Error("Catalog must not start a turn");
    },
    async *runTurn() {},
    getCapabilities: vi.fn(async () => ({ controls: [] })),
    getStatus: vi.fn(async () => ({})),
    setMode: vi.fn(async () => {}),
    setConfigOption: vi.fn(async () => {}),
    doctor: vi.fn(async () => ({ ok: true, message: "ready" })),
    prepareFreshSession: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const withSession = vi.fn<AcpxNativeRuntime["withSession"]>(async (input, run) => {
    input.onSessionCreated?.(handle.backendSessionId);
    return run({ runtime, handle, getStatus: () => getStatus(handle) });
  });
  const outerGetStatus = vi.fn<AcpxNativeRuntime["getStatus"]>(async () => {
    throw new Error("Catalog status must use its own native session scope");
  });
  runtime.native = { withSession, getStatus: outerGetStatus, closeSession };
  const getRuntime = vi.fn(async () => runtime);
  mocks.service.mockReturnValue({
    id: "acpx-runtime",
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getRuntime,
  });
  const hostRuntime = createPluginRuntimeMock();
  hostRuntime.state.resolveStateDir = vi.fn(() => "/test/state");
  const cleanup = vi.mocked(hostRuntime.system.runCommandWithTimeout);
  cleanup.mockResolvedValue({
    pid: 1,
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  });
  const harnesses: RegisteredHarness[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  plugin.register(
    createTestPluginApi({
      pluginConfig: { piSessionCatalog: { enabled: false } },
      runtime: hostRuntime,
      logger,
      registerAgentHarness: (harness) => harnesses.push(harness),
    }),
  );
  const harness = harnesses.find((entry) => entry.id === "opencode");
  if (!harness?.loadModelCatalog || !harness.withSessionDeletion || !harness.dispose) {
    throw new Error("OpenCode must register catalog and session lifecycle operations");
  }
  return {
    harness,
    loadCatalog: harness.loadModelCatalog,
    deleteSession: harness.withSessionDeletion,
    dispose: harness.dispose,
    closeSession,
    getStatus,
    outerGetStatus,
    withSession,
    getRuntime,
    cleanup,
    hostRuntime,
    logger,
  };
}

function attemptInput(): AgentHarnessAttemptParamsV2 {
  return {
    ...deletionInput,
    workspaceDir: "/test/workspace",
    sessionFile: "/test/session.jsonl",
    prompt: "hello",
    runId: "run-1",
    provider: "vendor",
    modelId: "model-a",
    model: {
      id: "model-a",
      name: "Model A",
      provider: "vendor",
      api: "openai-responses",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    },
    timeoutMs: 1000,
    thinkLevel: "off",
    get authProfileStore() {
      throw new Error("Native dispatch must not read host auth profiles");
    },
    get authStorage() {
      throw new Error("Native dispatch must not read host credentials");
    },
    get modelRegistry() {
      throw new Error("Native dispatch must not read the host model registry");
    },
    get hostCapabilities() {
      throw new Error("Attempt implementation is isolated in this lifecycle test");
    },
  };
}

describe("registered OpenCode harness lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executable.mockReturnValue({ executable: "/test/bin/opencode" });
  });

  it("accepts CLI-owned authentication for an explicit native selection", () => {
    const { harness } = registerHarness();
    expect(
      harness.supports({
        requestedRuntime: "opencode",
        provider: "vendor",
        modelProvider: { preparedAuth: { source: "harness" }, requestTransportOverrides: "none" },
      }),
    ).toMatchObject({ supported: true });
  });

  it.each([
    { preparedAuth: { source: "profile" as const } },
    { preparedAuth: { source: "direct" as const } },
    { requestTransportOverrides: "present" as const },
    { endpointOverrides: "present" as const },
    { runtimePolicy: { compatibleIds: ["openclaw"] } },
  ])("rejects a native selection that would discard host route policy: %j", (modelProvider) => {
    const { harness } = registerHarness();
    expect(
      harness.supports({ requestedRuntime: "opencode", provider: "vendor", modelProvider }),
    ).toMatchObject({ supported: false });
  });

  it("discovers an installation on catalog refresh and removes its transient native session", async () => {
    mocks.executable.mockReturnValueOnce(undefined);
    const fixture = registerHarness();
    await expect(fixture.loadCatalog(catalogInput)).resolves.toEqual([]);
    expect(fixture.getRuntime).not.toHaveBeenCalled();

    await expect(fixture.loadCatalog(catalogInput)).resolves.toEqual([
      { provider: "vendor", id: "model-a", name: "vendor/model-a", nativeRuntime: "opencode" },
    ]);
    expect(fixture.withSession).toHaveBeenCalledWith(
      expect.objectContaining({ transient: true, command: ["/test/bin/opencode", "acp"] }),
      expect.any(Function),
    );
    expect(fixture.cleanup).toHaveBeenCalledWith(
      ["/test/bin/opencode", "session", "delete", "native-backend-session"],
      { timeoutMs: 30_000 },
    );
    expect(fixture.closeSession).not.toHaveBeenCalled();
    expect(fixture.getStatus).toHaveBeenCalledWith(handle);
    expect(fixture.outerGetStatus).not.toHaveBeenCalled();
    expect(fixture.hostRuntime.state.openKeyedStore).not.toHaveBeenCalled();
    await fixture.dispose();
    expect(fixture.closeSession).not.toHaveBeenCalled();
  });

  it("surfaces native catalog cleanup failures", async () => {
    const fixture = registerHarness();
    fixture.cleanup.mockResolvedValueOnce({
      pid: 1,
      stdout: "",
      stderr: "session deletion refused",
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });
    await expect(fixture.loadCatalog(catalogInput)).rejects.toThrow(
      "Native catalog cleanup failed",
    );
    expect(fixture.closeSession).not.toHaveBeenCalled();
  });

  it("cleans up a failed catalog without replacing its discovery error", async () => {
    const fixture = registerHarness();
    const failure = new Error("Native account unavailable");
    fixture.getStatus.mockRejectedValueOnce(failure);
    fixture.cleanup.mockRejectedValueOnce(new Error("Native session delete failed"));
    await expect(fixture.loadCatalog(catalogInput)).rejects.toBe(failure);
    expect(fixture.cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Native catalog cleanup also failed"),
    );
  });

  it.each(["reject", "rollback"] as const)(
    "preserves native sessions when authoritative deletion does not commit: %s",
    async (outcome) => {
      const fixture = registerHarness();
      const failure = new Error("Session transaction failed");
      const deletion = fixture.deleteSession(deletionInput, async (mutation) => {
        if (outcome === "rollback") {
          mutation.commit();
          mutation.rollback();
        }
        throw failure;
      });
      await expect(deletion).rejects.toBe(failure);
      expect(fixture.getRuntime).not.toHaveBeenCalled();
      expect(fixture.closeSession).not.toHaveBeenCalled();
    },
  );

  it("tears down a committed session even when later deletion work fails", async () => {
    const fixture = registerHarness();
    const failure = new Error("Transcript cleanup failed");
    await expect(
      fixture.deleteSession(deletionInput, async (mutation) => {
        mutation.commit();
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(deletionInput.assertCurrent).toHaveBeenCalled();
    expect(fixture.closeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "openclaw-session", agent: "opencode" }),
      deletionInput.assertCurrent,
      true,
    );
  });

  it("surfaces teardown failure after a successful deletion commit", async () => {
    const fixture = registerHarness();
    const failure = new Error("Native history deletion failed");
    fixture.closeSession.mockRejectedValueOnce(failure);
    await expect(
      fixture.deleteSession(deletionInput, async (mutation) => {
        mutation.commit();
        return "deleted";
      }),
    ).rejects.toBe(failure);
  });

  it("cancels tracked attempts and closes their processes without deleting native history on disposal", async () => {
    const fixture = registerHarness();
    const started = createDeferred<void>();
    const cancelled = createDeferred<void>();
    const cancel = vi.fn(() => cancelled.resolve());
    const attemptFinished = new Error("Attempt cancelled");
    mocks.attempt.mockImplementationOnce(async ({ input, active }) => {
      active.set(input.sessionId, cancel);
      started.resolve();
      await cancelled.promise;
      active.delete(input.sessionId);
      throw attemptFinished;
    });
    const attempt = fixture.harness.runAttempt(attemptInput());
    const rejection = expect(attempt).rejects.toBe(attemptFinished);
    await started.promise;
    await fixture.dispose();
    await rejection;
    expect(cancel).toHaveBeenCalled();
    expect(fixture.closeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "openclaw-session", agent: "opencode" }),
      expect.any(Function),
      false,
    );
    await expect(fixture.loadCatalog(catalogInput)).rejects.toThrow("runtime is closed");
  });
});
