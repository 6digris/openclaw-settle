import { expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../agents/internal-runtime-context.js";
import { recordTaskActivityEvent, flushTaskActivity } from "../tasks/task-registry-activity.js";
import {
  createTaskFixture,
  finishTaskFixture,
  withTaskRegistryTempDir,
} from "../tasks/task-registry.test-support.js";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";
import { createTuiTaskProgressController } from "./tui-task-progress.js";

type EmbeddedAgentResult = {
  payloads: Array<{ text: string }>;
  meta: Record<string, unknown>;
};

type StreamTestContext = {
  createBackend: () => EmbeddedTuiBackend;
  createPendingReply: () => {
    promise: Promise<EmbeddedAgentResult>;
    resolve: (result: EmbeddedAgentResult) => void;
  };
  prepareReply: (reply: Promise<EmbeddedAgentResult>) => void;
  failNextRuntimePluginLoad: () => void;
  emitAgentEvent: (event: unknown) => void;
  captureBackendEvents: (backend: EmbeddedTuiBackend) => Array<{ event: string; payload: unknown }>;
  flushMicrotasks: () => Promise<void>;
  embeddedEventTimestamp: number;
};

export function registerEmbeddedBackendStreamTests({
  createBackend,
  createPendingReply,
  prepareReply,
  failNextRuntimePluginLoad,
  emitAgentEvent,
  captureBackendEvents,
  flushMicrotasks,
  embeddedEventTimestamp,
}: StreamTestContext) {
  it("renders ongoing child registry activity without a foreground run and retires it on cancellation", async () => {
    vi.useRealTimers();
    await withTaskRegistryTempDir(async () => {
      const sessionKey = "agent:main:main";
      const backend = createBackend();
      const progress = createTuiTaskProgressController({
        client: backend,
        getScope: () => ({ sessionKey, agentId: "main" }),
        requestRender: () => {},
      });
      const render = () => stripAnsi(progress.component.render(100).join("\n"));
      backend.onEvent = ({ event, payload }) => progress.handleEvent(event, payload);
      backend.start();
      try {
        const task = createTaskFixture("subagent", {
          requesterSessionKey: sessionKey,
          requesterAgentId: "main",
          childSessionKey: "agent:main:subagent:child",
          runId: "child-progress-run",
          task: "Detached investigation",
        });
        recordTaskActivityEvent(task, {
          runId: "child-progress-run",
          seq: 1,
          ts: Date.now(),
          stream: "execution",
          data: { state: "running" },
        });
        await progress.connect();
        recordTaskActivityEvent(task, {
          runId: "child-progress-run",
          seq: 1,
          ts: Date.now(),
          stream: "item",
          data: {
            itemId: "inspect",
            phase: "start",
            kind: "tool",
            title: "Inspect child files",
            status: "running",
            progressText: "Post-yield child output",
          },
        });
        flushTaskActivity(task.taskId);
        await vi.waitFor(() => expect(render()).toContain("Post-yield child output"));
        finishTaskFixture({
          taskId: task.taskId,
          status: "cancelled",
          endedAt: Date.now(),
          terminalSummary: "Operator cancelled child",
        });
        await vi.waitFor(() => expect(render()).toContain("[cancelled]"));
        expect(render()).not.toContain("Post-yield child output");
        progress.dispose();
        await backend.stop();
        createTaskFixture("subagent", {
          requesterSessionKey: sessionKey,
          runId: "after-stop",
          task: "Must not appear",
        });
        await progress.settled();
        expect(render()).not.toContain("Must not appear");
      } finally {
        progress.dispose();
        await backend.stop();
      }
    });
  });
  it("returns embedded history when runtime plugin loading fails", async () => {
    failNextRuntimePluginLoad();

    const backend = createBackend();

    await expect(backend.loadHistory({ sessionKey: "agent:main:main" })).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      messages: [],
      runtimePluginsPrewarm: { status: "failed", error: "runtime unavailable" },
    });
  });
  it("keeps internal context private when local deltas split its delimiters", async () => {
    const pending = createPendingReply();
    prepareReply(pending.promise);

    const backend = createBackend();
    const events = captureBackendEvents(backend);
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "split internal context",
      runId: "run-local-split-context",
    });

    const deltas = [
      `Visible\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\n`,
      "private runtime detail\n",
      `${INTERNAL_RUNTIME_CONTEXT_END}\nAfter`,
    ];
    deltas.forEach((delta) => {
      emitAgentEvent({
        runId: "run-local-split-context",
        stream: "assistant",
        data: { delta },
      });
    });
    emitAgentEvent({
      runId: "run-local-split-context",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });
    pending.resolve({ payloads: [{ text: "Visible\n\nAfter" }], meta: {} });
    await flushMicrotasks();

    const chatPayloads = events
      .filter((entry) => entry.event === "chat")
      .map((entry) => entry.payload);
    expect(JSON.stringify(chatPayloads)).not.toContain("private runtime detail");
    expect(chatPayloads.at(-1)).toMatchObject({
      state: "final",
      message: { content: [{ text: "Visible\n\nAfter" }] },
    });
  });

  it.each([
    {
      name: "unkeyed replacement snapshots",
      updates: [{ text: "Hello world" }, { text: "Goodbye world" }],
      expectedDeltas: [
        { deltaText: "Hello world", replace: undefined },
        { deltaText: "Goodbye world", replace: true },
      ],
      expectedText: "Goodbye world",
    },
    {
      name: "identical snapshots from distinct assistant items",
      updates: [
        { itemId: "first", text: "Echo" },
        { itemId: "second", text: "Echo" },
      ],
      expectedDeltas: [
        { deltaText: "Echo", replace: undefined },
        { deltaText: "\n\nEcho", replace: undefined },
      ],
      expectedText: "Echo\n\nEcho",
    },
    {
      name: "a new assistant item extending an earlier item's text",
      updates: [
        { itemId: "first", text: "Echo", delta: "Echo" },
        { itemId: "second", text: "Echo!", delta: "Echo!" },
      ],
      expectedDeltas: [
        { deltaText: "Echo", replace: undefined },
        { deltaText: "\n\nEcho!", replace: undefined },
      ],
      expectedText: "Echo\n\nEcho!",
    },
    {
      name: "replayed and growing snapshots of one assistant item",
      updates: [
        { itemId: "answer", text: "Echo", delta: "Echo" },
        { itemId: "answer", text: "Echo", delta: "Echo" },
        { itemId: "answer", text: "Echo again", delta: " again" },
      ],
      expectedDeltas: [
        { deltaText: "Echo", replace: undefined },
        { deltaText: " again", replace: undefined },
      ],
      expectedText: "Echo again",
    },
    {
      name: "item-scoped deltas without snapshots",
      updates: [
        { itemId: "first", delta: "Echo" },
        { itemId: "first", delta: "Echo" },
        { itemId: "second", delta: "!" },
      ],
      expectedDeltas: [
        { deltaText: "Echo", replace: undefined },
        { deltaText: "Echo", replace: undefined },
        { deltaText: "\n\n!", replace: undefined },
      ],
      expectedText: "EchoEcho\n\n!",
    },
    {
      name: "empty corrections that remove only the current assistant item",
      updates: [
        { itemId: "first", text: "Hello" },
        { itemId: "second", text: " world" },
        { itemId: "second", text: "" },
      ],
      expectedDeltas: [
        { deltaText: "Hello", replace: undefined },
        { deltaText: "\n\n world", replace: undefined },
        { deltaText: "Hello", replace: true },
      ],
      expectedText: "Hello",
    },
    {
      name: "a failed same-item clear followed by a recovery item",
      updates: [
        { itemId: "failed", text: "Failed draft", delta: "Failed draft" },
        { itemId: "failed", text: "", delta: "", replace: true },
        { itemId: "recovery", text: "Recovered answer", delta: "Recovered answer" },
      ],
      expectedDeltas: [
        { deltaText: "Failed draft", replace: undefined },
        { deltaText: "", replace: true },
        { deltaText: "Recovered answer", replace: undefined },
      ],
      expectedText: "Recovered answer",
    },
  ])(
    "EmbeddedTuiBackend.sendChat projects $name",
    async ({ updates, expectedDeltas, expectedText }) => {
      const pending = createPendingReply();
      prepareReply(pending.promise);

      const backend = createBackend();
      const events = captureBackendEvents(backend);

      backend.start();
      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "replace",
        runId: "run-local-replace",
      });

      for (const data of updates) {
        emitAgentEvent({ runId: "run-local-replace", stream: "assistant", data });
      }

      pending.resolve({ payloads: [], meta: {} });
      await flushMicrotasks();

      const chatPayloads = events
        .filter((entry) => entry.event === "chat")
        .map(
          (entry) =>
            entry.payload as {
              state?: string;
              deltaText?: string;
              replace?: boolean;
              message?: { content?: Array<{ text?: string }> };
            },
        );
      expect(
        chatPayloads
          .filter((payload) => payload.state === "delta")
          .map((payload) => ({
            deltaText: payload.deltaText,
            replace: payload.replace,
          })),
      ).toEqual(expectedDeltas);
      expect(chatPayloads.at(-1)).toMatchObject({
        state: "final",
        message: { content: [{ text: expectedText }] },
      });
    },
  );

  it.each(["final", "aborted"] as const)(
    "EmbeddedTuiBackend.sendChat keeps a failed clear visible before %s without exposing suppressed output",
    async (state) => {
      const pending = createPendingReply();
      prepareReply(pending.promise);
      const backend = createBackend();
      const events = captureBackendEvents(backend);
      const runId = `run-local-clear-${state}`;
      backend.start();
      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "clear the failed draft",
        runId,
      });

      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { itemId: "failed", text: "Failed draft", delta: "Failed draft" },
      });
      for (const data of [
        { itemId: "failed", text: "NO_REPLY" },
        {
          itemId: "failed",
          text: `${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nprivate runtime detail\n${INTERNAL_RUNTIME_CONTEXT_END}`,
        },
        { itemId: "failed", text: "Private commentary", phase: "commentary" },
      ]) {
        emitAgentEvent({ runId, stream: "assistant", data });
      }
      expect(events.filter((entry) => entry.event === "chat")).toHaveLength(1);

      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { itemId: "failed", text: "", delta: "", replace: true },
      });
      expect(
        events.filter((entry) => entry.event === "chat").map((entry) => entry.payload),
      ).toEqual([
        expect.objectContaining({ state: "delta", deltaText: "Failed draft" }),
        {
          runId,
          sessionKey: "agent:main:main",
          agentId: "main",
          state: "delta",
          deltaText: "",
          replace: true,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            timestamp: embeddedEventTimestamp,
          },
        },
      ]);

      if (state === "aborted") {
        await expect(backend.abortChat({ sessionKey: "agent:main:main", runId })).resolves.toEqual({
          ok: true,
          aborted: true,
          runIds: [runId],
        });
      }
      pending.resolve({ payloads: [], meta: state === "aborted" ? { aborted: true } : {} });
      await flushMicrotasks();

      const chatPayloads = events
        .filter((entry) => entry.event === "chat")
        .map((entry) => entry.payload);
      expect(chatPayloads).toHaveLength(3);
      expect(chatPayloads.at(-1)).toEqual({
        runId,
        sessionKey: "agent:main:main",
        agentId: "main",
        state,
      });
    },
  );
}
