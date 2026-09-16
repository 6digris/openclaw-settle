import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { runExclusiveSqliteSessionWrite } from "../../../config/sessions/session-accessor.sqlite-scope.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { resetClientVoiceConfirmationStateForTest } from "../../../talk/client-voice-confirmation.test-support.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import { resolveSessionMutationAuthorization } from "../../session-sharing.js";
import { closeTalkClientGatewayControlSession } from "../client-gateway-control.js";
import {
  browserSession,
  createDelegatedBrowserProviderFixture,
  type BrowserRequest,
} from "../client-gateway-control.test-support.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { createTalkClient } from "./client-create.js";
import { talkClientHandlers } from "./client.js";

const voiceMocks = vi.hoisted(() => ({
  resolveConfiguredRealtimeVoiceProvider: vi.fn(),
  consultRealtimeVoiceAgent: vi.fn(),
  runEmbeddedAgent: vi.fn<typeof import("../../../agents/embedded-agent.js").runEmbeddedAgent>(),
}));

vi.mock("../../../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: voiceMocks.resolveConfiguredRealtimeVoiceProvider,
}));
vi.mock("../../../talk/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/provider-registry.js")>()),
  listRealtimeVoiceProviders: () => [],
}));
vi.mock("../../../talk/agent-consult-runtime.js", () => ({
  consultRealtimeVoiceAgent: voiceMocks.consultRealtimeVoiceAgent,
}));
vi.mock("../../../plugins/runtime/index.js", async () => {
  const { createRuntimeAgent } = await import("../../../plugins/runtime/runtime-agent.js");
  return { createPluginRuntime: () => ({ agent: createRuntimeAgent() }) };
});
vi.mock("../../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: voiceMocks.runEmbeddedAgent,
}));
vi.mock("../../../agents/realtime-bootstrap-context.js", () => ({
  resolveRealtimeBootstrapContextInstructions: async () => undefined,
}));

const sessionKey = "agent:main:main";
const sessionId = "voice-transcript-session";
let state: OpenClawTestState;
let ownedVoiceSessionId: string | undefined;

async function invokeCreate(options: GatewayRequestHandlerOptions) {
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

async function invokeClose(params: Record<string, unknown>) {
  const respond = vi.fn();
  await talkClientHandlers["talk.client.close"]?.({
    params,
    respond,
    context: { getRuntimeConfig: () => ({}) },
    client: { connId: "conn-close" },
  } as never);
  return respond;
}

describe("talk.client.transcript", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetGatewayWorkAdmission();
    ownedVoiceSessionId = undefined;
    state = await createOpenClawTestState({
      label: "talk-client-transcript-drain",
      scenario: "minimal",
    });
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId, updatedAt: Date.now() },
    );
  });

  afterEach(async () => {
    const remainingRootWork = getActiveGatewayRootWorkCount();
    resetGatewayWorkAdmission();
    try {
      if (ownedVoiceSessionId) {
        await closeTalkClientGatewayControlSession({
          voiceSessionId: ownedVoiceSessionId,
          sessionKey,
          connId: "conn-close",
        });
      }
    } finally {
      cleanupTalkConnection("conn-close", { warn: vi.fn() });
      clientVoiceSessionTesting.reset();
      resetClientVoiceConfirmationStateForTest();
      vi.useRealTimers();
      await state?.cleanup();
    }
    expect(remainingRootWork).toBe(0);
  });

  it("drains accepted final provider transcripts after Gateway control close aborts transport", async () => {
    const createBrowserSession = vi.fn(async (_request: BrowserRequest) => browserSession);
    const fixture = createDelegatedBrowserProviderFixture(createBrowserSession, state.workspaceDir);
    voiceMocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue(fixture.resolution);
    const respond = vi.fn();
    await invokeCreate({
      params: { sessionKey, provider: "openai", model: "gpt-live-test" },
      respond,
      context: fixture.context,
      client: fixture.client,
    } as never);
    const result = respond.mock.calls[0]?.[1] as { voiceSessionId: string };
    ownedVoiceSessionId = result.voiceSessionId;
    const control = createBrowserSession.mock.calls[0]?.[0].gatewayControl;
    expect(control).toBeDefined();
    const gate = createDeferred();
    const entered = createDeferred();
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const held = runExclusiveSqliteSessionWrite(
      { agentId: "main", path: database.path },
      () => {
        entered.resolve();
        return gate.promise;
      },
      "session.transcript.locked-write",
    );
    await entered.promise;
    control?.onTranscript?.("user", "Synthetic accepted final speech", true);
    const closing = invokeClose({ sessionKey, voiceSessionId: result.voiceSessionId });
    void closing.catch(() => {});
    try {
      await vi.waitFor(() => expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce());
      expect(clientVoiceSessionTesting.readRecord("main", result.voiceSessionId)?.status).toBe(
        "open",
      );
    } finally {
      gate.resolve();
      await Promise.all([held, closing]);
    }
    expect(await closing).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(clientVoiceSessionTesting.readRecord("main", result.voiceSessionId)).toMatchObject({
      status: "closed",
      hasUserTranscript: true,
      transcriptFailureKeys: [],
    });
    expect(
      readSessionTranscriptMessageEvents({ agentId: "main", sessionKey, sessionId }),
    ).toHaveLength(1);
  });
});
