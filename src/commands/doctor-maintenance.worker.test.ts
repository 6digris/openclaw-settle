import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureCoordinatorDatabase } from "../infra/sqlite-coordinator.test-support.js";
import * as coordinatorDelegate from "../infra/state-database-coordinator-delegate.js";
import * as stateCoordinator from "../infra/state-database-coordinator.js";
import type { ManagedTaskFlowRecord } from "../plugins/runtime/runtime-taskflow.types.js";
import { createRuntimeAsyncTasks } from "../plugins/runtime/runtime-tasks-async.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { resetTaskFlowRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const coordinatorLoader = new URL("../../scripts/tsx.mjs", import.meta.url).href;
const coordinatorModule = new URL("../infra/sqlite-coordinator.ts", import.meta.url).href;

function acquireCoordinatorFromPeer(pathname: string): string {
  // A same-process open/close can drop POSIX locks held by another SQLite handle.
  const script = `
    import { tryAcquireExclusiveSqliteCoordinator } from ${JSON.stringify(coordinatorModule)};
    const lease = tryAcquireExclusiveSqliteCoordinator(process.argv[1]);
    process.stdout.write(lease ? "held" : "blocked");
    lease?.release();
  `;
  return execFileSync(
    process.execPath,
    ["--import", coordinatorLoader, "--input-type=module", "-e", script, pathname],
    { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetTaskFlowRegistryForTests({ persist: false });
});

describe("Doctor maintenance with managed-flow workers", () => {
  it("drains a capture interval and admits forward repair without releasing physical custody", async () => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "doctor-resource-interval" },
      async () => {
        const maintenance = await beginDoctorMaintenance({
          options: { repair: true, nonInteractive: true },
          root: null,
          runtime: { log() {}, error() {}, exit() {} },
        });
        const flows = createRuntimeAsyncTasks().managedFlows.bindSession({
          sessionKey: "agent:main:doctor-interval",
        });
        const coordinatorPath = stateCoordinator.resolveStateDatabaseCoordinatorPath({
          databasePath: resolveOpenClawStateSqlitePath(),
          runtimeDirectory: stateCoordinator.resolveStateLifecycleRuntimeDirectory(),
          uid: typeof process.getuid === "function" ? process.getuid() : undefined,
        });
        try {
          await maintenance!.run(() =>
            flows.createManaged({ controllerId: "tests/doctor", goal: "capture" }),
          );
          await maintenance!.closeStores();
          expect(acquireCoordinatorFromPeer(coordinatorPath)).toBe("blocked");
          await maintenance!.run(async () => {
            expect(await flows.list()).toHaveLength(1);
            await flows.createManaged({ controllerId: "tests/doctor", goal: "forward repair" });
          });
        } finally {
          await maintenance?.release();
        }
        expect(acquireCoordinatorFromPeer(coordinatorPath)).toBe("held");
        expect((await flows.list()).map((flow) => flow.goal).toSorted()).toEqual([
          "capture",
          "forward repair",
        ]);
      },
    );
  });

  it.each([false, true])(
    "preserves pooling until worker close requests retirement (close before owner release=%s)",
    async (closeBeforeRelease) => {
      await withOpenClawTestState(
        { scenario: "external-service", label: "doctor-worker-retention" },
        async (state) => {
          const directory = state.path("coordinator-runtime");
          await stateCoordinator.withStateDatabaseCoordinatorRuntimeDirectory(
            { directory, keepAlive: true },
            async () => {
              const context = captureOpenClawStateWorkerContext();
              // The pool only retains an already-established coordinator file.
              stateCoordinator
                .acquireStateDatabaseCoordinator({ databasePath: context.admission.databasePath })
                .release();
              const { result: coordinator, database } = captureCoordinatorDatabase(() =>
                stateCoordinator.acquireStateDatabaseCoordinator({
                  databasePath: context.admission.databasePath,
                }),
              );
              try {
                expect(
                  await executeOpenClawStateWorker(context, {
                    type: "tasks.list",
                    input: { ownerKey: "agent:main:doctor" },
                  }),
                ).toEqual([]);
                if (closeBeforeRelease) {
                  await closeOpenClawStateDatabaseAsync();
                }
                coordinator.release();
                expect(database.isOpen).toBe(!closeBeforeRelease);
              } finally {
                await closeOpenClawStateDatabaseAsync();
                coordinator.release();
                stateCoordinator
                  .acquireStateDatabaseCoordinator({
                    databasePath: context.admission.databasePath,
                    keepAlive: false,
                  })
                  .release();
              }
            },
          );
          await fs.rm(directory, { recursive: true });
        },
      );
    },
  );

  it.each([
    { alreadyOpen: false, reload: false },
    { alreadyOpen: true, reload: false },
    { alreadyOpen: true, reload: true },
  ])(
    "completes writes and drainage with an already-open worker=$alreadyOpen after module reload=$reload",
    async ({ alreadyOpen, reload }) => {
      await withOpenClawTestState(
        { scenario: "external-service", label: "doctor-managed-worker" },
        async () => {
          openOpenClawStateDatabase();
          let flows = createRuntimeAsyncTasks().managedFlows.bindSession({
            sessionKey: "agent:main:doctor",
          });
          if (alreadyOpen) {
            await flows.list();
          }
          let enterMaintenance = beginDoctorMaintenance;
          if (reload) {
            await closeOpenClawStateDatabaseAsync();
            vi.resetModules();
            const [reloadedDoctor, reloadedTasks] = await Promise.all([
              import("./doctor-maintenance.js"),
              import("../plugins/runtime/runtime-tasks-async.js"),
            ]);
            enterMaintenance = reloadedDoctor.beginDoctorMaintenance;
            flows = reloadedTasks.createRuntimeAsyncTasks().managedFlows.bindSession({
              sessionKey: "agent:main:doctor",
            });
          }
          const maintenance = await enterMaintenance({
            options: { repair: true, nonInteractive: true },
            root: null,
            runtime: { log() {}, error() {}, exit() {} },
          });
          let flowId: string;
          try {
            flowId = await maintenance!.run(async () => {
              const created = await flows.createManaged({
                controllerId: "tests/doctor",
                goal: "Complete Doctor repair",
              });
              const createdFlowId = created.flowId;
              expect(created.revision).toBe(0);
              await expect(
                flows.finish({
                  flowId: createdFlowId,
                  expectedRevision: created.revision,
                  stateJson: { completed: true },
                }),
              ).resolves.toMatchObject({
                applied: true,
                flow: { flowId: createdFlowId, status: "succeeded", revision: 1 },
              });
              return createdFlowId;
            });
          } finally {
            await maintenance?.release();
          }
          await closeOpenClawStateDatabaseAsync();
          expect(await flows.list()).toEqual([
            expect.objectContaining({
              flowId,
              goal: "Complete Doctor repair",
              status: "succeeded",
              revision: 1,
              stateJson: { completed: true },
            }),
          ]);
          const next = await flows.createManaged({
            controllerId: "tests/doctor",
            goal: "Continue after maintenance",
          });
          expect((await flows.list()).map((flow) => flow.flowId).toSorted()).toEqual(
            [flowId, next.flowId].toSorted(),
          );
        },
      );
    },
  );

  it("preserves a committed flow receipt when its retained coordinator release fails", async () => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "doctor-managed-cleanup" },
      async () => {
        openOpenClawStateDatabase();
        const maintenance = await beginDoctorMaintenance({
          options: { repair: true, nonInteractive: true },
          root: null,
          runtime: { log() {}, error() {}, exit() {} },
        });
        const flows = createRuntimeAsyncTasks().managedFlows.bindSession({
          sessionKey: "agent:main:doctor",
        });
        const receipt: {
          delegate?: ReturnType<typeof stateCoordinator.tryCreateStateLifecycleDelegate>;
        } = {};
        try {
          await maintenance!.run(async () => {
            await flows.list();
            const createDelegate = stateCoordinator.tryCreateStateLifecycleDelegate;
            let failRelease = true;
            const spy = vi
              .spyOn(stateCoordinator, "tryCreateStateLifecycleDelegate")
              .mockImplementation((params) => {
                const delegate = createDelegate(params);
                if (!delegate) {
                  return delegate;
                }
                receipt.delegate ??= delegate;
                return {
                  port: delegate.port,
                  get closed() {
                    return delegate.closed;
                  },
                  release() {
                    if (failRelease) {
                      failRelease = false;
                      throw new Error("Synthetic retained coordinator release failure");
                    }
                    delegate.release();
                  },
                };
              });
            let created: ManagedTaskFlowRecord | null;
            try {
              created = await flows.tryCreateManaged({
                controllerId: "tests/doctor",
                goal: "Retain confirmed result",
              });
              expect(created).toMatchObject({ goal: "Retain confirmed result", revision: 0 });
            } finally {
              spy.mockRestore();
            }
            await closeOpenClawStateDatabaseAsync();
            expect(receipt.delegate?.closed).toBe(true);
            expect(await flows.list()).toEqual([created]);
          });
        } finally {
          receipt.delegate?.release();
          await maintenance?.release();
        }
      },
    );
  });

  it.each([false, true])(
    "retains cleanup after setup and first release fail (pre-maintenance worker=%s)",
    async (beforeMaintenance) => {
      await withOpenClawTestState(
        { scenario: "external-service", label: "doctor-managed-setup" },
        async () => {
          openOpenClawStateDatabase();
          const flows = createRuntimeAsyncTasks().managedFlows.bindSession({
            sessionKey: "agent:main:doctor",
          });
          if (beforeMaintenance) {
            await flows.list();
          }
          const maintenance = await beginDoctorMaintenance({
            options: { repair: true, nonInteractive: true },
            root: null,
            runtime: { log() {}, error() {}, exit() {} },
          });
          const receipt: {
            retained?: Parameters<typeof coordinatorDelegate.createCoordinatorDelegate>[2];
          } = {};
          try {
            await maintenance!.run(async () => {
              if (!beforeMaintenance) {
                await flows.list();
              }
              const create = coordinatorDelegate.createCoordinatorDelegate;
              let failRelease = true;
              const delegate = vi
                .spyOn(coordinatorDelegate, "createCoordinatorDelegate")
                .mockImplementation((identity, live, retained, revoke, label) => {
                  if (receipt.retained) {
                    return create(identity, live, retained, revoke, label);
                  }
                  receipt.retained = retained;
                  return create(
                    identity,
                    live,
                    {
                      get closed() {
                        return retained.closed;
                      },
                      release() {
                        if (failRelease) {
                          failRelease = false;
                          throw new Error("Synthetic retained release failure");
                        }
                        retained.release();
                      },
                    },
                    revoke,
                    label,
                  );
                });
              const send = vi
                .spyOn(MessagePort.prototype, "postMessage")
                .mockImplementationOnce(() => {
                  throw new Error("Synthetic delegate setup failure");
                });
              try {
                await expect(
                  flows.tryCreateManaged({
                    controllerId: "tests/doctor",
                    goal: "Undispatched repair",
                  }),
                ).resolves.toBeNull();
              } finally {
                send.mockRestore();
                delegate.mockRestore();
              }
              await closeOpenClawStateDatabaseAsync();
              expect(receipt.retained?.closed).toBe(true);
              expect(await flows.list()).toEqual([]);
              const created = await flows.createManaged({
                controllerId: "tests/doctor",
                goal: "Continue after setup failure",
              });
              await closeOpenClawStateDatabaseAsync();
              expect(await flows.list()).toEqual([created]);
            });
          } finally {
            receipt.retained?.release();
            await maintenance?.release();
          }
        },
      );
    },
  );
});
