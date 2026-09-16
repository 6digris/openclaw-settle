import { vi } from "vitest";
import type { RealtimeVoiceBridge } from "../../talk/provider-types.js";

export const sessionTarget = {
  agentId: "main",
  sessionKey: "agent:main:main",
  canonicalKey: "agent:main:main",
  storePath: "/tmp/sessions",
};

export function controlContext(
  warn = vi.fn(),
  onTalkEvent?: (event: { type: string; payload: unknown }) => void,
) {
  return {
    logGateway: { warn },
    chatAbortControllers: new Map(),
    broadcastToConnIds: vi.fn((_name: string, payload: { talkEvent?: unknown }) => {
      if (payload.talkEvent) {
        onTalkEvent?.(payload.talkEvent as { type: string; payload: unknown });
      }
    }),
  } as never;
}

export function controlBridge() {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    sendUserMessage: vi.fn(),
    submitToolResult: vi.fn(async () => undefined),
    acknowledgeMark: vi.fn(),
    isConnected: vi.fn(() => true),
  } satisfies RealtimeVoiceBridge;
}

export type BrowserRequest = Parameters<
  NonNullable<import("../../plugins/types.js").RealtimeVoiceProviderPlugin["createBrowserSession"]>
>[0];
export const browserSession = {
  provider: "openai",
  transport: "webrtc" as const,
  clientSecret: "test-pending-offer",
  offerUrl: "/plugins/openai/realtime/calls",
};

export function createDelegatedBrowserProviderFixture(
  createBrowserSession: (request: BrowserRequest) => Promise<typeof browserSession>,
  workspaceDir: string,
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
  const client = { connId: "conn-close" };
  const clients = new Set([client]);
  return {
    resolution: { provider, providerConfig: {}, capabilities: provider.capabilities },
    provider,
    cancelBrowserSession,
    client,
    clients,
    context: {
      getRuntimeConfig: () => ({
        agents: { defaults: { workspace: workspaceDir } },
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
