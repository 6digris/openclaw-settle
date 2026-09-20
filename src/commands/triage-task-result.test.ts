import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveInstallationTarget } from "../infra/installation-target-context.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { settleTriageRepairTask } from "./triage-task-result.js";

const mocks = vi.hoisted(() => ({
  reload: vi.fn(),
  list: vi.fn(),
  settle: vi.fn(),
  publish: vi.fn(),
  observe: vi.fn(),
}));
vi.mock("../tasks/runtime-internal.js", () => ({
  reloadTaskRuntimeStateFromStore: mocks.reload,
  listTaskRecords: mocks.list,
}));
vi.mock("../tasks/task-registry-mutation.js", () => ({
  publishTaskRecordUpdate: mocks.publish,
}));
vi.mock("../tasks/task-registry.store.js", () => {
  const store = { settleTriageTask: mocks.settle };
  return { getTaskRegistryStore: () => store };
});
vi.mock("../infra/triage-backing.js", () => ({ observeTriageBacking: mocks.observe }));
const dirs = useAutoCleanupTempDirTracker(afterEach);

describe("original parent exact task selection", () => {
  let root: string;
  beforeEach(() => {
    vi.resetAllMocks();
    root = dirs.make("triage-task-result-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    mocks.observe.mockReturnValue({ kind: "absent", reason: "missing-row" });
  });
  afterEach(() => vi.unstubAllEnvs());

  function task(taskId: string, runId = "generation"): TaskRecord {
    const taskScope = {
      taskId,
      runtime: "cli" as const,
      taskKind: "triage_repair",
      sourceId: runId,
      runId,
      scopeKind: "system" as const,
      ownerKey: "",
      requesterSessionKey: "",
    };
    return {
      ...taskScope,
      task: "Repair",
      status: "running",
      createdAt: 100,
      startedAt: 100,
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      detail: {
        kind: "triage_repair",
        version: 1,
        taskScope,
        executionStartedAt: 100,
        backing: { installationRoot: root, generation: { owner: runId } },
      },
    };
  }
  function run(isCurrent?: () => boolean) {
    return settleTriageRepairTask({
      taskId: "joined-task",
      root,
      target: resolveInstallationTarget(),
      signal: new AbortController().signal,
      isCurrent,
      outcome: {
        status: "completed",
        installationRoot: root,
        generationOwner: "generation",
        exitCode: 0,
        signal: null,
        commandOutput: { kind: "complete", stdout: "" },
      },
      repair: {
        status: "repaired",
        attempts: [],
        finalValidation: { ok: true, score: 0, summary: "Verified" },
      },
    });
  }

  it.each(["exact", "missing", "foreign-generation", "store-rejected"])(
    "selects only the joined task among same-run peers (%s)",
    async (mode) => {
      const peer = task("unrelated-peer");
      const joined = task("joined-task", mode === "foreign-generation" ? "other" : "generation");
      const records = mode === "missing" ? [peer] : [peer, joined];
      mocks.list.mockImplementation((predicate: (record: TaskRecord) => boolean) =>
        records.filter(predicate),
      );
      const settled = { ...joined, status: "succeeded" as const, endedAt: 200 };
      mocks.settle.mockImplementation(({ assertCurrent }: { assertCurrent: () => void }) => {
        assertCurrent();
        return mode === "store-rejected" ? null : settled;
      });
      await run();
      if (mode === "exact" || mode === "store-rejected") {
        expect(mocks.settle).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ expected: joined, status: "succeeded" }),
        );
      } else {
        expect(mocks.settle).not.toHaveBeenCalled();
      }
      if (mode === "exact") {
        expect(mocks.publish).toHaveBeenCalledExactlyOnceWith(joined, settled, true);
      } else {
        expect(mocks.publish).not.toHaveBeenCalled();
      }
      expect(peer.status).toBe("running");
    },
  );

  it("does not settle after authority closes during async reload", async () => {
    let current = true;
    mocks.reload.mockImplementation(async () => {
      current = false;
    });
    await run(() => current);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
