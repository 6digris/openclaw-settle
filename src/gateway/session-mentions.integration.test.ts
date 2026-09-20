import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Registered sessions tool -> in-process authorization -> real transcript -> durable Inbox.
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateSessionsMentionResult } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createSessionsTool } from "../agents/tools/sessions-tool.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import {
  SESSION_KEY,
  SESSION_ID,
  withMentionInbox,
  readMentionInbox,
} from "./mention-inbox.test-support.js";
import * as transcriptInjection from "./server-methods/chat-transcript-inject.js";
import { dispatchGatewayMethodInProcess } from "./server-plugins.js";

const cfg = { agents: { entries: { main: { identity: { name: "Research assistant" } } } } };
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function withFixture(
  run: (
    f: Parameters<Parameters<typeof withMentionInbox>[0]>[0] & {
      invoke: (action: string, args?: Record<string, unknown>, callId?: string) => Promise<unknown>;
      retire: () => void;
    },
  ) => Promise<void>,
) {
  await withMentionInbox(async (f) => {
    await withLocalGatewayRequestScope(
      { deps: {} as CliDeps, getRuntimeConfig: () => cfg },
      async () => {
        const context = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext?.();
        if (!context) {
          throw new Error("Missing local Gateway fixture");
        }
        context.mentionInbox = f.inbox;
        const admission = prepareSystemAgentRunAdmission(cfg, "mention-run", "main", "test");
        const tool = createSessionsTool({ config: cfg, agentSessionKey: SESSION_KEY });
        const caller = createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: await admission.admit("embedded"),
          agentId: "main",
          sessionKey: SESSION_KEY,
        });
        try {
          await run({
            ...f,
            retire: () => {
              admission.close();
            },
            invoke: async (action, args = {}, callId = "mention-call") => {
              const result = await withGatewayToolCallerIdentity(caller, () =>
                tool.execute(callId, { action, ...args }),
              );
              if (action === "mention") {
                expect(validateSessionsMentionResult(result.details)).toBe(true);
              }
              return result.details;
            },
          });
        } finally {
          admission.close();
        }
      },
    );
  }, cfg);
}

async function transcript() {
  return (
    await loadTranscriptEvents({ agentId: "main", sessionKey: SESSION_KEY, sessionId: SESSION_ID })
  ).filter(isRecord);
}

