import fs from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { MemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { MemorySearchManager } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type {
  MemoryWorkerConfiguration,
  MemoryWorkerHost,
  MemoryWorkerManager,
} from "./memory-native.js";
import {
  createMemoryPeer,
  embeddingInputs,
  embeddingVectors,
  MAX_EMBED_BYTES,
  MAX_EMBED_ITEMS,
  objectFields,
} from "./memory-wire.js";

export type MemoryWorkerNativeRuntime = Pick<
  typeof import("./memory-native.js"),
  "openNativeManager" | "MEMORY_SEARCH_DEADLINE_CONTROL" | "createMemorySearchDeadlineControl"
>;

export type MemoryWorkerOptions = {
  workspace: string;
  stateDir: string;
  agentId: string;
  input: Readable;
  output: Writable;
  loadHost: () => Promise<MemoryWorkerHost>;
  loadNative?: () => Promise<MemoryWorkerNativeRuntime>;
};

type SearchOptions = NonNullable<Parameters<MemorySearchManager["search"]>[1]>;
type WorkerCall =
  | { method: "initialize"; params: MemoryWorkerConfiguration }
  | {
      method: "search";
      params: Pick<
        SearchOptions,
        "maxResults" | "minScore" | "lexicalOnly" | "activeProjectKeys" | "sessionKey"
      > & { query: string; searchId?: number };
    }
  | { method: "readFile"; params: Parameters<MemorySearchManager["readFile"]>[0] }
  | { method: "sync"; params: { reason?: string; force?: boolean } }
  | { method: "listTriggerCandidates"; params: { limit?: number; activeProjectKeys?: string[] } }
  | {
      method: "listCuratedProjectCandidates";
      params: { limit?: number; activeProjectKeys: string[] };
    }
  | {
      method:
        | "probeEmbeddingAvailability"
        | "probeVectorStoreAvailability"
        | "probeVectorAvailability"
        | "close";
    };

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error("Invalid memory range");
  }
  return value;
}

function finiteNumber(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Invalid memory score");
  }
  return value;
}

function boolean(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error("Invalid memory boolean");
  }
  return value;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || /[\uD800-\uDFFF]/u.test(value)) {
    throw new Error("Invalid memory text");
  }
  return value;
}

function projectKeys(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error("Invalid memory project keys");
  }
  return value.map((key: unknown) => text(key, 1024));
}

