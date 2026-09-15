/**
 * ACPX runtime plugin entry. It registers the embedded ACP backend service and
 * wires reply-dispatch hooks into the plugin SDK runtime.
 */
import { tryDispatchAcpReplyHook } from "openclaw/plugin-sdk/acp-runtime-backend";
import { createAcpxRuntimeService } from "./register.runtime.js";
import type { OpenClawPluginApi } from "./runtime-api.js";
import { createAcpxNativeHarness } from "./src/native-harness.js";
import { registerPiSessionCatalog } from "./src/pi-session-catalog-plugin.js";

const plugin = {
  id: "acpx",
  name: "ACPX Runtime",
  description: "Embedded ACP runtime backend with plugin-owned session and transport management.",
  register(api: OpenClawPluginApi) {
    registerPiSessionCatalog(api);
    const service = createAcpxRuntimeService({
      pluginConfig: api.pluginConfig,
      openKeyedStore: (options) => api.runtime.state.openKeyedStore(options),
    });
    api.registerService(service);
    api.registerAgentHarness(
      createAcpxNativeHarness({
        id: "opencode",
        label: "OpenCode",
        agent: "opencode",
        executable: "opencode",
        args: ["acp"],
        api,
        getRuntime: service.getRuntime,
        cleanupCatalogSession: async (sessionId, command) => {
          const result = await api.runtime.system.runCommandWithTimeout(
            [command[0]!, "session", "delete", sessionId],
            {
              timeoutMs: 30_000,
            },
          );
          if (result.code !== 0) {
            throw new Error(`OpenCode catalog cleanup failed: ${result.stderr}`);
          }
        },
      }),
    );
    api.on("reply_dispatch", tryDispatchAcpReplyHook, { eligibleDispatchKinds: ["acp"] });
  },
};

export default plugin;
