import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  isPluginRegistryActivated,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import { withPluginRegistrationContext } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { getDetachedTaskLifecycleRuntime, prepareRunningTaskRun } from "./detached-task-runtime.js";
import type { TaskRecord } from "./task-registry.types.js";

const { createInCore } = vi.hoisted(() => ({
  createInCore:
    vi.fn<
      typeof import("./task-executor-create.async.js").createRunningTaskRunCoreWithReceiptAsync
    >(),
}));
vi.mock("./task-executor-create.async.js", () => ({
  createRunningTaskRunCoreWithReceiptAsync: createInCore,
}));

const input = {
  runtime: "subagent",
  ownerKey: "agent:main:room",
  runId: "owned-worker",
  task: "Inspect the requested work",
} as const;
const task: TaskRecord = {
  taskId: "owned-task",
  ...input,
  requesterSessionKey: input.ownerKey,
  scopeKind: "session",
  status: "running",
  deliveryStatus: "pending",
  notifyPolicy: "done_only",
  createdAt: 1,
};

afterEach(() => createInCore.mockReset());

describe("core task creation in scoped runtime registries", () => {
  it.each(["live", "retired", "activated", "runtime-replaced"] as const)(
    "persists only for the retained scoped owner (%s)",
    async (transition) => {
      const registry = createEmptyPluginRegistry();
      const entered = createDeferred();
      const release = createDeferred();
      const persisted: TaskRecord[] = [];
      createInCore.mockImplementation(async (_params, assertCurrent) => {
        if (!assertCurrent) {
          throw new Error("Task creation admission is required");
        }
        entered.resolve();
        await release.promise;
        assertCurrent();
        persisted.push(task);
        return {
          task,
          settleUnstarted: async () => false,
          finalizeActive: async () => {
            throw new Error("Scoped creation must not finalize active work");
          },
        };
      });
      try {
        await withPluginRuntimeRegistryScope(registry, async () => {
          const creation = Promise.resolve().then(() => {
            const prepared = prepareRunningTaskRun(input);
            if (prepared.kind !== "receipt") {
              throw new Error("Expected core receipt creation");
            }
            return prepared.create();
          });
          await Promise.race([entered.promise, creation]);
          expect(isPluginRegistryActivated(registry)).toBe(false);
          if (transition === "retired") {
            markPluginRegistryRetired(registry);
          } else if (transition === "activated") {
            markPluginRegistryActive(registry);
          } else if (transition === "runtime-replaced") {
            registry.detachedTaskRuntimes.push({
              pluginId: "replacement",
              runtime: getDetachedTaskLifecycleRuntime(),
            });
          }
          release.resolve();
          if (transition === "live") {
            await expect(creation).resolves.toMatchObject({ task });
            expect(persisted).toEqual([task]);
            expect(isPluginRegistryActivated(registry)).toBe(false);
          } else {
            await expect(creation).rejects.toThrow("Detached task runtime owner changed");
            expect(persisted).toEqual([]);
          }
        });
      } finally {
        release.resolve();
        markPluginRegistryRetired(registry);
      }
    },
  );

  it("does not turn cold registration into task creation authority", () => {
    const registry = createEmptyPluginRegistry();
    try {
      expect(() =>
        withPluginRegistrationContext(registry, "unactivated", () => prepareRunningTaskRun(input)),
      ).toThrow("Detached task runtime owner changed");
      expect(createInCore).not.toHaveBeenCalled();
      expect(isPluginRegistryActivated(registry)).toBe(false);
    } finally {
      markPluginRegistryRetired(registry);
    }
  });
});
