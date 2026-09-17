import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type {
  MemorySearchConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  readMemoryFile,
  type MemorySearchManager,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { configureMemoryCoreDreamingState, SHORT_TERM_LOCK_NAMESPACE } from "../dreaming-state.js";
import { MemoryIndexManager } from "../memory/manager.js";
import { MEMORY_RELAY_PROVIDER } from "./memory-wire.js";

export {
  MEMORY_SEARCH_DEADLINE_CONTROL,
  createMemorySearchDeadlineControl,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type MemoryWorkerHost = {
  registerEmbeddingProvider: (adapter: MemoryEmbeddingProviderAdapter) => void;
  openShortTermLocks: <T>(
    options: Omit<OpenKeyedStoreOptions, "namespace">,
  ) => PluginStateKeyedStore<T>;
};

export type MemoryWorkerConfiguration = {
  provider: string;
  model: string;
  identity: string;
  maxInputTokens?: number;
  memoryGetMaxChars?: number;
  query?: MemorySearchConfig["query"];
  cache?: MemorySearchConfig["cache"];
  vectorEnabled?: boolean;
  tokenizer?: "unicode61" | "trigram";
};

export type MemoryWorkerManager = Required<MemorySearchManager>;

export type OpenNativeMemoryManagerOptions = {
  workspace: string;
  agentId: string;
  config: MemoryWorkerConfiguration;
  host: MemoryWorkerHost;
  embed: MemoryEmbeddingProvider["embedBatch"];
};

export async function openNativeManager({
  workspace,
  agentId,
  config,
  host,
  embed,
}: OpenNativeMemoryManagerOptions): Promise<MemoryWorkerManager> {
  const identity = { relayIdentity: config.identity };
  if (config.provider !== "none") {
    host.registerEmbeddingProvider({
      id: MEMORY_RELAY_PROVIDER,
      transport: "remote",
      defaultModel: config.model,
      resolveIndexIdentity: () => ({ model: config.model, cacheKeyData: identity }),
      create: async () => ({
        provider: {
          id: MEMORY_RELAY_PROVIDER,
          model: config.model,
          maxInputTokens: config.maxInputTokens,
          embed: async (input, options) => {
            const [vector] = await embed([input], options);
            if (!vector) {
              throw new Error("Memory embedding output is missing");
            }
            return vector;
          },
          embedBatch: embed,
        },
        runtime: { id: MEMORY_RELAY_PROVIDER, cacheKeyData: identity },
      }),
    });
  }
  configureMemoryCoreDreamingState(({ namespace, ...options }) => {
    if (namespace !== SHORT_TERM_LOCK_NAMESPACE) {
      throw new Error("Only short-term locks are available in the memory worker");
    }
    return host.openShortTermLocks(options);
  });
  const cfg: OpenClawConfig = {
    agents: {
      defaults: { workspace, contextLimits: { memoryGetMaxChars: config.memoryGetMaxChars } },
      entries: { [agentId]: { workspace } },
    },
    memory: {
      search: {
        enabled: true,
        provider: config.provider === "none" ? "none" : MEMORY_RELAY_PROVIDER,
        model: config.model,
        fallback: "none",
        sources: ["memory"],
        extraPaths: [],
        rememberAcrossConversations: false,
        experimental: { sessionMemory: false },
        query: config.query,
        cache: config.cache,
        store: { fts: { tokenizer: config.tokenizer }, vector: { enabled: config.vectorEnabled } },
      },
    },
  };
  // Chunking and synchronization settings belong to the native config resolver.
  const manager = await MemoryIndexManager.get({ cfg, agentId });
  if (!manager) {
    throw new Error("Native memory manager unavailable");
  }
  // The index manager's readFile does not apply agent context limits.
  manager.readFile = (params) =>
    readMemoryFile({
      ...params,
      workspaceDir: workspace,
      extraPaths: [],
      maxChars: config.memoryGetMaxChars,
    });
  return manager;
}
