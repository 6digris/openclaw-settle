import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { requestHeartbeat } from "./heartbeat-runtime.js";

const handler = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  resetGatewayWorkAdmission();
  handler.mockClear();
  dispose = setHeartbeatWakeHandler(handler);
});

afterEach(async () => {
  await vi.runAllTimersAsync();
  dispose?.();
  vi.useRealTimers();
});

it.each(
  ["!!!", "", " "].flatMap((agentId) =>
    [undefined, "agent:main:main"].map((sessionKey) => ({ agentId, sessionKey })),
  ),
)("rejects explicit malformed SDK heartbeat ownership: %j", async (target) => {
  expect(() =>
    requestHeartbeat({ source: "manual", intent: "manual", ...target, coalesceMs: 0 }),
  ).toThrow(/agentId/);
  await vi.advanceTimersByTimeAsync(1);
  expect(handler).not.toHaveBeenCalled();
});

it.each([
  { target: {}, expected: {} },
  { target: { agentId: " Bad Agent " }, expected: { agentId: "bad-agent" } },
  {
    target: { sessionKey: "agent:Bad Agent:notes" },
    expected: { sessionKey: "agent:bad-agent:notes" },
  },
  {
    target: { agentId: " Bad Agent ", sessionKey: "agent:Bad Agent:notes" },
    expected: { agentId: "bad-agent", sessionKey: "agent:bad-agent:notes" },
  },
])("delivers valid SDK heartbeat ownership: %j", async ({ target, expected }) => {
  requestHeartbeat({ source: "manual", intent: "manual", ...target, coalesceMs: 0 });
  await vi.advanceTimersByTimeAsync(1);
  expect(handler).toHaveBeenCalledExactlyOnceWith({
    source: "manual",
    intent: "manual",
    reason: "requested",
    ...expected,
  });
});
