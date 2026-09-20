import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as sqliteScope from "../config/sessions/session-accessor.sqlite-scope.js";
import type {
  SessionHistoryWorkerRequest,
  SessionHistoryWorkerResult,
} from "../config/sessions/session-history-types.js";
import { readSessionHistoryPageInWorker } from "../config/sessions/session-history-worker-runtime.js";
import type { SessionTranscriptHistoryWorkerInput } from "../config/sessions/session-transcript-worker.types.js";
import { DEFAULT_WORKER_PENDING_TASKS } from "../infra/worker-task-capacity.js";

const { runWorker, readerAdmitted } = vi.hoisted(() => ({
  runWorker: vi.fn(),
  readerAdmitted: vi.fn(),
}));
vi.mock("../config/sessions/session-transcript-worker-runtime.js", () => ({
  withSessionHistoryWorkerDatabase: (
    _options: unknown,
    operation: (owner: {
      generation: number;
      run: typeof runWorker;
      assertCurrent: () => void;
    }) => unknown,
  ) => {
    const result = operation({ generation: 1, run: runWorker, assertCurrent: () => {} });
    readerAdmitted();
    return result;
  },
}));
vi.mock("../config/sessions/session-cold-storage-read.js", () => ({
  readRestoredSessionTranscript: async (_scope: unknown, read: () => unknown) => read(),
}));

type RpcRequest = Extract<SessionHistoryWorkerRequest, { kind: "rpc" }>;
const queued: Array<{
  prepare: () => SessionTranscriptHistoryWorkerInput;
  result: ReturnType<typeof createDeferred<SessionHistoryWorkerResult>>;
}> = [];
let admittedReaders = 0;
const admissionWaiters: Array<{ count: number; ready: ReturnType<typeof createDeferred<void>> }> =
  [];

function waitForReaderAdmission(count: number): Promise<void> {
  if (admittedReaders >= count) {
    return Promise.resolve();
  }
  const ready = createDeferred();
  admissionWaiters.push({ count, ready });
  return ready.promise;
}

beforeEach(() => {
  vi.spyOn(sqliteScope, "prepareSqliteTranscriptReadScope").mockImplementation(async (scope) => {
    if (!scope.agentId || !scope.storePath) {
      throw new Error("Queue fixture requires an explicit history target");
    }
    return {
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      env: scope.env,
      path: path.join(path.dirname(scope.storePath), "openclaw-agent.sqlite"),
      ownerStorePath: scope.storePath,
      ...(scope.sessionKey
        ? { sessionKey: sqliteScope.normalizeSqliteSessionKey(scope.sessionKey) }
        : {}),
    };
  });
  queued.length = 0;
  admittedReaders = 0;
  admissionWaiters.length = 0;
  readerAdmitted.mockReset().mockImplementation(() => {
    admittedReaders++;
    for (const waiter of admissionWaiters) {
      if (admittedReaders >= waiter.count) {
        waiter.ready.resolve();
      }
    }
  });
  runWorker.mockReset().mockImplementation((prepare: () => SessionTranscriptHistoryWorkerInput) => {
    const result = createDeferred<SessionHistoryWorkerResult>();
    queued.push({ prepare, result });
    return result.promise;
  });
});

afterEach(() => vi.restoreAllMocks());

function request(overrides: Partial<RpcRequest["params"]> = {}): RpcRequest {
  return {
    kind: "rpc",
    params: {
      sessionAgentId: "main",
      canonicalKey: "agent:main:history-worker",
      sessionId: "history-worker",
      storePath: "/tmp/history-worker-fixture/sessions.json",
      entry: { sessionId: "history-worker", updatedAt: 1, sessionStartedAt: 1 },
      provider: undefined,
      max: 20,
      maxHistoryBytes: 100_000,
      effectiveMaxChars: 8000,
      offset: undefined,
      messageId: undefined,
      ...overrides,
    },
  };
}

function page(text: string): SessionHistoryWorkerResult {
  return {
    kind: "rpc",
    page: { messages: [{ role: "assistant", content: [{ type: "text", text }] }] },
  };
}

