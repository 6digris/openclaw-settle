import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  SessionTranscriptMessageEntry,
  TranscriptTurnAdmission,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAcpxNativeAttempt, type AcpxNativeAttemptInput } from "./native-attempt.js";
import type { AcpxNativeRuntime } from "./native-types.js";
import type { CompleteAcpRuntime } from "./runtime-proxy.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn<() => Promise<SessionTranscriptMessageEntry[]>>(),
  append: vi.fn(),
  publish: vi.fn(async () => {}),
  setActive: vi.fn(),
  clearActive: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  setActiveEmbeddedRun: mocks.setActive,
  clearActiveEmbeddedRun: mocks.clearActive,
  resolveBootstrapContextForRun: async () => ({
    contextFiles: [{ path: "SOUL.md", content: "Keep workspace guidance." }],
  }),
  resolveAgentHarnessBeforePromptBuildResult: async (input: {
    prompt: string;
    developerInstructions: string;
  }) => input,
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  resolveStorePath: () => "/test/sessions",
}));
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  readVisibleSessionTranscriptMessageEntries: mocks.read,
  appendSessionTranscriptMessageByIdentityStrict: mocks.append,
  publishSessionTranscriptUpdateByIdentity: mocks.publish,
}));

const target = {
  agentId: "main",
  sessionId: "session",
  sessionKey: "agent:main:chat",
  agent: "opencode",
};
const admission: TranscriptTurnAdmission = {
  ...target,
  storePath: "/test/sessions",
  generation: "generation",
  entryId: "committed-input",
  rawSeq: 2,
  effectiveParentId: null,
  activeMessagePosition: 1,
  logicalTurnId: "logical-turn",
  role: "user",
};
const user: Extract<AgentMessage, { role: "user" }> = {
  role: "user",
  content: "hello",
  timestamp: 1,
};
const handle = {
  sessionKey: "native-resource",
  agentId: "main",
  backend: "acpx",
  runtimeSessionName: "native",
  backendSessionId: "native-session",
};
type Turn = ReturnType<CompleteAcpRuntime["startTurn"]>;

function fixture() {
  let persisted = false;
  const turn: Omit<Turn, "events" | "result"> & { events: Turn["events"]; result: Turn["result"] } =
    {
      requestId: admission.entryId,
      promptStarted: Promise.resolve(),
      events: (async function* () {
        yield { type: "text_delta", text: "Hello" };
      })(),
      result: Promise.resolve({ status: "completed" }),
      cancel: vi.fn(async () => {}),
      closeStream: vi.fn(async () => {}),
    };
  const startTurn = vi.fn<CompleteAcpRuntime["startTurn"]>(() => turn);
  const native: AcpxNativeRuntime = {
    withSession: async (input, run) => {
      input.assertActive();
      return run({ runtime: { startTurn }, handle, getStatus: () => native.getStatus(handle) });
    },
    closeSession: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({
      models: { currentModelId: "vendor/model", availableModelIds: ["vendor/model"] },
    })),
  };
  const input: AcpxNativeAttemptInput = {
    ...target,
    sessionFile: "/test/session",
    workspaceDir: "/test/workspace",
    runId: "run",
    config: {},
    provider: "vendor",
    modelId: "model",
    model: { api: "openai-responses" },
    prompt: "hello",
    timeoutMs: 30_000,
    hostCapabilities: {
      assertActive: vi.fn(),
      requestApproval: vi.fn<AcpxNativeAttemptInput["hostCapabilities"]["requestApproval"]>(
        async () => ({ decision: "deny" }),
      ),
    },
    userTurnTranscriptRecorder: {
      message: user,
      resolveMessage: async () => user,
      getAdmissionReceipt: () => (persisted ? admission : undefined),
      markRuntimePersistencePending() {},
      markRuntimePersisted() {},
      markBlocked() {},
      hasPersisted: () => persisted,
      isBlocked: () => false,
      hasRuntimePersistencePending: () => false,
      waitForRuntimePersistence: async () => {},
      persistApproved: async () => {
        persisted = true;
        return undefined;
      },
      persistBlocked: async () => undefined,
      persistFallback: async () => undefined,
    },
  };
  const active = new Map<string, () => void>();
  const run = () =>
    runAcpxNativeAttempt({
      input,
      target,
      native,
      command: ["opencode", "acp"],
      harnessId: "opencode",
      label: "OpenCode",
      active,
    });
  return { input, native, turn, startTurn, active, run };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue([]);
  mocks.append.mockImplementation(async (input: { message: AgentMessage }) => ({
    kind: "result",
    result: {
      message: input.message,
      messageId: "assistant",
      appended: true,
      anchor: { ...admission, entryId: "assistant" },
    },
  }));
});

