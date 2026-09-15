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
import {
  getMeetTool,
  invokeGoogleMeetGatewayMethodForTest,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";
import {
  EMOJIS,
  MEETING_URL,
  reactionPage,
} from "./src/test-support/reaction-page.test-helpers.js";
import * as chromeTransport from "./src/transports/chrome.js";
import { testing } from "./test-api.js";

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

describe("registered Google Meet reactions", () => {
  afterEach(() => {
    testing.setCallGatewayFromCliForTests();
    vi.restoreAllMocks();
  });

  it.each(["chrome", "chrome-node"] as const)(
    "routes %s reactions through the tool, Gateway, session ledger, and native page",
    async (transport) => {
      await withOpenClawTestState(
        { label: "google-meet-reactions", applyEnv: false },
        async (state) => {
          const page = reactionPage({ open: false });
          let afterPreparation: (() => Promise<void>) | undefined;
          const browserRequest = vi.fn(async (request: Record<string, unknown>) => {
            if (request.path === "/tabs")
              return {
                tabs: [
                  { targetId: "other-tab", url: MEETING_URL },
                  { targetId: "reaction-tab", url: MEETING_URL },
                ],
              };
            if (request.path !== "/act")
              throw new Error(`Unexpected browser path: ${String(request.path)}`);
            const body = requireRecord(request.body, "browser action");
            expect(body).toMatchObject({ kind: "evaluate", targetId: "reaction-tab" });
            if (typeof body.fn !== "string") throw new Error("Expected native page source");
            const result = await page.evaluate(body.fn);
            const parsed: unknown =
              typeof result.result === "string" ? JSON.parse(result.result) : result.result;
            if (requireRecord(parsed, "page result").status === "prepared")
              await afterPreparation?.();
            return { ...result, targetId: "reaction-tab" };
          });
          const launch = async ({ meetingSessionId }: { meetingSessionId?: string }) => {
            if (!meetingSessionId) throw new Error("Expected tracked meeting session");
            page.window.__openclawMeetAudioSession = meetingSessionId;
            return {
              launched: true,
              tab: { targetId: "reaction-tab", openedByPlugin: false },
              browser: { inCall: true, micMuted: true },
              ...(transport === "chrome-node" ? { nodeId: "reaction-node" } : {}),
            };
          };
          vi.spyOn(chromeTransport, "launchChromeMeet").mockImplementation(launch);
          vi.spyOn(chromeTransport, "launchChromeMeetOnNode").mockImplementation(
            async (params) => ({
              ...(await launch(params)),
              nodeId: "reaction-node",
            }),
          );
          vi.spyOn(chromeTransport, "leaveChromeMeet").mockResolvedValue({
            left: true,
            note: "Left test meeting",
          });
          vi.spyOn(chromeTransport, "readChromeMeetTranscript").mockResolvedValue({
            droppedLines: 0,
            lines: [],
          });

          let harness: ReturnType<typeof setupGoogleMeetPlugin>;
          harness = setupGoogleMeetPlugin(
            {
              register(api) {
                plugin.register({
                  ...api,
                  runtime: {
                    ...api.runtime,
                    state: {
                      ...api.runtime.state,
                      openKeyedStore<T>(options: OpenKeyedStoreOptions) {
                        return createPluginStateKeyedStoreForTests<T>("google-meet", {
                          ...options,
                          env: state.env,
                        });
                      },
                    },
                  },
                });
              },
            },
            { defaultTransport: transport, defaultMode: "transcribe" },
            {
              fullConfig: { transcripts: { enabled: false } },
              gatewayAvailable: true,
              gatewayRequestHandler: async (method, params) =>
                method === "browser.request"
                  ? await browserRequest(params ?? {})
                  : await invokeGoogleMeetGatewayMethodForTest(
                      harness.methods,
                      method,
                      params,
                      "google-meet",
                    ),
              nodesInvokeHandler: async ({ nodeId, command, params }) => {
                expect(nodeId).toBe("reaction-node");
                expect(command).toBe("browser.proxy");
                return {
                  payload: {
                    result: await browserRequest(requireRecord(params, "node browser request")),
                  },
                };
              },
            },
          );
          const tool = harness.tools[0];
          if (!tool) throw new Error("Expected Google Meet tool registration");
          const toolGateway = vi.fn(async (method: string, _options: unknown, params?: unknown) =>
            requireRecord(
              await invokeGoogleMeetGatewayMethodForTest(harness.methods, method, params),
              "Google Meet Gateway result",
            ),
          );
          testing.setCallGatewayFromCliForTests(toolGateway);
          let sessionId: string | undefined;
          try {
            const joined = await getMeetTool(harness).execute("join", {
              action: "join",
              url: MEETING_URL,
            });
            sessionId = joined.details.session.id;
            const context = await tool.execute("context", {
              action: "participation_context",
              sessionId,
            });
            expect(context.details).toMatchObject({
              active: true,
              capabilities: ["chat.send", "reaction.send"],
            });
            const gatewayCalls = toolGateway.mock.calls.length;
            expect(
              (
                await tool.execute("invalid-emoji", {
                  action: "react",
                  sessionId,
                  requestId: "invalid-emoji",
                  emoji: 42,
                })
              ).details,
            ).toEqual({ error: "participationAction.emoji must be a string" });
            expect(toolGateway).toHaveBeenCalledTimes(gatewayCalls);

            const unavailable = {
              action: "react",
              sessionId,
              requestId: "unavailable",
              emoji: "🦄",
            };
            const rejected = await tool.execute("unavailable", unavailable);
            expect(rejected.details).toMatchObject({
              status: "rejected",
              correctionOf: "unavailable",
              observed: { supportedReactions: EMOJIS },
            });
            expect(page.buttons.every((button) => button.click.mock.calls.length === 0)).toBe(true);

            const corrected = {
              action: "react",
              sessionId,
              requestId: "corrected",
              correctionOf: "unavailable",
              emoji: "👍",
            };
            const sent = await tool.execute("send", corrected);
            expect(sent.details).toMatchObject({
              status: "succeeded",
              observed: { emoji: "👍", confirmation: "native_reaction_announcement" },
            });
            expect(toolGateway.mock.lastCall?.[0]).toBe("googlemeet.participate");
            const ledger = createPluginStateKeyedStoreForTests<MeetingParticipationAttempt>(
              "google-meet",
              {
                namespace: "meeting-participation",
                maxEntries: 10_000,
                overflowPolicy: "reject-new",
                env: state.env,
              },
            );
            expect(await ledger.lookup(`${sessionId}:request:corrected`)).toMatchObject({
              actionType: "reaction.send",
              result: sent.details,
            });
            expect((await tool.execute("replay", corrected)).details).toMatchObject({
              status: "succeeded",
              replayed: true,
            });
            expect(
              (
                await tool.execute("another-correction", {
                  ...corrected,
                  requestId: "another-correction",
                })
              ).details,
            ).toMatchObject({ status: "rejected" });
            expect(page.buttons[1].click).toHaveBeenCalledOnce();

            // The generic Gateway entry and public alias share the same durable claim.
            const uncertain = {
              sessionId,
              requestId: "uncertain",
              participationAction: { type: "reaction.send", emoji: "👏" },
            };
            page.buttons[3].click.mockImplementation(() => {});
            expect(
              await invokeGoogleMeetGatewayMethodForTest(
                harness.methods,
                "googlemeet.participate",
                uncertain,
              ),
            ).toMatchObject({ status: "uncertain" });
            expect(
              (
                await tool.execute("uncertain-replay", {
                  action: "react",
                  sessionId,
                  requestId: "uncertain",
                  emoji: "👏",
                })
              ).details,
            ).toMatchObject({ status: "uncertain", replayed: true });
            expect(
              (
                await tool.execute("uncertain-correction", {
                  action: "react",
                  sessionId,
                  requestId: "retry-uncertain",
                  correctionOf: "uncertain",
                  emoji: "👏",
                })
              ).details,
            ).toMatchObject({ status: "rejected" });
            expect(page.buttons[3].click).toHaveBeenCalledOnce();

            // End the runtime owner after the menu's asynchronous preparation. The
            // page marker deliberately remains unchanged: it is not enough authority.
            afterPreparation = async () => {
              await invokeGoogleMeetGatewayMethodForTest(harness.methods, "googlemeet.leave", {
                sessionId,
              });
            };
            const beforeClose = page.buttons.reduce(
              (sum, button) => sum + button.click.mock.calls.length,
              0,
            );
            expect(
              (
                await tool.execute("closing", {
                  action: "react",
                  sessionId,
                  requestId: "closing",
                  emoji: "🎉",
                })
              ).details,
            ).toMatchObject({ status: "rejected" });
            expect(
              page.buttons.reduce((sum, button) => sum + button.click.mock.calls.length, 0),
            ).toBe(beforeClose);
            expect(harness.nodesList).not.toHaveBeenCalled();
            expect(harness.runCommandWithTimeout).not.toHaveBeenCalled();
            expect(page.microphone.click).not.toHaveBeenCalled();
            expect(page.hand.click).not.toHaveBeenCalled();
            if (transport === "chrome") expect(harness.nodesInvoke).not.toHaveBeenCalled();
            else expect(harness.nodesInvoke).toHaveBeenCalled();
          } finally {
            if (sessionId)
              await invokeGoogleMeetGatewayMethodForTest(harness.methods, "googlemeet.leave", {
                sessionId,
              });
            await closeOpenClawStateDatabaseAsync();
            resetPluginStateStoreForTests();
          }
        },
      );
    },
  );
});
import type { MeetingParticipationAttempt } from "openclaw/plugin-sdk/meeting-runtime";
