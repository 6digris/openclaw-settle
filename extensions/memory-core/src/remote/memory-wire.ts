import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// The worker relays embeddings without replacing any installed provider.
export const MEMORY_RELAY_PROVIDER = "workspace-memory-relay";

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_EMBED_ITEMS = 32;
export const MAX_EMBED_BYTES = 256 * 1024;

export function objectFields(
  value: unknown,
  fields: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  ) {
    throw new Error("Invalid memory protocol fields");
  }
}

export type MemoryEmbeddingInputs = {
  inputs: string[];
  inputType: "query" | "document";
  searchId?: number;
};

function assertEmbeddingInputs(params: unknown): asserts params is MemoryEmbeddingInputs {
  objectFields(params, ["inputs", "inputType", "searchId"]);
  if (
    !Array.isArray(params.inputs) ||
    !params.inputs.length ||
    params.inputs.length > MAX_EMBED_ITEMS ||
    params.inputs.some(
      // Unicode mode matches lone surrogates but treats valid pairs as one code point.
      (text: unknown) =>
        typeof text !== "string" ||
        /[\uD800-\uDFFF]/u.test(text) ||
        Buffer.byteLength(text) > 32 * 1024,
    ) ||
    Buffer.byteLength(JSON.stringify(params.inputs)) > MAX_EMBED_BYTES ||
    (params.inputType !== "query" && params.inputType !== "document") ||
    (params.searchId !== undefined &&
      (params.inputType !== "query" ||
        typeof params.searchId !== "number" ||
        !Number.isSafeInteger(params.searchId) ||
        params.searchId < 1))
  ) {
    throw new Error("Invalid memory embedding input");
  }
}

export function embeddingInputs(params: unknown): MemoryEmbeddingInputs {
  assertEmbeddingInputs(params);
  return params;
}

export function embeddingVectors(value: unknown, count: number): number[][] {
  const dimensions = Array.isArray(value) && Array.isArray(value[0]) ? value[0].length : 0;
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    !dimensions ||
    dimensions > 4096 ||
    !value.every(
      (vector: unknown): vector is number[] =>
        Array.isArray(vector) &&
        vector.length === dimensions &&
        vector.every((number: unknown) => typeof number === "number" && Number.isFinite(number)),
    )
  ) {
    throw new Error("Invalid memory embedding output");
  }
  return value;
}

type MemoryFrame =
  | { type: "request"; id: number; method: string; params: unknown }
  | { type: "response"; id: number; result?: unknown; error?: true }
  | { type: "event"; id: number; event: unknown }
  | { type: "cancel"; id: number };

type MemoryRequestContext = {
  signal: AbortSignal;
  event: (event: unknown) => void;
};

type MemoryCallOptions = {
  signal?: AbortSignal;
  event?: (event: unknown) => void;
  timeoutMs?: number;
};

type MemoryPeerOptions = {
  // Supply byte streams without a text encoding; the peer owns UTF-8 decoding.
  input: Readable;
  output: Writable;
  handle: (method: unknown, params: unknown, context: MemoryRequestContext) => unknown;
  onFailure?: (error: unknown) => void;
  onEvent?: (event: unknown) => void;
};

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
  event?: (event: unknown) => void;
};

// Full duplex framing lets the worker request embeddings on the same byte streams.
// Reject oversized partial frames before allocating a complete JSON document.
export function createMemoryPeer({ input, output, handle, onFailure, onEvent }: MemoryPeerOptions) {
  let buffer = "";
  let bytes = 0;
  let sequence = 0;
  let stopped = false;
  const decoder = new StringDecoder("utf8");
  const pending = new Map<number, PendingRequest>();
  const incoming = new Map<number, AbortController>();

  function fail(error: unknown = new Error("Memory transport closed")) {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.cleanup();
      entry.reject(error);
    }
    pending.clear();
    for (const controller of incoming.values()) {
      controller.abort(error);
    }
    incoming.clear();
    input.off("data", receive);
    onFailure?.(error);
  }
  function send(frame: MemoryFrame) {
    if (stopped) {
      throw new Error("Memory transport closed");
    }
    const wire = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(wire) > MAX_FRAME_BYTES || output.writableLength > MAX_FRAME_BYTES) {
      throw new Error("Memory frame exceeds limit");
    }
    output.write(wire);
  }
  async function dispatch(frame: unknown) {
    objectFields(frame, ["type", "id", "method", "params", "result", "error", "event"]);
    if (typeof frame.id !== "number" || !Number.isSafeInteger(frame.id) || frame.id < 1) {
      throw new Error("Invalid memory frame id");
    }
    const id = frame.id;
    if (frame.type === "response") {
      const entry = pending.get(frame.id);
      if (!entry) {
        return;
      }
      pending.delete(frame.id);
      clearTimeout(entry.timer);
      entry.cleanup();
      if (frame.error) {
        entry.reject(new Error("Remote memory operation failed"));
      } else {
        entry.resolve(frame.result);
      }
    } else if (frame.type === "cancel") {
      incoming.get(frame.id)?.abort(new Error("Memory operation cancelled"));
    } else if (frame.type === "event") {
      pending.get(frame.id)?.event?.(frame.event);
      onEvent?.(frame.event);
    } else if (frame.type === "request") {
      if (incoming.size >= 16 || incoming.has(frame.id)) {
        throw new Error("Memory admission limit");
      }
      const controller = new AbortController();
      incoming.set(frame.id, controller);
      try {
        const result = await handle(frame.method, frame.params, {
          signal: controller.signal,
          event: (event) => send({ type: "event", id, event }),
        });
        controller.signal.throwIfAborted();
        send({ type: "response", id, result });
      } catch {
        if (!stopped) {
          send({ type: "response", id, error: true });
        }
      } finally {
        incoming.delete(frame.id);
      }
    } else {
      throw new Error("Unsupported memory frame");
    }
  }
  function receive(chunk: Buffer) {
    bytes += chunk.length;
    if (bytes > MAX_FRAME_BYTES && !chunk.includes(10)) {
      fail(new Error("Memory frame exceeds limit"));
      return;
    }
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        fail(new Error("Memory frame exceeds limit"));
        return;
      }
      try {
        void dispatch(JSON.parse(line)).catch(fail);
      } catch (error) {
        fail(error);
        return;
      }
    }
    bytes = Buffer.byteLength(buffer);
    if (bytes > MAX_FRAME_BYTES) {
      fail(new Error("Memory frame exceeds limit"));
    }
  }
  input.on("data", receive);
  input.once("end", () => fail());
  input.once("error", fail);
  output.once("error", fail);
  return {
    close: fail,
    get activeRequests() {
      return pending.size;
    },
    call(
      method: string,
      params: unknown,
      { signal, event, timeoutMs = 120_000 }: MemoryCallOptions = {},
    ): Promise<unknown> {
      signal?.throwIfAborted();
      if (stopped || pending.size >= 16) {
        return Promise.reject(new Error("Memory transport unavailable"));
      }
      const id = ++sequence;
      return new Promise<unknown>((resolve, reject) => {
        const abort = () => {
          try {
            send({ type: "cancel", id });
          } catch {
            /* Already closed. */
          }
          fail(new Error("Memory operation cancelled"));
        };
        const timer = setTimeout(() => fail(new Error("Memory operation timed out")), timeoutMs);
        const cleanup = () => signal?.removeEventListener("abort", abort);
        pending.set(id, { resolve, reject, timer, cleanup, event });
        signal?.addEventListener("abort", abort, { once: true });
        try {
          send({ type: "request", id, method, params });
        } catch (error) {
          fail(error);
        }
      });
    },
  };
}
