import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { buildActiveSubagentRuntimeContext } from "./subagent-active-context.js";
import { killSessionSubagentRuns, killSubagentRunAdmin } from "./subagent-control-kill.js";
import {
  buildControlledSubagentRunsReadContext,
  ensureSubagentControllerOwnsRun,
  getLatestOwnedSubagentRun,
  isCurrentSubagentRun,
} from "./subagent-control-scope.js";
import {
  createSubagentControlRunRecord,
  useSubagentControlFixture,
} from "./subagent-control.test-support.js";
import { buildSubagentList } from "./subagent-list.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import { listSubagentRunsForRequester } from "./subagent-registry-read.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import { addSubagentRunForTests } from "./subagent-registry.test-helpers.js";
import { createSubagentRunStoreScope } from "./subagent-session-read-scope.js";

const execution = vi.hoisted(() => ({
  abort: vi.fn(() => true),
  active: vi.fn(() => true),
  clear: vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
}));
vi.mock("./subagent-control.runtime.js", () => ({
  abortEmbeddedAgentRun: execution.abort,
  isEmbeddedAgentRunActive: execution.active,
  clearSessionQueues: execution.clear,
}));

const delivery = vi.hoisted(() => vi.fn());
vi.mock("../announce/subagent-announce-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../announce/subagent-announce-delivery.js")>()),
  deliverSubagentAnnouncement: delivery,
}));

