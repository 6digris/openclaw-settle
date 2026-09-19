// A live executor family may borrow the original config lock without releasing it.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type ConfigWriteTransferPin = {
  path: string;
  dev: string;
  ino: string;
  birthtimeNs: string;
};
export type ConfigWriteTransferScope = {
  active: boolean;
  accepting: boolean;
  pins: Map<string, ConfigWriteTransferPin>;
  pending: Set<Promise<unknown>>;
  assertCurrent: () => void;
};
const current = resolveGlobalSingleton(
  Symbol.for("openclaw.configWriteTransfer"),
  () => new AsyncLocalStorage<ConfigWriteTransferScope>(),
);

export function runWithConfigWriteTransfer<T>(
  scope: ConfigWriteTransferScope,
  operation: () => T,
): T {
  return current.run(scope, operation);
}

export function captureConfigWriteTransferPin(pathname: string): ConfigWriteTransferPin {
  const target = path.resolve(pathname);
  const identity = fs.lstatSync(`${target}.lock`, { bigint: true });
  if (!identity.isFile() || identity.isSymbolicLink()) {
    throw new Error("Update config lock no longer has its original file owner.");
  }
  return {
    path: target,
    dev: String(identity.dev),
    ino: String(identity.ino),
    birthtimeNs: String(identity.birthtimeNs),
  };
}

export function captureConfigWriteTransferGuard(pathname: string): (() => void) | undefined {
  const scope = current.getStore();
  if (!scope?.pins.size) {
    return undefined;
  }
  const target = path.resolve(pathname);
  const pin = scope.pins.get(target);
  if (!pin) {
    throw new Error("Update config write is outside the captured root/include lock set.");
  }
  return () => {
    if (!scope.active || current.getStore() !== scope) {
      throw new Error("Update config writer custody has closed.");
    }
    scope.assertCurrent();
    const observed = captureConfigWriteTransferPin(target);
    if (
      pin.dev !== observed.dev ||
      pin.ino !== observed.ino ||
      pin.birthtimeNs !== observed.birthtimeNs
    ) {
      throw new Error("Update config writer lock was replaced.");
    }
  };
}

export function trackTransferredConfigWrite<T>(operation: () => Promise<T>): Promise<T> {
  const scope = current.getStore();
  if (!scope?.active || !scope.accepting) {
    throw new Error("Update config writer custody is unavailable.");
  }
  const task = Promise.resolve().then(operation);
  scope.pending.add(task);
  void task.finally(() => scope.pending.delete(task)).catch(() => {});
  return task;
}
