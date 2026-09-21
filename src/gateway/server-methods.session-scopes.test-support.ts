import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { handleGatewayRequest } from "./server-methods.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandler,
  RespondFn,
} from "./server-methods/types.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";

export function roleConfig(
  scopes = ["operator.write"],
  others: "none" | "write" = "write",
): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "visitor",
        definitions: { visitor: { sessions: { others }, agents: ["main"], scopes } },
      },
    },
  };
}

export function requestContext(
  getRuntimeConfig: () => OpenClawConfig,
  getCommittedRuntimeConfig: () => OpenClawConfig = getRuntimeConfig,
): GatewayRequestContext {
  return {
    ...createGatewayRequestContext(makeContextParams()),
    getRuntimeConfig,
    getCommittedRuntimeConfig,
  };
}

export async function dispatch(params: {
  method: string;
  params: Record<string, unknown>;
  client: GatewayClient;
  context: GatewayRequestContext;
  handler?: GatewayRequestHandler;
  signal?: AbortSignal;
}) {
  const respond = vi.fn<RespondFn>();
  await initializeSessionReadContext(params.context);
  await handleGatewayRequest({
    req: { type: "req", id: randomUUID(), method: params.method, params: params.params },
    client: params.client,
    context: params.context,
    isWebchatConnect: () => false,
    respond,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.handler ? { extraHandlers: { [params.method]: params.handler } } : {}),
  });
  return respond;
}
