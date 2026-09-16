import { getAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
// Memory Core plugin module owns builtin search manager acquisition and cleanup.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySearchManager } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { MemoryCoreAcquireLocalService } from "./embedding-local-service.js";

const managerRuntimeLoader = createLazyRuntimeModule(() => import("../../manager-runtime.js"));
const loadManagerRuntime = managerRuntimeLoader;
const remoteManagerRuntimeLoader = createLazyRuntimeModule(
  () => import("./remote-search-manager.js"),
);

type MemorySearchManagerPurpose = "default" | "status" | "cli";
type MemorySearchManagerParams = {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: MemorySearchManagerPurpose;
  inspectSources?: boolean;
  acquireLocalService?: MemoryCoreAcquireLocalService;
};

type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
  debug?: {
    backend: "builtin";
    purpose: MemorySearchManagerPurpose;
    managerMs: number;
  };
};

export async function getMemorySearchManager(
  params: MemorySearchManagerParams,
): Promise<MemorySearchManagerResult> {
  const startedAt = Date.now();
  const result = await getBuiltinMemorySearchManager(params);
  return {
    ...result,
    debug: {
      backend: "builtin",
      purpose: params.purpose ?? "default",
      managerMs: Math.max(0, Date.now() - startedAt),
    },
  };
}

async function getBuiltinMemorySearchManager(
  params: MemorySearchManagerParams,
): Promise<Omit<MemorySearchManagerResult, "debug">> {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const access = getAgentWorkspaceAccess(workspaceDir);
    if (access) {
      const { getWorkspaceMemorySearchManager } = await remoteManagerRuntimeLoader();
      return {
        manager: await getWorkspaceMemorySearchManager({ ...params, workspaceDir, access }),
      };
    }
    const { MemoryIndexManager } = await loadManagerRuntime();
    return { manager: await MemoryIndexManager.get(params) };
  } catch (err) {
    return { manager: null, error: formatErrorMessage(err) };
  }
}

export async function closeAllMemorySearchManagers(): Promise<void> {
  await Promise.all([
    remoteManagerRuntimeLoader
      .peek()
      ?.then((runtime) => runtime.closeWorkspaceMemorySearchManagers()),
    managerRuntimeLoader.peek()?.then((runtime) => runtime.closeAllMemoryIndexManagers()),
  ]);
}

export async function closeMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  await Promise.all([
    remoteManagerRuntimeLoader
      .peek()
      ?.then((runtime) => runtime.closeWorkspaceMemorySearchManagers(params.agentId)),
    managerRuntimeLoader.peek()?.then((runtime) =>
      runtime.closeMemoryIndexManagersForAgent({
        agentId: normalizeAgentId(params.agentId),
      }),
    ),
  ]);
}
