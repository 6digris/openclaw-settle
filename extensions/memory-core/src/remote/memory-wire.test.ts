import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryPeer,
  embeddingInputs,
  embeddingVectors,
  MAX_EMBED_BYTES,
  MAX_EMBED_ITEMS,
  MAX_FRAME_BYTES,
  objectFields,
} from "./memory-wire.js";

type Peer = ReturnType<typeof createMemoryPeer>;
type PeerOptions = Parameters<typeof createMemoryPeer>[0];
const peers: Peer[] = [];
const streams: Writable[] = [];

function stream() {
  const value = new PassThrough();
  streams.push(value);
  return value;
}

function peer(options: Partial<PeerOptions> = {}) {
  const input = options.input ?? stream();
  const output = options.output ?? stream();
  const value = createMemoryPeer({ input, output, handle: () => undefined, ...options });
  peers.push(value);
  return { peer: value, input, output };
}

const settled = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

afterEach(() => {
  for (const value of peers.splice(0)) {
    value.close();
  }
  for (const value of streams.splice(0)) {
    value.destroy();
  }
  vi.useRealTimers();
});

describe("memory embedding wire validation", () => {
  it("accepts bounded text and query correlation without altering the request", () => {
    const request = { inputs: ["记忆🧠"], inputType: "query", searchId: 1 };
    expect(embeddingInputs(request)).toBe(request);
    expect(
      embeddingInputs({ inputs: Array<string>(MAX_EMBED_ITEMS).fill(""), inputType: "document" })
        .inputs,
    ).toHaveLength(MAX_EMBED_ITEMS);
    expect(
      embeddingInputs({ inputs: ["x".repeat(32 * 1024)], inputType: "document" }).inputs[0],
    ).toHaveLength(32 * 1024);
  });

  it.each([
    null,
    [],
    {},
    { inputs: [], inputType: "query" },
    { inputs: ["text"], inputType: "other" },
    { inputs: [3], inputType: "document" },
    { inputs: ["\ud800"], inputType: "document" },
    { inputs: ["\udc00"], inputType: "document" },
    { inputs: ["\ud800x"], inputType: "document" },
    { inputs: Array<string>(MAX_EMBED_ITEMS + 1).fill("text"), inputType: "document" },
    { inputs: ["记".repeat(11_000)], inputType: "document" },
    { inputs: Array<string>(8).fill("x".repeat(32 * 1024)), inputType: "document" },
    { inputs: ["text"], inputType: "query", searchId: 0 },
    { inputs: ["text"], inputType: "query", searchId: 1.5 },
    { inputs: ["text"], inputType: "query", searchId: Number.MAX_SAFE_INTEGER + 1 },
    { inputs: ["text"], inputType: "query", searchId: "1" },
    { inputs: ["text"], inputType: "document", searchId: 1 },
    { inputs: ["text"], inputType: "query", unexpected: true },
  ])("rejects invalid embedding request %#", (request) => {
    expect(() => embeddingInputs(request)).toThrow(/Invalid memory/);
  });

  it("counts JSON escaping and array overhead in the batch byte limit", () => {
    const inputs = Array<string>(4).fill("\n".repeat(32 * 1024));
    expect(Buffer.byteLength(inputs.join(""))).toBeLessThan(MAX_EMBED_BYTES);
    expect(() => embeddingInputs({ inputs, inputType: "document" })).toThrow();
  });

  it("requires only allowlisted object fields", () => {
    expect(() => objectFields({ allowed: 1 }, ["allowed"])).not.toThrow();
    for (const value of [null, [], "text", { unexpected: 1 }]) {
      expect(() => objectFields(value, ["allowed"])).toThrow(/protocol fields/);
    }
  });

  it("accepts finite equal-length vectors through the dimension limit", () => {
    const vectors = [Array<number>(4096).fill(0), Array<number>(4096).fill(-1)];
    expect(embeddingVectors(vectors, 2)).toBe(vectors);
  });

  it.each([
    null,
    [],
    [[]],
    [[Number.NaN]],
    [[Infinity]],
    [["1"]],
    [[1], [1, 2]],
    [Array<number>(4097).fill(0)],
  ])("rejects invalid embedding vectors %#", (vectors) =>
    expect(() => embeddingVectors(vectors, 1)).toThrow(/embedding output/),
  );

  it("requires the returned vector count to match the requested text count", () => {
    expect(() => embeddingVectors([[1]], 2)).toThrow(/embedding output/);
    expect(() => embeddingVectors([[1], [1, 2]], 2)).toThrow(/embedding output/);
  });
});

