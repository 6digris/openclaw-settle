/** Real registry/SQLite lifetime shared by cancellation ownership regressions. */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, vi, type Mock } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../config/config.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import { resolveSessionStorePathForScope } from "../../../config/sessions/session-store-path.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { flushLogger, resetLogger } from "../../../logging/logger.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import { resetDetachedTaskLifecycleRuntimeForTests } from "../../../tasks/detached-task-runtime.test-support.js";
import { resetTaskFlowRegistryForTests } from "../../../tasks/task-flow-registry.test-support.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-registry.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { testing as schedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";

type ControlRuntime = typeof import("./subagent-control.runtime.js");

const { patchSessionEntryCore: patchCanonicalSessionEntry } = await vi.importActual<
  typeof import("../../../config/sessions/session-accessor.js")
>("../../../config/sessions/session-accessor.js");

export function resetSubagentControlRuntimeMocks(
  controlRuntimeMocks: {
    abortEmbeddedAgentRun: Mock<ControlRuntime["abortEmbeddedAgentRun"]>;
    isEmbeddedAgentRunActive: Mock<ControlRuntime["isEmbeddedAgentRunActive"]>;
    clearSessionQueues: Mock<ControlRuntime["clearSessionQueues"]>;
  },
  overrides: Partial<ControlRuntime> = {},
) {
  controlRuntimeMocks.abortEmbeddedAgentRun.mockReset();
  controlRuntimeMocks.isEmbeddedAgentRunActive.mockReset();
  controlRuntimeMocks.clearSessionQueues.mockReset();
  // Default to the canonical store; individual race tests replace only their fault boundary.
  vi.mocked(patchSessionEntryCore).mockReset();
  if (overrides.abortEmbeddedAgentRun) {
    controlRuntimeMocks.abortEmbeddedAgentRun.mockImplementation(overrides.abortEmbeddedAgentRun);
  }
  if (overrides.isEmbeddedAgentRunActive) {
    controlRuntimeMocks.isEmbeddedAgentRunActive.mockImplementation(
      overrides.isEmbeddedAgentRunActive,
    );
  }
  if (overrides.clearSessionQueues) {
    controlRuntimeMocks.clearSessionQueues.mockImplementation(overrides.clearSessionQueues);
  }
}

export function mockSessionPatchForStore(
  storePath: string,
  implementation: typeof patchSessionEntryCore,
) {
  // Registry timing writes use a different store; a fault must not fabricate entries there.
  vi.mocked(patchSessionEntryCore).mockImplementation((scope, patcher, options) =>
    scope.storePath === storePath
      ? implementation(scope, patcher, options)
      : patchCanonicalSessionEntry(scope, patcher, options),
  );
}

export function useSubagentControlRegistry() {
  beforeEach(() => {
    testing.setDepsForTest({
      cleanupBrowserSessionsForLifecycleEnd: async () => {},
      ensureContextEnginesInitialized: () => {},
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      persistSubagentRunsToDisk: () => {},
      persistSubagentRunsToDiskOrThrow: () => {},
      restoreSubagentRunsFromDisk: () => 0,
      resolveContextEngine: async () => ({
        info: { id: "test", name: "Test" },
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
        ingest: async () => ({ ingested: false }),
      }),
    });
  });
  afterEach(() => {
    testing.setDepsForTest();
  });
}

/** Capture the selected physical owner when a control fixture creates a run. */
export function createSubagentControlRunRecord(
  cfg: OpenClawConfig,
  overrides: SubagentRunRecordOverrides,
) {
  const entry = createSubagentRunRecord(overrides);
  const requesterAgentId = resolveSubagentRequesterAgentId(cfg, entry);
  const storeFor = (sessionKey: string) => {
    const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? requesterAgentId;
    return resolveSqliteTargetFromSessionStorePath(
      resolveSessionStorePathForScope({ sessionKey, agentId }, cfg),
      { agentId },
    ).path;
  };
  return {
    ...entry,
    requesterStorePath: storeFor(entry.requesterSessionKey),
    controllerStorePath: storeFor(entry.controllerSessionKey ?? entry.requesterSessionKey),
  };
}

export function addSubagentControlRunForTests(
  cfg: OpenClawConfig,
  overrides: SubagentRunRecordOverrides,
) {
  addSubagentRunForTests(createSubagentControlRunRecord(cfg, overrides));
}

export function useSubagentControlSessionStores() {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      await closeOpenClawAgentDatabasesAsync(tempRoot);
      cleanup();
    }),
  );
  const tempRoot = tempDirs.make("openclaw-subagent-control-");
  let tempStoreIndex = 0;
  const nextSessionStorePath = (label: string) => {
    tempStoreIndex += 1;
    return path.join(tempRoot, `${tempStoreIndex}-${label}.json`);
  };
  return {
    nextSessionStorePath,
    cfgWithSessionStore: (storePath = nextSessionStorePath("sessions")): OpenClawConfig => ({
      session: { store: storePath },
    }),
    writeSessionStoreFixture: async (storePath: string, store: Record<string, unknown>) => {
      for (const [sessionKey, entry] of Object.entries(store)) {
        const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
        const sessionId =
          typeof record.sessionId === "string" && record.sessionId.trim()
            ? record.sessionId
            : `sess-${sessionKey.replaceAll(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;
        await replaceSessionEntry({ storePath, sessionKey }, {
          ...record,
          sessionId,
        } as SessionEntry);
      }
      return storePath;
    },
  };
}

export function useSubagentControlFixture() {
  const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
  let stateDir = "";
  const persist = vi.fn(persistSubagentRunsToDiskOrThrow);
  const gateway = vi.fn(async (request: { method: string }) => {
    if (request.method !== "agent.wait") {
      throw new Error(`Unexpected registry RPC ${request.method}`);
    }
    return await new Promise<never>(() => {});
  });
  beforeEach(async () => {
    stateDir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "openclaw-ancestor-retirement-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { workspace: stateDir } } }),
    );
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    gateway.mockReset();
    persist.mockReset().mockImplementation(persistSubagentRunsToDiskOrThrow);
    testing.setDepsForTest({
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      resolveContextEngine: async () => new LegacyContextEngine(),
      callGateway: gateway,
      persistSubagentRunsToDiskOrThrow: persist,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await settleSubagentRegistryPersistenceWork();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    schedulerTesting.reset();
    resetDetachedTaskLifecycleRuntimeForTests();
    await cleanupSessionStateForTest({ stateDir });
    testing.setDepsForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await flushLogger();
    resetLogger();
    await rm(stateDir, { recursive: true, force: true });
    env.restore();
  });

  return {
    get stateDir() {
      return stateDir;
    },
    persist,
    gateway,
  };
}
