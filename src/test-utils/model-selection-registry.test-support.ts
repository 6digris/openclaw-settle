import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";

export function createModelSelectionRegistry(
  harnesses: readonly { id: string; provider?: string }[],
) {
  const registry = createEmptyPluginRegistry();
  for (const { id, provider } of harnesses) {
    registry.agentHarnesses.push({
      pluginId: id,
      source: "fixture",
      harness: {
        id,
        label: id,
        supports: (context) => ({
          supported:
            context.requestedRuntime === id &&
            (provider === undefined || context.provider === provider),
        }),
        async runAttempt() {
          throw new Error("Model selection must not run a prompt");
        },
      },
    });
  }
  return registry;
}
