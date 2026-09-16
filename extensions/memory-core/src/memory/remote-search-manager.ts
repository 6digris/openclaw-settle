import {
  getAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  MemorySearchManager,
  MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { classifyWorkspaceMemoryPaths } from "../workspace-path-classifier.js";
import { MemoryManagerRegistry } from "./manager-registry.js";

type RemoteManagerEntry = {
  access: AgentWorkspaceAccess;
  cfg: Parameters<NonNullable<AgentWorkspaceAccess["getMemorySearchManager"]>>[0]["cfg"];
  manager: MemorySearchManager;
  active: boolean;
  assertCurrent: () => void;
  close: () => Promise<void>;
};

// Keep remote adapters separate from the native registry while sharing its close serialization.
const registry = new MemoryManagerRegistry<RemoteManagerEntry>({
  cache: Symbol.for("openclaw.workspaceMemoryManagerCache"),
  scopeOperations: Symbol.for("openclaw.workspaceMemoryManagerScopeCloses"),
  globalLifecycle: Symbol.for("openclaw.workspaceMemoryManagerGlobalLifecycle"),
});

function createRemoteManagerEntry(
  key: string,
  workspaceDir: string,
  access: AgentWorkspaceAccess,
  cfg: RemoteManagerEntry["cfg"],
  backend: MemorySearchManager,
  agentId: string,
): RemoteManagerEntry {
  let closing: Promise<void> | undefined;
  const assertCurrent = () => {
    if (!entry.active || getAgentWorkspaceAccess(workspaceDir) !== access) {
      throw new Error("Remote memory workspace access changed or closed");
    }
  };
  const guardCallback =
    <T>(callback: (value: T) => void) =>
    (value: T) => {
      assertCurrent();
      callback(value);
    };
  const classifyResults = async (results: MemorySearchResult[]): Promise<MemorySearchResult[]> => {
    assertCurrent();
    const relativePaths = [
      ...new Set(
        results.filter((result) => result.source === "memory").map((result) => result.path),
      ),
    ];
    const classified = await classifyWorkspaceMemoryPaths({
      cfg,
      agentId,
      workspaceDir,
      relativePaths,
    });
    assertCurrent();
    const origins = new Map(classified.map((result) => [result.relativePath, result.originClass]));
    return results.map((result): MemorySearchResult => {
      if (result.source !== "memory") {
        return result;
      }
      const originClass = origins.get(result.path) ?? "untrusted";
      return {
        ...result,
        originClass,
        provenance: {
          originClass,
          sessionKind: "unknown",
          observedAt: result.provenance?.observedAt ?? 0,
        },
      };
    });
  };
  const search: MemorySearchManager["search"] = async (query, options) =>
    await classifyResults(
      await backend.search(
        query,
        options?.onDebug ? { ...options, onDebug: guardCallback(options.onDebug) } : options,
      ),
    );
  const listTriggerCandidates: MemorySearchManager["listTriggerCandidates"] =
    backend.listTriggerCandidates
      ? async (options) => await classifyResults(await backend.listTriggerCandidates!(options))
      : undefined;
  const listCuratedProjectCandidates: MemorySearchManager["listCuratedProjectCandidates"] =
    backend.listCuratedProjectCandidates
      ? async (options) =>
          await classifyResults(await backend.listCuratedProjectCandidates!(options))
      : undefined;
  const sync: MemorySearchManager["sync"] = backend.sync
    ? (options) =>
        backend.sync!(
          options?.progress ? { ...options, progress: guardCallback(options.progress) } : options,
        )
    : undefined;
  const entry: RemoteManagerEntry = {
    access,
    cfg,
    active: true,
    assertCurrent,
    manager: new Proxy(backend, {
      get(target, property) {
        // Cleanup remains available after revocation; it never reopens data access.
        if (property === "close") {
          return entry.close;
        }
        const value: unknown =
          property === "search"
            ? search
            : property === "listTriggerCandidates"
              ? listTriggerCandidates
              : property === "listCuratedProjectCandidates"
                ? listCuratedProjectCandidates
                : property === "sync"
                  ? sync
                  : Reflect.get(target, property, target);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          assertCurrent();
          // Preserve native private/class state and synchronous status/cache methods.
          const result: unknown = Reflect.apply(value, target, args);
          if (result instanceof Promise) {
            return result.then((resolved: unknown) => {
              assertCurrent();
              return resolved;
            });
          }
          assertCurrent();
          return result;
        };
      },
    }),
    async close() {
      entry.active = false;
      closing ??= (async () => {
        await backend.close?.();
        registry.deleteIfCurrent(key, entry);
      })().catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      await closing;
    },
  };
  return entry;
}

export async function getWorkspaceMemorySearchManager(
  params: Parameters<NonNullable<AgentWorkspaceAccess["getMemorySearchManager"]>>[0] & {
    workspaceDir: string;
    access: AgentWorkspaceAccess;
  },
): Promise<MemorySearchManager | null> {
  const { cfg, workspaceDir, access, inspectSources } = params;
  const agentId = normalizeAgentId(params.agentId);
  const purpose = params.purpose ?? "default";
  const key = `${agentId}:${workspaceDir}:${purpose}`;
  const entry = await registry.acquire(
    { agentId, purpose },
    {
      prepare: () => {
        if (getAgentWorkspaceAccess(workspaceDir) !== access) {
          throw new Error("Remote memory workspace access changed");
        }
        if (!access.getMemorySearchManager) {
          throw new Error("Remote workspace memory manager is unavailable");
        }
        const getManager = access.getMemorySearchManager.bind(access);
        return {
          key,
          transient: false,
          create: async () => {
            if (getAgentWorkspaceAccess(workspaceDir) !== access) {
              throw new Error("Remote memory workspace access changed");
            }
            const backend = await getManager({
              cfg,
              agentId,
              purpose: params.purpose,
              inspectSources,
            });
            return createRemoteManagerEntry(key, workspaceDir, access, cfg, backend, agentId);
          },
          // Diagnostics must refresh source state; default callers reuse one admitted adapter.
          reuse: (existing) =>
            existing.active &&
            existing.access === access &&
            existing.cfg === cfg &&
            purpose === "default" &&
            !inspectSources,
        };
      },
      close: async (manager) => await manager.close(),
    },
  );
  if (!entry) {
    return null;
  }
  try {
    entry.assertCurrent();
    return entry.manager;
  } catch (error) {
    await entry.close();
    throw error;
  }
}

export async function closeWorkspaceMemorySearchManagers(agentId?: string): Promise<void> {
  const close = async (manager: RemoteManagerEntry) => await manager.close();
  if (agentId === undefined) {
    await registry.closeAll(close);
    return;
  }
  for (const purpose of ["default", "status", "cli"] as const) {
    await registry.closeForAgent({ agentId, purpose, close });
  }
}