describe("memory peer", () => {
  it("supports duplex requests and correlated events during an active search", async () => {
    const a = stream();
    const b = stream();
    const partials: unknown[] = [];
    const deadlines: unknown[] = [];
    const globalEvents: unknown[] = [];
    const client = peer({
      input: a,
      output: b,
      onEvent: (event) => globalEvents.push(event),
      handle: (method, params, context) => {
        expect(method).toBe("embed");
        expect(embeddingInputs(params).inputs).toEqual(["query"]);
        context.event({ kind: "deadline", value: "pause" });
        context.event({ kind: "deadline", value: "resume" });
        return [[1]];
      },
    }).peer;
    const server: Peer = peer({
      input: b,
      output: a,
      handle: async (method, _params, context) => {
        expect(method).toBe("search");
        context.event({ kind: "partial", value: [] });
        const vectors = await server.call(
          "embed",
          { inputs: ["query"], inputType: "query" },
          {
            event: (event) => deadlines.push(event),
          },
        );
        return embeddingVectors(vectors, 1);
      },
    }).peer;
    expect(await client.call("search", {}, { event: (event) => partials.push(event) })).toEqual([
      [1],
    ]);
    expect(partials).toEqual([{ kind: "partial", value: [] }]);
    expect(globalEvents).toEqual(partials);
    expect(deadlines).toEqual([
      { kind: "deadline", value: "pause" },
      { kind: "deadline", value: "resume" },
    ]);
    expect(client.activeRequests).toBe(0);
    expect(server.activeRequests).toBe(0);
  });

  it("decodes UTF-8 split at every byte and multiple frames in one chunk", async () => {
    const input = stream();
    const output = stream();
    const events: unknown[] = [];
    const client = peer({ input, output }).peer;
    output.on("data", (chunk: Buffer) => {
      const request: { id: number } = JSON.parse(chunk.toString());
      const frame = Buffer.from(
        JSON.stringify({ type: "event", id: request.id, event: "记忆" }) + "\n",
      );
      for (const byte of frame) {
        input.write(Buffer.from([byte]));
      }
      input.write(
        JSON.stringify({ type: "response", id: 999, result: "ignored" }) +
          "\n" +
          JSON.stringify({ type: "response", id: request.id, result: "记忆" }) +
          "\n",
      );
    });
    expect(await client.call("search", {}, { event: (event) => events.push(event) })).toBe("记忆");
    expect(events).toEqual(["记忆"]);
  });

  it("sanitizes handler failures while allowing subsequent requests", async () => {
    const a = stream();
    const b = stream();
    const frames: string[] = [];
    a.on("data", (chunk: Buffer) => frames.push(chunk.toString()));
    const client = peer({ input: a, output: b }).peer;
    peer({
      input: b,
      output: a,
      handle: (method) => {
        if (method === "fail") {
          throw new Error("private handler detail");
        }
        return "ok";
      },
    });
    await expect(client.call("fail", {})).rejects.toThrow("Remote memory operation failed");
    expect(frames.join("")).not.toContain("private handler detail");
    expect(await client.call("retry", {})).toBe("ok");
  });

  it("cancels the incoming operation and rejects every pending call on caller abort", async () => {
    const a = stream();
    const b = stream();
    const signals: AbortSignal[] = [];
    const failures = vi.fn();
    const client = peer({ input: a, output: b, onFailure: failures }).peer;
    peer({
      input: b,
      output: a,
      handle: (_method, _params, { signal }) => {
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("Request aborted", { cause: signal.reason })),
            { once: true },
          );
        });
      },
    });
    const controller = new AbortController();
    const first = expect(client.call("search", {}, { signal: controller.signal })).rejects.toThrow(
      /cancelled/,
    );
    const second = expect(client.call("search", {})).rejects.toThrow(/cancelled/);
    controller.abort();
    await Promise.all([first, second]);
    expect(signals[0]?.aborted).toBe(true);
    expect(client.activeRequests).toBe(0);
    client.close();
    expect(failures).toHaveBeenCalledTimes(1);
    await expect(client.call("search", {})).rejects.toThrow(/unavailable/);
  });

  it("does not send a request for an already aborted caller", () => {
    const output = stream();
    const write = vi.spyOn(output, "write");
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    const client = peer({ output }).peer;
    expect(() => client.call("search", {}, { signal: controller.signal })).toThrow(
      "already cancelled",
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("fails all pending calls on timeout", async () => {
    vi.useFakeTimers();
    const client = peer().peer;
    const first = expect(client.call("search", {}, { timeoutMs: 10 })).rejects.toThrow(/timed out/);
    const second = expect(client.call("search", {})).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([first, second]);
    expect(client.activeRequests).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limits pending outbound requests to sixteen", async () => {
    const client = peer().peer;
    const pending = Array.from({ length: 16 }, () =>
      expect(client.call("search", {})).rejects.toThrow(/closed/),
    );
    await expect(client.call("search", {})).rejects.toThrow(/unavailable/);
    expect(client.activeRequests).toBe(16);
    client.close();
    await Promise.all(pending);
  });

  it.each(["duplicate", "capacity"])(
    "rejects incoming request %s and aborts admitted handlers",
    async (mode) => {
      const input = stream();
      const signals: AbortSignal[] = [];
      const failed = vi.fn();
      peer({
        input,
        onFailure: failed,
        handle: (_method, _params, { signal }) => {
          signals.push(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("Request aborted", { cause: signal.reason })),
              { once: true },
            );
          });
        },
      });
      for (let index = 0; index < (mode === "duplicate" ? 2 : 17); index++) {
        input.write(
          JSON.stringify({
            type: "request",
            id: mode === "duplicate" ? 1 : index + 1,
            method: "search",
            params: {},
          }) + "\n",
        );
      }
      await settled();
      expect(failed).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Memory admission limit" }),
      );
      expect(signals).toHaveLength(mode === "duplicate" ? 1 : 16);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    },
  );

  it.each([
    "not json",
    JSON.stringify({ type: "other", id: 1 }),
    JSON.stringify({ type: "response", id: 0 }),
    JSON.stringify({ type: "response", id: "1" }),
    JSON.stringify({ type: "response", id: 1, unexpected: true }),
  ])("closes on malformed frame %#", async (frame) => {
    const input = stream();
    const failed = vi.fn();
    const client = peer({ input, onFailure: failed }).peer;
    const pending = expect(client.call("search", {})).rejects.toThrow();
    input.write(frame + "\n");
    await pending;
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("rejects oversized inbound frames (newline: %s)", (newline) => {
    const input = stream();
    const failed = vi.fn();
    peer({ input, onFailure: failed });
    input.write(
      Buffer.concat([
        Buffer.alloc(MAX_FRAME_BYTES + 1, 120),
        ...(newline ? [Buffer.from("\n")] : []),
      ]),
    );
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Memory frame exceeds limit" }),
    );
  });

  it("rejects oversized outbound frames", async () => {
    const client = peer().peer;
    await expect(client.call("search", "x".repeat(MAX_FRAME_BYTES))).rejects.toThrow(
      /exceeds limit/,
    );
  });

  it("rejects output backed up beyond the byte limit", async () => {
    const output = new Writable({ write() {} });
    streams.push(output);
    output.write(Buffer.alloc(MAX_FRAME_BYTES + 1));
    const client = peer({ output }).peer;
    await expect(client.call("search", {})).rejects.toThrow(/exceeds limit/);
  });

  it.each(["end", "input error", "output error"])("settles calls on %s", async (reason) => {
    const input = stream();
    const output = stream();
    const failed = vi.fn();
    const client = peer({ input, output, onFailure: failed }).peer;
    const pending = expect(client.call("search", {})).rejects.toThrow();
    if (reason === "end") {
      input.end();
    } else {
      (reason === "input error" ? input : output).emit("error", new Error("stream failed"));
    }
    await pending;
    expect(client.activeRequests).toBe(0);
    expect(input.listenerCount("data")).toBe(0);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