function validateCall(method: unknown, params: unknown): WorkerCall {
  if (method === "initialize") {
    objectFields(params, [
      "provider",
      "model",
      "identity",
      "maxInputTokens",
      "memoryGetMaxChars",
      "query",
      "cache",
      "vectorEnabled",
      "tokenizer",
    ]);
    const provider = text(params.provider, 64);
    const model = text(params.model, 256);
    const identity = text(params.identity, 64);
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(provider) ||
      (!model && provider !== "none") ||
      !/^[a-f0-9]{64}$/.test(identity)
    ) {
      throw new Error("Invalid memory identity");
    }
    let query: MemoryWorkerConfiguration["query"];
    if (params.query !== undefined) {
      objectFields(params.query, ["maxResults", "minScore"]);
      query = {
        maxResults: positiveInteger(params.query.maxResults),
        minScore: finiteNumber(params.query.minScore),
      };
    }
    let cache: MemoryWorkerConfiguration["cache"];
    if (params.cache !== undefined) {
      objectFields(params.cache, ["enabled"]);
      cache = { enabled: boolean(params.cache.enabled) };
    }
    const tokenizer = params.tokenizer;
    if (tokenizer !== undefined && tokenizer !== "unicode61" && tokenizer !== "trigram") {
      throw new Error("Invalid memory tokenizer");
    }
    return {
      method,
      params: {
        provider,
        model,
        identity,
        query,
        cache,
        tokenizer,
        maxInputTokens: positiveInteger(params.maxInputTokens),
        memoryGetMaxChars: positiveInteger(params.memoryGetMaxChars),
        vectorEnabled: boolean(params.vectorEnabled),
      },
    };
  }
  if (method === "search") {
    objectFields(params, [
      "query",
      "maxResults",
      "minScore",
      "lexicalOnly",
      "activeProjectKeys",
      "sources",
      "sessionKey",
      "searchId",
    ]);
    const query = text(params.query, 8192);
    if (Buffer.byteLength(query) > 8192) {
      throw new Error("Invalid memory query");
    }
    if (params.sources !== undefined && JSON.stringify(params.sources) !== '["memory"]') {
      throw new Error("Only workspace memory is available");
    }
    return {
      method,
      params: {
        query,
        maxResults: positiveInteger(params.maxResults),
        minScore: finiteNumber(params.minScore),
        lexicalOnly: boolean(params.lexicalOnly),
        activeProjectKeys: projectKeys(params.activeProjectKeys),
        sessionKey: params.sessionKey === undefined ? undefined : text(params.sessionKey, 4096),
        searchId: positiveInteger(params.searchId),
      },
    };
  }
  if (method === "readFile") {
    objectFields(params, ["relPath", "from", "lines"]);
    const relPath = text(params.relPath, 4096);
    if (
      !relPath ||
      relPath.includes("\0") ||
      relPath.includes("\\") ||
      path.posix.isAbsolute(relPath) ||
      path.win32.isAbsolute(relPath) ||
      path.posix.normalize(relPath) !== relPath ||
      relPath.split("/").includes("..")
    ) {
      throw new Error("Invalid memory path");
    }
    return {
      method,
      params: { relPath, from: positiveInteger(params.from), lines: positiveInteger(params.lines) },
    };
  }
  if (method === "sync") {
    objectFields(params, ["reason", "force"]);
    return {
      method,
      params: {
        reason: params.reason === undefined ? undefined : text(params.reason, 4096),
        force: boolean(params.force),
      },
    };
  }
  if (method === "listTriggerCandidates" || method === "listCuratedProjectCandidates") {
    objectFields(params, ["limit", "activeProjectKeys"]);
    const limit = positiveInteger(params.limit);
    const activeProjectKeys = projectKeys(params.activeProjectKeys);
    if (method === "listCuratedProjectCandidates") {
      if (!activeProjectKeys) {
        throw new Error("Active project keys are required");
      }
      return { method, params: { limit, activeProjectKeys } };
    }
    return { method, params: { limit, activeProjectKeys } };
  }
  if (
    method === "probeEmbeddingAvailability" ||
    method === "probeVectorStoreAvailability" ||
    method === "probeVectorAvailability" ||
    method === "close"
  ) {
    objectFields(params, []);
    return { method };
  }
  throw new Error("Unsupported memory operation");
}

