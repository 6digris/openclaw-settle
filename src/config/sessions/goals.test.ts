// Session goal tests cover persisted session goal state and transitions.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  acceptSessionEventStoreTestConfig,
  captureSessionEventStoreTestConfig,
} from "../../../test/helpers/infra/session-event-store.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../../infra/system-events.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { registerSessionStateWatch } from "../../sessions/session-state-watches.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  clearSessionGoal,
  createSessionGoal,
  formatSessionGoalStatus,
  getSessionGoal,
  resolveSessionGoalDisplayState,
  updateSessionGoalObjective,
  updateSessionGoalStatus,
} from "./goals.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore as upsertAccessorSessionEntry,
} from "./session-accessor.js";
import { resolveSystemEventStorePath } from "./session-store-path.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

// The goal APIs read/write session entries through the SQLite-backed accessor,
// so fixtures must seed and assert through the same accessor rather than the
// file-backed store helpers.
function getSessionEntry(params: {
  storePath: string;
  sessionKey: string;
}): SessionEntry | undefined {
  return loadSessionEntry(params);
}

async function upsertSessionEntry(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
}): Promise<void> {
  await upsertAccessorSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    params.entry,
  );
}

describe("session goals", () => {
  const fixture = useTempSessionsFixture("openclaw-session-goals-");
  const sessionKey = "agent:main:telegram:direct:123";

  async function writeSession(totalTokens = 0) {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        sessionId: "sess-1",
        updatedAt: 1,
        totalTokens,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    });
  }

  it("creates core-owned goal state on the session entry", async () => {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        ...getSessionEntry({ storePath: fixture.storePath(), sessionKey })!,
        totalTokens: 100,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    });

    const goal = await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "  land the PR \n",
      tokenBudget: 50,
      now: 10,
    });

    expect(goal.objective).toBe("land the PR");
    expect(goal.status).toBe("active");
    expect(goal.tokenStart).toBe(100);
    expect(goal.tokenStartFresh).toBe(true);
    expect(goal.tokenBudget).toBe(50);
    expect(getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.goal?.id).toBe(goal.id);
  });

  it("can create a goal from a fallback session entry", async () => {
    const goal = await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "native slash start",
      fallbackEntry: {
        sessionId: "sess-1",
        updatedAt: 1,
        totalTokens: 10,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
      now: 10,
    });

    expect(goal.tokenStart).toBe(10);
    expect(getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.goal?.objective).toBe(
      "native slash start",
    );
  });

  it("accounts usage from session token snapshots and enforces budget", async () => {
    await writeSession(100);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "finish task",
      tokenBudget: 20,
      now: 10,
    });
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        ...getSessionEntry({ storePath: fixture.storePath(), sessionKey })!,
        totalTokens: 125,
      },
    });

    const snapshot = await getSessionGoal({ storePath: fixture.storePath(), sessionKey, now: 20 });

    expect(snapshot.goal?.tokensUsed).toBe(25);
    expect(snapshot.goal?.status).toBe("budget_limited");
  });

  it("resumes budget-limited goals with a fresh budget window", async () => {
    await writeSession(100);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "finish task",
      tokenBudget: 20,
      now: 10,
    });
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        ...getSessionEntry({ storePath: fixture.storePath(), sessionKey })!,
        totalTokens: 125,
      },
    });
    await getSessionGoal({ storePath: fixture.storePath(), sessionKey, now: 20 });

    const resumed = await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "active",
      now: 30,
    });
    const snapshot = await getSessionGoal({ storePath: fixture.storePath(), sessionKey, now: 40 });

    expect(resumed.status).toBe("active");
    expect(resumed.tokenStart).toBe(125);
    expect(resumed.tokensUsed).toBe(0);
    expect(snapshot.goal?.status).toBe("active");
    expect(snapshot.goal?.tokensUsed).toBe(0);
  });

  it("ignores stale token snapshots for budget accounting", async () => {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        sessionId: "sess-1",
        updatedAt: 1,
        totalTokens: 100,
        totalTokensFresh: false,
      },
    });
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "finish task",
      tokenBudget: 20,
      now: 10,
    });
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        ...getSessionEntry({ storePath: fixture.storePath(), sessionKey })!,
        totalTokens: 125,
        totalTokensFresh: false,
      },
    });

    const snapshot = await getSessionGoal({ storePath: fixture.storePath(), sessionKey, now: 20 });

    expect(snapshot.goal?.tokenStart).toBe(0);
    expect(snapshot.goal?.tokenStartFresh).toBe(false);
    expect(snapshot.goal?.tokensUsed).toBe(0);
    expect(snapshot.goal?.status).toBe("active");
  });

  it("adopts the first fresh token snapshot as the baseline after stale goal creation", async () => {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        sessionId: "sess-1",
        updatedAt: 1,
        totalTokens: 100,
        totalTokensFresh: false,
      },
    });
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "finish task",
      tokenBudget: 20,
      now: 10,
    });
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        ...getSessionEntry({ storePath: fixture.storePath(), sessionKey })!,
        totalTokens: 125,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    });

    const snapshot = await getSessionGoal({ storePath: fixture.storePath(), sessionKey, now: 20 });

    expect(snapshot.goal?.tokenStart).toBe(125);
    expect(snapshot.goal?.tokenStartFresh).toBe(true);
    expect(snapshot.goal?.tokensUsed).toBe(0);
    expect(snapshot.goal?.status).toBe("active");
  });

  it("accounts token snapshots with current context provenance", async () => {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        sessionId: "sess-1",
        updatedAt: 1,
        totalTokens: 100,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    });
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "finish task",
      now: 10,
    });
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        ...getSessionEntry({ storePath: fixture.storePath(), sessionKey })!,
        totalTokens: 125,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    });

    const snapshot = await getSessionGoal({ storePath: fixture.storePath(), sessionKey, now: 20 });

    expect(snapshot.goal?.tokenStart).toBe(100);
    expect(snapshot.goal?.tokensUsed).toBe(25);
  });

  it("lets model tools complete or block but keeps existing terminal state", async () => {
    await writeSession(0);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "ship",
      now: 10,
    });

    const completed = await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "complete",
      note: "done",
      now: 20,
    });

    expect(completed.status).toBe("complete");
    expect(completed.lastStatusNote).toBe("done");
    const repeated = await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "complete",
      note: "verified",
      now: 30,
    });
    expect(repeated.completedAt).toBe(completed.completedAt);
    expect(repeated.lastStatusNote).toBe("verified");
    expect(getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.goal?.completedAt).toBe(
      completed.completedAt,
    );
    await expect(
      updateSessionGoalStatus({
        storePath: fixture.storePath(),
        sessionKey,
        status: "blocked",
        now: 30,
      }),
    ).rejects.toThrow(/already complete/);
  });

  it("lets users resume blocked goals", async () => {
    await writeSession(0);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "ship",
      now: 10,
    });

    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "blocked",
      note: "waiting on CI",
      now: 20,
    });
    const resumed = await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "active",
      now: 30,
    });

    expect(resumed.status).toBe("active");
    expect(resumed.lastStatusNote).toBe("waiting on CI");
  });

  it("resumes paused goals with a fresh budget window after usage passes the budget", async () => {
    await writeSession(0);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "ship",
      tokenBudget: 20,
      now: 10,
    });
    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "paused",
      now: 20,
    });
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        ...getSessionEntry({ storePath: fixture.storePath(), sessionKey })!,
        totalTokens: 100,
      },
    });

    const resumed = await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "active",
      now: 30,
    });

    expect(resumed.status).toBe("active");
    expect(resumed.tokenStart).toBe(100);
    expect(resumed.tokensUsed).toBe(0);
    expect(resumed.budgetLimitedAt).toBeUndefined();
  });

  it("formats a readable status summary with command hints", () => {
    const text = formatSessionGoalStatus({
      schemaVersion: 1,
      id: "goal-1",
      objective: "land the PR",
      status: "blocked",
      createdAt: 1,
      updatedAt: 2,
      tokenStart: 0,
      tokensUsed: 12_000,
      tokenBudget: 30_000,
      continuationTurns: 0,
      lastStatusNote: "waiting on review",
    });

    expect(text).toContain("Goal\nStatus: blocked\nObjective: land the PR");
    expect(text).toContain("Token budget: 12k/30k");
    expect(text).toContain("Commands: /goal resume, /goal edit <objective>, /goal clear");
  });

  it("rewords the objective without touching status or token accounting", async () => {
    await writeSession(100);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "ship the fix",
      tokenBudget: 50,
      now: 10,
    });

    const updated = await updateSessionGoalObjective({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "\tship the fix and update docs \n",
      now: 20,
    });

    expect(updated.objective).toBe("ship the fix and update docs");
    expect(updated.status).toBe("active");
    expect(updated.tokenStart).toBe(100);
    expect(updated.tokenBudget).toBe(50);
    expect(updated.updatedAt).toBe(20);
    expect(getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.goal?.objective).toBe(
      "ship the fix and update docs",
    );
  });

  it("rejects rewording terminal or missing goals", async () => {
    await writeSession(0);
    await expect(
      updateSessionGoalObjective({
        storePath: fixture.storePath(),
        sessionKey,
        objective: "anything",
        now: 10,
      }),
    ).rejects.toThrow(/goal not found/);

    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "ship",
      now: 10,
    });
    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "complete",
      now: 20,
    });

    await expect(
      updateSessionGoalObjective({
        storePath: fixture.storePath(),
        sessionKey,
        objective: "new target",
        now: 30,
      }),
    ).rejects.toThrow(/already complete/);
  });

  it("projects display state from fresh session tokens", () => {
    const goal = resolveSessionGoalDisplayState(
      {
        totalTokens: 140,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "finish",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 100,
          tokensUsed: 0,
          tokenBudget: 40,
          continuationTurns: 0,
        },
      },
      20,
    );

    expect(goal?.tokensUsed).toBe(40);
    expect(goal?.status).toBe("budget_limited");
  });

  it("can project without adopting a stale baseline for read-only displays", () => {
    const goal = resolveSessionGoalDisplayState(
      {
        totalTokens: 140,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "finish",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokenStartFresh: false,
          tokensUsed: 0,
          tokenBudget: 40,
          continuationTurns: 0,
        },
      },
      20,
      { adoptFreshBaseline: false },
    );

    expect(goal?.tokenStart).toBe(0);
    expect(goal?.tokenStartFresh).toBe(false);
    expect(goal?.tokensUsed).toBe(0);
    expect(goal?.status).toBe("active");
  });

  it("clears goal state", async () => {
    await writeSession(0);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "ship",
      now: 10,
    });

    await expect(clearSessionGoal({ storePath: fixture.storePath(), sessionKey })).resolves.toBe(
      true,
    );
    expect(getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.goal).toBeUndefined();
  });
});

