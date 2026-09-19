// Exercises cutover through the registered suspension RPC dispatcher and real admission owner.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { createCoreGatewayMethodDescriptors } from "../../gateway/methods/core-method-policy.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import { getGatewayProcessInstanceId } from "../../gateway/process-instance.js";
import { handleGatewayRequest } from "../../gateway/server-methods.js";
import { suspendHandlers } from "../../gateway/server-methods/suspend.js";
import { resetGatewaySuspendCoordinatorForLifecycleRestart } from "../../infra/gateway-suspend-coordinator.js";
import {
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { prepareGatewayUpdateCutover } from "./update-cutover.js";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("../../gateway/call.js", () => ({ callGateway: rpc }));
vi.mock("./lifecycle-context.js", () => ({
  resolveGatewayLifecycleContext: async () => ({ port: 1234, env: {} }),
}));
vi.mock("./restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: async () => ({ config: {}, auth: {} }),
}));
vi.mock("../../gateway/local-http-probe.js", () => ({
  createConfiguredGatewayLocalProbe: () => ({ resolveWebSocketTarget: async () => ({}) }),
}));

let bootId: string;
let current: boolean;
let lostPrepareReply: boolean;
let revokeAfterLostReply: boolean;
let failMethod: string | undefined;
const pauseScheduling = vi.fn();
const resumeScheduling = vi.fn();
const terminalSessions = new Map();
const chatAbortControllers = new Map();
const methodRegistry = createGatewayMethodRegistry(
  createCoreGatewayMethodDescriptors(suspendHandlers),
);
const assertCurrent = () => {
  if (!current) {
    throw new Error("executor replaced");
  }
};
const prepare = () => prepareGatewayUpdateCutover({ expectedPid: process.pid, assertCurrent });

beforeEach(() => {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
  vi.clearAllMocks();
  bootId = "original-boot";
  current = true;
  lostPrepareReply = false;
  revokeAfterLostReply = false;
  failMethod = undefined;
  terminalSessions.clear();
  chatAbortControllers.clear();
  rpc.mockImplementation(async (options: CallGatewayOptions) => {
    options.onHelloOk?.({ server: { bootId } } as Parameters<
      NonNullable<CallGatewayOptions["onHelloOk"]>
    >[0]);
    options.assertDispatchCurrent?.();
    if (options.method === failMethod) {
      throw new Error("protocol unavailable or disconnected");
    }
    if (options.method === "system.info") {
      return { pid: process.pid, processInstanceId: getGatewayProcessInstanceId() };
    }
    let result: unknown;
    let failure: unknown;
    await handleGatewayRequest({
      req: { type: "req", id: "cutover", method: options.method, params: options.params ?? {} },
      respond: (ok, payload, error) => {
        if (ok) {
          result = payload;
        } else {
          failure = error;
        }
      },
      client: {
        connId: "cutover",
        connect: {
          role: "operator",
          scopes: ["operator.admin"],
          client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      },
      isWebchatConnect: () => false,
      context: {
        cron: { pauseScheduling, resumeScheduling },
        logGateway: { warn: vi.fn() },
        hostLifecycle: { externalRestart: { isCurrent: () => current } },
        terminalSessions,
        chatAbortControllers,
        chatQueuedTurns: new Map(),
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      methodRegistry,
    });
    if (failure) {
      throw new Error(JSON.stringify(failure));
    }
    if (options.method === "gateway.suspend.prepare" && lostPrepareReply) {
      lostPrepareReply = false;
      if (revokeAfterLostReply) {
        current = false;
      }
      throw new Error("prepare reply lost after server accepted it");
    }
    return result;
  });
});
afterEach(() => {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
});

it("closes admission, arms only the identified process, and restores an unused preparation", async () => {
  const cutover = await prepare();
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  cutover.assertCurrent();
  expect(rpc).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "gateway.suspend.handoff",
      params: expect.objectContaining({
        target: { pid: process.pid, processInstanceId: getGatewayProcessInstanceId() },
      }),
    }),
  );
  await cutover.release();
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
  expect(resumeScheduling).toHaveBeenCalledOnce();
  expect(() => cutover.assertCurrent()).toThrow("released");
});

it("defers registered busy work without cancelling it and restores admission", async () => {
  const active = tryBeginGatewayRootWorkAdmission("existing-native-run");
  expect(active).not.toBeNull();
  try {
    await expect(prepare()).rejects.toThrow("active Gateway work");
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(rpc.mock.calls.some(([call]) => call.method === "gateway.suspend.handoff")).toBe(false);
  } finally {
    active?.release();
  }
});

it.each(["terminal", "unsettled receipt"])(
  "defers %s custody before native mutation",
  async (kind) => {
    if (kind === "terminal") {
      terminalSessions.set("retained", {});
    } else {
      chatAbortControllers.set("unsettled", {
        controller: new AbortController(),
        projectSessionTerminalPending: true,
        registrationCleanupRequested: true,
      });
    }
    await expect(prepare()).rejects.toThrow("active Gateway work");
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  },
);

it.each([false, true])(
  "reconciles a lost prepare reply and restores admission (executor revoked=%s)",
  async (revoked) => {
    lostPrepareReply = true;
    revokeAfterLostReply = revoked;
    await expect(prepare()).rejects.toThrow("prepare reply lost");
    const requests = rpc.mock.calls.filter(([call]) => call.method === "gateway.suspend.prepare");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.[0].params).toEqual(requests[1]?.[0].params);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    expect(resumeScheduling).toHaveBeenCalledOnce();
  },
);

it.each(["gateway.suspend.status", "gateway.suspend.handoff"])(
  "restores admission after %s timeout/disconnect",
  async (method) => {
    failMethod = method;
    await expect(prepare()).rejects.toThrow("disconnected");
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  },
);

it("refuses unavailable preparation without native authority or a false restoration claim", async () => {
  failMethod = "gateway.suspend.prepare";
  await expect(prepare()).rejects.toThrow("restoration could not be confirmed");
  expect(rpc.mock.calls.some(([call]) => call.method === "gateway.suspend.handoff")).toBe(false);
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
});

it("does not transfer preparation to a replacement connection", async () => {
  const cutover = await prepare();
  bootId = "replacement-boot";
  await expect(cutover.refresh()).rejects.toThrow("generation changed");
  bootId = "original-boot";
  await cutover.release();
});

it("restores its own preparation after executor authority is revoked", async () => {
  const cutover = await prepare();
  current = false;
  expect(() => cutover.assertCurrent()).toThrow("executor replaced");
  await cutover.release();
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
});
