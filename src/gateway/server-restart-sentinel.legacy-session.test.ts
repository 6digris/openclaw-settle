import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  SessionDeliveryDeferredError,
  type QueuedSessionDelivery,
} from "../infra/session-delivery-queue.records.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { deliverQueuedSessionDelivery } from "./server-restart-sentinel.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn<typeof import("./session-utils.js").loadSessionEntry>(),
  enqueueSystemEvent: vi.fn(),
  requestHeartbeat: vi.fn(),
}));

vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: mocks.loadSessionEntry,
}));
vi.mock("../infra/system-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/system-events.js")>()),
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));
vi.mock("../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/heartbeat-wake.js")>()),
  requestHeartbeat: mocks.requestHeartbeat,
}));

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "legacy-queue-owner-" });
  vi.clearAllMocks();
  mocks.loadSessionEntry.mockImplementation((sessionKey) => ({
    cfg: { session: { mainKey: "new-home" } },
    agentId: "ops",
    entry: { sessionId: "retained-session", updatedAt: 1 },
    store: {},
    storePath: state.statePath("agents", "ops", "agent.sqlite"),
    canonicalKey: sessionKey,
    storeKeys: [sessionKey],
  }));
});
afterEach(async () => {
  subagentRuns.clear();
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

async function replay(entry: QueuedSessionDelivery) {
  const original = structuredClone(entry);
  try {
    return await deliverQueuedSessionDelivery({
      deps: {},
      entry,
      queueContext: captureOpenClawStateWorkerContext(),
    });
  } finally {
    expect(entry).toEqual(original);
  }
}

it.each([
  { sessionKey: "global", agentId: "ops", expected: "agent:ops:global" },
  { sessionKey: "unknown", agentId: "ops", expected: "agent:ops:unknown" },
  { sessionKey: "agent:ops:main", agentId: "ops", expected: "agent:ops:main" },
  { sessionKey: "global", agentId: undefined, expected: undefined },
  { sessionKey: "main", agentId: "ops", expected: undefined },
])(
  "replays retained $sessionKey only with an exact historical target ($agentId)",
  async ({ sessionKey, agentId, expected }) => {
    const delivery = replay({
      id: "event",
      kind: "systemEvent",
      sessionKey,
      agentId,
      text: "retained result",
      enqueuedAt: 1,
      retryCount: 0,
    });
    if (!expected) {
      await expect(delivery).rejects.toThrow(SessionDeliveryDeferredError);
      expect(mocks.loadSessionEntry).not.toHaveBeenCalled();
      expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
      return;
    }
    await delivery;
    expect(mocks.loadSessionEntry).toHaveBeenCalledExactlyOnceWith(expected, { agentId });
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("retained result", {
      sessionKey: expected,
    });
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "ops", sessionKey: expected }),
    );
  },
);

it.each([
  {
    sessionKey: "global",
    requester: "agent:ops:global",
    generation: 1,
    expected: "agent:ops:global",
  },
  {
    sessionKey: "unknown",
    requester: "agent:ops:unknown",
    generation: 1,
    expected: "agent:ops:unknown",
  },
  {
    sessionKey: "main",
    requester: "agent:ops:main",
    generation: 1,
    expected: "agent:ops:main",
  },
  { sessionKey: "main", requester: "agent:ops:old-home", generation: 1, expected: undefined },
  {
    sessionKey: "global",
    requester: "agent:worker:subagent:ended",
    generation: 1,
    expected: undefined,
  },
  {
    sessionKey: "agent:ops:main",
    requester: "agent:ops:old-home",
    generation: 1,
    expected: "agent:ops:main",
  },
  { sessionKey: "main", requester: "main", generation: 1, expected: undefined },
  { sessionKey: "main", requester: "agent:ops:old-home", generation: 2, expected: undefined },
])(
  "replays correlated $sessionKey from captured $requester at generation $generation",
  async ({ sessionKey, requester, generation, expected }) => {
    const deadlineAt = Date.now() + 60_000;
    const entry = createSubagentRunRecord({
      runId: "child-run",
      childSessionKey: "agent:worker:subagent:child",
      requesterAgentId: requester === "agent:worker:subagent:ended" ? "worker" : "ops",
      requesterSessionKey: requester,
      controllerSessionKey: "agent:ops:global",
      swarmWaitOwnerSessionKeys: ["agent:ops:global"],
      completion: { required: true, resultText: "retained result" },
      delivery: { status: "in_progress", queueId: "completion", generation, deadlineAt },
    });
    subagentRuns.set(entry.runId, entry);
    const delivery = replay({
      id: "completion",
      kind: "agentTurn",
      sessionKey,
      message: "placeholder",
      messageId: "completion",
      enqueuedAt: 1,
      retryCount: 0,
      owner: {
        kind: "subagent_completion",
        runId: entry.runId,
        taskId: "task",
        generation: 1,
        deadlineAt,
      },
    });
    if (!expected) {
      await expect(delivery).rejects.toThrow(SessionDeliveryDeferredError);
      expect(mocks.loadSessionEntry).not.toHaveBeenCalled();
      expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
      return;
    }
    await delivery;
    expect(mocks.loadSessionEntry).toHaveBeenCalledExactlyOnceWith(expected, undefined);
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("retained result"),
      { sessionKey: expected },
    );
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: expected }),
    );
  },
);