describe("ACPX native harness attempt", () => {
  it("submits the committed input anchor, bootstrap guidance, and canonical assistant", async () => {
    const test = fixture();
    const result = await test.run();
    expect(test.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: admission.entryId,
        text: expect.stringContaining("Keep workspace guidance."),
      }),
    );
    expect(result.terminal.kind).toBe("ok");
    expect(result.assistantTranscriptIdempotencyKey).toBe(
      `${admission.entryId}:acp-native:assistant`,
    );
    expect(test.active.size).toBe(0);
    expect(mocks.clearActive).toHaveBeenCalledOnce();
  });

  it("continues from a cancelled input anchor without requiring an assistant marker", async () => {
    const test = fixture();
    mocks.read.mockResolvedValue([
      { entryId: "previous-input", parentId: null, seq: 1, message: user, role: "user" },
    ]);
    test.native.withSession = async (_input, run) =>
      run({
        runtime: { startTurn: test.startTurn },
        handle,
        lastRequestId: "previous-input",
        getStatus: () => test.native.getStatus(handle),
      });
    const result = await test.run();
    expect(result.terminal.kind).toBe("ok");
    expect(test.startTurn).toHaveBeenCalledWith(expect.objectContaining({ text: "hello" }));
  });

  it("shows a denied requested permission and retains the failed tool update", async () => {
    const test = fixture();
    test.native.withSession = async (input, run) => {
      expect(
        await input.onPermissionRequest(
          {
            sessionId: "native-session",
            inferredKind: "edit",
            raw: {
              sessionId: "native-session",
              toolCall: { toolCallId: "write", title: "Write file", kind: "edit" },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "reject", name: "Reject", kind: "reject_once" },
              ],
            },
          },
          { signal: new AbortController().signal },
        ),
      ).toEqual({ outcome: "reject_once" });
      return run({
        runtime: { startTurn: test.startTurn },
        handle,
        getStatus: () => test.native.getStatus(handle),
      });
    };
    test.turn.events = (async function* () {
      yield { type: "tool_call", toolCallId: "write", text: "Write file", status: "pending" };
      yield { type: "tool_call", toolCallId: "write", text: "Permission denied", status: "failed" };
    })();
    const result = await test.run();
    expect(result.assistantTexts).toEqual([
      "OpenCode could not complete this turn because permission was not granted.",
    ]);
    expect(result.toolMetas).toEqual([
      expect.objectContaining({ toolCallId: "write", isError: true }),
    ]);
  });

  it("uses the runtime abort signal as the single cancellation owner", async () => {
    const test = fixture();
    const controller = new AbortController();
    test.input.abortSignal = controller.signal;
    test.startTurn.mockImplementation((input) => {
      const result = Promise.resolve({ status: "cancelled" as const });
      controller.abort();
      expect(input.signal?.aborted).toBe(true);
      return { ...test.turn, events: (async function* () {})(), result };
    });
    const result = await test.run();
    expect(result.terminal.kind).toBe("aborted");
    expect(test.turn.cancel).not.toHaveBeenCalled();
    expect(test.active.size).toBe(0);
  });

  it("does not submit after cancellation during session preparation", async () => {
    const test = fixture();
    const controller = new AbortController();
    test.input.abortSignal = controller.signal;
    test.native.withSession = async (input) => {
      controller.abort();
      input.assertActive();
      throw new Error("unreachable");
    };
    expect((await test.run()).terminal.kind).toBe("aborted");
    expect(test.startTurn).not.toHaveBeenCalled();
    expect(test.active.size).toBe(0);
  });

  it("releases active registration even when transport cleanup rejects", async () => {
    const test = fixture();
    test.turn.events = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error("stream failed");
        },
      }),
    };
    vi.mocked(test.turn.cancel).mockRejectedValue(new Error("cancel failed"));
    const result = await test.run();
    expect(result.terminal).toMatchObject({ kind: "failed", error: new Error("stream failed") });
    expect(test.turn.closeStream).toHaveBeenCalledOnce();
    expect(test.active.size).toBe(0);
    expect(mocks.clearActive).toHaveBeenCalledOnce();
  });
});
