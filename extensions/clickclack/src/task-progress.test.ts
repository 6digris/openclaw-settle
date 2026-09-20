import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveClickClackAccount } from "./accounts.js";
import { createClickClackClient } from "./http-client.js";
import { createClickClackAgentProgressPublisher } from "./progress.js";
import { createClickClackTaskProgressObserver } from "./task-progress.js";
import type { ClickClackMessage } from "./types.js";

type BoundTasks = ReturnType<PluginRuntime["tasks"]["async"]["runs"]["bindSession"]>;
type ObserveOptions = Parameters<BoundTasks["observeProgress"]>[0];
type TaskUpdate = Parameters<ObserveOptions["onChange"]>;
const sessionKey = "agent:main:clickclack:channel:chn_1";
const sourceMessage: ClickClackMessage = {
  id: "msg_01arz3ndektsv4rrffq69g5fav",
  workspace_id: "wsp_1",
  channel_id: "chn_1",
  author_id: "usr_1",
  body: "Inspect the build",
  created_at: "2026-09-20T10:00:00.000Z",
  thread_root_id: "msg_01arz3ndektsv4rrffq69g5fav",
  body_format: "markdown",
  kind: "message",
};

function task(revision = 1, execution = "execution-1"): TaskUpdate[0][number] {
  return {
    id: "task-1",
    runId: "logical-task-1",
    status: "running",
    execution: { state: "running" },
    progress: {
      runId: execution,
      revision,
      items: [{ itemId: "inspect", kind: "tool", phase: "start", title: `Inspect ${execution}` }],
    },
  };
}

