import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderCreateResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySearchDeadlineControl,
  MemoryEntryProvenance,
  MemorySearchRuntimeDebug,
  MemorySyncProgressUpdate,
  MemoryReadResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { MemoryWorkerConfiguration } from "./memory-native.js";
import {
  createMemoryPeer,
  embeddingInputs,
  embeddingVectors,
  MEMORY_RELAY_PROVIDER,
} from "./memory-wire.js";

export type MemoryWorkerProcess = Pick<
  ChildProcessWithoutNullStreams,
  "stdin" | "stdout" | "stderr" | "kill" | "exitCode" | "signalCode"
> & { once: (event: "close" | "error", listener: () => void) => unknown };
export type GatewayMemoryBindingOptions = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  openWorker: () => Promise<MemoryWorkerProcess>;
  signal?: AbortSignal;
};
export type RemoteMemoryManagerOptions = {
  child: MemoryWorkerProcess;
  config: MemoryWorkerConfiguration;
  embedding: (MemoryEmbeddingProviderCreateResult & { provider: MemoryEmbeddingProvider }) | null;
  signal?: AbortSignal;
};

export async function createGatewayMemoryBinding({
  cfg,
  agentId,
  agentDir,
  openWorker,
  signal,
}: GatewayMemoryBindingOptions): Promise<MemorySearchManager> {
  const { resolveMemorySearchConfig, resolveAgentContextLimits } =
    await import("openclaw/plugin-sdk/memory-core-host-engine-foundation");
  const settings = resolveMemorySearchConfig(cfg, agentId);
  if (
    !settings ||
    settings.fallback !== "none" ||
    settings.sources.some((source) => source !== "memory") ||
    settings.extraPaths.length ||
    settings.multimodal.enabled ||
    settings.remote?.batch?.enabled
  ) {
    throw new Error("Remote memory settings are not supported");
  }
  let embedding: RemoteMemoryManagerOptions["embedding"] = null;
  if (settings.provider !== "none") {
    const [{ createEmbeddingProvider }, { resolveMemoryPrimaryProviderRequest }] =
      await Promise.all([
        import("../memory/embeddings.js"),
        import("../memory/manager-provider-state.js"),
      ]);
    const result = await createEmbeddingProvider({
      config: cfg,
      agentDir,
      ...resolveMemoryPrimaryProviderRequest({ settings }),
    });
    if (!result.provider) {
      throw new Error("Memory embeddings are required");
    }
    embedding = { ...result, provider: result.provider };
  }
  // Only the digest crosses the boundary; custom headers can contain credentials.
  const identity = createHash("sha256")
    .update(
      JSON.stringify({
        provider: embedding?.provider.id ?? "none",
        model: embedding?.provider.model ?? "",
        runtime: embedding?.runtime?.cacheKeyData,
      }),
    )
    .digest("hex");
  const memoryGetMaxChars = resolveAgentContextLimits(cfg, agentId)?.memoryGetMaxChars;
  const config: MemoryWorkerConfiguration = {
    provider: embedding?.provider.id ?? "none",
    model: embedding?.provider.model ?? "",
    identity,
    maxInputTokens: embedding?.provider.maxInputTokens,
    memoryGetMaxChars,
    query: { maxResults: settings.query.maxResults, minScore: settings.query.minScore },
    cache: { enabled: settings.cache.enabled },
    vectorEnabled: settings.store.vector.enabled,
    tokenizer: settings.store.fts.tokenizer,
  };
  let child: MemoryWorkerProcess;
  try {
    signal?.throwIfAborted();
    child = await openWorker();
  } catch (error) {
    await embedding?.provider.close?.();
    throw error;
  }
  return await createRemoteMemoryManager({
    child,
    config,
    embedding,
    signal,
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid memory response");
  }
  return value as Record<string, unknown>;
}

function safeProvenance(value: unknown): MemoryEntryProvenance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const provenance = record(value);
  const { originClass, sessionKind, observedAt, supersedesKey } = provenance;
  if (
    (originClass !== "owner" &&
      originClass !== "agent" &&
      originClass !== "untrusted" &&
      originClass !== "system") ||
    (sessionKind !== "interactive" &&
      sessionKind !== "cron" &&
      sessionKind !== "heartbeat" &&
      sessionKind !== "subagent" &&
      sessionKind !== "unknown") ||
    typeof observedAt !== "number" ||
    !Number.isFinite(observedAt) ||
    observedAt < 0 ||
    observedAt > 8_640_000_000_000_000 ||
    (supersedesKey !== undefined && typeof supersedesKey !== "string")
  ) {
    return undefined;
  }
  return {
    originClass,
    sessionKind,
    observedAt,
    ...(supersedesKey === undefined ? {} : { supersedesKey }),
  };
}

