import type { ProgressContinuationReceipt } from "openclaw/plugin-sdk/channel-outbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { matrixMessageActions } from "./actions.js";
import { createMatrixDraftController } from "./matrix/monitor/handler-draft-controller.js";
import { createMatrixReplyDispatcher } from "./matrix/monitor/handler-reply-dispatcher.js";
import { createReplyPrefixOptions, createTypingCallbacks } from "./matrix/monitor/runtime-api.js";
import * as readPolicy from "./matrix/read-policy.js";
import { MatrixClient } from "./matrix/sdk.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

const ROOM = "!room:example.org";
const THREAD = "$thread";
const LIVE = "org.matrix.msc4357.live";

describe("Matrix continuation HTTP ownership", () => {
  it.each([
    { mode: "partial", outcome: "accepted" },
    { mode: "progress", outcome: "accepted" },
    { mode: "partial", outcome: "declined" },
    { mode: "partial", outcome: "unconfirmed" },
    { mode: "partial", outcome: "revoked" },
  ] as const)("settles $mode progress with $outcome custody", async ({ mode, outcome }) => {
    installMatrixTestRuntime({ channel: createPluginRuntimeMock().channel });
    const events: Array<Record<string, unknown>> = [];
    const redactions: string[] = [];
    let current = true;
    let receipt: ProgressContinuationReceipt | undefined;
    let adoptCalls = 0;
    await withServer(
      (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          const path = decodeURIComponent(request.url ?? "");
          response.setHeader("content-type", "application/json");
          if (path.includes("/state/m.room.encryption")) {
            response.writeHead(404);
            response.end(JSON.stringify({ errcode: "M_NOT_FOUND", error: "unencrypted" }));
          } else if (path.includes("/event/$event-1")) {
            response.end(
              JSON.stringify({
                event_id: "$event-1",
                room_id: ROOM,
                sender: "@bot:example.org",
                type: "m.room.message",
                content: events[0],
              }),
            );
          } else if (path.includes("/relations/")) {
            response.end(JSON.stringify({ chunk: [] }));
          } else if (path.includes("/send/m.room.message/")) {
            const content = JSON.parse(body) as Record<string, unknown>;
            events.push(content);
            if (outcome === "revoked" && content["m.new_content"]) {
              current = false;
            }
            response.end(
              JSON.stringify(
                outcome === "unconfirmed" ? {} : { event_id: `$event-${events.length}` },
              ),
            );
          } else if (path.includes("/redact/")) {
            redactions.push(path);
            response.end(JSON.stringify({ event_id: "$redacted" }));
          } else {
            response.writeHead(500);
            response.end(JSON.stringify({ errcode: "M_UNKNOWN", error: `unexpected ${path}` }));
          }
        });
      },
      async (baseUrl) => {
        const client = new MatrixClient(baseUrl, "synthetic-matrix-token", {
          userId: "@bot:example.org",
          deviceId: "fixture",
          encryption: false,
          autoBootstrapCrypto: false,
          ssrfPolicy: { allowPrivateNetwork: true },
        });
        const cfg: CoreConfig = {
          channels: { matrix: { streaming: { mode, progress: { toolProgress: true } } } },
        };
        const controller = await createMatrixDraftController({
          streaming: mode,
          previewToolProgressEnabled: true,
          replyToMode: "off",
          messageId: "$inbound",
          threadTarget: THREAD,
          cfg,
          accountId: "ops",
          roomId: ROOM,
          client,
          logVerboseMessage: () => {},
        });
        try {
          const options = controller.buildPreviewToolProgressReplyOptions();
          const plan = {
            phase: "update" as const,
            steps: [{ step: "Inspect @room", status: "in_progress" as const }],
          };
          await options.onPlanUpdate?.(plan);
          await controller.draftStream?.flush();
          await options.onPlanUpdate?.(plan);
          const info = {
            kind: "final" as const,
            assertPlatformSendAuthorized: () => {
              if (!current) {
                throw new Error("owner retired");
              }
            },
            adoptProgressContinuation: async (value: ProgressContinuationReceipt) => {
              adoptCalls += 1;
              receipt = value;
              expect(value.messageId).toBe("$event-1");
              expect(value.threadId).toBe(THREAD);
              expect(value.to).toBe(`room:${ROOM}`);
              expect(value.text).toContain("Inspect");
              return outcome === "accepted";
            },
          };
          if (outcome === "unconfirmed") {
            expect(
              await controller.adoptProgressContinuation({ text: "Waiting for workers" }, info),
            ).toBe(false);
            expect(adoptCalls).toBe(0);
          } else if (outcome === "revoked") {
            await expect(
              controller.adoptProgressContinuation({ text: "Waiting for workers" }, info),
            ).rejects.toThrow("owner retired");
            expect(adoptCalls).toBe(0);
          } else {
            const dispatcher = createMatrixReplyDispatcher({
              cfg,
              prefixOptions: createReplyPrefixOptions({ cfg, agentId: "main" }),
              humanDelay: { mode: "off" },
              typingCallbacks: createTypingCallbacks({
                start: async () => {},
                onStartError: () => {},
              }),
              streaming: mode,
              draftStream: controller.draftStream,
              draftController: controller,
              client,
              roomId: ROOM,
              runtime: {
                log: () => {},
                error: () => {},
                exit: () => {
                  throw new Error("unexpected exit");
                },
              },
              replyToMode: "off",
              threadTarget: THREAD,
              accountId: "ops",
              mediaLocalRoots: [],
              logVerboseMessage: () => {},
            });
            await dispatcher.deliverReply({ text: "Waiting for workers" }, info);
            expect(adoptCalls).toBe(1);
            expect(controller.draftDisposition()).toBe(
              outcome === "accepted" ? "adopted" : "consumed",
            );
            await controller.settleProgressContinuation();
            const stillOwned = await controller.draftStream?.stop();
            if (controller.draftDisposition() === "active" && stillOwned) {
              await client.redactEvent(ROOM, stillOwned);
            }
            expect(redactions).toEqual([]);
            const last = events.at(-1);
            const content = (last?.["m.new_content"] ?? last) as Record<string, unknown>;
            if (outcome === "accepted") {
              expect(content.body).toContain("Inspect @room");
              expect(content.body).not.toContain("Waiting for workers");
              expect(receipt?.snapshot.plan?.[0]?.status).toBe("in_progress");
              expect(content[LIVE]).toBeUndefined();
              expect(content.msgtype).toBe(mode === "progress" ? "m.notice" : "m.text");
              expect(content["m.mentions"]).toBeUndefined();
              expect(controller.draftStream?.eventId()).toBeUndefined();
              await controller.resetDraftDeliveryState();
              await options.onPlanUpdate?.({
                ...plan,
                steps: [{ step: "Next turn", status: "in_progress" }],
              });
              await controller.draftStream?.flush();
              expect(controller.draftStream?.eventId()).not.toBe("$event-1");
            } else {
              expect(content.body).toBe("Waiting for workers");
            }
          }
        } finally {
          controller.cancelProgressDraft();
          await controller.settleProgressContinuation();
          await controller.draftStream?.discardPending();
          await client.stopWithoutPersist();
        }
      },
    );
  });

  it.each([false, true])(
    "uses the registered retained edit owner with revocation=%s",
    async (revoke) => {
      installMatrixTestRuntime({ channel: createPluginRuntimeMock().channel });
      let current = true;
      const edits: Array<Record<string, unknown>> = [];
      await withServer(
        (request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            const path = decodeURIComponent(request.url ?? "");
            response.setHeader("content-type", "application/json");
            if (path.includes("/event/$retained")) {
              if (revoke) {
                current = false;
              }
              response.end(
                JSON.stringify({
                  event_id: "$retained",
                  sender: "@bot:example.org",
                  type: "m.room.message",
                  content: {
                    msgtype: "m.notice",
                    body: "Working",
                    [LIVE]: {},
                    "m.relates_to": { rel_type: "m.thread", event_id: THREAD },
                  },
                }),
              );
            } else if (path.includes("/state/m.room.encryption")) {
              response.writeHead(404);
              response.end(JSON.stringify({ errcode: "M_NOT_FOUND", error: "unencrypted" }));
            } else if (path.includes("/send/m.room.message/")) {
              edits.push(JSON.parse(body) as Record<string, unknown>);
              response.end(JSON.stringify({ event_id: "$edited" }));
            } else {
              response.writeHead(500);
              response.end("{}");
            }
          });
        },
        async (baseUrl) => {
          const client = new MatrixClient(baseUrl, "synthetic-restarted-token", {
            userId: "@bot:example.org",
            deviceId: "fixture",
            encryption: false,
            autoBootstrapCrypto: false,
            ssrfPolicy: { allowPrivateNetwork: true },
          });
          const target = vi
            .spyOn(readPolicy, "withAuthorizedMatrixReadTarget")
            .mockImplementation(async (params) => await params.run({ roomId: ROOM, client }));
          try {
            const handle = matrixMessageActions.handleAction;
            if (!handle) {
              throw new Error("Missing registered Matrix action");
            }
            const cfg: CoreConfig = { channels: { matrix: { streaming: { mode: "partial" } } } };
            const edit = handle({
              channel: "matrix",
              action: "edit",
              cfg,
              accountId: "ops",
              params: {
                to: `room:${ROOM}`,
                messageId: "$retained",
                threadId: THREAD,
                message: "untrusted fallback",
                progressSnapshot: { statusHeadline: "forged" },
              },
              progressSnapshot: {
                lines: [],
                label: "Working",
                statusHeadline: "Inspect @room",
                plan: [{ step: "Review", status: "completed" }],
              },
              assertDirectAdapterHandoff: () => {
                if (!current) {
                  throw new Error("owner retired");
                }
              },
            });
            if (revoke) {
              await expect(edit).rejects.toThrow("owner retired");
              expect(edits).toEqual([]);
            } else {
              await edit;
              expect(edits).toHaveLength(1);
              expect(edits[0]?.["m.relates_to"]).toEqual({
                rel_type: "m.replace",
                event_id: "$retained",
              });
              const content = edits[0]?.["m.new_content"] as Record<string, unknown>;
              expect(content.msgtype).toBe("m.notice");
              expect(content.body).toContain("Review");
              expect(content.body).not.toContain("forged");
              expect(content.body).not.toContain("untrusted fallback");
              expect(content["m.mentions"]).toBeUndefined();
              expect(content[LIVE]).toBeUndefined();
            }
          } finally {
            target.mockRestore();
            await client.stopWithoutPersist();
          }
        },
      );
    },
  );
});
