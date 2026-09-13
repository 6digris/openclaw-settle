import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLocalSource } from "../../config/sessions/types.js";
import type { LocalSessionRecord } from "../../sessions/local-session-source-protocol.js";

const appended: Array<Record<string, unknown>> = [];

vi.mock("../../plugin-sdk/session-transcript-runtime.js", () => ({
  withSessionTranscriptWriteLock: async (
    _scope: unknown,
    run: (transcript: {
      appendMessage: (params: { message: Record<string, unknown> }) => Promise<void>;
      publishUpdate: () => Promise<void>;
    }) => Promise<void>,
  ) =>
    await run({
      appendMessage: async ({ message }) => {
        appended.push(message);
      },
      publishUpdate: async () => {},
    }),
}));

vi.mock("../../config/sessions/session-local-store.js", () => ({
  advanceLocalSessionMirrorCheckpoint: () => {},
  readLocalSessionMirrorCheckpoint: () => undefined,
}));

const { appendMirroredRecords } = await import("./bridge-mirror.js");

const SOURCE: SessionLocalSource = {
  pluginId: "anthropic",
  sourceId: "claude",
  deviceId: "device-1",
  threadId: "thread-1",
  enrollmentId: "enrollment-1",
};

function thread() {
  return {
    sessionKey: "agent:main:local:claude:device-1:owner-1:thread-1",
    sessionId: "session-1",
    agentId: "main",
    storePath: "/tmp/store",
    threadId: "thread-1",
    state: "active" as const,
    canInput: true,
    acceptedSeq: 0,
    appendChain: Promise.resolve(),
  };
}

async function mirror(...records: LocalSessionRecord[]) {
  appended.length = 0;
  await appendMirroredRecords({
    cfg: {} as never,
    thread: thread(),
    source: SOURCE,
    records,
  });
  return appended;
}

// The team reads these sessions in Control UI, which builds tool cards, call/result
// pairing, and reasoning disclosures from content block shape. Prefixed prose
// ("Tool call · Bash\n\n{…}") renders as an unreadable wall of text instead.
describe("mirrored records become native content blocks", () => {
  beforeEach(() => {
    appended.length = 0;
  });

  it("projects a tool call as a tool_use block carrying its native identity", async () => {
    const [message] = await mirror({
      id: "a1",
      seq: 1,
      ts: 1,
      kind: "toolCall",
      text: '{"command":"ls"}',
      toolName: "Bash",
      toolCallId: "t1",
      toolInput: { command: "ls" },
    });
    expect(message?.content).toEqual([
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ]);
  });

  it("pairs a failing tool result back to its call", async () => {
    const [message] = await mirror({
      id: "a2",
      seq: 2,
      ts: 2,
      kind: "toolResult",
      text: "boom",
      toolName: "Bash",
      toolCallId: "t1",
      isError: true,
      exitCode: 2,
    });
    expect(message?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "t1",
        name: "Bash",
        content: "boom",
        is_error: true,
        exitCode: 2,
      },
    ]);
  });

  it("keeps the call populated when the source dropped an oversized input", async () => {
    const [message] = await mirror({
      id: "a3",
      seq: 3,
      ts: 3,
      kind: "toolCall",
      text: "{huge}",
      toolName: "Bash",
      toolCallId: "t2",
    });
    expect(message?.content).toEqual([
      { type: "tool_use", id: "t2", name: "Bash", input: "{huge}" },
    ]);
  });

  it("projects reasoning and assistant text as their own block kinds", async () => {
    const messages = await mirror(
      { id: "a4", seq: 4, ts: 4, kind: "reasoning", text: "weighing options" },
      { id: "a5", seq: 5, ts: 5, kind: "assistant", text: "done" },
    );
    expect(messages[0]?.content).toEqual([{ type: "thinking", thinking: "weighing options" }]);
    expect(messages[1]?.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("keeps a user record a plain user message", async () => {
    const [message] = await mirror({
      id: "u1",
      seq: 6,
      ts: 6,
      kind: "user",
      text: "hello",
      clientId: "in_1",
    });
    expect(message).toMatchObject({ role: "user", content: "hello" });
  });
});
