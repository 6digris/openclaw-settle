import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config.js";
import { createSessionEntryWithTranscript } from "./session-accessor.entry-mutation.js";
import { withSqliteSessionCommitContext } from "./session-accessor.sqlite-deletion.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import type { SessionEntryCommitContext } from "./session-accessor.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  resetConfigRuntimeState();
  const config = { session: { maintenance: { mode: "warn" as const } } };
  setRuntimeConfigSnapshot(config, config);
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("session-commit-continuation-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
});

function fixture(incognito = false, env = { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR }) {
  const database = openOpenClawAgentDatabase({
    agentId: "main",
    env,
    ...(incognito
      ? { path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }) }
      : {}),
  });
  return {
    database,
    scope: {
      agentId: "main",
      env,
      storePath: database.path,
      sessionKey: incognito
        ? "agent:main:dashboard:incognito-commit-continuation"
        : "agent:main:commit-continuation",
    },
    entry: {
      sessionId: "committed-session",
      updatedAt: 1,
      category: "Research",
      ...(incognito ? { incognito: true as const } : {}),
    },
  };
}

it.each(["create", "lifecycle", "replacement", "adoption"] as const)(
  "retains the %s writer after durable commit until continuation settlement",
  async (kind) => {
    const { database, scope, entry } = fixture();
    if (kind === "replacement" || kind === "adoption") {
      await applySessionEntryLifecycleMutation({
        ...scope,
        upserts: [{ sessionKey: scope.sessionKey, entry }],
        skipMaintenance: true,
      });
    }
    const entered = createDeferredCore<SessionEntryCommitContext>();
    const resume = createDeferredCore();
    const order: string[] = [];
    const notification = vi.fn(() => {
      expect(database.db.isTransaction).toBe(false);
      order.push("notification");
    });
    const unsubscribe = onSessionIdentityMutation((mutation) => {
      if (mutation.kind === "create" && mutation.current.sessionKeys.includes(scope.sessionKey)) {
        order.push("publication");
      }
    });
    const afterCommitted = async (context: SessionEntryCommitContext) => {
      expect(database.db.isTransaction).toBe(false);
      expect(loadSessionEntryReadOnly(scope)).toMatchObject(entry);
      context.assertCurrent();
      order.push("continuation");
      entered.resolve(context);
      await resume.promise;
      context.assertCurrent();
      order.push("registered");
    };
    const first =
      kind === "create"
        ? createSessionEntryWithTranscript(scope, () => ({ ok: true, entry }), {
            onLifecycleCommitted: notification,
            afterCommitted: async (committed, context) => {
              expect(committed).toEqual(entry);
              await afterCommitted(context);
            },
          })
        : kind === "lifecycle"
          ? applySessionEntryLifecycleMutation({
              ...scope,
              upserts: [{ sessionKey: scope.sessionKey, entry }],
              skipMaintenance: true,
              onLifecycleCommitted: notification,
              // Exercise the split prepare/source-custody path as well as ordinary writes.
              withCommit: async (run) => await run(() => {}),
              afterCommitted,
            })
          : applySessionEntryCanonicalReplacements({
              ...scope,
              sessionKeys: [scope.sessionKey],
              update: ([snapshot]) => ({
                result: "committed",
                replacements: [
                  {
                    sessionKey: scope.sessionKey,
                    previousSessionKeys: [],
                    // Same-row adoption still commits and runs the continuation.
                    entry:
                      kind === "adoption"
                        ? snapshot!.entry
                        : { ...snapshot!.entry, label: "Patched" },
                  },
                ],
              }),
              afterCommitted: async (result, context) => {
                expect(result).toBe("committed");
                await afterCommitted(context);
              },
            });
    void first.catch((error: unknown) => entered.reject(error));
    let clear: Promise<unknown> | undefined;
    try {
      const context = await entered.promise;
      clear = applySessionEntryCanonicalReplacements({
        ...scope,
        sessionKeys: [scope.sessionKey],
        update: ([snapshot]) => {
          order.push("clear-membership");
          return {
            result: undefined,
            replacements: [
              {
                sessionKey: scope.sessionKey,
                previousSessionKeys: [],
                entry: { ...snapshot!.entry, category: undefined },
              },
            ],
          };
        },
      });
      await nextTurn();
      expect(order).not.toContain("clear-membership");
      expect(loadSessionEntryReadOnly(scope)?.category).toBe("Research");
      resume.resolve();
      await first;
      await clear;
      expect(order.slice(-2)).toEqual(["registered", "clear-membership"]);
      expect(loadSessionEntryReadOnly(scope)?.category).toBeUndefined();
      expect(() => context.assertCurrent()).toThrow("no longer current");
      if (kind === "create" || kind === "lifecycle") {
        expect(notification).toHaveBeenCalledTimes(1);
        expect(order.slice(0, 3)).toEqual(["notification", "publication", "continuation"]);
      }
    } finally {
      resume.resolve();
      await Promise.allSettled([first, ...(clear ? [clear] : [])]);
      unsubscribe();
    }
  },
);

