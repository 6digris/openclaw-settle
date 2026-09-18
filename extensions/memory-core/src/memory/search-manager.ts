// Memory Core owns Gateway indexes for both local and host-provided files.
import {
  getAgentWorkspaceAccess,
  WorkspaceAccessUnavailableError,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  resolveAgentWorkspaceDir,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySearchManager } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { MemoryCoreAcquireLocalService } from "./embedding-local-service.js";

const loadManagerRuntime = createLazyRuntimeModule(() => import("../../manager-runtime.js"));

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
  const result = await getConfiguredMemorySearchManager(params);
  return {
    ...result,
    debug: {
      backend: "builtin",
      purpose: params.purpose ?? "default",
      managerMs: Math.max(0, Date.now() - startedAt),
    },
  };
}

async function getConfiguredMemorySearchManager(
  params: MemorySearchManagerParams,
): Promise<Omit<MemorySearchManagerResult, "debug">> {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const access = getAgentWorkspaceAccess(workspaceDir);
    if (access && !access.memoryFiles) {
      throw new WorkspaceAccessUnavailableError("Remote Memory file access is unavailable");
    }
    const { MemoryIndexManager } = await loadManagerRuntime();
    return {
      manager: await MemoryIndexManager.get({ ...params, memoryFiles: access?.memoryFiles }),
    };
  } catch (err) {
    return { manager: null, error: formatErrorMessage(err) };
  }
}

async function closeLoadedManagers(agentId?: string): Promise<void> {
  const runtime = await loadManagerRuntime.peek();
  if (!runtime) {
    return;
  }
  if (agentId === undefined) {
    await runtime.closeAllMemoryIndexManagers();
  } else {
    await runtime.closeMemoryIndexManagersForAgent({ agentId: normalizeAgentId(agentId) });
  }
}

export async function closeAllMemorySearchManagers(): Promise<void> {
  await closeLoadedManagers();
}

export async function closeMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  await closeLoadedManagers(params.agentId);
}
