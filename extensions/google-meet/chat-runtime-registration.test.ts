import type { MeetingParticipationAttempt } from "openclaw/plugin-sdk/meeting-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { MEET_URL } from "./src/test-support/fixtures.test-helpers.js";
import { createGoogleMeetChatPage } from "./src/test-support/google-meet-chat.test-helpers.js";
import {
  getMeetTool,
  invokeGoogleMeetGatewayMethodForTest,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";
import * as chromeTransport from "./src/transports/chrome.js";
import { testing } from "./test-api.js";

const TAB_ID = "registered-chat-tab";
const PINNED_NODE = "pinned-chat-node";
const MESSAGE = "The proposal is ready to review.";
const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");
type BrowserTransport = "chrome" | "chrome-node";

// Registration, session ownership, the durable action ledger, and browser
// participation run unchanged. Only browser and audio boundaries are simulated.
function setupRegisteredChat(env: NodeJS.ProcessEnv, transport: BrowserTransport) {
  const page = createGoogleMeetChatPage();
  page.acceptSend();
  const hooks: { afterPreparation?: () => Promise<void> } = {};
  const browserRequest = vi.fn(async (raw: unknown) => {
    const request = requireRecord(raw, "browser request");
    if (request.method === "GET" && request.path === "/tabs") {
      return { tabs: [{ targetId: TAB_ID, url: MEET_URL }] };
    }
    if (request.method === "POST" && request.path === "/act") {
      const body = requireRecord(request.body, "browser action");
      if (body.kind !== "evaluate" || body.targetId !== TAB_ID || typeof body.fn !== "string") {
        throw new Error("Expected evaluation in the tracked Meet tab.");
      }
      const result = await page.evaluate(body.fn);
      if (
        typeof result === "string" &&
        requireRecord(JSON.parse(result), "chat script result").status === "prepared"
      ) {
        await hooks.afterPreparation?.();
      }
      return { ok: true, targetId: TAB_ID, result };
    }
    throw new Error(
      `Unexpected browser request: ${String(request.method)} ${String(request.path)}`,
    );
  });
  const launch = vi
    .spyOn(chromeTransport, "launchChromeMeet")
    .mockImplementation(async ({ meetingSessionId }) => {
      page.window.__openclawMeetAudioSession = meetingSessionId;
      return {
        launched: true,
        tab: { targetId: TAB_ID, openedByPlugin: true },
        browser: { inCall: true, micMuted: true },
      };
    });
  const launchOnNode = vi
    .spyOn(chromeTransport, "launchChromeMeetOnNode")
    .mockImplementation(async ({ meetingSessionId }) => {
      page.window.__openclawMeetAudioSession = meetingSessionId;
      return {
        launched: true,
        nodeId: PINNED_NODE,
        tab: { targetId: TAB_ID, openedByPlugin: true },
        browser: { inCall: true, micMuted: true },
      };
    });
  const leave = vi.spyOn(chromeTransport, "leaveChromeMeet").mockResolvedValue({
    left: true,
    note: "Left the fixture meeting",
  });
  vi.spyOn(chromeTransport, "readChromeMeetTranscript").mockResolvedValue({
    droppedLines: 0,
    lines: [],
  });
  const harness = setupGoogleMeetPlugin(
    {
      register(api) {
        plugin.register({
          ...api,
          runtime: {
            ...api.runtime,
            state: {
              ...api.runtime.state,
              openKeyedStore<T>(options: OpenKeyedStoreOptions) {
                return createPluginStateKeyedStoreForTests<T>("google-meet", { ...options, env });
              },
            },
          },
        });
      },
    },
    {
      defaultTransport: transport,
      defaultMode: "transcribe",
      // Actions must use the session's actual launch node, not this preference.
      chromeNode: { node: "configured-other-node" },
    },
    {
      fullConfig: { transcripts: { enabled: false } },
      gatewayAvailable: true,
      gatewayRequestHandler: async (method, params) => {
        if (method !== "browser.request") {
          throw new Error(`Unexpected in-process Gateway method: ${method}`);
        }
        return await browserRequest(params);
      },
      nodesInvokeHandler: async ({ nodeId, command, params }) => {
        if (nodeId !== PINNED_NODE || command !== "browser.proxy") {
          throw new Error("Browser participation did not use the session's pinned node.");
        }
        return { payload: { result: await browserRequest(params) } };
      },
    },
  );
  const tool = harness.tools[0];
  if (!tool) {
    throw new Error("Expected Google Meet tool registration");
  }
  const invoke = async (method: string, params: unknown) =>
    await invokeGoogleMeetGatewayMethodForTest(harness.methods, method, params);
  const toolGateway = vi.fn(async (method: string, _options: unknown, params?: unknown) =>
    requireRecord(await invoke(method, params), "Google Meet Gateway result"),
  );
  testing.setCallGatewayFromCliForTests(toolGateway);
  let sessionId: string | undefined;
  const join = async () => {
    const joined = await getMeetTool(harness).execute("join-chat-session", {
      action: "join",
      url: MEET_URL,
    });
    sessionId = joined.details.session.id;
    expect(joined.details.session.state).toBe("active");
    expect(page.window.__openclawMeetAudioSession).toBe(sessionId);
    if (transport === "chrome-node") {
      expect(launchOnNode).toHaveBeenCalledOnce();
      expect(launch).not.toHaveBeenCalled();
      expect(joined.details.session.chrome?.nodeId).toBe(PINNED_NODE);
    } else {
      expect(launch).toHaveBeenCalledOnce();
      expect(launchOnNode).not.toHaveBeenCalled();
    }
    return sessionId;
  };
  const cleanup = async () => {
    try {
      if (sessionId) {
        await invoke("googlemeet.leave", { sessionId });
      }
    } finally {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
    }
  };
  return {
    env,
    page,
    hooks,
    browserRequest,
    harness,
    tool,
    toolGateway,
    invoke,
    join,
    leave,
    cleanup,
  };
}

async function withRegisteredChat(
  transport: BrowserTransport,
  run: (fixture: ReturnType<typeof setupRegisteredChat>) => Promise<void>,
) {
  await withOpenClawTestState(
    { label: `google-meet-chat-${transport}`, applyEnv: false },
    async (state) => {
      const fixture = setupRegisteredChat(state.env, transport);
      try {
        await run(fixture);
      } finally {
        await fixture.cleanup();
      }
    },
  );
}

describe("Google Meet registered native chat", () => {
  afterEach(() => {
    testing.setCallGatewayFromCliForTests();
    vi.restoreAllMocks();
  });

  it.each(["chrome", "chrome-node"] as const)(
    "sends through %s once across the manual alias, generic replay, and session leave",
    async (transport) => {
      await withRegisteredChat(transport, async (fixture) => {
        const { env, page, harness, tool, invoke, join, leave, toolGateway } = fixture;
        const sessionId = await join();
        const context = await tool.execute("chat-context", {
          action: "participation_context",
          sessionId,
        });
        expect(context.details).toMatchObject({
          sessionId,
          active: true,
          capabilities: ["chat.send"],
        });

        const requestId = "registered-chat-write";
        const first = await tool.execute("manual-send-chat", {
          action: "send_chat",
          sessionId,
          requestId,
          text: MESSAGE,
        });
        const result = requireRecord(first.details, "chat participation result");
        expect(result).toMatchObject({
          requestId,
          status: "succeeded",
          observed: { confirmation: "composer_cleared" },
        });
        expect(toolGateway.mock.lastCall?.[0]).toBe("googlemeet.participate");
        expect(page.sendButton.click).toHaveBeenCalledOnce();
        expect(page.composer.value).toBe("");
        const ledger = createPluginStateKeyedStoreForTests<MeetingParticipationAttempt>(
          "google-meet",
          {
            namespace: "meeting-participation",
            maxEntries: 10_000,
            overflowPolicy: "reject-new",
            env,
          },
        );
        expect(await ledger.lookup(`${sessionId}:request:${requestId}`)).toMatchObject({
          requestId,
          actionType: "chat.send",
          result,
        });

        const genericRequest = {
          sessionId,
          requestId,
          participationAction: { type: "chat.send", text: MESSAGE },
        };
        expect(await invoke("googlemeet.participate", genericRequest)).toEqual({
          ...result,
          replayed: true,
        });
        expect(page.sendButton.click).toHaveBeenCalledOnce();

        const left = await getMeetTool(harness).execute("leave-chat-session", {
          action: "leave",
          sessionId,
        });
        expect(left.details).toMatchObject({ found: true, browserLeft: true });
        expect(leave).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            meetingSessionId: sessionId,
            meetingUrl: MEET_URL,
            tab: { targetId: TAB_ID, openedByPlugin: true },
            ...(transport === "chrome-node" ? { transport, nodeId: PINNED_NODE } : {}),
          }),
        );
        expect(
          (
            await tool.execute("ended-chat-context", {
              action: "participation_context",
              sessionId,
            })
          ).details,
        ).toMatchObject({ sessionId, active: false, capabilities: [] });
        expect(await invoke("googlemeet.participate", genericRequest)).toEqual({
          ...result,
          replayed: true,
        });
        expect(
          (
            await tool.execute("send-after-leave", {
              action: "send_chat",
              sessionId,
              requestId: "after-leave",
              text: "Do not send this.",
            })
          ).details,
        ).toMatchObject({ status: "rejected" });
        expect(page.sendButton.click).toHaveBeenCalledOnce();
        expect(harness.nodesList).not.toHaveBeenCalled();
        expect(harness.runCommandWithTimeout).not.toHaveBeenCalled();
        if (transport === "chrome-node") {
          expect(harness.gatewayRequest).not.toHaveBeenCalled();
          expect(harness.nodesInvoke).toHaveBeenCalled();
          for (const [call] of harness.nodesInvoke.mock.calls) {
            expect(call).toMatchObject({ nodeId: PINNED_NODE, command: "browser.proxy" });
          }
        } else {
          expect(harness.nodesInvoke).not.toHaveBeenCalled();
          expect(harness.gatewayRequest).toHaveBeenCalledWith(
            "browser.request",
            expect.objectContaining({ method: "POST", path: "/act" }),
            expect.objectContaining({ scopes: ["operator.admin"] }),
          );
        }
      });
    },
  );

  it.each(["chrome", "chrome-node"] as const)(
    "prevents a final %s send when leave closes authority during preparation",
    async (transport) => {
      await withRegisteredChat(transport, async ({ page, hooks, tool, invoke, join, leave }) => {
        const sessionId = await join();
        hooks.afterPreparation = async () => {
          await invoke("googlemeet.leave", { sessionId });
        };

        const result = await tool.execute("leave-during-chat-preparation", {
          action: "send_chat",
          sessionId,
          requestId: "preparation-race",
          text: MESSAGE,
        });

        expect(result.details).toMatchObject({
          requestId: "preparation-race",
          status: "uncertain",
        });
        expect(leave).toHaveBeenCalledOnce();
        expect(page.composer.focus).not.toHaveBeenCalled();
        expect(page.composer.value).toBe("");
        expect(page.sendButton.click).not.toHaveBeenCalled();
      });
    },
  );
});