function optionalHitFields(hit: Record<string, unknown>) {
  const fields: Pick<
    MemorySearchResult,
    "vectorScore" | "textScore" | "importance" | "triggers" | "projectKey" | "citation"
  > = {};
  for (const key of ["vectorScore", "textScore", "importance"] as const) {
    const value = hit[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("Invalid memory score");
    }
    fields[key] = value;
  }
  for (const key of ["triggers", "projectKey", "citation"] as const) {
    const value = hit[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      throw new Error("Invalid memory metadata");
    }
    fields[key] = value;
  }
  return fields;
}

function probeResult(value: unknown): MemoryEmbeddingProbeResult {
  const result = record(value);
  if (typeof result.ok !== "boolean") {
    throw new Error("Invalid memory availability");
  }
  return result as MemoryEmbeddingProbeResult;
}

function booleanResult(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("Invalid memory availability");
  }
  return value;
}

function debugResult(value: unknown, provider: string): MemorySearchRuntimeDebug {
  const result = record(value);
  if (result.backend !== "builtin") {
    throw new Error("Invalid memory debug event");
  }
  const debug = result as MemorySearchRuntimeDebug;
  return debug.embeddingBootstrap?.provider === MEMORY_RELAY_PROVIDER
    ? { ...debug, embeddingBootstrap: { ...debug.embeddingBootstrap, provider } }
    : debug;
}

function progressResult(value: unknown): MemorySyncProgressUpdate {
  const result = record(value);
  if (
    typeof result.completed !== "number" ||
    !Number.isFinite(result.completed) ||
    typeof result.total !== "number" ||
    !Number.isFinite(result.total) ||
    (result.label !== undefined && typeof result.label !== "string")
  ) {
    throw new Error("Invalid memory progress");
  }
  return {
    completed: result.completed,
    total: result.total,
    ...(result.label === undefined ? {} : { label: result.label }),
  };
}

function readResult(value: unknown): MemoryReadResult {
  const result = record(value);
  if (
    typeof result.path !== "string" ||
    typeof result.text !== "string" ||
    (result.status !== "ok" && result.status !== "not_found") ||
    (result.status === "not_found" && result.text !== "")
  ) {
    throw new Error("Invalid memory read result");
  }
  return result as MemoryReadResult;
}

function safeHits(hits: unknown): MemorySearchResult[] {
  if (!Array.isArray(hits)) {
    throw new Error("Invalid memory results");
  }
  return hits.map((value: unknown) => {
    const hit = record(value);
    if (
      hit?.source !== "memory" ||
      typeof hit.path !== "string" ||
      hit.path === "." ||
      hit.path === ".." ||
      hit.path.startsWith("../") ||
      path.isAbsolute(hit.path) ||
      path.win32.isAbsolute(hit.path) ||
      hit.path.includes("\\") ||
      hit.path.includes("\0") ||
      path.posix.normalize(hit.path) !== hit.path ||
      typeof hit.snippet !== "string" ||
      typeof hit.startLine !== "number" ||
      !Number.isSafeInteger(hit.startLine) ||
      hit.startLine < 1 ||
      typeof hit.endLine !== "number" ||
      !Number.isSafeInteger(hit.endLine) ||
      hit.endLine < hit.startLine ||
      typeof hit.score !== "number" ||
      !Number.isFinite(hit.score)
    ) {
      throw new Error("Invalid workspace memory hit");
    }
    const provenance = safeProvenance(hit.provenance);
    // The legacy originClass field cannot grant automatic recall eligibility.
    return {
      path: hit.path,
      startLine: hit.startLine,
      endLine: hit.endLine,
      snippet: hit.snippet,
      score: hit.score,
      source: "memory",
      ...optionalHitFields(hit),
      originClass: provenance?.originClass ?? "untrusted",
      ...(provenance ? { provenance } : {}),
    };
  });
}