describe("structured agent mentions", () => {
  it("discovers eligible profile IDs and commits an assistant source with truthful identity and involvement", async () => {
    await withFixture(async (f) => {
      const roster = await f.invoke("mentionable", { query: "Bob" });
      expect(roster).toMatchObject({
        users: [{ profileId: f.bob.id, displayName: "Bob" }],
        truncated: false,
      });
      expect(f.push).not.toHaveBeenCalled();
      const result = await f.invoke("mention", {
        recipientProfileIds: [f.bob.id],
        message: "Please review **the evidence**.",
      });
      const item = readMentionInbox(f.inbox, f.bobClient).items[0]!;
      expect(result).toMatchObject({
        status: "recorded",
        recipientProfileIds: [f.bob.id],
        sessionKey: SESSION_KEY,
        messageId: item.messageId,
      });
      expect(item).toMatchObject({
        sender: { type: "agent", id: "main" },
        senderLabel: "Research assistant",
        excerpt: "Please review the evidence.",
      });
      expect(item).not.toHaveProperty("senderProfileId");
      const rows = await transcript();
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: item.messageId,
            message: expect.objectContaining({
              role: "assistant",
              openclawAgentMention: expect.objectContaining({
                senderAgentId: "main",
                recipientProfileIds: [f.bob.id],
              }),
            }),
          }),
        ]),
      );
      const entry = loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY });
      expect(entry?.profileInvolvement?.profiles[f.bob.id]?.lastMention).toBeDefined();
      expect(entry?.participants).toBeUndefined();
      expect(f.push).toHaveBeenCalledTimes(1);
      expect(f.push.mock.calls[0]?.[0].senderLabel).toBe("Research assistant");
      expect(f.broadcast).toHaveBeenCalledWith(
        "mentions.changed",
        expect.anything(),
        expect.any(Set),
      );
    });
  });

  it("keeps the note on the active transcript path when the running session appends its next result", async () => {
    await withFixture(async (f) => {
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
      const target = { agentId: "main", sessionKey: SESSION_KEY, sessionId: SESSION_ID, storePath };
      await appendTranscriptMessage(target, {
        message: { role: "user", content: "Please ask Bob to review.", timestamp: Date.now() },
      });
      const manager = SessionManager.open(target, path.dirname(storePath));
      await f.invoke("mention", { recipientProfileIds: [f.bob.id], message: "Please review." });
      const item = readMentionInbox(f.inbox, f.bobClient).items[0]!;
      const followup = manager.appendMessage({
        role: "toolResult",
        toolCallId: "mention-call",
        toolName: "sessions",
        isError: false,
        content: [{ type: "text", text: "Recorded." }],
        timestamp: Date.now(),
      });
      expect(manager.getEntry(followup)?.parentId).toBe(item.messageId);
      expect(manager.getBranch().map((entry) => entry.id)).toContain(item.messageId);
    });
  });

  it.each(["NO_REPLY", "HEARTBEAT_OK", "[[reply_to_current]]", "   "])(
    "rejects invisible note %s without a false source link",
    async (message) => {
      await withFixture(async (f) => {
        await expect(
          f.invoke("mention", { recipientProfileIds: [f.bob.id], message }),
        ).rejects.toThrow();
        expect((await transcript()).filter((row) => row.type === "message")).toEqual([]);
        expect(f.push).not.toHaveBeenCalled();
      });
    },
  );

  it("deduplicates tool replay across restart and dismissal without replaying push", async () => {
    await withFixture(async (f) => {
      const args = { recipientProfileIds: [f.bob.id], message: "Please review." };
      const first = await f.invoke("mention", args);
      const item = readMentionInbox(f.inbox, f.bobClient).items[0]!;
      expect(await f.invoke("mention", args)).toMatchObject({
        status: "skipped",
        reason: "already_processed",
        messageId: item.messageId,
      });
      expect(first).toMatchObject({ status: "recorded" });
      const reopened = f.openInbox("restart");
      expect(readMentionInbox(reopened, f.bobClient).items).toEqual([item]);
      expect(reopened.dismiss(f.bobClient, [item.id]).ok).toBe(true);
      expect(await f.invoke("mention", args)).toMatchObject({
        status: "skipped",
        reason: "already_processed",
      });
      expect(readMentionInbox(f.inbox, f.bobClient).items).toEqual([]);
      expect(f.push).toHaveBeenCalledTimes(1);
      expect((await transcript()).filter((row) => row.type === "message")).toHaveLength(1);
    });
  });

  it("stores agent payloads where old readers see only safe consumed sources", async () => {
    await withFixture(async (f) => {
      await f.invoke("mention", { recipientProfileIds: [f.bob.id], message: "Review." });
      f.post("human");
      const rows = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key GLOB 'notifications.mentions.source.*'",
        )
        .all();
      const sources = rows.map((row) => JSON.parse(String(row.value_json)));
      const agent = sources.find((source) => source.agentMention);
      expect(agent).toMatchObject({
        recipients: [],
        agentMention: {
          recipients: [[f.bob.id, expect.any(String)]],
          message: { content: { sender: { type: "agent", id: "main" } } },
        },
      });
      expect(agent).not.toHaveProperty("message");
      expect(sources.find((source) => source.message)).toMatchObject({
        message: { content: { senderProfileId: f.alice.id } },
      });
      expect(readMentionInbox(f.openInbox(), f.bobClient).items).toHaveLength(2);
    });
  });

  it.each(["incognito", "private", "missing recipient", "too many", "other session", "retired"])(
    "refuses %s without transcript or notifications",
    async (scenario) => {
      await withFixture(async (f) => {
        if (scenario === "incognito") {
          await f.setSession({ incognito: true });
        }
        if (scenario === "private") {
          await f.setSession({ visibility: "draft" });
        }
        if (scenario === "retired") {
          f.retire();
        }
        const ids =
          scenario === "missing recipient"
            ? ["unknown-profile"]
            : scenario === "too many"
              ? Array.from({ length: 11 }, (_, index) => "profile-" + index)
              : [f.bob.id];
        await expect(
          f.invoke("mention", {
            recipientProfileIds: ids,
            message: "Review.",
            ...(scenario === "other session" ? { sessionKey: "agent:main:other" } : {}),
          }),
        ).rejects.toThrow();
        expect(readMentionInbox(f.inbox, f.bobClient).items).toEqual([]);
        expect((await transcript()).filter((row) => row.type === "message")).toEqual([]);
        expect(f.push).not.toHaveBeenCalled();
      });
    },
  );

  it("rejects a synthetic identity without a live assertion and human wire callers", async () => {
    await withFixture(async (f) => {
      const params = {
        sessionKey: SESSION_KEY,
        agentId: "main",
        message: "Review.",
        recipientProfileIds: [f.bob.id],
        idempotencyKey: "forged",
      };
      await expect(
        dispatchGatewayMethodInProcess("sessions.mention", params, {
          forceSyntheticClient: true,
          agentToolCaller: { agentId: "main", sessionKey: SESSION_KEY },
        }),
      ).rejects.toThrow(/active Gateway-hosted/);
      await expect(
        dispatchGatewayMethodInProcess(
          "sessions.mention",
          { ...params, senderProfileId: f.alice.id },
          { forceSyntheticClient: true },
        ),
      ).rejects.toThrow();
      expect(f.push).not.toHaveBeenCalled();
    });
  });

  it("rechecks run authority after roster preparation", async () => {
    await withFixture(async (f) => {
      const pending = f.invoke("mentionable");
      f.retire();
      await expect(pending).rejects.toThrow(/authority/);
      expect(f.push).not.toHaveBeenCalled();
    });
  });

  it.each(["cancelled run", "revoked recipient", "replaced session"] as const)(
    "fences %s after transcript preparation awaits",
    async (scenario) => {
      await withFixture(async (f) => {
        const entered = createDeferred();
        const release = createDeferred();
        const append = transcriptInjection.appendInjectedAssistantMessageToTranscript;
        vi.spyOn(
          transcriptInjection,
          "appendInjectedAssistantMessageToTranscript",
        ).mockImplementationOnce(async (params) => {
          entered.resolve();
          await release.promise;
          return append(params);
        });
        const pending = f.invoke("mention", {
          recipientProfileIds: [f.bob.id],
          message: "Review.",
        });
        const rejected = expect(pending).rejects.toThrow();
        await entered.promise;
        if (scenario === "cancelled run") {
          f.retire();
        } else if (scenario === "revoked recipient") {
          await f.setSession({ visibility: "draft" });
        } else {
          await f.setSession({ sessionId: "replacement" });
        }
        release.resolve();
        await rejected;
        expect((await transcript()).filter((row) => row.type === "message")).toEqual([]);
        expect(readMentionInbox(f.inbox, f.bobClient).items).toEqual([]);
        expect(f.push).not.toHaveBeenCalled();
      });
    },
  );

  it("expires agent alerts from their original commit and never revives them on replay", async () => {
    await withFixture(async (f) => {
      const args = { recipientProfileIds: [f.bob.id], message: "Review." };
      await f.invoke("mention", args);
      const item = readMentionInbox(f.inbox, f.bobClient).items[0]!;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(item.expiresAt + 1);
      expect(readMentionInbox(f.inbox, f.bobClient).items).toEqual([]);
      expect(await f.invoke("mention", args)).toMatchObject({
        status: "skipped",
        reason: "expired",
        messageId: item.messageId,
      });
      expect(readMentionInbox(f.openInbox(), f.bobClient).items).toEqual([]);
      expect(f.push).toHaveBeenCalledTimes(1);
    });
  });

  it("retracts agent mentions and delayed push when recipient access is revoked", async () => {
    await withFixture(async (f) => {
      await f.invoke("mention", { recipientProfileIds: [f.bob.id], message: "Review." });
      const notification = f.push.mock.calls[0]![0];
      expect(notification.isCurrent()).toBe(true);
      await f.setSession({ visibility: "draft" });
      expect(notification.isCurrent()).toBe(false);
      expect(readMentionInbox(f.inbox, f.bobClient).items).toEqual([]);
      expect(readMentionInbox(f.openInbox(), f.bobClient).items).toEqual([]);
      expect(f.push).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps plain assistant @names inert and rejects changed arguments on tool replay", async () => {
    await withFixture(async (f) => {
      const plain = await transcriptInjection.appendInjectedAssistantMessageToTranscript({
        sessionKey: SESSION_KEY,
        sessionId: SESSION_ID,
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        agentId: "main",
        message: "@Bob this is plain prose",
      });
      expect(plain.ok).toBe(true);
      expect(readMentionInbox(f.inbox, f.bobClient).items).toEqual([]);
      expect(f.push).not.toHaveBeenCalled();
      await f.invoke("mention", { recipientProfileIds: [f.bob.id], message: "Review." });
      await expect(
        f.invoke("mention", { recipientProfileIds: [f.carol.id], message: "Different request" }),
      ).rejects.toThrow(/idempotency/);
      expect(readMentionInbox(f.inbox, f.carolClient).items).toEqual([]);
      expect(f.push).toHaveBeenCalledTimes(1);
    });
  });

  it("reports skipped when Inbox persistence fails while retaining the genuine note", async () => {
    await withFixture(async (f) => {
      const db = openOpenClawStateDatabase().db;
      db.exec(
        "CREATE TEMP TRIGGER reject_agent_mention BEFORE INSERT ON config_machine_state WHEN NEW.state_key GLOB 'notifications.mentions.source.*' BEGIN SELECT RAISE(ABORT, 'test Inbox failure'); END",
      );
      try {
        expect(
          await f.invoke("mention", { recipientProfileIds: [f.bob.id], message: "Review." }),
        ).toMatchObject({
          status: "skipped",
          reason: "unavailable",
          messageId: expect.any(String),
        });
      } finally {
        db.exec("DROP TRIGGER reject_agent_mention");
      }
      expect(readMentionInbox(f.inbox, f.bobClient).items).toEqual([]);
      expect((await transcript()).filter((row) => row.type === "message")).toHaveLength(1);
      expect(f.push).not.toHaveBeenCalled();
    });
  });
});
