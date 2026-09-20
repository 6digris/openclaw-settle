import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { ProgressContinuationReceipt } from "openclaw/plugin-sdk/channel-outbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { mattermostPlugin } from "./channel.js";
import { resolveMattermostAccount } from "./mattermost/accounts.js";
import { createMattermostClient } from "./mattermost/client.js";
import { buildMattermostEventPlan } from "./mattermost/monitor-event-plan.js";
import { createMattermostMonitorResources } from "./mattermost/monitor-resources.js";
import { dispatchMattermostInboundTurn } from "./mattermost/monitor-turn.js";
import type { MattermostMonitorContext } from "./mattermost/monitor-types.js";
import { createChannelPairingController, type OpenClawConfig } from "./mattermost/runtime-api.js";
import { setMattermostRuntime } from "./runtime.js";

const CHANNEL_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const POST_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const NEXT_POST_ID = "cccccccccccccccccccccccccc";

describe("Mattermost progress continuation over HTTP", () => {
  it.each(["accepted", "declined", "unconfirmed", "revoked"] as const)(
    "settles a %s waiting final through the inbound delivery owner",
    async (outcome) => {
      let visibleText = "";
      let current = true;
      let captured: ProgressContinuationReceipt | undefined;
      let adoptionCalls = 0;
      const writes: string[] = [];
      const posts = new Map<string, string>();
      let created = 0;
      await withServer(
        (request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            const path = request.url ?? "";
            response.setHeader("content-type", "application/json");
            if (request.method === "POST" || request.method === "PUT") {
              writes.push(`${request.method} ${path}`);
              const payload = JSON.parse(body) as { message?: string };
              visibleText = payload.message ?? "";
              const id =
                request.method === "POST"
                  ? ++created === 1
                    ? POST_ID
                    : NEXT_POST_ID
                  : path.slice("/api/v4/posts/".length);
              posts.set(id, visibleText);
              if (outcome === "revoked") {
                current = false;
              }
              response.end(
                JSON.stringify(
                  outcome === "unconfirmed"
                    ? {}
                    : {
                        id,
                        channel_id: CHANNEL_ID,
                        message: visibleText,
                      },
                ),
              );
            } else if (request.method === "DELETE") {
              writes.push(`DELETE ${path}`);
              visibleText = "";
              posts.delete(path.slice("/api/v4/posts/".length));
              response.end("{}");
            } else {
              response.writeHead(500);
              response.end(JSON.stringify({ message: `Unexpected request ${path}` }));
            }
          });
        },
        async (baseUrl) => {
          const cfg: OpenClawConfig = {
            channels: {
              mattermost: {
                baseUrl,
                botToken: "synthetic-progress-token",
                streaming: { mode: "progress" },
                network: { dangerouslyAllowPrivateNetwork: true },
              },
            },
          };
          const core = createPluginRuntimeMock();
          setMattermostRuntime(core);
          core.channel.inbound.run = async (input) => {
            const normalized = await input.adapter.ingest(input.raw);
            if (!normalized) {
              throw new Error("Missing inbound input");
            }
            const turn = await input.adapter.resolveTurn(
              normalized,
              { kind: "message", canStartAgentTurn: true },
              {},
            );
            if (!("delivery" in turn) || !turn.delivery.deliver) {
              throw new Error("Missing Mattermost delivery owner");
            }
            await turn.replyOptions?.onPlanUpdate?.({
              phase: "update",
              steps: [{ step: "Inspect @channel", status: "in_progress" }],
            });
            const info = {
              kind: "final" as const,
              assertPlatformSendAuthorized: () => {
                if (!current) {
                  throw new Error("owner retired");
                }
              },
              adoptProgressContinuation: async (receipt: ProgressContinuationReceipt) => {
                adoptionCalls += 1;
                expect(receipt.text).toBe(visibleText);
                expect(receipt.messageId).toBe(POST_ID);
                expect(receipt.to).toBe(`channel:${CHANNEL_ID}`);
                captured = receipt;
                return outcome === "accepted";
              },
            };
            await turn.delivery.deliver({ text: "Waiting for worker" }, info);
            await turn.replyOptions?.onPlanUpdate?.({
              phase: "update",
              steps: [{ step: "Late parent update", status: "completed" }],
            });
            if (outcome === "accepted") {
              await turn.replyOptions?.onObservedReplyDelivery?.();
              expect(posts.get(POST_ID)).toBe(captured?.text);
              await turn.replyOptions?.onQueuedFollowupAdmitted?.();
              await turn.replyOptions?.onPlanUpdate?.({
                phase: "update",
                steps: [{ step: "Next queued turn", status: "in_progress" }],
              });
            }
            return {
              admission: { kind: "handled", reason: "loopback delivery exercised" },
              dispatched: false,
            };
          };
          const client = createMattermostClient({
            baseUrl,
            botToken: "synthetic-progress-token",
            allowPrivateNetwork: true,
          });
          const monitor: MattermostMonitorContext = {
            cfg,
            core,
            client,
            account: resolveMattermostAccount({ cfg }),
            runtime: {
              log: () => {},
              error: () => {},
              exit: () => {
                throw new Error("unexpected exit");
              },
            },
            pairing: createChannelPairingController({
              core,
              channel: "mattermost",
              accountId: "default",
            }),
            resources: createMattermostMonitorResources({
              accountId: "default",
              callbackUrl: "",
              client,
              logger: {},
              mediaMaxBytes: 0,
              saveRemoteMedia: async () => {
                throw new Error("unexpected media");
              },
              mediaKindFromMime: () => undefined,
            }),
            botUserId: "bot",
            groupPolicy: "open",
            logDebugMessage: () => {},
            logVerboseMessage: () => {},
          };
          const eventPlan = await buildMattermostEventPlan(monitor, {
            channelId: CHANNEL_ID,
            senderId: "sender",
            postId: "inbound",
            dropLabel: "test",
            channelInfo: { id: CHANNEL_ID, type: "D" },
          });
          if (!eventPlan) {
            throw new Error("Missing event plan");
          }
          const pending = dispatchMattermostInboundTurn(monitor, {
            post: { id: "inbound", channel_id: CHANNEL_ID, message: "inspect" },
            rawText: "inspect",
            ctxPayload: eventPlan.finalizeContext({
              Body: "inspect",
              BodyForAgent: "inspect",
              CommandBody: "inspect",
            }),
            eventPlan,
            historyKey: null,
            historyLimit: 0,
            channelHistories: new Map(),
            pinnedMainDmOwner: null,
          });
          if (outcome === "unconfirmed" || outcome === "revoked") {
            await expect(pending).rejects.toThrow();
            expect(adoptionCalls).toBe(0);
            expect(writes).toEqual(["POST /api/v4/posts"]);
          } else {
            await pending;
            expect(adoptionCalls).toBe(1);
            if (outcome === "accepted") {
              expect(posts.get(POST_ID)).toContain("Inspect @\u200bchannel");
              expect(posts.get(POST_ID)).not.toContain("Late parent update");
              expect(posts.get(NEXT_POST_ID)).toContain("Next queued turn");
              expect(writes).toEqual(["POST /api/v4/posts", "POST /api/v4/posts"]);
              expect(captured?.snapshot.plan?.[0]?.status).toBe("in_progress");
            } else {
              expect(visibleText).toBe("Waiting for worker");
              expect(writes).toContain(`PUT /api/v4/posts/${POST_ID}`);
              expect(captured?.text).toContain("Inspect");
            }
          }
        },
      );
    },
  );

  it.each(["edit", "wrong-thread", "revoked"] as const)(
    "renders a retained snapshot through the registered action: %s",
    async (outcome) => {
      let current = true;
      const edits: Array<{ id: string; message: string }> = [];
      const authorization: Array<string | undefined> = [];
      await withServer(
        (request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            authorization.push(request.headers.authorization);
            response.setHeader("content-type", "application/json");
            if (request.method === "GET") {
              if (outcome === "revoked") {
                current = false;
              }
              response.end(
                JSON.stringify({ id: POST_ID, channel_id: CHANNEL_ID, root_id: "thread-root" }),
              );
            } else if (request.method === "PUT") {
              const edit = JSON.parse(body) as { id: string; message: string };
              edits.push(edit);
              response.end(
                JSON.stringify({ ...edit, channel_id: CHANNEL_ID, root_id: "thread-root" }),
              );
            } else {
              response.writeHead(500);
              response.end("{}");
            }
          });
        },
        async (baseUrl) => {
          setMattermostRuntime(createPluginRuntimeMock());
          const cfg: OpenClawConfig = {
            channels: {
              mattermost: {
                accounts: {
                  ops: {
                    baseUrl,
                    botToken: "synthetic-restarted-token",
                    streaming: { mode: "progress" },
                    network: { dangerouslyAllowPrivateNetwork: true },
                  },
                },
              },
            },
          };
          const handle = mattermostPlugin.actions?.handleAction;
          if (!handle) {
            throw new Error("Missing registered action");
          }
          const ctx: ChannelMessageActionContext = {
            channel: "mattermost",
            action: "edit",
            cfg,
            accountId: "ops",
            params: {
              to: `channel:${CHANNEL_ID}`,
              messageId: POST_ID,
              threadId: outcome === "wrong-thread" ? "other" : "thread-root",
              message: "untrusted fallback",
              progressSnapshot: { statusHeadline: "forged" },
            },
            progressSnapshot: {
              lines: [],
              label: "Working",
              statusHeadline: "Inspect @channel",
              plan: [{ step: "Review", status: "completed" }],
            },
            assertDirectAdapterHandoff: () => {
              if (!current) {
                throw new Error("owner retired");
              }
            },
          };
          const editing = handle(ctx);
          if (outcome === "edit") {
            await editing;
            expect(edits).toHaveLength(1);
            expect(edits[0]?.id).toBe(POST_ID);
            expect(edits[0]?.message).toContain("Review");
            expect(edits[0]?.message).toContain("@\u200bchannel");
            expect(edits[0]?.message).not.toContain("forged");
            expect(edits[0]?.message).not.toContain("untrusted fallback");
          } else {
            await expect(editing).rejects.toThrow(
              outcome === "wrong-thread" ? "conversation" : "owner retired",
            );
            expect(edits).toEqual([]);
          }
          expect(authorization.every((value) => value === "Bearer synthetic-restarted-token")).toBe(
            true,
          );
          await expect(handle({ ...ctx, progressSnapshot: undefined })).rejects.toThrow(
            "Unsupported Mattermost action",
          );
        },
      );
    },
  );
});
