import {
  capturePluginLifecycleAuthority,
  getPluginRecordRegistry,
} from "../plugins/registry-lifecycle.js";
import { requireActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { DetachedTaskLifecycleRuntime } from "./detached-task-runtime-contract.js";

export function getRegisteredDetachedTaskLifecycleRuntime():
  | DetachedTaskLifecycleRuntime
  | undefined {
  return requireActivePluginRegistry().detachedTaskRuntimes[0]?.runtime;
}

/** Core creation retains its selected registry lifetime; plugin work follows its live instance. */
export function captureDetachedTaskRuntimeOwner(): {
  runtime: DetachedTaskLifecycleRuntime | undefined;
  assertCurrent: () => void;
} {
  const registry = requireActivePluginRegistry();
  const registration = registry.detachedTaskRuntimes[0];
  const runtime = registration?.runtime;
  const pluginId = registration?.pluginId;
  const record = registration
    ? registry.plugins.find((candidate) => candidate.id === pluginId)
    : undefined;
  const authority = record
    ? capturePluginLifecycleAuthority(getPluginRecordRegistry(registry, record), record)
    : undefined;
  const coreAuthority = registration
    ? undefined
    : capturePluginLifecycleAuthority(registry, undefined, {
        scopedRuntime: getPluginRuntimeGatewayRequestScope()?.pluginRegistry === registry,
      });
  return {
    runtime,
    assertCurrent() {
      if (registration) {
        const owner = record ? getPluginRecordRegistry(registry, record) : undefined;
        if (
          authority?.() &&
          owner?.detachedTaskRuntimes.some(
            (candidate) => candidate.pluginId === pluginId && candidate.runtime === runtime,
          )
        ) {
          return;
        }
      } else if (coreAuthority?.() && registry.detachedTaskRuntimes[0] === undefined) {
        // Queued worker callbacks borrow their scheduler's context, not this captured owner.
        return;
      }
      throw new Error("Detached task runtime owner changed before task creation settled.");
    },
  };
}
