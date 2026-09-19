// Lexical custody of physical lifecycle coordinators across a registered process family.
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { SqliteCoordinatorError } from "./sqlite-coordinator.js";

export type StateLifecycleTransferAdmission = {
  mode: "reserved" | "shared";
  active: boolean;
  assertCurrent: () => void;
};
export type StateLifecycleTransferScope = Map<string, StateLifecycleTransferAdmission>;

const currentTransfer = resolveGlobalSingleton(
  Symbol.for("openclaw.stateLifecycleTransfer"),
  () => new AsyncLocalStorage<StateLifecycleTransferScope>(),
);

/** Only the update executor installs this scope after live process-lineage admission. */
export function runWithStateLifecycleTransfer<T>(
  scope: StateLifecycleTransferScope,
  operation: () => T,
): T {
  return currentTransfer.run(scope, operation);
}

export function captureStateLifecycleTransfer(
  coordinatorPath: string,
): StateLifecycleTransferAdmission | undefined {
  const admission = currentTransfer.getStore()?.get(coordinatorPath);
  if (admission) {
    assertStateLifecycleTransfer(coordinatorPath, admission);
  }
  return admission;
}

export function assertStateLifecycleTransfer(
  coordinatorPath: string,
  admission: StateLifecycleTransferAdmission,
): void {
  if (!admission.active || currentTransfer.getStore()?.get(coordinatorPath) !== admission) {
    throw new SqliteCoordinatorError("State lifecycle transfer has no current lexical owner");
  }
  admission.assertCurrent();
}
