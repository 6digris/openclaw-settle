// The executor keeps canonical writer admission closed across fresh Doctor processes.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveConfigPath } from "../../config/paths.js";
import {
  captureConfigWriteTransferPin,
  runWithConfigWriteTransfer,
  type ConfigWriteTransferPin,
  type ConfigWriteTransferScope,
} from "../../config/write-transfer.js";
import { acquireFileLock, type FileLockHandle } from "../../infra/file-lock.js";
import { resolveLifecycleCoordinatorPath } from "../../infra/state-database-coordinator-paths.js";
import {
  runWithStateLifecycleTransfer,
  type StateLifecycleTransferAdmission,
  type StateLifecycleTransferScope,
} from "../../infra/state-database-coordinator-transfer.js";
import {
  acquireGatewayMaintenanceCoordinator,
  acquireStateDatabaseCoordinator,
  resolveStateLifecycleRuntimeDirectory,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../../infra/state-database-coordinator.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import type { CommandOptions } from "../../process/exec.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";

type CoordinatorPin = { path: string; dev: string; ino: string; birthtimeNs: string };
export type UpdateWriterCustodyGrant = {
  activationChannel?: { runId: string };
  databasePath: string;
  runtimeDirectory: string;
  coordinators: CoordinatorPin[];
  config: ConfigWriteTransferPin[];
};
type Custody = {
  assertCurrent: () => void;
  lifecycle: StateLifecycleTransferScope;
  config: ConfigWriteTransferScope;
  grant?: UpdateWriterCustodyGrant;
  handles: Array<{ release(): void; assertSoleOwner?: () => void }>;
  locks: FileLockHandle[];
  released: boolean;
  parentActivation?: { runId: string };
  activation?: Promise<void>;
};
const current = resolveGlobalSingleton(
  Symbol.for("openclaw.updateWriterCustody"),
  () => new AsyncLocalStorage<Custody>(),
);
function pinCoordinator(pathname: string): CoordinatorPin {
  const stat = fs.lstatSync(pathname, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Update lifecycle coordinator is no longer a regular file.");
  }
  return {
    path: pathname,
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs),
  };
}
function assertPins(pins: readonly CoordinatorPin[]): void {
  for (const pin of pins) {
    const actual = pinCoordinator(pin.path);
    if (
      actual.dev !== pin.dev ||
      actual.ino !== pin.ino ||
      actual.birthtimeNs !== pin.birthtimeNs
    ) {
      throw new Error("Update lifecycle coordinator was replaced.");
    }
  }
}
function coordinatorPaths(databasePath: string, runtimeDirectory: string): string[] {
  return (["gateway-lifecycle", "state-lifecycle"] as const).map((family) =>
    resolveLifecycleCoordinatorPath(family, {
      databasePath,
      runtimeDirectory,
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    }),
  );
}
function retainCoordinators(
  owner: Custody,
  grant: UpdateWriterCustodyGrant,
  mode: "reserved" | "shared",
) {
  const admission: StateLifecycleTransferAdmission = {
    mode,
    active: true,
    assertCurrent() {
      owner.assertCurrent();
      assertPins(grant.coordinators);
    },
  };
  for (const pathname of coordinatorPaths(grant.databasePath, grant.runtimeDirectory)) {
    owner.lifecycle.set(pathname, admission);
  }
  owner.handles.push(
    acquireGatewayMaintenanceCoordinator({
      databasePath: grant.databasePath,
      runtimeDirectory: grant.runtimeDirectory,
      busyTimeoutMs: 0,
    }),
  );
  owner.handles.push(
    acquireStateDatabaseCoordinator({
      databasePath: grant.databasePath,
      runtimeDirectory: grant.runtimeDirectory,
      busyTimeoutMs: 250,
    }),
  );
}