export async function serveMemoryWorker({
  workspace,
  stateDir,
  agentId,
  input,
  output,
  loadHost,
  loadNative = () => import("./memory-native.js"),
}: MemoryWorkerOptions): Promise<{ close: () => void }> {
  if (
    ![workspace, stateDir].every(
      (value) =>
        typeof value === "string" &&
        path.isAbsolute(value) &&
        path.normalize(value) === value &&
        value !== path.parse(value).root &&
        !value.includes("\0"),
    ) ||
    workspace === stateDir ||
    stateDir.startsWith(workspace + path.sep) ||
    workspace.startsWith(stateDir + path.sep) ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)
  ) {
    throw new Error("Invalid worker paths or agent");
  }
  // Both the host factories and native runtime may capture state paths at import time.
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "memory-worker-config.json");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const host = await loadHost();
  let manager: MemoryWorkerManager | undefined;
  let initialized = false;
  let native: MemoryWorkerNativeRuntime | undefined;
  let searchId: number | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const lifetime = new AbortController();
  const peer = createMemoryPeer({
    input,
    output,
    onFailure: () => {
      lifetime.abort();
      void queue
        .catch(() => {})
        .then(() => manager?.close())
        .catch(() => {});
    },
    handle: (method, params, context) => {
      const call = validateCall(method, params);
      const run = queue.then(async () => {
        context.signal.throwIfAborted();
        lifetime.signal.throwIfAborted();
        const signal = AbortSignal.any([context.signal, lifetime.signal]);
        let value: unknown;
        if (call.method === "initialize") {
          if (initialized) {
            throw new Error("Memory worker already initialized");
          }
          initialized = true;
          const loaded = await loadNative();
          native = loaded;
          const embed: MemoryEmbeddingProvider["embedBatch"] = async (inputs, options = {}) => {
            const texts = inputs.map((item) => {
              if (typeof item === "string") {
                return item;
              }
              if (item.parts?.length) {
                throw new Error("Only text memory embeddings are supported");
              }
              return item.text;
            });
            const vectors: number[][] = [];
            for (let offset = 0; offset < texts.length;) {
              const batch: string[] = [];
              while (
                offset < texts.length &&
                batch.length < MAX_EMBED_ITEMS &&
                (!batch.length ||
                  Buffer.byteLength(JSON.stringify([...batch, texts[offset]])) <= MAX_EMBED_BYTES)
              ) {
                const item = texts[offset++];
                if (item !== undefined) {
                  batch.push(item);
                }
              }
              const request = embeddingInputs({
                inputs: batch,
                inputType: options.inputType === "query" ? "query" : "document",
                ...(options.inputType === "query" && searchId ? { searchId } : {}),
              });
              const reply = await peer.call("embed", request, {
                signal: AbortSignal.any([
                  lifetime.signal,
                  ...(options.signal ? [options.signal] : []),
                ]),
                timeoutMs: 35_000,
                event: (event) => {
                  objectFields(event, ["kind", "value"]);
                  if (
                    event.kind !== "deadline" ||
                    (event.value !== "pause" && event.value !== "resume")
                  ) {
                    throw new Error("Invalid memory deadline event");
                  }
                  options[loaded.MEMORY_SEARCH_DEADLINE_CONTROL]?.report(event.value);
                },
              });
              vectors.push(...embeddingVectors(reply, request.inputs.length));
            }
            return vectors;
          };
          manager = await loaded.openNativeManager({
            workspace,
            agentId,
            config: call.params,
            host,
            embed,
          });
          if (call.params.provider === "none" || call.params.vectorEnabled === false) {
            // The vector probe skips provider initialization when vectors are disabled.
            // Candidate listing still needs the native provider state initialized.
            await manager.probeEmbeddingAvailability();
          } else {
            await manager.probeVectorAvailability();
          }
        } else {
          if (!manager || !native) {
            throw new Error("Memory worker is not initialized");
          }
          switch (call.method) {
            case "search": {
              const { query, searchId: requestSearchId, ...options } = call.params;
              searchId = requestSearchId;
              try {
                value = await manager.search(query, {
                  ...options,
                  sources: ["memory"],
                  signal,
                  [native.MEMORY_SEARCH_DEADLINE_CONTROL]:
                    native.createMemorySearchDeadlineControl(),
                  onDebug: (debug) => context.event({ kind: "debug", value: debug }),
                  onPartialResults: (partial) => context.event({ kind: "partial", value: partial }),
                });
              } finally {
                searchId = undefined;
              }
              break;
            }
            case "sync":
              await manager.sync({
                ...call.params,
                progress: (progress) => context.event({ kind: "progress", value: progress }),
              });
              if (manager.status().lastSyncError) {
                throw new Error("Native memory index did not sync");
              }
              break;
            case "close": {
              const reply = {
                status: manager.status(),
                availability: manager.getCachedEmbeddingAvailability(),
                value: null,
              };
              await manager.close();
              return reply;
            }
            case "readFile":
              value = await manager.readFile(call.params);
              break;
            case "listTriggerCandidates":
              value = await manager.listTriggerCandidates(call.params);
              break;
            case "listCuratedProjectCandidates":
              value = await manager.listCuratedProjectCandidates(call.params);
              break;
            case "probeEmbeddingAvailability":
              value = await manager.probeEmbeddingAvailability();
              break;
            case "probeVectorStoreAvailability":
              value = await manager.probeVectorStoreAvailability();
              break;
            case "probeVectorAvailability":
              value = await manager.probeVectorAvailability();
              break;
          }
        }
        signal.throwIfAborted();
        return {
          value: value ?? null,
          status: manager.status(),
          availability: manager.getCachedEmbeddingAvailability() ?? null,
        };
      });
      queue = run.catch(() => {});
      return run;
    },
  });
  return { close: () => peer.close() };
}