it.each(["rpc", "http"] as const)(
  "captures %s request identity and selectors before target preparation and queue dispatch",
  async (kind) => {
    const makeRequest = (): SessionHistoryWorkerRequest => {
      const rpc = request();
      return kind === "rpc"
        ? rpc
        : {
            kind: "http",
            params: {
              target: {
                agentId: rpc.params.sessionAgentId,
                sessionId: rpc.params.sessionId,
                sessionKey: rpc.params.canonicalKey,
                storePath: rpc.params.storePath,
                sessionEntry: rpc.params.entry,
              },
              limit: 20,
              maxChars: 8000,
              cursor: "7",
            },
          };
    };
    const read = (input: SessionHistoryWorkerRequest) =>
      input.kind === "rpc"
        ? readSessionHistoryPageInWorker(input)
        : readSessionHistoryPageInWorker(input);
    const supplied = makeRequest();
    const expected = makeRequest();
    const mutate = (stage: string) => {
      const entry =
        supplied.kind === "rpc" ? supplied.params.entry : supplied.params.target.sessionEntry;
      if (!entry) {
        throw new Error("Capture fixture requires entry metadata");
      }
      entry.sessionId = `${stage}-entry`;
      entry.updatedAt = 99;
      entry.sessionStartedAt = 98;
      if (supplied.kind === "rpc") {
        Object.assign(supplied.params, {
          sessionAgentId: "other",
          sessionId: `${stage}-session`,
          canonicalKey: `agent:other:${stage}`,
          storePath: `/tmp/${stage}/sessions.json`,
          provider: stage,
          max: 2,
          maxHistoryBytes: 512,
          effectiveMaxChars: 20,
          offset: 2,
          messageId: `${stage}-anchor`,
          ignoreCliSessionImports: true,
        });
      } else {
        Object.assign(supplied.params.target, {
          agentId: "other",
          sessionId: `${stage}-session`,
          sessionKey: `agent:other:${stage}`,
          storePath: `/tmp/${stage}/sessions.json`,
        });
        Object.assign(supplied.params, { limit: 2, maxChars: 20, cursor: `${stage}-cursor` });
      }
    };
    const entered = createDeferred();
    const release = createDeferred();
    const prepare = vi.mocked(sqliteScope.prepareSqliteTranscriptReadScope).getMockImplementation();
    if (!prepare) {
      throw new Error("Capture fixture requires the prepared-target boundary");
    }
    vi.mocked(sqliteScope.prepareSqliteTranscriptReadScope).mockImplementationOnce(
      async (...args) => {
        const target = await prepare(...args);
        entered.resolve();
        await release.promise;
        return target;
      },
    );
    const first = read(supplied);
    await entered.promise;
    mutate("during-preparation");
    release.resolve();
    await waitForReaderAdmission(1);
    const second = read(makeRequest());
    await waitForReaderAdmission(2);
    mutate("after-enqueue-before-dispatch");

    const dispatched = queued.map((job, index) => {
      const input = job.prepare();
      const bytes = runWorker.mock.calls[index]![1];
      job.result.resolve(
        kind === "rpc"
          ? page("captured request")
          : {
              kind: "http",
              snapshot: {
                history: { items: [], messages: [], hasMore: false },
                rawTranscriptSeq: 0,
                turnBoundaryPending: false,
                assistantErrorPending: false,
              },
            },
      );
      return { input, bytes };
    });
    const outcomes = await Promise.allSettled([first, second]);
    expect.soft(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect.soft(outcomes[0]).toEqual(outcomes[1]);
    expect.soft(dispatched).toHaveLength(1);
    for (const { input, bytes } of dispatched) {
      expect.soft(input.request).toEqual(expected);
      expect.soft(input.target.transcript).toMatchObject({
        agentId: "main",
        sessionId: "history-worker",
        sessionKey: "agent:main:history-worker",
        storePath: "/tmp/history-worker-fixture/sessions.json",
      });
      expect.soft(bytes).toBe(`1:${JSON.stringify(input)}`.length * 2);
    }
  },
);

it("shares queued equivalent pages but starts a fresh read after dispatch", async () => {
  const first = readSessionHistoryPageInWorker(request());
  const second = readSessionHistoryPageInWorker(request());
  await waitForReaderAdmission(2);
  expect(queued).toHaveLength(1);

  queued[0]!.prepare();
  const afterAppend = readSessionHistoryPageInWorker(request());
  await waitForReaderAdmission(3);
  expect(queued).toHaveLength(2);
  queued[0]!.result.resolve(page("before append"));
  const [a, b] = await Promise.all([first, second]);
  const sameSuccessor = readSessionHistoryPageInWorker(request());
  await waitForReaderAdmission(4);
  expect(queued).toHaveLength(2);
  queued[1]!.prepare();
  queued[1]!.result.resolve(page("after append"));

  const [latest, successor] = await Promise.all([afterAppend, sameSuccessor]);
  expect(a.messages).toEqual([
    { role: "assistant", content: [{ type: "text", text: "before append" }] },
  ]);
  expect(b).toEqual(a);
  expect(latest.messages).toEqual([
    { role: "assistant", content: [{ type: "text", text: "after append" }] },
  ]);
  expect(successor).toEqual(latest);
  expect(a.messages[0]).not.toBe(b.messages[0]);
  const message = asOptionalRecord(a.messages[0]);
  expect(message).toBeDefined();
  expect(message?.content).not.toBe(asOptionalRecord(b.messages[0])?.content);
  message!.content = ["changed by another caller"];
  expect(b.messages).toEqual([
    { role: "assistant", content: [{ type: "text", text: "before append" }] },
  ]);
});

it.each([
  { max: 2 },
  { provider: "other" },
  { ignoreCliSessionImports: true },
  { canonicalKey: "agent:main:other" },
  { maxHistoryBytes: 512 },
  { effectiveMaxChars: 20 },
  { offset: 2 },
  { messageId: "anchor" },
  { storePath: "/tmp/another-history-worker-fixture/sessions.json" },
  { sessionId: "replacement" },
  { entry: { sessionId: "history-worker", updatedAt: 1, sessionStartedAt: 2 } },
])("keeps distinct history selectors separate: %j", async (difference) => {
  const first = readSessionHistoryPageInWorker(request());
  const second = readSessionHistoryPageInWorker(request(difference));
  await waitForReaderAdmission(2);
  expect(queued).toHaveLength(2);
  for (const job of queued) {
    job.prepare();
    job.result.resolve(page("selected page"));
  }
  await Promise.all([first, second]);
});

it("discards a rejected queued read so a later request can succeed", async () => {
  const first = readSessionHistoryPageInWorker(request());
  const second = readSessionHistoryPageInWorker(request());
  const failed = Promise.allSettled([first, second]);
  await waitForReaderAdmission(2);
  queued[0]!.result.reject(new Error("worker unavailable"));
  expect(await failed).toEqual([
    { status: "rejected", reason: new Error("worker unavailable") },
    { status: "rejected", reason: new Error("worker unavailable") },
  ]);
  const fresh = readSessionHistoryPageInWorker(request());
  await waitForReaderAdmission(3);
  expect(queued).toHaveLength(2);
  queued[1]!.prepare();
  queued[1]!.result.resolve(page("recovered"));
  expect(await fresh).toEqual({
    messages: [{ role: "assistant", content: [{ type: "text", text: "recovered" }] }],
  });
});

it("bounds coalesced waiters and releases their capacity without cloning cancelled replies", async () => {
  const controller = new AbortController();
  const readers = Array.from({ length: DEFAULT_WORKER_PENDING_TASKS }, (_, index) =>
    readSessionHistoryPageInWorker(request(), index === 0 ? controller.signal : undefined),
  );
  const settled = Promise.allSettled(readers);
  await waitForReaderAdmission(DEFAULT_WORKER_PENDING_TASKS);
  expect(queued).toHaveLength(1);
  await expect(readSessionHistoryPageInWorker(request())).rejects.toMatchObject({
    code: "overloaded",
  });
  const cancelled = new Error("caller closed");
  controller.abort(cancelled);
  // The cancelled callback remains retained by the shared promise until its job settles.
  await expect(readSessionHistoryPageInWorker(request())).rejects.toMatchObject({
    code: "overloaded",
  });
  expect(queued).toHaveLength(1);

  const clone = vi.spyOn(globalThis, "structuredClone");
  try {
    queued[0]!.prepare();
    queued[0]!.result.resolve(page("shared result"));
    const results = await settled;
    expect(results[0]).toEqual({ status: "rejected", reason: cancelled });
    expect(results.slice(1).every((result) => result.status === "fulfilled")).toBe(true);
    expect(clone).toHaveBeenCalledTimes(DEFAULT_WORKER_PENDING_TASKS - 1);
  } finally {
    clone.mockRestore();
  }

  const fresh = Promise.all(
    Array.from({ length: DEFAULT_WORKER_PENDING_TASKS }, () =>
      readSessionHistoryPageInWorker(request()),
    ),
  );
  await waitForReaderAdmission(DEFAULT_WORKER_PENDING_TASKS * 2);
  expect(queued).toHaveLength(2);
  queued[1]!.prepare();
  queued[1]!.result.resolve(page("capacity released"));
  for (const result of await fresh) {
    expect(result).toEqual({
      messages: [{ role: "assistant", content: [{ type: "text", text: "capacity released" }] }],
    });
  }
});

it.each([
  {
    entry: { sessionId: "history-worker", updatedAt: 1 },
    key: "agent:main:history-worker",
    validate: false,
  },
  { entry: undefined, key: "", validate: false },
  { entry: undefined, key: "agent:main:history-worker", validate: true },
  {
    entry: { sessionId: "successor", updatedAt: 1 },
    key: "agent:main:history-worker",
    validate: true,
  },
])(
  "carries conditional validation without reading or retargeting on enqueue: %j",
  async ({ entry, key, validate }) => {
    const pending = readSessionHistoryPageInWorker(request({ entry, canonicalKey: key }));
    await waitForReaderAdmission(1);
    expect(queued).toHaveLength(1);
    const input = queued[0]!.prepare();
    expect(input.target.transcript.sessionId).toBe("history-worker");
    expect(input.target.entryValidationKey).toBe(validate ? key : undefined);
    expect(input.database).toEqual({
      agentId: "main",
      path: expect.stringMatching(/openclaw-agent\.sqlite$/),
    });
    expect(input.target).not.toHaveProperty("database");
    expect(input.target).not.toHaveProperty("env");
    expect(runWorker.mock.calls[0]![1]).toBe(`1:${JSON.stringify(input)}`.length * 2);
    queued[0]!.result.resolve(page("requested transcript"));
    await pending;
  },
);

it.each([{ limit: 2 }, { cursor: "7" }, { maxChars: 20 }])(
  "includes HTTP pagination selectors in coalescing and byte admission: %j",
  async (difference) => {
    const rpc = request().params;
    const params = {
      target: {
        agentId: rpc.sessionAgentId,
        sessionKey: rpc.canonicalKey,
        sessionId: rpc.sessionId,
        sessionEntry: rpc.entry,
        storePath: rpc.storePath,
      },
      limit: 10,
      maxChars: 8000,
      cursor: undefined as string | undefined,
    };
    const first = readSessionHistoryPageInWorker({ kind: "http", params });
    const second = readSessionHistoryPageInWorker({
      kind: "http",
      params: { ...params, ...difference },
    });
    await waitForReaderAdmission(2);
    expect(queued).toHaveLength(2);
    for (const [index, job] of queued.entries()) {
      const input = job.prepare();
      expect(runWorker.mock.calls[index]![1]).toBe(`1:${JSON.stringify(input)}`.length * 2);
      job.result.resolve({
        kind: "http",
        snapshot: {
          history: { items: [], messages: [], hasMore: false },
          rawTranscriptSeq: 0,
          turnBoundaryPending: false,
          assistantErrorPending: false,
        },
      });
    }
    await Promise.all([first, second]);
  },
);
