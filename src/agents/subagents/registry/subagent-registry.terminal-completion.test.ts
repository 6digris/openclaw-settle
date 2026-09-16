import { afterEach, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { resetTaskRegistryMaintenanceRuntimeForTests } from "../../../tasks/task-registry.maintenance.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import {
  createSubagentRegistryTestDeps,
  readSubagentSessionStore,
  settleSubagentRegistryPersistenceWork,
  withSubagentRegistryPersistenceState,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry.store.sqlite.js";
import {
  getSubagentRunByChildSessionKey,
  registerSubagentRun,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";

const { announceSpy } = vi.hoisted(() => ({
  announceSpy: vi.fn(async (): Promise<"delivered"> => "delivered"),
}));
vi.mock("../announce/subagent-announce.js", () => ({ runSubagentAnnounceFlow: announceSpy }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("registerSubagentRun commits lifecycle and agent.wait equivalent completion once", async () => {
  const stateDir = tempDirs.make("openclaw-subagent-terminal-");
  await withSubagentRegistryPersistenceState(
    {
      stateDir,
      resetRegistry: () => resetSubagentRegistryForTests({ persist: false }),
      resetDeps: () => testing.setDepsForTest(),
      closeDatabases: () => {
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        resetTaskRegistryMaintenanceRuntimeForTests();
      },
    },
    async () => {
      resetTaskRegistryMaintenanceRuntimeForTests();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      testing.setDepsForTest({
        ...createSubagentRegistryTestDeps(),
        callGateway,
        persistSubagentRunsToDisk: saveSubagentRegistryToSqlite,
        runSubagentAnnounceFlow: announceSpy,
      });
      vi.mocked(onAgentEvent)
        .mockReset()
        .mockReturnValue(() => undefined);
      vi.mocked(callGateway).mockReset().mockResolvedValue({ status: "pending" });
      const runId = "run-terminal-once";
      const childSessionKey = "agent:main:subagent:terminal-once";
      const terminalReply = { disposition: "visible", text: "child result" } as const;
      const wait = createDeferred<Record<string, unknown>>();
      vi.mocked(callGateway).mockImplementationOnce(() => wait.promise);
      const generations = vi.spyOn(SubagentLifecycleController.prototype, "bumpTerminalGeneration");
      registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "capture terminal completion once",
        cleanup: "keep",
        expectsCompletionMessage: true,
      });
      const startedAt = getSubagentRunByChildSessionKey(childSessionKey)?.sessionStartedAt;
      if (startedAt === undefined) {
        throw new Error("registerSubagentRun did not record the session start");
      }
      const endedAt = startedAt + 500;
      const storePath = await writeSubagentSessionEntry({
        stateDir,
        agentId: "main",
        defaultSessionId: "session-terminal-once",
        sessionKey: childSessionKey,
        sessionId: "session-terminal-once",
        updatedAt: startedAt - 1,
      });
      const timingEntered = createDeferred();
      const releaseTiming = createDeferred();
      const committed = vi.fn();
      const patch = sessionAccessor.patchSessionEntryCore;
      // Hold the real SQLite updater before its commit guard; retain every scope and option.
      const timing = vi
        .spyOn(sessionAccessor, "patchSessionEntryCore")
        .mockImplementationOnce((scope, update, options) =>
          patch(
            scope,
            async (entry, context) => {
              const result = await update(entry, context);
              timingEntered.resolve();
              await releaseTiming.promise;
              return result;
            },
            {
              ...options,
              onCommitted: (entry) => {
                options?.onCommitted?.(entry);
                committed(entry);
              },
            },
          ),
        );
      try {
        const listeners = vi.mocked(onAgentEvent).mock.calls.map(([listener]) => listener);
        if (listeners.length === 0) {
          throw new Error("registerSubagentRun did not arm the lifecycle listener");
        }
        for (const listener of listeners) {
          listener({
            runId,
            stream: "lifecycle",
            seq: 1,
            ts: endedAt,
            sessionKey: childSessionKey,
            data: { phase: "end", startedAt, endedAt, terminalReply },
          });
        }
        await vi.waitFor(() => expect(timing).toHaveBeenCalledOnce(), { timeout: 5_000 });
        await timingEntered.promise;
        const controller = generations.mock.contexts[0];
        if (!(controller instanceof SubagentLifecycleController)) {
          throw new Error("lifecycle completion did not acquire terminal authority");
        }
        const warn = vi.spyOn(controller.options, "warn");
        const acquire = controller.acquireTerminalCompletionLock.bind(controller);
        let duplicateSettled = false;
        const lock = vi
          .spyOn(controller, "acquireTerminalCompletionLock")
          .mockImplementationOnce(async (id) => {
            const release = await acquire(id);
            return () => {
              release();
              duplicateSettled = true;
            };
          });
        try {
          wait.resolve({ status: "ok", startedAt, endedAt, terminalReply });
          await vi.waitFor(() => expect(duplicateSettled).toBe(true));
          releaseTiming.resolve();
          await settleSubagentRegistryPersistenceWork();
          expect.soft(generations).toHaveBeenCalledOnce();
          expect
            .soft(warn)
            .not.toHaveBeenCalledWith(
              "failed to persist subagent session timing",
              expect.anything(),
            );
          expect(committed).toHaveBeenCalledOnce();
          expect(timing).toHaveBeenCalledOnce();
          expect((await readSubagentSessionStore(storePath))[childSessionKey]).toMatchObject({
            startedAt,
            endedAt,
            runtimeMs: 500,
            status: "done",
          });
          expect(announceSpy).toHaveBeenCalledOnce();
        } finally {
          lock.mockRestore();
          warn.mockRestore();
        }
      } finally {
        wait.resolve({ status: "pending" });
        releaseTiming.resolve();
        await settleSubagentRegistryPersistenceWork();
        timing.mockRestore();
        generations.mockRestore();
      }
    },
  );
});
