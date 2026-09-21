import { onTestFinished, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { HealthSummary } from "../../health/types.js";

export function useGatewayTestConfig<T>(mock: Mock<() => T>, implementation: () => T) {
  const previous = mock.getMockImplementation();
  onTestFinished(() => {
    if (previous) {
      mock.mockImplementation(previous);
    }
  });
  mock.mockImplementation(implementation);
}

export function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

export function createHealthSummary(): HealthSummary {
  return {
    ok: true,
    ts: 1,
    durationMs: 1,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    defaultAgentId: "main",
    agents: [],
    sessions: { path: "", count: 0, recent: [] },
  };
}

type ConnectedTestClient = {
  invalidated: boolean;
  invalidatedReason?: string;
  connect: {
    client: {
      id: string;
      version: string;
      platform: string;
      mode: string;
    };
    role: "operator";
    scopes: string[];
  };
  connId: string;
  usesSharedGatewayAuth: false;
};

export function createConnectedTestClient(params: {
  connId: string;
  invalidated?: boolean;
  invalidatedReason?: string;
}): ConnectedTestClient {
  return {
    invalidated: params.invalidated ?? false,
    ...(params.invalidatedReason ? { invalidatedReason: params.invalidatedReason } : {}),
    connect: {
      client: {
        id: "openclaw-control-ui",
        version: "dev",
        platform: "test",
        mode: "ui",
      },
      role: "operator",
      scopes: [],
    },
    connId: params.connId,
    usesSharedGatewayAuth: false,
  };
}

export function createGatewayAttachmentCompletion(connId: string, warnings: () => unknown) {
  const completion = createDeferred();
  void completion.promise.catch(() => {});
  return {
    promise: completion.promise,
    attached(callback?: () => void) {
      try {
        callback?.();
        completion.resolve();
      } catch (error) {
        completion.reject(error);
        throw error;
      }
    },
    closed(code?: number, reason?: string) {
      completion.reject(
        new Error(
          `Connection ${connId} closed before attachment: ${code ?? "no code"} ${reason ?? "no reason"}; warnings=${JSON.stringify(warnings())}`,
        ),
      );
    },
  };
}