export async function createRemoteMemoryManager({
  child,
  config,
  embedding,
  signal,
}: RemoteMemoryManagerOptions): Promise<Required<MemorySearchManager>> {
  // Attach process listeners before loading the runtime: a failed spawn can emit
  // its error while dynamic imports are still pending.
  const deadlinePromise = import("openclaw/plugin-sdk/memory-core-host-engine-storage");
  let deadline: Awaited<typeof deadlinePromise>;
  let closed = false;
  let cachedStatus: MemoryProviderStatus;
  let cachedAvailability: MemoryEmbeddingProbeResult | null = null;
  let closePromise: Promise<void> | undefined;
  const lifetime = new AbortController();
  const searches = new Map<number, { control?: MemorySearchDeadlineControl }>();
  let searchSequence = 0;
  // Native indexing admits four requests at once. Queue within the wire's
  // bounded admission limit rather than failing valid work above our limit.
  const embeddingQueues: Promise<unknown>[] = [Promise.resolve(), Promise.resolve()];
  let nextEmbeddingQueue = 0;
  const exit = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
    } else {
      child.once("close", () => resolve());
    }
  });
  function assertOpen() {
    signal?.throwIfAborted();
    if (closed) {
      throw new Error("Remote memory manager is closed");
    }
  }
  function stop() {
    if (closed) {
      return;
    }
    closed = true;
    lifetime.abort();
    child.stdin.destroy();
    child.kill("SIGTERM");
  }
  const abort = () => peer.close(new Error("Remote memory binding revoked"));
  const peer = createMemoryPeer({
    input: child.stdout,
    output: child.stdin,
    onFailure: stop,
    handle: async (method, params, { signal: requestSignal, event }) => {
      const embeddingDeadline = await deadlinePromise;
      assertOpen();
      if (method !== "embed" || !embedding) {
        throw new Error("Unexpected embedding request");
      }
      const request = embeddingInputs(params);
      const search = request.searchId === undefined ? undefined : searches.get(request.searchId);
      if (request.searchId !== undefined && !search) {
        throw new Error("Unknown memory search");
      }
      const callSignal = AbortSignal.any([
        lifetime.signal,
        requestSignal,
        AbortSignal.timeout(30000),
      ]);
      const lane = nextEmbeddingQueue++ % embeddingQueues.length;
      const operation = embeddingQueues[lane]!.then(async () => {
        assertOpen();
        callSignal.throwIfAborted();
        const control = search && embeddingDeadline.createMemorySearchDeadlineControl();
        let paused = false;
        const unsubscribe = control?.subscribe((action) => {
          paused = action === "pause";
          search?.control?.report(action);
          event({ kind: "deadline", value: action });
        });
        try {
          const result = await embedding.provider.embedBatch(request.inputs, {
            inputType: request.inputType,
            signal: callSignal,
            ...(control ? { [embeddingDeadline.MEMORY_SEARCH_DEADLINE_CONTROL]: control } : {}),
          });
          assertOpen();
          callSignal.throwIfAborted();
          return embeddingVectors(result, request.inputs.length);
        } finally {
          unsubscribe?.();
          // A cancelled provider must not leave its caller's deadline paused.
          if (paused) {
            search?.control?.report("resume");
            try {
              event({ kind: "deadline", value: "resume" });
            } catch {
              // A revoked worker has already stopped its deadline owner.
            }
          }
        }
      });
      embeddingQueues[lane] = operation.catch(() => {});
      return await operation;
    },
  });
  child.once("error", () => peer.close());
  child.once("close", () => peer.close());
  // Native diagnostics are not protocol responses and may contain workspace text.
  let stderrBytes = 0;
  child.stderr?.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 256 * 1024) {
      peer.close(new Error("Memory diagnostics exceeded limit"));
    }
  });
  signal?.addEventListener("abort", abort, { once: true });
  async function invoke(
    method: string,
    params: unknown = {},
    options: NonNullable<Parameters<typeof peer.call>[2]> = {},
  ): Promise<unknown> {
    assertOpen();
    const reply = record(await peer.call(method, params, options));
    const status = record(reply.status);
    assertOpen();
    if (
      status.backend !== "builtin" ||
      status.provider !== (config.provider === "none" ? "none" : MEMORY_RELAY_PROVIDER) ||
      status.model !== (config.provider === "none" ? undefined : config.model) ||
      JSON.stringify(status.sources) !== '["memory"]'
    ) {
      throw new Error("Unexpected remote memory index");
    }
    // The native worker owns the optional diagnostic payload; validate the bound index identity here.
    const providerState = record(record(status.custom).providerState);
    cachedStatus = {
      ...status,
      backend: "builtin",
      provider: config.provider,
      requestedProvider: config.provider,
      custom: {
        ...record(status.custom),
        providerState: {
          ...providerState,
          ...(providerState.providerId === MEMORY_RELAY_PROVIDER
            ? { providerId: config.provider }
            : {}),
          ...(providerState.requestedProvider === MEMORY_RELAY_PROVIDER
            ? { requestedProvider: config.provider }
            : {}),
        },
      },
    };
    cachedAvailability = reply.availability === null ? null : probeResult(reply.availability);
    if (
      ["search", "listTriggerCandidates", "listCuratedProjectCandidates"].includes(method) &&
      (cachedStatus.lastSyncError ||
        record(cachedStatus.custom?.providerState).mode !==
          (config.provider === "none" ? "fts-only" : "active"))
    ) {
      throw new Error("Remote memory index is unavailable");
    }
    return reply.value;
  }
  const manager: Required<MemorySearchManager> = {
    async search(query, opts = {}) {
      const { signal: callSignal, onDebug, onPartialResults, ...searchOptions } = opts;
      const searchId = ++searchSequence;
      searches.set(searchId, {
        control: opts[deadline.MEMORY_SEARCH_DEADLINE_CONTROL],
      });
      try {
        return safeHits(
          await invoke(
            "search",
            { query, ...searchOptions, searchId },
            {
              signal: callSignal,
              event: (value) => {
                const event = record(value);
                assertOpen();
                callSignal?.throwIfAborted();
                if (event.kind === "debug") {
                  onDebug?.(debugResult(event.value, config.provider));
                }
                if (event.kind === "partial") {
                  onPartialResults?.(event.value === null ? null : safeHits(event.value));
                }
              },
            },
          ),
        );
      } finally {
        searches.delete(searchId);
      }
    },
    async listTriggerCandidates(opts = {}) {
      return safeHits(await invoke("listTriggerCandidates", opts));
    },
    async listCuratedProjectCandidates(opts) {
      return safeHits(await invoke("listCuratedProjectCandidates", opts));
    },
    async readFile(params) {
      return readResult(await invoke("readFile", params));
    },
    status() {
      assertOpen();
      return structuredClone(cachedStatus);
    },
    async sync(params = {}) {
      const { progress, ...wire } = params;
      await invoke("sync", wire, {
        event: (value) => {
          const event = record(value);
          assertOpen();
          if (event.kind === "progress") {
            progress?.(progressResult(event.value));
          }
        },
      });
    },
    getCachedEmbeddingAvailability() {
      assertOpen();
      if (
        cachedAvailability?.cacheExpiresAtMs !== undefined &&
        Date.now() >= cachedAvailability.cacheExpiresAtMs
      ) {
        cachedAvailability = null;
      }
      return structuredClone(cachedAvailability);
    },
    async probeEmbeddingAvailability() {
      return probeResult(await invoke("probeEmbeddingAvailability"));
    },
    async probeVectorStoreAvailability() {
      return booleanResult(await invoke("probeVectorStoreAvailability"));
    },
    async probeVectorAvailability() {
      return booleanResult(await invoke("probeVectorAvailability"));
    },
    close() {
      closePromise ??= (async () => {
        signal?.removeEventListener("abort", abort);
        if (!closed) {
          try {
            await invoke("close", {}, { timeoutMs: 5000 });
          } catch {
            /* Reap an unreachable worker too. */
          } finally {
            peer.close();
          }
        }
        const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
        try {
          await exit;
        } finally {
          clearTimeout(kill);
        }
        // Aborting the transport does not settle provider calls already in flight.
        await Promise.all(embeddingQueues);
        await embedding?.provider.close?.();
      })().catch((error: unknown) => {
        closePromise = undefined;
        throw error;
      });
      return closePromise;
    },
  };
  try {
    deadline = await deadlinePromise;
    await invoke("initialize", config);
    return manager;
  } catch (error) {
    peer.close();
    await manager.close();
    throw error;
  }
}
