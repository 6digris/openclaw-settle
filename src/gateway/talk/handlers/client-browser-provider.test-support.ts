import path from "node:path";
import { vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import { resolveSessionMutationAuthorization } from "../../session-sharing.js";
import { createTalkClient } from "./client-create.js";
export type BrowserRequest = Parameters<
  NonNullable<
    import("../../../plugins/types.js").RealtimeVoiceProviderPlugin["createBrowserSession"]
  >
>[0];
export const browserSession = {
  provider: "openai",
  transport: "webrtc" as const,
  clientSecret: "test-pending-offer",
  offerUrl: "/plugins/openai/realtime/calls",
};

export function configureBrowserProviderFixture(
  tempDir: string,
  resolveProvider: { mockReturnValue: (value: unknown) => unknown },
  createBrowserSession: (request: BrowserRequest) => Promise<typeof browserSession>,
) {
  const cancelBrowserSession = vi.fn(async () => undefined);
  const provider = {
    id: "openai",
    capabilities: { transports: ["webrtc"], handlesAgentConsult: true, supportsToolCalls: false },
    createBrowserSession,
  };
  Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
    value: { isBrowserSessionConfigured: () => true, cancelBrowserSession },
  });
  resolveProvider.mockReturnValue({
    provider,
    providerConfig: {},
    capabilities: provider.capabilities,
  });
  const client = { connId: "conn-close" };
  const clients = new Set([client]);
  return {
    provider,
    cancelBrowserSession,
    client,
    clients,
    context: {
      getRuntimeConfig: () => ({
        agents: { defaults: { workspace: path.join(tempDir, "workspace") } },
      }),
      getClientConnIds: (filter?: (candidate: typeof client) => boolean) =>
        new Set(
          [...clients]
            .filter((candidate) => !filter || filter(candidate))
            .map((candidate) => candidate.connId),
        ),
      chatAbortControllers: new Map(),
      logGateway: { warn: vi.fn() },
      broadcastToConnIds: vi.fn(),
    },
  };
}

export async function invokeCreate(options: GatewayRequestHandlerOptions) {
  const admission = resolveSessionMutationAuthorization({
    method: "talk.client.create",
    requestParams: options.params,
    context: options.context,
    client: options.client,
  });
  if (admission.error) {
    options.respond(false, undefined, admission.error);
    return;
  }
  await createTalkClient({ ...options, sessionMutationAuthorization: admission.authorization });
}
