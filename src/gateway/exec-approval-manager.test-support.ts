import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, vi, type TestContext } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import type { ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import type { ExecApprovalManagerOptions } from "./exec-approval-manager.types.js";
import * as operatorApprovalStore from "./operator-approval-store.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";

/** Vitest clocks are process-local; send controlled time through the store's existing input. */
export function installTestApprovalClock(): (() => void) | undefined {
  const forceDeny = operatorApprovalStore.forceDenyOperatorApproval;
  if (vi.isMockFunction(forceDeny)) {
    return undefined;
  }
  const spy = vi
    .spyOn(operatorApprovalStore, "forceDenyOperatorApproval")
    .mockImplementation((params) => {
      if (params.nowMs === undefined && (vi.isFakeTimers() || vi.isMockFunction(Date.now))) {
        return forceDeny({ ...params, nowMs: Date.now() });
      }
      return forceDeny(params);
    });
  return () => spy.mockRestore();
}

function createTestApprovalFixture<TPayload>(
  test: TestContext,
  options: Omit<ExecApprovalManagerOptions<TPayload>, "persistence">,
) {
  test.signal.throwIfAborted();
  const restoreClock = installTestApprovalClock();
  test.onTestFinished(() => restoreClock?.());
  const fixture = createFixtureLifetime();
  let manager: ExecApprovalManager<TPayload> | undefined;
  let databasePath: string | undefined = undefined;
  let body: Promise<unknown> | undefined;
  // Register on the actual test, never once through a cached helper module.
  test.onTestFinished(() => {
    void fixture.verifyCleanup(async () => {
      await manager?.drain();
      await Promise.allSettled([body]);
      if (databasePath) {
        await closeOpenClawStateDatabaseByPathAsync(databasePath);
      }
    });
    return fixture.cleanup();
  });
  const root = fixture.createTempDir("openclaw-test-approval-");
  databasePath = path.join(root, "state.sqlite");
  const databaseOptions = {
    path: databasePath,
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
  };
  // Schema setup precedes the request's existing deadline, as at Gateway startup.
  try {
    openOpenClawStateDatabase(databaseOptions);
    manager = new ExecApprovalManager<TPayload>({
      ...options,
      persistence: { runtimeEpoch: randomUUID(), databaseOptions },
    });
    return {
      manager,
      databaseOptions,
      run: <T>(callback: () => Promise<T>) => {
        const work = fixture.run(callback);
        body = work;
        return work;
      },
    };
  } catch (error) {
    // A failed open can include failed closure of an unpublished handle.
    // Retain its inputs rather than certify cleanup from an empty cache.
    void fixture.track(
      Promise.reject(new Error("Approval fixture initialization failed", { cause: error })),
      true,
    );
    throw error;
  }
}

/** Each manager owns a real store, including when two managers reuse an approval id. */
export function createTestApprovalManager<TPayload = ExecApprovalRequestPayload>(
  test: TestContext,
  options: Omit<ExecApprovalManagerOptions<TPayload>, "persistence"> = {},
): ExecApprovalManager<TPayload> {
  return createTestApprovalFixture(test, options).manager;
}

/** Join the RPC acceptance and decision before releasing its real persistence fixture. */
export async function withTestApprovalRequest<TPayload = ExecApprovalRequestPayload>(
  test: TestContext,
  options: Omit<ExecApprovalManagerOptions<TPayload>, "persistence">,
  createHandler: (manager: ExecApprovalManager<TPayload>) => GatewayRequestHandler | undefined,
  opts: GatewayRequestHandlerOptions,
  inspect: (approval: {
    manager: ExecApprovalManager<TPayload>;
    databaseOptions: OpenClawStateDatabaseOptions;
    approvalId: string;
    pending: Promise<void>;
  }) => void | Promise<void>,
): Promise<void> {
  const fixture = createTestApprovalFixture(test, options);
  const { manager, databaseOptions } = fixture;
  await fixture.run(async () => {
    const handler = createHandler(manager);
    if (!handler) {
      throw new Error(`${opts.req.method} request handler is unavailable`);
    }
    const firstResponse = createDeferredCore<Parameters<GatewayRequestHandlerOptions["respond"]>>();
    vi.mocked(opts.respond).mockImplementationOnce((...response) =>
      firstResponse.resolve(response),
    );
    const pending = Promise.resolve(handler(opts));
    try {
      const response = await Promise.race([
        firstResponse.promise,
        pending.then(() => {
          throw new Error("Approval request ended before acceptance");
        }),
      ]);
      expect(response[0]).toBe(true);
      expect(response[1]).toMatchObject({ status: "accepted", id: expect.any(String) });
      expect(response[2]).toBeUndefined();
      expect(opts.context.broadcast).toHaveBeenCalled();
      const approvalId = String(
        (vi.mocked(opts.context.broadcast).mock.calls[0]?.[1] as { id?: unknown } | undefined)?.id,
      );
      expect(response[1]).toMatchObject({ id: approvalId });
      await inspect({ manager, databaseOptions, approvalId, pending });
      await pending;
    } finally {
      await manager.drain();
      await Promise.allSettled([pending]);
    }
  });
}