function createHarness(options?: { nativeProgress?: boolean; agentActivity?: boolean }) {
  const account = resolveClickClackAccount({
    cfg: {
      channels: {
        clickclack: {
          baseUrl: "https://clickclack.example.test",
          token: "synthetic-token",
          workspace: "wsp_1",
          nativeProgress: options?.nativeProgress ?? true,
          agentActivity: options?.agentActivity ?? true,
        },
      },
    },
  });
  const frames: Array<{
    turn_id: string;
    seq: number;
    op: string;
    line?: { id: string; text: string; status?: string };
  }> = [];
  const visible = new Map<string, Map<string, string>>();
  const durable = new Map<string, string>();
  const reads = { gate: undefined as Promise<void> | undefined, entered: createDeferred<void>() };
  const writes = {
    gate: undefined as Promise<void> | undefined,
    entered: createDeferred<void>(),
    failItemOnce: false,
  };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (init?.method === "POST" && url.pathname === "/api/realtime/ephemeral") {
      if (typeof init.body !== "string") {
        throw new Error("Expected a serialized ClickClack JSON body");
      }
      const frame = JSON.parse(init.body).payload as (typeof frames)[number];
      if (writes.gate) {
        const gate = writes.gate;
        writes.gate = undefined;
        writes.entered.resolve();
        await gate;
      }
      frames.push(frame);
      if (frame.op === "clear") {
        visible.delete(frame.turn_id);
      } else if (frame.line) {
        const lines = visible.get(frame.turn_id) ?? new Map<string, string>();
        if (frame.line.text && (frame.op !== "update" || lines.has(frame.line.id))) {
          lines.set(frame.line.id, frame.line.text);
        } else {
          lines.delete(frame.line.id);
        }
        visible.set(frame.turn_id, lines);
      }
      if (writes.failItemOnce && frame.line && frame.line.id !== "turn") {
        writes.failItemOnce = false;
        throw new Error("Native acknowledgement was lost after publication");
      }
      return new Response(null, { status: 204 });
    }
    if (init?.method === "POST" && url.pathname.endsWith("/messages")) {
      if (typeof init.body !== "string") {
        throw new Error("Expected a serialized ClickClack JSON body");
      }
      const payload = JSON.parse(init.body) as { body: string; turn_id: string };
      const id = `activity-${durable.size + 1}`;
      durable.set(id, payload.body);
      return Response.json({ message: { ...sourceMessage, id, body: payload.body } });
    }
    if (init?.method === "PATCH") {
      if (typeof init.body !== "string") {
        throw new Error("Expected a serialized ClickClack JSON body");
      }
      const payload = JSON.parse(init.body) as { body: string };
      const id = url.pathname.split("/").at(-1)!;
      durable.set(id, payload.body);
      return Response.json({ message: { ...sourceMessage, id, body: payload.body } });
    }
    reads.entered.resolve();
    await reads.gate;
    return Response.json({ message: sourceMessage });
  });
  const runtime = createPluginRuntimeMock();
  const bound = runtime.tasks.async.runs.bindSession({ sessionKey, agentId: "main" });
  let currentTasks: TaskUpdate[0] = [];
  let version = 0;
  let callback: ObserveOptions | undefined;
  let pending = Promise.resolve();
  const sources: TaskUpdate[2] = new Map([
    [
      "task-1",
      {
        channel: "clickclack",
        accountId: "default",
        to: "channel:chn_1",
        channelId: "chn_1",
        messageId: sourceMessage.id,
      },
    ],
  ]);
  const publish = () => {
    const observer = callback;
    if (!observer) {
      return Promise.resolve();
    }
    const captured = version;
    const assertCurrent = () => {
      observer.signal.throwIfAborted();
      if (callback !== observer || captured !== version) {
        throw new Error("Task source was replaced");
      }
    };
    pending = Promise.resolve(observer.onChange(currentTasks, assertCurrent, sources));
    return pending;
  };
  bound.observeProgress = async (observer) => {
    callback = observer;
    await publish();
    return async () => {
      if (callback === observer) {
        callback = undefined;
      }
      await pending.catch(() => undefined);
    };
  };
  vi.spyOn(runtime.tasks.async.runs, "bindSession").mockReturnValue(bound);
  const abort = new AbortController();
  const observer = createClickClackTaskProgressObserver({
    runtime,
    account,
    signal: abort.signal,
    onError: () => {},
  });
  return {
    account,
    observer,
    frames,
    visible,
    durable,
    reads,
    writes,
    seed(tasks: TaskUpdate[0]) {
      currentTasks = tasks;
      version += 1;
    },
    async update(tasks: TaskUpdate[0]) {
      currentTasks = tasks;
      version += 1;
      await publish();
    },
    async reobserve() {
      version += 1;
      await pending.catch(() => undefined);
      await publish();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ClickClack task-owned progress", () => {
  it("keeps the original native correlation after the foreground returns, then clears only on task completion", async () => {
    const h = createHarness();
    const progress = createClickClackAgentProgressPublisher({
      client: createClickClackClient({ baseUrl: h.account.apiEndpoint, token: h.account.token }),
      target: { workspaceId: "wsp_1", channelId: "chn_1" },
      turnId: sourceMessage.id,
    });
    try {
      const foreground = await h.observer.attach({
        sessionKey,
        agentId: "main",
        message: sourceMessage,
        progress,
      });
      await h.update([task()]);
      await foreground.finishForeground();
      await vi.waitFor(() => {
        expect(h.visible.get(sourceMessage.id)?.get("turn")).toBe("Background work is continuing");
      });
      expect([...h.visible.get(sourceMessage.id)!.values()]).toContain("Inspect execution-1");
      expect([...h.durable.values()].join("\n")).toContain("Inspect execution-1");

      await h.update([{ ...task(), status: "completed", progress: undefined }]);
      expect(h.visible.has(sourceMessage.id)).toBe(false);
      expect([...h.durable.values()].join("\n")).toContain("Inspect execution-1");
      expect(new Set(h.frames.map((frame) => frame.turn_id))).toEqual(new Set([sourceMessage.id]));
      expect(h.frames.map((frame) => frame.seq)).toEqual(
        h.frames.map((_frame, index) => index + 1),
      );
    } finally {
      await h.observer.close();
    }
  });

  it("recovers a stored original message scope and replaces same-task execution items without deleting historical activity", async () => {
    const h = createHarness();
    h.seed([task()]);
    try {
      await h.observer.restore([{ sessionKey, agentId: "main" }]);
      expect([...h.visible.get(sourceMessage.id)!.values()]).toContain("Inspect execution-1");
      await h.update([task(2, "execution-2")]);
      expect([...h.visible.get(sourceMessage.id)!.values()]).toContain("Inspect execution-2");
      expect([...h.visible.get(sourceMessage.id)!.values()]).not.toContain("Inspect execution-1");
      expect([...h.durable.values()].join("\n")).toContain("Inspect execution-1");
      await h.update([
        { ...task(3, "execution-2"), progress: { runId: "execution-2", revision: 3, items: [] } },
      ]);
      expect([...h.visible.get(sourceMessage.id)!.values()]).toEqual([
        "Background work is continuing",
      ]);
    } finally {
      await h.observer.close();
    }
  });

  it("does not infer liveness when execution and prepared progress are unavailable", async () => {
    const h = createHarness({ agentActivity: false });
    h.seed([{ ...task(), execution: undefined, progress: undefined }]);
    try {
      await h.observer.restore([{ sessionKey, agentId: "main" }]);
      expect(h.visible.size).toBe(0);
      await h.update([task()]);
      const previousSequence = h.frames.at(-1)!.seq;
      await h.update([{ ...task(), execution: undefined, progress: undefined }]);
      expect(h.visible.size).toBe(0);
      await h.update([task(2)]);
      expect(h.frames.at(-1)!.seq).toBeGreaterThan(previousSequence);
      expect([...h.visible.get(sourceMessage.id)!.values()]).toContain("Inspect execution-1");
      expect(h.durable.size).toBe(0);
    } finally {
      await h.observer.close();
    }
  });

  it("suspends retained snapshots without current execution and reoffers the same revision on resume", async () => {
    const h = createHarness();
    const retained = task();
    h.seed([retained]);
    try {
      await h.observer.restore([{ sessionKey, agentId: "main" }]);
      const history = [...h.durable];
      for (const state of ["unknown", undefined, "queued", "finished"] as const) {
        await h.update([{ ...retained, execution: state ? { state } : undefined }]);
        expect(h.visible.has(sourceMessage.id)).toBe(false);
        expect([...h.durable]).toEqual(history);
        await h.update([retained]);
        expect([...h.visible.get(sourceMessage.id)!.values()]).toContain("Inspect execution-1");
        expect([...h.durable]).toEqual(history);
      }
      // Explicit execution remains authoritative even before display items
      // become available; missing progress content is not an execution state.
      await h.update([{ ...retained, progress: undefined }]);
      expect([...h.visible.get(sourceMessage.id)!.keys()]).toEqual(["turn"]);
      expect(h.frames.at(-1)?.line?.status).toBe("running");
      expect(h.frames.map((frame) => frame.seq)).toEqual(
        h.frames.map((_frame, index) => index + 1),
      );
    } finally {
      await h.observer.close();
    }
  });

  it("labels waiting without a running or terminal native outcome while preserving durable activity", async () => {
    const h = createHarness();
    h.seed([task()]);
    try {
      await h.observer.restore([{ sessionKey, agentId: "main" }]);
      const historyIds = [...h.durable.keys()];
      const waiting: TaskUpdate[0][number] = {
        ...task(),
        execution: { state: "waiting", wait: { kind: "children" } },
        progress: {
          runId: "execution-1",
          revision: 2,
          items: [
            {
              itemId: "inspect",
              kind: "tool",
              phase: "end",
              status: "completed",
              title: "Inspection complete",
            },
          ],
        },
      };
      await h.update([waiting]);
      expect(h.visible.get(sourceMessage.id)?.get("turn")).toContain("waiting");
      expect([...h.visible.get(sourceMessage.id)!.keys()]).toEqual(["turn"]);
      expect(h.frames.at(-1)?.line?.status).toBeUndefined();
      expect([...h.durable.keys()]).toEqual(historyIds);
      expect([...h.durable.values()].join("\n")).toContain("Inspection complete");
      await h.update([{ ...waiting, execution: { state: "running" } }]);
      expect([...h.visible.get(sourceMessage.id)!.values()]).toContain("Inspection complete");
      expect(h.frames.at(-1)?.line?.status).toBe("running");
      expect([...h.durable.keys()]).toEqual(historyIds);
    } finally {
      await h.observer.close();
    }
  });

  it("reoffers the same revision after a running observation interrupts a partial suspension", async () => {
    const h = createHarness({ agentActivity: false });
    const retained = task();
    retained.progress!.items.push({
      itemId: "second",
      kind: "tool",
      phase: "start",
      title: "Second running item",
    });
    h.seed([retained]);
    const release = createDeferred<void>();
    try {
      await h.observer.restore([{ sessionKey, agentId: "main" }]);
      h.writes.gate = release.promise;
      const suspending = h.update([{ ...retained, execution: { state: "unknown" } }]);
      const rejected = expect(suspending).rejects.toThrow("Task source was replaced");
      await h.writes.entered.promise;
      h.seed([retained]);
      const resumed = h.reobserve();
      release.resolve();
      await rejected;
      await resumed;
      expect(new Set(h.visible.get(sourceMessage.id)!.values())).toEqual(
        new Set(["Background work is continuing", "Second running item", "Inspect execution-1"]),
      );
    } finally {
      release.resolve();
      await h.observer.close();
    }
  });

  it("fences a recovered original message lookup that settles after its task source was replaced", async () => {
    const h = createHarness();
    const release = createDeferred<void>();
    h.reads.gate = release.promise;
    h.seed([task()]);
    const restoring = h.observer.restore([{ sessionKey, agentId: "main" }]);
    const rejected = expect(restoring).rejects.toThrow("Task source was replaced");
    try {
      await h.reads.entered.promise;
      h.seed([task(2, "replacement")]);
      release.resolve();
      await rejected;
      expect(h.frames).toEqual([]);
      expect(h.durable.size).toBe(0);
    } finally {
      release.resolve();
      await h.observer.close();
    }
  });

  it.each(["retraction", "execution replacement"] as const)(
    "reoffers blocked native removals on the next unchanged observation during %s",
    async (transition) => {
      const h = createHarness({ agentActivity: false });
      const initial = task();
      initial.progress!.items.push({
        itemId: "second",
        kind: "tool",
        phase: "start",
        title: "Second original item",
      });
      h.seed([initial]);
      const release = createDeferred<void>();
      try {
        await h.observer.restore([{ sessionKey, agentId: "main" }]);
        h.writes.gate = release.promise;
        const next =
          transition === "execution replacement"
            ? task(2, "execution-2")
            : { ...task(2), progress: { runId: "execution-1", revision: 2, items: [] } };
        const updating = h.update([next]);
        const rejected = expect(updating).rejects.toThrow("Task source was replaced");
        await h.writes.entered.promise;
        const refreshed = h.reobserve();
        release.resolve();
        await rejected;
        await refreshed;
        const contents = [...h.visible.get(sourceMessage.id)!.values()];
        expect(contents).not.toContain("Inspect execution-1");
        expect(contents).not.toContain("Second original item");
        expect(contents).toEqual(
          transition === "execution replacement"
            ? ["Background work is continuing", "Inspect execution-2"]
            : ["Background work is continuing"],
        );
      } finally {
        release.resolve();
        await h.observer.close();
      }
    },
  );

  it("does not acknowledge an ambiguous native write or retry it as a duplicate append", async () => {
    const h = createHarness({ agentActivity: false });
    h.writes.failItemOnce = true;
    h.seed([task()]);
    try {
      await h.observer.restore([{ sessionKey, agentId: "main" }]);
      await h.reobserve();
      const items = h.frames.filter((frame) => frame.line?.text === "Inspect execution-1");
      expect(items.map((frame) => frame.op)).toEqual(["append", "update"]);
      expect([...h.visible.get(sourceMessage.id)!.values()]).toContain("Inspect execution-1");
    } finally {
      await h.observer.close();
    }
  });

  it("honors durable-only activity without enabling the native realtime protocol", async () => {
    const h = createHarness({ nativeProgress: false, agentActivity: true });
    h.seed([task()]);
    try {
      await h.observer.restore([{ sessionKey, agentId: "main" }]);
      expect(h.frames).toEqual([]);
      expect([...h.durable.values()].join("\n")).toContain("Inspect execution-1");
    } finally {
      await h.observer.close();
    }
  });
});
