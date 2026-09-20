// Tests for the durable ClickClack agent-activity publisher (coalescing rules).
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClickClackActivityPublisher } from "./activity.js";
import type { ClickClackMessage } from "./types.js";

type ActivityClient = Parameters<typeof createClickClackActivityPublisher>[0]["client"];

function createClientMock(): {
  client: ActivityClient;
  createActivityMessage: ReturnType<typeof vi.fn>;
  updateMessageBody: ReturnType<typeof vi.fn>;
} {
  let counter = 0;
  const createActivityMessage = vi.fn(async () => {
    counter += 1;
    return { id: `msg_${counter}` } as ClickClackMessage;
  });
  const updateMessageBody = vi.fn(async () => ({}) as ClickClackMessage);
  return {
    client: { createActivityMessage, updateMessageBody } as ActivityClient,
    createActivityMessage,
    updateMessageBody,
  };
}

describe("createClickClackActivityPublisher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces cumulative commentary snapshots into one POST per segment", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
    });

    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "Looking at" });
    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "Looking at the repo" });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(createActivityMessage).toHaveBeenCalledWith({
      channelId: "chn_1",
      conversationId: undefined,
      body: "Looking at the repo",
      kind: "agent_commentary",
      turnId: "msg_turn",
    });
    expect(updateMessageBody).not.toHaveBeenCalled();
  });

  it("PATCHes the commentary row when the snapshot grows after a debounce flush", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
      flushMs: 10,
    });

    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "First" });
    await vi.advanceTimersByTimeAsync(20);
    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "First and second" });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(updateMessageBody).toHaveBeenCalledTimes(1);
    expect(updateMessageBody).toHaveBeenCalledWith("msg_1", "First and second");
  });

  it("keeps complete commentary during a partial successor and accepts shorter completion", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
      flushMs: 10,
    });

    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "First and second" });
    await vi.advanceTimersByTimeAsync(20);
    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "First and second" });
    publisher.onItemEvent({
      itemId: "c1",
      kind: "preamble",
      phase: "update",
      progressText: "First",
    });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(updateMessageBody).not.toHaveBeenCalled();
    publisher.onItemEvent({ itemId: "c1", kind: "preamble", phase: "end", progressText: "Done" });
    await publisher.finalize();
    expect(updateMessageBody).toHaveBeenLastCalledWith("msg_1", "Done");
    publisher.onItemEvent({ itemId: "c1", kind: "preamble", phase: "update", progressText: "" });
    await publisher.finalize();
    expect(updateMessageBody).toHaveBeenLastCalledWith("msg_1", "");
  });

  it("retracts hidden commentary and reuses its durable row when visibility returns", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
    });
    publisher.onItemEvent({
      itemId: "commentary",
      kind: "preamble",
      phase: "end",
      progressText: "Visible progress",
    });
    await publisher.finalize();
    publisher.onItemEvent({
      itemId: "commentary",
      kind: "preamble",
      phase: "end",
      hideFromChannelProgress: true,
      progressText: "Hidden replacement",
    });
    await publisher.finalize();
    expect(updateMessageBody).toHaveBeenLastCalledWith("msg_1", "");
    expect(JSON.stringify(createActivityMessage.mock.calls)).not.toContain("Hidden replacement");
    publisher.onItemEvent({
      itemId: "commentary",
      kind: "preamble",
      phase: "end",
      progressText: "Visible replacement",
    });
    await publisher.finalize();
    expect(createActivityMessage).toHaveBeenCalledOnce();
    expect(updateMessageBody).toHaveBeenLastCalledWith("msg_1", "Visible replacement");
  });

  it("does not post commentary retracted while its first flush is queued", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
    });
    publisher.onItemEvent({
      itemId: "commentary",
      kind: "commentary",
      progressText: "Pending progress",
    });
    const flushing = publisher.finalize();
    publisher.onItemEvent({
      itemId: "commentary",
      kind: "commentary",
      progressText: "Suppressed replacement",
      suppressDurableProgress: true,
    });
    await flushing;
    await publisher.finalize();
    expect(createActivityMessage).not.toHaveBeenCalled();
    expect(updateMessageBody).not.toHaveBeenCalled();

    publisher.onItemEvent({
      itemId: "commentary",
      kind: "commentary",
      progressText: "Visible replacement",
    });
    await publisher.finalize();
    expect(createActivityMessage).toHaveBeenCalledOnce();
    expect(createActivityMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Visible replacement" }),
    );
    expect(updateMessageBody).not.toHaveBeenCalled();
  });

  it.each(["post", "clear"] as const)(
    "preserves newer visibility while a commentary %s is in flight",
    async (write) => {
      const base = createClientMock();
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const client: ActivityClient = {
        async createActivityMessage(input) {
          if (write === "post") {
            entered.resolve();
            await release.promise;
          }
          return base.client.createActivityMessage(input);
        },
        async updateMessageBody(messageId, body) {
          if (write === "clear" && body === "") {
            entered.resolve();
            await release.promise;
          }
          return base.client.updateMessageBody(messageId, body);
        },
      };
      const publisher = createClickClackActivityPublisher({
        client,
        target: { channelId: "chn_1" },
        turnId: "msg_turn",
      });
      const visible = {
        itemId: "commentary",
        kind: "commentary",
        progressText: "Visible progress",
      };
      const hidden: Parameters<typeof publisher.onItemEvent>[0] = {
        ...visible,
        suppressDurableProgress: true,
      };
      publisher.onItemEvent(visible);
      if (write === "clear") {
        await publisher.finalize();
        publisher.onItemEvent(hidden);
      }
      const flushing = publisher.finalize();
      try {
        await entered.promise;
        publisher.onItemEvent(
          write === "post" ? hidden : { ...visible, progressText: "Visible again" },
        );
      } finally {
        release.resolve();
        await flushing;
        await publisher.finalize();
      }
      expect(base.createActivityMessage).toHaveBeenCalledOnce();
      expect(base.updateMessageBody).toHaveBeenLastCalledWith(
        "msg_1",
        write === "post" ? "" : "Visible again",
      );
    },
  );

  it("discards staged commentary without losing its confirmed row or suppressing a later current snapshot", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
    });
    publisher.onItemEvent({
      itemId: "commentary",
      kind: "preamble",
      phase: "end",
      progressText: "Confirmed",
    });
    await publisher.finalize();
    const replacement = {
      itemId: "commentary",
      kind: "preamble",
      phase: "end" as const,
      progressText: "Current replacement",
    };
    publisher.onItemEvent(replacement);
    publisher.discardPendingItem("commentary");
    await publisher.finalize();
    expect(updateMessageBody).not.toHaveBeenCalled();
    publisher.onItemEvent(replacement);
    await publisher.finalize();
    expect(createActivityMessage).toHaveBeenCalledOnce();
    expect(updateMessageBody).toHaveBeenLastCalledWith("msg_1", "Current replacement");
  });

  it("opens a new durable row for each commentary segment (item id)", async () => {
    const { client, createActivityMessage } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { conversationId: "dcn_1" },
      turnId: "msg_turn",
    });

    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "before tool" });
    publisher.onItemEvent({ itemId: "c2", kind: "preamble", progressText: "after tool" });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(2);
    const bodies = createActivityMessage.mock.calls.map(
      (call) => (call[0] as { body: string }).body,
    );
    expect(bodies).toEqual(["before tool", "after tool"]);
  });

  it("consumes canonical item ownership without rendering suppressed diagnostic siblings", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
    });

    // The runtime emits one opaque toolCallId across all frames of a call;
    // the lane prefix (tool:/command:) lives on itemId only.
    publisher.onItemEvent({
      itemId: "tool:toolu_1",
      toolCallId: "toolu_1",
      kind: "tool",
      name: "exec",
    });
    await publisher.finalize();
    publisher.onItemEvent({
      itemId: "command:toolu_1",
      toolCallId: "toolu_1",
      kind: "command",
      name: "exec",
      progressText: "ls -la",
      suppressChannelProgress: true,
    });
    // A shorter late echo must never clobber the richer body.
    publisher.onItemEvent({
      itemId: "tool:toolu_1",
      toolCallId: "toolu_1",
      kind: "tool",
      name: "exec",
    });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(createActivityMessage.mock.calls[0]?.[0]).toMatchObject({
      kind: "agent_tool",
      body: "🛠️ Exec",
    });
    expect(updateMessageBody).not.toHaveBeenCalled();
  });

  it("updates a durable row when only the outcome changes to failed", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
    });
    const item = {
      itemId: "work",
      kind: "tool",
      name: "read",
      title: "Read sample",
      progressText: "sample.txt",
    };
    publisher.onItemEvent({ ...item, phase: "start", status: "running" });
    await publisher.finalize();
    publisher.onItemEvent({ ...item, phase: "end", status: "failed" });
    await publisher.finalize();
    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(updateMessageBody).toHaveBeenCalledWith("msg_1", expect.stringContaining("failed"));
    expect(updateMessageBody).toHaveBeenCalledWith("msg_1", expect.stringContaining("Read sample"));
  });

  it("hides command metadata from item-only durable activity", async () => {
    const { client, createActivityMessage } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
    });

    publisher.onItemEvent({
      itemId: "tool:toolu_1",
      toolCallId: "toolu_1",
      kind: "tool",
      name: "server.exec",
      meta: "echo private-sentinel",
      commandBearing: true,
    });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "🧩 Server.exec", kind: "agent_tool" }),
    );
    expect(JSON.stringify(createActivityMessage.mock.calls)).not.toContain("private-sentinel");
  });

  it("posts the upgraded body directly when frames land before the first POST runs", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
    });

    publisher.onItemEvent({ toolCallId: "toolu_1", kind: "tool", name: "read" });
    publisher.onItemEvent({
      toolCallId: "toolu_1",
      kind: "tool",
      name: "read",
      progressText: "Done",
    });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(createActivityMessage.mock.calls[0]?.[0]).toMatchObject({
      kind: "agent_tool",
      body: "📖 Read: Done",
    });
    expect(updateMessageBody).not.toHaveBeenCalled();
  });

  it("renders non-tool item kinds as commentary rows and skips lifecycle lanes", async () => {
    const { client, createActivityMessage } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
    });

    publisher.onItemEvent({ itemId: "p1", kind: "plan", title: "Plan", summary: "step one" });
    publisher.onItemEvent({ itemId: "life1", kind: "lifecycle", progressText: "internal state" });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(createActivityMessage.mock.calls[0]?.[0]).toMatchObject({
      kind: "agent_commentary",
      body: "step one",
    });
  });

  it("normalizes reasoning-style progress lanes into durable commentary rows", async () => {
    const { client, createActivityMessage, updateMessageBody } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
      flushMs: 10,
    });

    publisher.onItemEvent({ itemId: "empty1", kind: "thinking", progressText: " " });
    publisher.onItemEvent({
      itemId: "think1",
      kind: "thinking",
      progressText: "Checking the runtime",
    });
    await vi.advanceTimersByTimeAsync(20);
    publisher.onItemEvent({
      itemId: "think1",
      kind: "thinking",
      progressText: "Checking the runtime and recent rows",
    });
    publisher.onItemEvent({
      itemId: "reason1",
      kind: "reasoning",
      progressText: "Comparing provider lanes",
    });
    publisher.onItemEvent({
      itemId: "analysis1",
      kind: "analysis",
      summary: "Mapping this to ClickClack",
    });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(3);
    expect(createActivityMessage.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        body: "**Thinking**\n\nChecking the runtime",
        kind: "agent_commentary",
      }),
      expect.objectContaining({
        body: "**Thinking**\n\nComparing provider lanes",
        kind: "agent_commentary",
      }),
      expect.objectContaining({
        body: "**Thinking**\n\nMapping this to ClickClack",
        kind: "agent_commentary",
      }),
    ]);
    expect(updateMessageBody).toHaveBeenCalledTimes(1);
    expect(updateMessageBody).toHaveBeenCalledWith(
      "msg_1",
      "**Thinking**\n\nChecking the runtime and recent rows",
    );
  });

  it("reports transport failures through onError without rejecting finalize", async () => {
    const onError = vi.fn();
    const createActivityMessage = vi.fn(async () => {
      throw new Error("boom");
    });
    const updateMessageBody = vi.fn(async () => ({}) as ClickClackMessage);
    const publisher = createClickClackActivityPublisher({
      client: { createActivityMessage, updateMessageBody } as ActivityClient,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
      onError,
    });

    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "streaming" });
    await expect(publisher.finalize()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("stamps resolved provenance onto rows posted after setProvenance", async () => {
    const { client, createActivityMessage } = createClientMock();
    const publisher = createClickClackActivityPublisher({
      client,
      target: { channelId: "chn_1" },
      turnId: "msg_turn",
    });

    publisher.setProvenance({ model: "anthropic/claude-opus-4-8", thinking: "low" });
    publisher.onItemEvent({ itemId: "c1", kind: "preamble", progressText: "working on it" });
    await publisher.finalize();

    expect(createActivityMessage).toHaveBeenCalledTimes(1);
    expect(createActivityMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "working on it",
        kind: "agent_commentary",
        provenance: { model: "anthropic/claude-opus-4-8", thinking: "low" },
      }),
    );
  });
});