describe("subagent physical-store generation scope", () => {
  const fixture = useSubagentControlFixture();
  const root = "agent:main:main";
  const other = "agent:main:other-controller";
  const child = "agent:main:subagent:reused-child";
  const leaf = "agent:main:subagent:reused-leaf";
  const store = (name: string) => path.join(fixture.stateDir, `${name}.sqlite`);
  const cfg = (name: string): OpenClawConfig => ({ session: { store: store(name) } });
  const add = (
    runId: string,
    storeName: string,
    generation: number,
    owner = root,
    childSessionKey = child,
    ended = false,
  ) => {
    const run = createSubagentRunRecord({
      runId,
      childSessionKey,
      requesterSessionKey: owner,
      controllerSessionKey: owner,
      requesterAgentId: "main",
      requesterStorePath: store(storeName),
      controllerStorePath: store(storeName),
      generation,
      createdAt: Date.now() - 10_000 + generation,
      execution: ended
        ? { status: "terminal", endedAt: Date.now() - 1_000 }
        : { status: "running", startedAt: Date.now() - 1_000 },
      ...(ended ? { cleanupCompletedAt: Date.now() } : {}),
    });
    addSubagentRunForTests(run);
    return run;
  };

  it("returns to A without B hiding its same-key children and descendants", () => {
    const original = add("original-parent", "a", 1);
    add("original-leaf", "a", 1, child, leaf);
    const replacement = add("replacement-parent", "b", 2);
    add("replacement-leaf", "b", 2, child, leaf, true);

    for (const [name, expected, pending] of [
      ["a", original, 1],
      ["b", replacement, 0],
      ["a", original, 1],
    ] as const) {
      const config = cfg(name);
      const context = buildControlledSubagentRunsReadContext(root, "main", config);
      expect.soft(context.runs.map((run) => run.runId)).toEqual([expected.runId]);
      expect.soft(context.countPendingDescendantRuns(child)).toBe(pending);
      expect.soft(context.countPendingDescendantRuns(root)).toBe(1 + pending);
      expect.soft(getLatestOwnedSubagentRun(child, "main", config)).toBe(expected);
      expect.soft(isCurrentSubagentRun(expected, config)).toBe(true);
      const prompt = buildActiveSubagentRuntimeContext({ cfg: config, controllerSessionKey: root });
      expect.soft(prompt).toContain(expected.task);
      const list = buildSubagentList({ cfg: config, runs: [expected], recentMinutes: 30 });
      expect
        .soft(list.active.map((run) => [run.runId, run.pendingDescendants]))
        .toEqual([[expected.runId, pending]]);
    }
  });

  it.each([false, true])(
    "retains the same-store latest-generation fence (ownership transferred=%s)",
    (transferred) => {
      const old = add("old-generation", "a", 1);
      const owner = transferred ? other : root;
      const latest = add("latest-generation", "a", 2, owner);
      add("unrelated-store-generation", "b", 3);
      const config = cfg("a");
      expect.soft(isCurrentSubagentRun(old, config)).toBe(false);
      expect.soft(getLatestOwnedSubagentRun(child, "main", config)).toBe(latest);
      expect.soft(isCurrentSubagentRun(latest, config)).toBe(true);
      expect
        .soft(buildControlledSubagentRunsReadContext(root, "main", config).runs)
        .toEqual(transferred ? [] : [latest]);
      expect
        .soft(buildControlledSubagentRunsReadContext(owner, "main", config).runs)
        .toEqual([latest]);
    },
  );

  it("keeps requester read access separate from a controller in another physical store", () => {
    const run = createSubagentRunRecord({
      runId: "split-store-owners",
      childSessionKey: child,
      requesterSessionKey: root,
      controllerSessionKey: root,
      requesterAgentId: "main",
      requesterStorePath: store("a"),
      controllerStorePath: store("b"),
    });
    addSubagentRunForTests(run);
    for (const name of ["a", "b"]) {
      expect(buildControlledSubagentRunsReadContext(root, "main", cfg(name)).runs).toEqual([run]);
    }
    const controller = { controllerSessionKey: root, controllerAgentId: "main" };
    expect(ensureSubagentControllerOwnsRun({ cfg: cfg("a"), controller, entry: run })).toBe(
      "Subagents can only control runs spawned from their own session.",
    );
    expect(
      ensureSubagentControllerOwnsRun({ cfg: cfg("b"), controller, entry: run }),
    ).toBeUndefined();
  });

  it("retains admin access to an unbound historical run without granting caller control", async () => {
    const run = createSubagentRunRecord({
      runId: "legacy-admin-history",
      childSessionKey: child,
      requesterSessionKey: root,
      controllerSessionKey: root,
      requesterStorePath: undefined,
      controllerStorePath: undefined,
      completion: { required: false },
      delivery: { status: "not_required" },
      execution: { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } },
    });
    addSubagentRunForTests(run);
    const config = cfg("a");
    expect(buildControlledSubagentRunsReadContext(root, "main", config).runs).toEqual([]);
    expect(
      ensureSubagentControllerOwnsRun({
        cfg: config,
        controller: { controllerSessionKey: root, controllerAgentId: "main" },
        entry: run,
      }),
    ).toBe("Subagents can only control runs spawned from their own session.");
    await expect(
      killSubagentRunAdmin({ cfg: config, sessionKey: child, expectedRunId: run.runId }),
    ).resolves.toMatchObject({ found: true, killed: false, runId: run.runId });
  });

  it.each([false, true])(
    "requires the requester-role store for lifecycle cleanup (requester matches=%s)",
    async (requesterMatches) => {
      execution.abort.mockClear();
      const run = createSubagentRunRecord({
        runId: "lifecycle-role-owner",
        childSessionKey: child,
        requesterSessionKey: root,
        requesterAgentId: "main",
        requesterStorePath: store(requesterMatches ? "a" : "b"),
        controllerSessionKey: other,
        controllerStorePath: store("a"),
        completion: { required: false },
        delivery: { status: "not_required" },
        createdAt: Date.now(),
        execution: { status: "running", startedAt: Date.now() },
      });
      addSubagentRunForTests(run);
      replaceSessionEntrySync(
        { sessionKey: child, storePath: store("a") },
        { sessionId: "lifecycle-child", updatedAt: Date.now() },
      );
      const result = await killSessionSubagentRuns({
        cfg: cfg("a"),
        sessionKey: root,
        agentId: "main",
      });
      expect.soft(result).toEqual({
        status: "ok",
        killed: requesterMatches ? 1 : 0,
        labels: requesterMatches ? [run.task] : [],
      });
      expect(execution.abort).toHaveBeenCalledTimes(requesterMatches ? 1 : 0);
      if (!requesterMatches) {
        expect(run.execution.endedAt).toBeUndefined();
      }
    },
  );

  it("keeps an admitted prompt store and its same-store ownership-transfer fence", () => {
    add("old-controller", "a", 1);
    const current = add("admitted-controller", "a", 2, other);
    add("different-store-controller", "b", 3);
    const read = (controllerSessionKey: string) =>
      buildActiveSubagentRuntimeContext({
        cfg: cfg("b"),
        controllerSessionKey,
        storePath: store("a"),
      });
    expect.soft(read(root)).toBeUndefined();
    expect(read(other)).toContain(current.task);
  });

  it("preserves a distinct child-agent store while the parent uses its admitted store", () => {
    const config: OpenClawConfig = {
      session: { store: path.join(fixture.stateDir, "configured-{agentId}.sqlite") },
    };
    const worker = "agent:worker:subagent:distinct-placement";
    const workerStore = path.join(fixture.stateDir, "configured-worker.sqlite");
    const parent = add("admitted-parent-worker", "a", 1, root, worker);
    replaceSessionEntrySync(
      { agentId: "worker", sessionKey: worker, storePath: workerStore },
      {
        sessionId: "worker-session",
        updatedAt: 1,
        modelProvider: "synthetic",
        model: "worker-model",
      },
    );
    const storeScope = createSubagentRunStoreScope(config, {
      sessionKey: root,
      agentId: "main",
      storePath: store("a"),
    });
    const list = buildSubagentList({
      cfg: config,
      runs: [parent],
      recentMinutes: 30,
      storeScope,
    });
    expect(list.active.map((entry) => [entry.runId, entry.model])).toEqual([
      [parent.runId, "synthetic/worker-model"],
    ]);
  });
  it.each([
    "foreign",
    "same-store",
    "distinct-agent",
    "newer-foreign",
    "split-foreign",
    "newer-split",
    "direct-newer-split",
    "inverse-split",
  ] as const)(
    "settles the requester using the complete physical descendant graph (%s)",
    async (placement) => {
      const configFor = (name: string): OpenClawConfig => ({
        session: { store: path.join(fixture.stateDir, `${name}-{agentId}.sqlite`) },
      });
      const original = configFor("a");
      const replacement = configFor("b");
      const worker = placement === "distinct-agent" ? "agent:worker:subagent:settled" : child;
      setRuntimeConfigSnapshot(original);
      const parent = createSubagentControlRunRecord(original, {
        runId: "settled-parent",
        childSessionKey: worker,
        requesterSessionKey: root,
        requesterAgentId: "main",
        createdAt: Date.now() - 3_000,
        execution: { status: "terminal", endedAt: Date.now() - 1_000 },
        cleanupCompletedAt: Date.now(),
        expectsCompletionMessage: true,
        completion: { required: true, resultText: "completed parent findings" },
        delivery: { status: "pending" },
        requesterSettleWake: { status: "pending", attemptCount: 0 },
      });
      addSubagentRunForTests(parent);
      setRuntimeConfigSnapshot(replacement);
      const currentScope = createSubagentRunStoreScope(original);
      const foreignScope = createSubagentRunStoreScope(replacement);
      const grandchild = {
        ...createSubagentControlRunRecord(
          placement === "foreign" || placement === "split-foreign" ? replacement : original,
          {
            runId: "live-grandchild",
            childSessionKey: leaf,
            requesterSessionKey: placement === "direct-newer-split" ? root : worker,
            requesterAgentId: placement === "distinct-agent" ? "worker" : "main",
            controllerSessionKey: worker,
            expectsCompletionMessage: true,
            generation: 1,
            createdAt: Date.now() - 2_000,
            execution: { status: "running", startedAt: Date.now() - 1_500 },
          },
        ),
        ...(placement === "split-foreign"
          ? {
              controllerSessionKey: other,
              controllerStorePath: currentScope.resolveStorePath(other, "main"),
            }
          : {}),
        ...(placement === "inverse-split"
          ? {
              controllerStorePath: foreignScope.resolveStorePath(worker, "main"),
            }
          : {}),
      };
      addSubagentRunForTests(grandchild);
      if (["newer-foreign", "newer-split", "direct-newer-split"].includes(placement)) {
        addSubagentRunForTests({
          ...createSubagentControlRunRecord(replacement, {
            ...grandchild,
            runId: "foreign-grandchild-successor",
            generation: 2,
            createdAt: Date.now(),
            execution: { status: "terminal", endedAt: Date.now() },
            cleanupCompletedAt: Date.now(),
          }),
          ...(placement !== "newer-foreign"
            ? {
                controllerSessionKey: other,
                controllerStorePath: currentScope.resolveStorePath(other, "main"),
              }
            : {}),
        });
      }
      setRuntimeConfigSnapshot(original);
      replaceSessionEntrySync(
        { sessionKey: root, storePath: parent.requesterStorePath },
        { sessionId: "requester-current", updatedAt: Date.now() },
      );
      expect(
        listSubagentRunsForRequester(root, {
          requesterAgentId: "main",
          requesterStorePath: parent.requesterStorePath,
        }),
      ).toContain(parent);
      delivery.mockReset().mockImplementation(async (params) => {
        expect(params.isSourceSessionEffectsAllowed()).toBe(true);
        return { delivered: true, path: "direct" };
      });
      const completeBatch = vi.fn();
      const transitionBatch = vi.fn((batch, state) => {
        for (const entry of batch) {
          entry.requesterSettleWake = state;
        }
      });
      const woke = await maybeWakeRequesterAfterAllChildrenSettled({
        requesterSessionKey: root,
        settledEntry: parent,
        transitionBatch,
        completeBatch,
      });
      const shouldWake = ["foreign", "split-foreign", "newer-split", "direct-newer-split"].includes(
        placement,
      );
      expect.soft(woke).toBe(shouldWake);
      expect.soft(delivery).toHaveBeenCalledTimes(shouldWake ? 1 : 0);
      expect.soft(completeBatch).toHaveBeenCalledTimes(shouldWake ? 1 : 0);
      const context = buildControlledSubagentRunsReadContext(root, "main", original);
      expect.soft(context.countPendingDescendantRuns(root)).toBe(shouldWake ? 0 : 1);
      const index = buildSubagentRunReadIndexFromRuns({
        runs: getSubagentRunsSnapshotForRead(subagentRuns),
        storeScope: currentScope,
        rootRequester: { sessionKey: root, agentId: "main", storePath: parent.requesterStorePath },
      });
      for (const replay of [
        index.atTime(Date.now()),
        buildSubagentRunReadIndexFromRuns({ ...index.inputs, now: Date.now() }),
      ]) {
        expect.soft(replay.countPendingDescendantRuns(root)).toBe(shouldWake ? 0 : 1);
        expect
          .soft(
            replay.latestRunsByControllerSessionKey
              .get(worker)
              ?.map((entry) => entry.childSessionKey) ?? [],
          )
          .toEqual(shouldWake || placement === "inverse-split" ? [] : [leaf]);
      }
      const yielded = createSubagentControlRunRecord(original, {
        ...parent,
        runId: "yielded-parent",
        generation: 2,
        pauseReason: "sessions_yield",
      });
      addSubagentRunForTests(yielded);
      const list = buildSubagentList({ cfg: original, runs: [yielded], recentMinutes: 30 });
      const item = [...list.active, ...list.recent].find((entry) => entry.runId === yielded.runId);
      expect.soft(item?.pendingDescendants).toBe(shouldWake ? 0 : 1);
      expect.soft(item?.execution.wait?.pendingCount ?? 0).toBe(shouldWake ? 0 : 1);
      expect(item?.childSessions ?? []).toEqual(
        shouldWake || placement === "inverse-split" ? [] : [leaf],
      );
    },
  );
});
