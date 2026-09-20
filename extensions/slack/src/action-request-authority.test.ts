// Slack tests cover interactive action request authority.
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelProgressDraftCompositorSnapshot } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackActions } from "./channel-actions.js";
import { clearSlackThreadParticipationCache } from "./sent-thread-cache.js";

const BOT_TOKEN = "xoxb-interactive-authority";
const PROXY_ENV_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const;

function useSlackApi(baseUrl: string, namedTarget = false): OpenClawConfig {
  for (const key of PROXY_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("NO_PROXY", "*");
  vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
  return {
    channels: {
      slack: {
        botToken: BOT_TOKEN,
        actions: { messages: true },
        groupPolicy: "allowlist",
        ...(namedTarget
          ? { channels: { "#allowed": { enabled: true } }, dangerouslyAllowNameMatching: true }
          : {}),
      },
    },
  };
}

function sendSlackResponse(response: import("node:http").ServerResponse, payload: object): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function interactiveAction(
  cfg: OpenClawConfig,
  action: ChannelMessageActionContext["action"],
  params: Record<string, unknown>,
  assertDirectAdapterHandoff?: () => void,
  progressSnapshot?: ChannelProgressDraftCompositorSnapshot,
) {
  return createSlackActions("slack").handleAction!({
    channel: "slack",
    action,
    cfg,
    accountId: "default",
    requesterAccountId: "default",
    params,
    toolContext: {
      currentChannelProvider: "slack",
      currentChannelId: "channel:C_CURRENT",
    },
    assertDirectAdapterHandoff,
    progressSnapshot,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearSlackThreadParticipationCache();
});

describe("Slack interactive-action request authority", () => {
  it.each(["card", "compact"] as const)(
    "renders retained %s progress through registered edits with fresh request authority",
    async (style) => {
      const requests: Array<{ path: string; body: URLSearchParams }> = [];
      let current = true;
      await withServer(
        (request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          request.once("end", () => {
            requests.push({
              path: request.url ?? "",
              body: new URLSearchParams(Buffer.concat(chunks).toString()),
            });
            sendSlackResponse(response, {
              ok: true,
              channel:
                request.url === "/api/conversations.info"
                  ? { id: "C_CURRENT", name: "current", is_im: false, is_mpim: false }
                  : "C_CURRENT",
              ts: "171234.1",
            });
          });
        },
        async (baseUrl) => {
          const cfg = useSlackApi(baseUrl);
          cfg.channels!.slack!.streaming = {
            mode: "progress",
            progress: { style, toolProgress: false },
          };
          const snapshot: ChannelProgressDraftCompositorSnapshot = {
            statusHeadline: "Checking <!channel>",
            statusHeadlineFormat: "plain",
            lines: [],
            preparedBlocks: [{ text: "Checking <!channel>", format: "plain" }],
          };
          // This action has no dispatcher, stream, or listener callback: account
          // configuration and the retained route are sufficient after restart.
          await interactiveAction(
            cfg,
            "edit",
            { channelId: "C_CURRENT", messageId: "171234.1", message: "Checking" },
            () => {
              if (!current) {
                throw new Error("progress owner expired");
              }
            },
            snapshot,
          );
          const updates = requests.filter(({ path }) => path === "/api/chat.update");
          expect(updates).toHaveLength(1);
          const update = updates[0];
          expect(update?.body.get("channel")).toBe("C_CURRENT");
          expect(update?.body.get("ts")).toBe("171234.1");
          expect(JSON.parse(update?.body.get("blocks") ?? "[]")).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "section",
                text: expect.objectContaining({ type: "plain_text" }),
              }),
            ]),
          );
          await interactiveAction(
            cfg,
            "edit",
            {
              channelId: "C_CURRENT",
              messageId: "171234.1",
              message: "Untrusted retained fallback",
            },
            () => {
              if (!current) {
                throw new Error("progress owner expired");
              }
            },
            {
              lines: [],
              plan: [{ step: "Preserve the authored checklist", status: "in_progress" }],
            },
          );
          const planUpdate = requests.filter(({ path }) => path === "/api/chat.update")[1];
          expect(planUpdate?.body.get("blocks")).toContain("Preserve the authored checklist");
          expect(planUpdate?.body.get("blocks")).not.toContain("Untrusted retained fallback");
          expect(planUpdate?.body.get("text")).toContain("Preserve the authored checklist");
          expect(planUpdate?.body.get("text")).not.toContain("Untrusted retained fallback");
          expect(
            planUpdate?.body.get("text")?.match(/Preserve the authored checklist/gu),
          ).toHaveLength(1);
          const requestsBeforeRevocation = requests.length;
          current = false;
          await expect(
            interactiveAction(
              cfg,
              "edit",
              { channelId: "C_CURRENT", messageId: "171234.1", message: "stale" },
              () => {
                if (!current) {
                  throw new Error("progress owner expired");
                }
              },
              snapshot,
            ),
          ).rejects.toThrow("progress owner expired");
          expect(requests).toHaveLength(requestsBeforeRevocation);

          await interactiveAction(cfg, "edit", {
            channelId: "C_CURRENT",
            messageId: "171234.1",
            message: "Ordinary edit",
            progressSnapshot: snapshot,
          });
          const ordinaryUpdates = requests.filter(({ path }) => path === "/api/chat.update");
          expect(ordinaryUpdates).toHaveLength(3);
          expect(ordinaryUpdates[2]?.body.get("blocks")).toBeNull();
        },
      );
    },
  );

  it.each([false, true])(
    "carries authority through permission lookup before a mutation (revoke=%s)",
    async (revokeAfterLookup) => {
      const paths: string[] = [];
      let isLive = true;
      await withServer(
        (request, response) => {
          const path = request.url ?? "";
          paths.push(path);
          request.resume();
          if (path === "/api/conversations.info") {
            if (revokeAfterLookup) {
              isLive = false;
            }
            sendSlackResponse(response, {
              ok: true,
              channel: { id: "C_TARGET", name: "allowed" },
            });
          } else {
            sendSlackResponse(response, {
              ok: true,
              channel: "C_TARGET",
              ts: "171234.1",
            });
          }
        },
        async (baseUrl) => {
          const action = interactiveAction(
            useSlackApi(baseUrl, true),
            "edit",
            {
              channelId: "C_TARGET",
              messageId: "171234.1",
              message: "Updated",
            },
            () => {
              if (!isLive) {
                throw new Error("interactive action is no longer active");
              }
            },
          );
          if (revokeAfterLookup) {
            await expect(action).rejects.toThrow("interactive action is no longer active");
            expect(paths).toEqual(["/api/conversations.info"]);
          } else {
            await expect(action).resolves.toMatchObject({ details: { ok: true } });
            expect(paths).toEqual(["/api/conversations.info", "/api/chat.update"]);
          }
        },
      );
    },
  );

  it("rechecks authority before a target-lookup retry", async () => {
    const paths: string[] = [];
    let isLive = true;
    await withServer(
      (request, response) => {
        paths.push(request.url ?? "");
        request.resume();
        isLive = false;
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0",
        });
        response.end(JSON.stringify({ ok: false, error: "ratelimited" }));
      },
      async (baseUrl) => {
        await expect(
          interactiveAction(
            useSlackApi(baseUrl, true),
            "edit",
            {
              channelId: "C_RETRY",
              messageId: "171234.2",
              message: "Updated",
            },
            () => {
              if (!isLive) {
                throw new Error("interactive action is no longer active");
              }
            },
          ),
        ).rejects.toThrow("interactive action is no longer active");
        expect(paths).toEqual(["/api/conversations.info"]);
      },
    );
  });

  it("keeps an accepted mutation and later ordinary action independent", async () => {
    const paths: string[] = [];
    let isLive = true;
    await withServer(
      (request, response) => {
        paths.push(request.url ?? "");
        request.resume();
        isLive = false;
        sendSlackResponse(response, {
          ok: true,
          channel: "C_CURRENT",
          ts: `171234.${String(paths.length)}`,
        });
      },
      async (baseUrl) => {
        const cfg = useSlackApi(baseUrl);
        await expect(
          interactiveAction(cfg, "send", { to: "C_CURRENT", message: "accepted" }, () => {
            if (!isLive) {
              throw new Error("interactive action is no longer active");
            }
          }),
        ).resolves.toMatchObject({ details: { ok: true } });
        await expect(
          interactiveAction(cfg, "send", { to: "C_CURRENT", message: "ordinary" }),
        ).resolves.toMatchObject({ details: { ok: true } });
        expect(paths).toEqual(["/api/chat.postMessage", "/api/chat.postMessage"]);
      },
    );
  });
});
