import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SqliteWorkerAdmissionCleanup } from "../infra/sqlite-worker-broker.types.js";
import { isSqliteWorkerError, type SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import type { OpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "./openclaw-state-worker-contract.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";

type Store = SqliteWorkerStore<OpenClawStateWorkerOperations>;

const lifecycle = vi.hoisted(() => {
  const state: {
    available: boolean;
    pending: boolean;
    refuseCleanup: boolean;
    cleanupGate?: Promise<void>;
    actor?: object;
    resource?: OpenClawStateDatabaseAsyncResource;
  } = { available: true, pending: false, refuseCleanup: false };
  const forbidden = (): never => {
    throw new Error("Cleanup refusal proof crossed its synthetic worker boundary");
  };
  const cleanupError = new Error("synthetic cleanup remains pending");
  const close = vi.fn(async () => {
    await state.cleanupGate;
    if (state.refuseCleanup) {
      throw cleanupError;
    }
    state.pending = false;
  });
  const store: Store = { execute: forbidden, close };
  const open = vi.fn(
    async (
      _input: unknown,
      _context: unknown,
      _assertCurrent: unknown,
      options?: { retainCleanup?: (cleanup: SqliteWorkerAdmissionCleanup) => void },
    ) => {
      await Promise.resolve();
      state.pending = true;
      options?.retainCleanup?.({
        get pending() {
          return state.pending;
        },
        close,
      });
      return store;
    },
  );
  return { state, store, open, close, cleanupError, forbidden, warn: vi.fn() };
});

vi.mock("../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/shared-state.worker.js"),
}));
vi.mock("../infra/sqlite-worker-store.js", () => ({
  openSharedStateSqliteWorkerStore: lifecycle.open,
  closeUnclaimedSharedStateSqliteWorkers: lifecycle.close,
  hasUnclaimedSharedStateSqliteCleanup: () => lifecycle.state.pending,
  isSqliteWorkerStoreAvailable: () => lifecycle.state.available,
  getSqliteWorkerActorIdentity: () => lifecycle.state.actor,
  retireSqliteWorkerActor: lifecycle.close,
  runSqliteWorkerStoreOperation: <T>(store: Store, operation: (scope: Store) => Promise<T>) =>
    operation(store),
}));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: lifecycle.warn }),
}));
vi.mock("./openclaw-state-db-cache.js", () => ({
  publishOpenClawStateDatabaseWorkerAdmission: () => undefined,
  getOpenClawStateDatabaseTerminalFailureAsync: async () => undefined,
  registerOpenClawStateDatabaseAsyncResource: (resource: OpenClawStateDatabaseAsyncResource) => {
    lifecycle.state.resource = resource;
  },
  registerOpenClawStateDatabaseLifecycleListener: () => undefined,
}));
vi.mock("./openclaw-state-db-schema-policy.js", () => ({
  getExistingOpenClawStateSchemaPath: () => undefined,
  isExistingOpenClawStateSchema: () => false,
}));
vi.mock("./openclaw-state-lease-worker-owner.js", () => ({
  withOpenClawStateLeaseWorkerAdmission: lifecycle.forbidden,
}));

afterEach(async () => {
  lifecycle.state.refuseCleanup = false;
  await lifecycle.state.resource?.close();
  lifecycle.state.available = true;
  lifecycle.state.actor = undefined;
  vi.clearAllMocks();
});

it.each([
  { kind: "entry", timing: "after failure" },
  { kind: "actor", timing: "after failure" },
  { kind: "entry", timing: "during cleanup" },
  { kind: "actor", timing: "during cleanup" },
] as const)(
  "refuses new callbacks while $kind cleanup remains pending ($timing)",
  async ({ kind, timing }) => {
    lifecycle.state.actor = kind === "actor" ? {} : undefined;
    const cleanup = createDeferred();
    lifecycle.state.cleanupGate = timing === "during cleanup" ? cleanup.promise : undefined;
    const databasePath = `/synthetic/${kind}-${timing}.sqlite`;
    const context: OpenClawStateWorkerContext = {
      admission: {
        databasePath,
        identity: { key: databasePath, canonicalPath: databasePath },
        assertCurrent() {},
      },
      environment: { OPENCLAW_STATE_DIR: "/synthetic" },
      coordinatorRuntime: { directory: "/synthetic/locks", keepAlive: false },
    };
    const settled = vi.fn(async () => {
      lifecycle.state.available = false;
      lifecycle.state.refuseCleanup = true;
      return "settled-result";
    });
    try {
      await expect(runOpenClawStateWorkerOperation(context, settled)).resolves.toBe(
        "settled-result",
      );
      if (timing === "after failure") {
        await vi.waitFor(() => expect(lifecycle.warn).toHaveBeenCalledTimes(1));
      }
      const next = vi.fn(async () => "next-result");
      const waiting = runOpenClawStateWorkerOperation(context, next).catch(
        (error: unknown) => error,
      );
      if (timing === "during cleanup") {
        // Join the outstanding cleanup before releasing its synthetic failure.
        await nextTurn();
        expect(next).not.toHaveBeenCalled();
        cleanup.resolve();
      }
      const failure = await waiting;
      expect(next).not.toHaveBeenCalled();
      expect(isSqliteWorkerError(failure, "unavailable")).toBe(true);
      if (timing === "during cleanup" && failure instanceof Error) {
        expect(failure.cause).toBe(lifecycle.cleanupError);
      }
      expect(settled).toHaveBeenCalledTimes(1);
      expect(lifecycle.open).toHaveBeenCalledTimes(1);

      lifecycle.state.refuseCleanup = false;
      await lifecycle.state.resource?.close();
      lifecycle.state.available = true;
      await expect(runOpenClawStateWorkerOperation(context, next)).resolves.toBe("next-result");
      expect(next).toHaveBeenCalledTimes(1);
      expect(settled).toHaveBeenCalledTimes(1);
    } finally {
      cleanup.resolve();
      lifecycle.state.cleanupGate = undefined;
    }
  },
);