/** The surrounding executor settles its exact children before this callback leaves. */
export async function withUpdateWriterCustody<T>(
  assertCurrent: () => void,
  operation: () => Promise<T>,
  inherited?: UpdateWriterCustodyGrant,
): Promise<T> {
  const owner: Custody = {
    assertCurrent,
    lifecycle: new Map(),
    handles: [],
    locks: [],
    released: false,
    config: { active: true, accepting: true, pins: new Map(), pending: new Set(), assertCurrent },
  };
  return await current.run(owner, () =>
    runWithStateLifecycleTransfer(owner.lifecycle, () =>
      runWithConfigWriteTransfer(owner.config, async () => {
        let outcome: { value: T } | { error: unknown };
        try {
          if (inherited) {
            assertCurrent();
            const expected = coordinatorPaths(inherited.databasePath, inherited.runtimeDirectory);
            if (
              JSON.stringify(inherited.coordinators.map((pin) => pin.path)) !==
              JSON.stringify(expected)
            ) {
              throw new Error(
                "Update lifecycle transfer does not match its canonical coordinators.",
              );
            }
            assertPins(inherited.coordinators);
            owner.grant = inherited;
            owner.parentActivation = inherited.activationChannel;
            for (const pin of inherited.config) {
              owner.config.pins.set(pin.path, pin);
            }
            retainCoordinators(owner, inherited, "shared");
          }
          outcome = {
            value: await (inherited
              ? withStateDatabaseCoordinatorRuntimeDirectory(
                  { directory: inherited.runtimeDirectory, keepAlive: false },
                  operation,
                )
              : operation()),
          };
        } catch (error) {
          if (hasCommandProcessCleanupError(error)) {
            throw error;
          }
          outcome = { error };
        }
        try {
          await releaseUpdateWriterCustody();
        } catch (error) {
          throw new AggregateError(
            "error" in outcome ? [outcome.error, error] : [error],
            "Update operation and writer custody did not settle.",
            { cause: error },
          );
        }
        if ("error" in outcome) {
          throw outcome.error;
        }
        return outcome.value;
      }),
    ),
  );
}

/** Called only after the service stopped, before constructing the recovery generation. */
export async function beginUpdateWriterCustody(env: NodeJS.ProcessEnv): Promise<void> {
  const owner = current.getStore();
  if (!owner || owner.released) {
    throw new Error("Update capture requires its live writer-custody executor.");
  }
  owner.assertCurrent();
  const databasePath = path.resolve(resolveOpenClawStateSqlitePath(env));
  if (owner.grant) {
    if (owner.grant.databasePath !== databasePath) {
      throw new Error("Update writer custody selected a different shared database.");
    }
    assertPins(owner.grant.coordinators);
    return;
  }
  const runtimeDirectory = resolveStateLifecycleRuntimeDirectory();
  const grant: UpdateWriterCustodyGrant = {
    databasePath,
    runtimeDirectory,
    coordinators: [],
    config: [],
  };
  owner.grant = grant;
  retainCoordinators(owner, grant, "reserved");
  grant.coordinators = coordinatorPaths(databasePath, runtimeDirectory).map(pinCoordinator);
  // Root first: all canonical include mutations also serialize through the root.
  const root = path.resolve(resolveConfigPath(env));
  const acquire = async (pathname: string) => {
    owner.assertCurrent();
    const lock = await acquireFileLock(pathname, {
      retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
      stale: 30_000,
      staleRecovery: "fail-closed",
    });
    owner.locks.push(lock);
    owner.assertCurrent();
    const pin = captureConfigWriteTransferPin(pathname);
    owner.config.pins.set(pin.path, pin);
    grant.config.push(pin);
  };
  await acquire(root);
  const { readConfigFileSnapshot } = await import("../../config/config.js");
  const config = await readConfigFileSnapshot({ observe: false, skipPluginValidation: true });
  const includes = [
    ...new Set(
      (config.includeProvenance ?? [])
        .flatMap((entry) => entry.targetPaths ?? (entry.targetPath ? [entry.targetPath] : []))
        .map((pathname) => path.resolve(pathname)),
    ),
  ]
    .filter((pathname) => pathname !== root)
    .toSorted();
  for (const pathname of includes) {
    await acquire(pathname);
  }
  owner.assertCurrent();
}