describe("Goal watcher store admission", () => {
  it.each(
    (["create", "status", "objective", "clear"] as const).flatMap((operation) =>
      [false, true].map((replaceStore) => ({ operation, replaceStore })),
    ),
  )(
    "retains the parent store while $operation queues (replaced=$replaceStore)",
    async ({ operation, replaceStore }) => {
      await withOpenClawTestState(
        { label: "goal-watcher-store", layout: "state-only" },
        async (state) => {
          const restoreConfig = captureSessionEventStoreTestConfig();
          const originalDir = state.path("original");
          const replacementDir = state.path("replacement");
          const alias = state.path("parent-store");
          await fs.mkdir(originalDir);
          await fs.mkdir(replacementDir);
          await fs.symlink(originalDir, alias, process.platform === "win32" ? "junction" : "dir");
          const parentStore = path.join(alias, "sessions.json");
          const targetStore = state.path("target", "sessions.json");
          const parent = "agent:main:main";
          const target = "agent:main:forked-goal";
          const config = { session: { store: parentStore } };
          const entered = createDeferred();
          const release = createDeferred();
          let heldWriter: Promise<unknown> | undefined;
          let mutation: Promise<unknown> | undefined;
          try {
            acceptSessionEventStoreTestConfig(config);
            await upsertAccessorSessionEntry(
              { sessionKey: parent, storePath: parentStore },
              { sessionId: "original-parent", updatedAt: Date.now() },
            );
            await upsertAccessorSessionEntry(
              { sessionKey: target, storePath: targetStore },
              {
                sessionId: "goal-session",
                updatedAt: Date.now(),
                parentSessionKey: parent,
                ...(operation === "create"
                  ? {}
                  : {
                      goal: {
                        schemaVersion: 1 as const,
                        id: "existing-goal",
                        objective: "original objective",
                        status: "active" as const,
                        createdAt: 1,
                        updatedAt: 1,
                        tokenStart: 0,
                        tokensUsed: 0,
                        continuationTurns: 0,
                      },
                    }),
              },
            );
            if (replaceStore) {
              expect(
                registerSessionStateWatch({ watcherSessionKey: parent, targetSessionKey: target }),
              ).toBe(true);
            }
            const targetPath = expectDefined(
              resolveSystemEventStorePath({
                cfg: { session: { store: targetStore } },
                sessionKey: target,
              }),
              "physical target store",
            );
            heldWriter = runOpenClawAgentWriteAdmission(
              { agentId: "main", path: targetPath },
              async () => {
                entered.resolve();
                await release.promise;
              },
            );
            await entered.promise;
            const options = { sessionKey: target, storePath: targetStore, agentId: "main" };
            mutation =
              operation === "create"
                ? createSessionGoal({ ...options, objective: "new objective" })
                : operation === "status"
                  ? updateSessionGoalStatus({ ...options, status: "complete" })
                  : operation === "objective"
                    ? updateSessionGoalObjective({ ...options, objective: "new objective" })
                    : clearSessionGoal(options);
            if (replaceStore) {
              const replacementAlias = state.path("parent-store-next");
              await fs.symlink(
                replacementDir,
                replacementAlias,
                process.platform === "win32" ? "junction" : "dir",
              );
              await fs.rename(replacementAlias, alias);
              acceptSessionEventStoreTestConfig({ session: { store: parentStore } });
              await upsertAccessorSessionEntry(
                { sessionKey: parent, storePath: parentStore },
                { sessionId: "replacement-parent", updatedAt: Date.now() },
              );
              expect(
                registerSessionStateWatch({ watcherSessionKey: parent, targetSessionKey: target }),
              ).toBe(true);
            }
            const { db } = openOpenClawStateDatabase();
            const readWatch = () =>
              db
                .prepare(
                  "SELECT * FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?",
                )
                .get(parent, target);
            const watchBefore = readWatch();
            expect(peekSystemEventEntries(parent)).toEqual([]);
            release.resolve();
            await heldWriter;
            await mutation;

            expect(listSessionStateEventsSince(target, "main", 0).events).toMatchObject([
              { kind: "goal_changed" },
            ]);
            const goal = loadSessionEntry({ sessionKey: target, storePath: targetStore })?.goal;
            if (operation === "clear") {
              expect(goal).toBeUndefined();
            } else {
              expect(goal).toMatchObject(
                operation === "status" ? { status: "complete" } : { objective: "new objective" },
              );
            }
            if (replaceStore) {
              expect.soft(readWatch()).toEqual(watchBefore);
              expect(peekSystemEventEntries(parent)).toEqual([]);
            } else {
              expect(watchBefore).toBeUndefined();
              expect(peekSystemEventEntries(parent)).toHaveLength(1);
            }
          } finally {
            release.resolve();
            await Promise.allSettled([heldWriter, mutation]);
            resetSystemEventsForTest();
            restoreConfig();
          }
        },
      );
    },
  );
});