it("binds replacement continuation to the explicit storage environment", async () => {
  const stateDir = tempDirs.make("session-replacement-explicit-env-");
  const { scope, entry } = fixture(false, { OPENCLAW_STATE_DIR: stateDir });
  await applySessionEntryLifecycleMutation({
    ...scope,
    upserts: [{ sessionKey: scope.sessionKey, entry }],
    skipMaintenance: true,
  });
  await applySessionEntryCanonicalReplacements({
    ...scope,
    sessionKeys: [scope.sessionKey],
    update: ([snapshot]) => ({
      result: "patched",
      replacements: [
        {
          sessionKey: scope.sessionKey,
          previousSessionKeys: [],
          entry: { ...snapshot!.entry, label: "Patched" },
        },
      ],
    }),
    afterCommitted: async (result, context) => {
      expect(result).toBe("patched");
      expect(context.env.OPENCLAW_STATE_DIR).toBe(stateDir);
      context.assertCurrent();
    },
  });
  expect(loadSessionEntryReadOnly(scope)?.label).toBe("Patched");
});

it.each(["durable", "incognito", "maintenance"] as const)(
  "keeps the original %s native owner, captures its environment, and guards without SQL",
  async (kind) => {
    const maintenance =
      kind === "maintenance" ? createOpenClawDatabaseMaintenanceScope() : undefined;
    const run = async () => {
      const { database, scope, entry } = fixture(kind === "incognito");
      const originalRoot = scope.env.OPENCLAW_STATE_DIR;
      let retained: SessionEntryCommitContext | undefined;
      await applySessionEntryLifecycleMutation({
        ...scope,
        upserts: [{ sessionKey: scope.sessionKey, entry }],
        skipMaintenance: true,
        afterCommitted: async (context) => {
          retained = context;
          scope.env.OPENCLAW_STATE_DIR = "changed-after-commit";
          expect(context.env.OPENCLAW_STATE_DIR).toBe(originalRoot);
          const sql = observeHostDataSql(context.env);
          try {
            context.assertCurrent();
            await Promise.resolve();
            context.assertCurrent();
            expect(sql.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
          } finally {
            sql.restore();
            scope.env.OPENCLAW_STATE_DIR = originalRoot;
          }
          expect(database.db.isOpen).toBe(true);
        },
      });
      expect(retained).toBeDefined();
      expect(() => retained!.assertCurrent()).toThrow("no longer current");
    };
    try {
      await (maintenance ? maintenance.run(run) : run());
    } finally {
      await maintenance?.close();
    }
  },
);

it("revokes synchronously and joins an accepted continuation before physical close", async () => {
  const { database, scope, entry } = fixture();
  const entered = createDeferredCore<SessionEntryCommitContext>();
  const resume = createDeferredCore();
  const notification = vi.fn();
  const operation = applySessionEntryLifecycleMutation({
    ...scope,
    upserts: [{ sessionKey: scope.sessionKey, entry }],
    skipMaintenance: true,
    onLifecycleCommitted: notification,
    afterCommitted: async (context) => {
      entered.resolve(context);
      await resume.promise;
      expect(() => context.assertCurrent()).toThrow("no longer current");
      // Best-effort registration owns its refusal, not the already committed row.
    },
  });
  void operation.catch((error: unknown) => entered.reject(error));
  let closing: Promise<boolean> | undefined;
  try {
    const context = await entered.promise;
    let closed = false;
    closing = closeOpenClawAgentDatabaseByPathAsync(database.path, "main").then((result) => {
      closed = true;
      return result;
    });
    expect(() => context.assertCurrent()).toThrow("no longer current");
    await nextTurn();
    expect(closed).toBe(false);
    expect(database.db.isOpen).toBe(true);
    expect(notification).toHaveBeenCalledTimes(1);
    resume.resolve();
    await operation;
    await closing;
    expect(loadSessionEntryReadOnly(scope)).toMatchObject(entry);
  } finally {
    resume.resolve();
    await Promise.allSettled([operation, ...(closing ? [closing] : [])]);
  }
});

it("never blesses a recreated database with a retained commit context", async () => {
  const { database, scope, entry } = fixture();
  const entered = createDeferredCore<SessionEntryCommitContext>();
  const resume = createDeferredCore();
  const operation = applySessionEntryLifecycleMutation({
    ...scope,
    upserts: [{ sessionKey: scope.sessionKey, entry }],
    skipMaintenance: true,
    afterCommitted: async (context) => {
      entered.resolve(context);
      await resume.promise;
      expect(() => context.assertCurrent()).toThrow("no longer current");
    },
  });
  void operation.catch((error: unknown) => entered.reject(error));
  try {
    const context = await entered.promise;
    expect(closeOpenClawAgentDatabaseByPath(database.path, "main")).toBe(true);
    const replacement = openOpenClawAgentDatabase({
      agentId: "main",
      env: scope.env,
      path: database.path,
    });
    expect(replacement).not.toBe(database);
    expect(replacement.db.isOpen).toBe(true);
    expect(() => context.assertCurrent()).toThrow("no longer current");
    resume.resolve();
    await operation;
    expect(loadSessionEntryReadOnly(scope)).toMatchObject(entry);
  } finally {
    resume.resolve();
    await Promise.allSettled([operation]);
  }
});

it("does not acquire a successor owner if publication closes the committed database", async () => {
  const { database, scope, entry } = fixture();
  await applySessionEntryLifecycleMutation({
    ...scope,
    upserts: [{ sessionKey: scope.sessionKey, entry }],
    skipMaintenance: true,
    onLifecycleCommitted: () => {
      expect(closeOpenClawAgentDatabaseByPath(database.path, "main")).toBe(true);
    },
    afterCommitted: async (context) => {
      expect(() => context.assertCurrent()).toThrow("no longer current");
      await Promise.resolve();
      expect(() => context.assertCurrent()).toThrow("no longer current");
    },
  });
  const replacement = openOpenClawAgentDatabase({
    agentId: "main",
    env: scope.env,
    path: database.path,
  });
  expect(replacement).not.toBe(database);
  expect(loadSessionEntryReadOnly(scope)).toMatchObject(entry);
});

it.each(["create", "replacement"] as const)(
  "captures the %s storage environment before its builder yields",
  async (kind) => {
    const { scope, entry } = fixture();
    const originalRoot = process.env.OPENCLAW_STATE_DIR;
    const replacementRoot = tempDirs.make("session-commit-other-root-");
    const mutateEnvironment = async () => {
      vi.stubEnv("OPENCLAW_STATE_DIR", replacementRoot);
      scope.env.OPENCLAW_STATE_DIR = replacementRoot;
      await Promise.resolve();
    };
    const continuation = vi.fn(async (context: SessionEntryCommitContext) => {
      expect(context.env.OPENCLAW_STATE_DIR).toBe(originalRoot);
      context.assertCurrent();
    });
    try {
      if (kind === "create") {
        await createSessionEntryWithTranscript(
          scope,
          async () => {
            await mutateEnvironment();
            return { ok: true, entry };
          },
          { afterCommitted: async (_entry, context) => await continuation(context) },
        );
      } else {
        await applySessionEntryCanonicalReplacements({
          ...scope,
          sessionKeys: [scope.sessionKey],
          update: async () => {
            await mutateEnvironment();
            return {
              result: undefined,
              replacements: [{ sessionKey: scope.sessionKey, entry, previousSessionKeys: [] }],
            };
          },
          afterCommitted: async (_result, context) => await continuation(context),
        });
      }
      expect(continuation).toHaveBeenCalledTimes(1);
    } finally {
      vi.stubEnv("OPENCLAW_STATE_DIR", originalRoot);
      scope.env.OPENCLAW_STATE_DIR = originalRoot;
    }
    expect(loadSessionEntryReadOnly(scope)).toMatchObject(entry);
  },
);

it("adds no parent SQL merely to capture, guard, and release continuation custody", async () => {
  const { database, scope } = fixture();
  const sql = observeHostDataSql(scope.env);
  try {
    await withSqliteSessionCommitContext(database, scope.env, async (context) => {
      context.assertCurrent();
      await Promise.resolve();
      context.assertCurrent();
    });
    expect(sql.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  } finally {
    sql.restore();
  }
});

it("does not admit a continuation inside an uncommitted outer transaction", async () => {
  const { database, scope } = fixture();
  const continuation = vi.fn(async () => {});
  database.db.exec("BEGIN IMMEDIATE");
  try {
    await expect(withSqliteSessionCommitContext(database, scope.env, continuation)).rejects.toThrow(
      "requires an outer SQLite commit",
    );
    expect(continuation).not.toHaveBeenCalled();
    expect(database.db.isTransaction).toBe(true);
  } finally {
    database.db.exec("ROLLBACK");
  }
});

it("runs neither notification nor continuation after a rolled-back lifecycle transaction", async () => {
  const { scope, entry } = fixture();
  const notification = vi.fn();
  const continuation = vi.fn(async () => {});
  const failure = new Error("synthetic rollback");
  await expect(
    applySessionEntryLifecycleMutation({
      ...scope,
      upserts: [{ sessionKey: scope.sessionKey, entry }],
      skipMaintenance: true,
      afterUpsertsInTransaction: () => {
        throw failure;
      },
      onLifecycleCommitted: notification,
      afterCommitted: continuation,
    }),
  ).rejects.toBe(failure);
  expect(notification).not.toHaveBeenCalled();
  expect(continuation).not.toHaveBeenCalled();
  expect(loadSessionEntryReadOnly(scope)).toBeUndefined();
});

it.each(["no projection", "rejected commit"] as const)(
  "does not run a replacement continuation for %s",
  async (mode) => {
    const { scope, entry } = fixture();
    await applySessionEntryLifecycleMutation({
      ...scope,
      upserts: [{ sessionKey: scope.sessionKey, entry }],
      skipMaintenance: true,
    });
    const continuation = vi.fn(async () => {});
    const failure = new Error("synthetic commit denial");
    const operation = applySessionEntryCanonicalReplacements({
      ...scope,
      sessionKeys: [scope.sessionKey],
      assertCommitAllowed: () => {
        throw failure;
      },
      update: ([snapshot]) => ({
        result: "not committed",
        ...(mode === "rejected commit"
          ? {
              replacements: [
                {
                  sessionKey: scope.sessionKey,
                  previousSessionKeys: [],
                  entry: { ...snapshot!.entry, category: "Denied" },
                },
              ],
            }
          : {}),
      }),
      afterCommitted: continuation,
    });
    if (mode === "rejected commit") {
      await expect(operation).rejects.toBe(failure);
    } else {
      await expect(operation).resolves.toBe("not committed");
    }
    expect(continuation).not.toHaveBeenCalled();
    expect(loadSessionEntryReadOnly(scope)).toMatchObject(entry);
  },
);