export function captureUpdateWriterCustody(): UpdateWriterCustodyGrant | undefined {
  const owner = current.getStore();
  if (!owner?.grant || owner.released) {
    return undefined;
  }
  owner.assertCurrent();
  assertPins(owner.grant.coordinators);
  return structuredClone(owner.grant);
}

/** Call only after migration/plugin children settle, before native successor activation. */
async function releaseUpdateWriterCustody(): Promise<void> {
  const owner = current.getStore();
  if (!owner || owner.released) {
    return;
  }
  owner.config.accepting = false;
  const failures: unknown[] = [];
  while (owner.config.pending.size) {
    for (const result of await Promise.allSettled(owner.config.pending)) {
      if (result.status === "rejected") {
        failures.push(result.reason);
      }
    }
  }
  owner.config.active = false;
  for (const lock of owner.locks.toReversed()) {
    try {
      await lock.release();
      owner.locks.splice(owner.locks.indexOf(lock), 1);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const admission of owner.lifecycle.values()) {
    admission.active = false;
  }
  for (const handle of owner.handles.toReversed()) {
    try {
      handle.release();
      owner.handles.splice(owner.handles.indexOf(handle), 1);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Update writer custody did not settle.");
  }
  owner.lifecycle.clear();
  owner.config.pins.clear();
  owner.released = true;
}

function requestParentActivation(runId: string): Promise<void> {
  if (!process.connected || !process.send) {
    return Promise.reject(new Error("Update writer handback requires its live parent channel."));
  }
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      process.off("message", receive);
      process.off("disconnect", disconnected);
      process.channel?.unref();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const disconnected = () =>
      finish(new Error("Update writer parent disconnected before handback."));
    const receive = (message: unknown) => {
      if (
        !isRecord(message) ||
        message.kind !== "openclaw-update-writers-released" ||
        message.runId !== runId
      ) {
        finish(new Error("Update writer parent sent an invalid handback."));
        return;
      }
      finish();
    };
    process.on("message", receive);
    process.once("disconnect", disconnected);
    process.send?.({ kind: "openclaw-update-writers-ready", runId }, (error) => {
      if (error) {
        finish(error);
      }
    });
  });
}

/** Drain the local migration pins, then ask each authenticated ancestor to do the same. */
export async function settleUpdateWriterCustodyForActivation(): Promise<void> {
  const owner = current.getStore();
  if (!owner?.grant) {
    return;
  }
  owner.activation ??= (async () => {
    owner.assertCurrent();
    for (const handle of owner.handles) {
      if (!handle.assertSoleOwner) {
        throw new Error("Update lifecycle transfer has no physical owner");
      }
      handle.assertSoleOwner();
    }
    await releaseUpdateWriterCustody();
    if (owner.parentActivation) {
      await requestParentActivation(owner.parentActivation.runId);
    }
    owner.assertCurrent();
  })();
  await owner.activation;
}

/** The command runner routes only this spawned child's IPC to this captured owner. */
export function createUpdateWriterCustodyControl(runId: string): CommandOptions["onChildMessage"] {
  const owner = current.getStore();
  if (!owner?.grant || owner.released) {
    return undefined;
  }
  const runInOwner = AsyncLocalStorage.snapshot();
  let received = false;
  return async (message, reply) => {
    if (
      received ||
      !isRecord(message) ||
      message.kind !== "openclaw-update-writers-ready" ||
      message.runId !== runId
    ) {
      throw new Error("Update writer child sent an invalid or repeated handback.");
    }
    received = true;
    await runInOwner(settleUpdateWriterCustodyForActivation);
    owner.assertCurrent();
    await reply({ kind: "openclaw-update-writers-released", runId });
  };
}
