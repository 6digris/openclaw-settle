import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { captureGatewayDeviceRevocation } from "../device-revocation.js";
import * as asyncApprovalStore from "../operator-approval-store.async.js";
import { getOperatorApprovalDetailed } from "../operator-approval-store.js";
import { createRequiredSharedGatewaySessionGenerationReader } from "../server-shared-auth-generation.js";
import { createOperatorWsClient } from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import type { createApprovalHandlers } from "./approval.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  bindWebSocketRequestMutationAuthority,
} from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions, GatewayRequestOptions } from "./types.js";

export function getOperatorApproval(params: Parameters<typeof getOperatorApprovalDetailed>[0]) {
  const result = getOperatorApprovalDetailed(params);
  return result.outcome === "found" ? result.record : null;
}

export function approvalFromResult(result: unknown) {
  if (!result || typeof result !== "object" || !("approval" in result)) {
    throw new Error("missing approval response");
  }
  return (result as { approval: Record<string, unknown> }).approval;
}

/** A host Date spy does not change the physical worker's clock. */
export function mockApprovalLookupTime(nowMs: number): void {
  const lookup = asyncApprovalStore.getOperatorApprovalDetailedAsync;
  vi.spyOn(asyncApprovalStore, "getOperatorApprovalDetailedAsync").mockImplementation((params) =>
    lookup({ ...params, nowMs }),
  );
}

export function expectSuccessfulApprovalResponses(
  responses: Awaited<ReturnType<typeof invoke>>[],
  context: GatewayRequestHandlerOptions["context"],
): void {
  expect(
    responses.map(({ ok, result, error }) => ({ ok, result, error })),
    JSON.stringify(vi.mocked(context.logGateway.error).mock.calls),
  ).toMatchObject(responses.map(() => ({ ok: true, error: undefined })));
}

export function createClient(params: {
  scopes?: string[];
  deviceId?: string;
  internal?: boolean;
  connId?: string;
}): GatewayWsClient {
  const client = createOperatorWsClient({
    connId: params.connId ?? (params.deviceId ? `conn-${params.deviceId}` : "conn-no-device"),
    scopes: params.scopes ?? ["operator.approvals"],
    clientInfo: { id: "approval-test", mode: "backend" },
  });
  client.connect.client.displayName = "Approval Test";
  if (params.deviceId) {
    client.connect.device = {
      id: params.deviceId,
      publicKey: "synthetic-public-key",
      signature: "synthetic-signature",
      signedAt: 1,
      nonce: "synthetic-nonce",
    };
  }
  if (params.internal) {
    client.internal = { approvalRuntime: true };
  }
  return client;
}

export function createContext(
  controlUiBasePath?: string,
  approvalWebPushDelivery?: GatewayRequestHandlerOptions["context"]["approvalWebPushDelivery"],
) {
  const cfg = { gateway: { controlUi: { basePath: controlUiBasePath } } };
  return {
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    approvalEvents: {
      publishRequested: vi.fn(() => 0),
      publishResolved: vi.fn(),
    },
    getApprovalClientConnIds: vi.fn(() => new Set(["approval-client"])),
    getRuntimeConfig: () => cfg,
    approvalWebPushDelivery,
    logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as unknown as GatewayRequestHandlerOptions["context"];
}

type ApprovalInvocationParams = {
  handlers: ReturnType<typeof createApprovalHandlers>;
  method: "approval.get" | "approval.history" | "approval.resolve";
  body: Record<string, unknown>;
  client: GatewayWsClient | null;
  context?: GatewayRequestHandlerOptions["context"];
  sessionMutationCommitGuard?: () => void;
};

export function createApprovalInvocation(params: ApprovalInvocationParams) {
  const respond = vi.fn();
  const context = params.context ?? createContext();
  const client = params.client;
  const capture = captureGatewayDeviceRevocation(
    context,
    { deviceId: client?.connect.device?.id, role: client?.connect.role ?? "operator" },
    () => !client?.invalidated,
    client?.connectionSignal,
  );
  const request: GatewayRequestOptions = {
    req: { id: "req-1", type: "req", method: params.method, params: params.body },
    client,
    context,
    isWebchatConnect: () => false,
    respond,
    hasCurrentClientAuthority: capture.isCurrent,
    ...(params.sessionMutationCommitGuard
      ? { sessionMutationCommitGuard: params.sessionMutationCommitGuard }
      : {}),
  };
  if (client) {
    bindWebSocketRequestMutationAuthority(
      request,
      client,
      createRequiredSharedGatewaySessionGenerationReader({ current: undefined, required: null }),
    );
  }
  const options = bindGatewayRequestHandlerMutationAuthority(
    request,
    { ...request, params: params.body },
    undefined,
  );
  return {
    context,
    respond,
    invoke: async () => {
      try {
        await expectDefined(
          params.handlers[params.method],
          "params.handlers[params.method] test invariant",
        )(options);
        const response = respond.mock.calls[0];
        if (!response) {
          throw new Error("approval handler did not respond");
        }
        return { ok: response[0], result: response[1], error: response[2], context };
      } finally {
        capture.release();
      }
    },
  };
}

export async function invoke(params: ApprovalInvocationParams) {
  return createApprovalInvocation(params).invoke();
}
