import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  getAgentRunContextOwnership,
  recordAgentRunModel,
  registerAgentRunContext,
  releaseAgentRunContext,
  resolveProjectedAgentRunProgressState,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
  sweepStaleRunContexts,
} from "./agent-run-registry.js";

beforeEach(resetAgentRunRegistryForTest);
afterEach(() => {
  resetAgentRunRegistryForTest();
  vi.restoreAllMocks();
});

it("normalizes a qualified run owner before registry publication", () => {
  registerAgentRunContext("normalized", { sessionKey: "AGENT: Bad Agent :notes" });
  expect(getAgentRunContext("normalized")?.sessionKey).toBe("agent:bad-agent:notes");
  registerAgentRunContext("normalized", { agentId: " Bad Agent " });
  expect(getAgentRunContext("normalized")?.agentId).toBe("bad-agent");
  expect(() =>
    registerAgentRunContext("invalid-side", { agentId: "!!!", sessionKey: "agent:main:notes" }),
  ).toThrow();
  expect(getAgentRunContext("invalid-side")).toBeUndefined();
  for (const sessionKey of ["agent:---:notes", "agent::notes", "agent:ops", "agent:ops:"]) {
    expect(() => registerAgentRunContext("invalid", { sessionKey, agentId: "main" })).toThrow();
    expect(getAgentRunContext("invalid")).toBeUndefined();
  }
});

it("rejects conflicting run owners before registration or claim mutation", () => {
  const foreign = { agentId: "ops", sessionKey: "agent:research:global" };
  expect(() => registerAgentRunContext("unbound", foreign)).toThrow("does not match");
  expect(() => claimAgentRunContext("unbound", foreign, { trackOwner: true })).toThrow(
    "does not match",
  );
  expect(getAgentRunContext("unbound")).toBeUndefined();
  expect(getAgentRunContextOwnership("unbound")).toBeUndefined();

  registerAgentRunContext("bound", { agentId: "ops", sessionKey: "AGENT:OPS:GLOBAL" });
  const original = { ...getAgentRunContext("bound") };
  const changed = vi.fn();
  const stop = sessionChanges.subscribe(changed);
  try {
    const update = { sessionKey: "agent:research:global" };
    expect(() => registerAgentRunContext("bound", update)).toThrow("does not match");
    expect(() => claimAgentRunContext("bound", update, { trackOwner: true })).toThrow(
      "does not match",
    );
    expect(getAgentRunContext("bound")).toEqual(original);
    expect(getAgentRunContext("bound")?.sessionKey).toBe("agent:ops:global");
    expect(getAgentRunContextOwnership("bound")).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

it.each(["main", "global", "unknown"])(
  "rejects ownerless %s before registration or claim publication",
  (sessionKey) => {
    const changed = vi.fn();
    const stop = sessionChanges.subscribe(changed);
    try {
      expect(() => registerAgentRunContext("unbound", { sessionKey })).toThrow("explicit agentId");
      expect(() => claimAgentRunContext("unbound", { sessionKey }, { trackOwner: true })).toThrow(
        "explicit agentId",
      );
      expect(getAgentRunContext("unbound")).toBeUndefined();
      expect(getAgentRunContextOwnership("unbound")).toBeUndefined();
      expect(changed).not.toHaveBeenCalled();
      for (const agentId of ["ops", "research"]) {
        expect(
          resolveProjectedAgentRunProgressState({
            sessionKeys: [`agent:${agentId}:${sessionKey}`],
            agentId,
            defaultAgentId: agentId,
          }),
        ).toBeUndefined();
      }
      registerAgentRunContext("sessionless", { sessionId: "unbound-session" });
      registerAgentRunContext("sessionless", { sessionKey, agentId: "ops" });
      expect(getAgentRunContext("sessionless")?.sessionKey).toBe(`agent:ops:${sessionKey}`);
    } finally {
      stop();
    }
  },
);

it.each([
  { name: "registration", register: registerAgentRunContext },
  { name: "claim", register: claimAgentRunContext },
])("qualifies $name before publishing its session", ({ register }) => {
  const changed = vi.fn();
  const stop = sessionChanges.subscribe(changed);
  try {
    register("owned", { agentId: "research", sessionKey: "global" });
    expect(getAgentRunContext("owned")).toMatchObject({
      agentId: "research",
      sessionKey: "agent:research:global",
    });
    expect(changed.mock.calls).toEqual([
      [{ agentId: "research", sessionKey: "agent:research:global" }],
    ]);
    changed.mockClear();
    registerAgentRunContext("owned", { sessionKey: "unknown" });
    expect(getAgentRunContext("owned")?.sessionKey).toBe("agent:research:unknown");
    expect(changed.mock.calls).toEqual(
      expect.arrayContaining([
        [{ agentId: "research", sessionKey: "agent:research:global" }],
        [{ agentId: "research", sessionKey: "agent:research:unknown" }],
      ]),
    );
  } finally {
    stop();
  }
});

it("publishes affected session identities for registration, moves, models, and release", () => {
  const changed = vi.fn();
  const stop = sessionChanges.subscribe(changed);
  const before = { sessionKey: "agent:main:before", agentId: "main" };
  const after = { sessionKey: "agent:other:after", agentId: "other" };
  try {
    registerAgentRunContext("moving", before);
    expect(changed.mock.calls).toEqual([[before]]);
    changed.mockClear();

    registerAgentRunContext("moving", after);
    expect(changed.mock.calls).toEqual(expect.arrayContaining([[before], [after]]));
    expect(changed).toHaveBeenCalledTimes(2);
    changed.mockClear();

    recordAgentRunModel("moving", { provider: "openai", model: "test-model" });
    expect(changed.mock.calls).toEqual([[after]]);
    changed.mockClear();
    recordAgentRunModel("moving", { provider: "openai", model: "test-model" });
    expect(changed).not.toHaveBeenCalled();

    const claim = claimAgentRunContext("moving", after, { trackOwner: true, ownsContext: true });
    changed.mockClear();
    releaseAgentRunContext("moving", claim);
    expect(changed.mock.calls).toEqual([[after]]);
    changed.mockClear();
    clearAgentRunContext("missing");
    expect(changed).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

it("invalidates the run projection on lifecycle rotation and orphan cleanup", () => {
  const changed = vi.fn();
  const stop = sessionChanges.subscribe(changed);
  try {
    rotateAgentRunRegistryLifecycleGeneration();
    expect(changed.mock.calls).toEqual([[{ all: true, scope: "agent-runs" }]]);
    registerAgentRunContext("orphan", { registeredAt: 1 });
    changed.mockClear();
    expect(sweepStaleRunContexts(1)).toBe(1);
    expect(changed.mock.calls).toEqual([[{ all: true, scope: "agent-runs" }]]);
    changed.mockClear();
    registerAgentRunContext("session-id-only", { agentId: "worker", sessionId: "shared-id" });
    expect(changed.mock.calls).toEqual([[{ all: true, scope: "agent-runs" }]]);
  } finally {
    stop();
  }
});
