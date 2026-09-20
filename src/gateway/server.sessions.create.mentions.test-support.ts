import { expect, test, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { createMentionInbox } from "./mention-inbox.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import type { GatewayClient } from "./server-methods/types.js";
import { waitForCreatedSessionRun } from "./server.sessions.create.projects.test-support.js";
import { directSessionReq } from "./test/server-sessions.test-helpers.js";

/** Keep first-message mention proofs on the session-create suite's configured store and mocks. */
export function registerSessionCreateMentionTests(
  withFixedOwnerSessionStore: (
    scope: "global" | "per-sender",
    run: (fixture: {
      storePath: string;
      cfg: ReturnType<typeof getRuntimeConfig>;
    }) => Promise<void>,
  ) => Promise<void>,
) {
  test("sessions.create delivers its selected everyone first message to offline readers", () =>
    withFixedOwnerSessionStore("per-sender", async ({ storePath }) => {
      const alice = ensureProfileForEmail("alice@everyone-create.example.test");
      const bob = ensureProfileForEmail("bob@everyone-create.example.test");
      const carol = ensureProfileForEmail("carol@everyone-create.example.test");
      const sender = { ...identifiedClient(alice.id, "Alice"), connId: "alice-everyone-create" };
      const recipient = { ...identifiedClient(bob.id, "Bob"), connId: "bob-everyone-create" };
      const offline = { ...identifiedClient(carol.id, "Carol"), connId: "carol-offline" };
      const inbox = createMentionInbox({
        gatewayInstanceId: "first-everyone-message",
        getRuntimeConfig,
        getClients: () => [sender, recipient],
        broadcastToConnIds: vi.fn(),
      });
      const context = {
        mentionInbox: inbox,
        chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
        getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
          new Set(
            [sender, recipient]
              .filter((client) => !filter || filter(client))
              .map(({ connId }) => connId),
          ),
      };
      let key: string | undefined;
      try {
        const created = await directSessionReq<{ key: string; runStarted: boolean }>(
          "sessions.create",
          {
            agentId: "main",
            message: "@everyone review this",
            mentions: [{ kind: "everyone", start: 0, end: 9 }],
          },
          { client: sender, context, isWebchatConnect: () => true },
        );
        expect(created.ok, JSON.stringify(created.error)).toBe(true);
        expect(created.payload?.runStarted).toBe(true);
        key = created.payload?.key;
        for (const client of [recipient, offline]) {
          expect(inbox.list(client)).toMatchObject({
            ok: true,
            value: { items: [{ sessionKey: key, senderProfileId: alice.id }] },
          });
        }
        expect(inbox.list(sender)).toMatchObject({ ok: true, value: { items: [] } });
      } finally {
        await waitForCreatedSessionRun(context, storePath, key);
        inbox.dispose();
      }
    }));

  const mentionCreationOwners = [
    ["main", "per-sender"],
    ["ops", "per-sender"],
    ["main", "global"],
    ["ops", "global"],
  ] as const;

  test.each(mentionCreationOwners)(
    "sessions.create commits its selected first-message mentions to the recipient Inbox for %s under %s scope",
    (agentId, scope) =>
      withFixedOwnerSessionStore(scope, async ({ storePath }) => {
        const alice = ensureProfileForEmail("alice@create-mentions.example.test");
        const bob = ensureProfileForEmail("bob@create-mentions.example.test");
        const sender = { ...identifiedClient(alice.id, "Alice"), connId: "alice-create" };
        const recipient = { ...identifiedClient(bob.id, "Bob"), connId: "bob-create" };
        const inbox = createMentionInbox({
          gatewayInstanceId: "first-message-mentions",
          getRuntimeConfig,
          getClients: () => [sender, recipient],
          broadcastToConnIds: vi.fn(),
        });
        const context = {
          mentionInbox: inbox,
          chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
          getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
            new Set(
              [sender, recipient]
                .filter((client) => !filter || filter(client))
                .map(({ connId }) => connId),
            ),
        };
        let key: string | undefined;
        try {
          const created = await directSessionReq<{
            key: string;
            sessionId: string;
            runStarted: boolean;
          }>(
            "sessions.create",
            {
              agentId,
              message: "@Bob review this",
              mentions: [{ profileId: bob.id, start: 0, end: 4 }],
            },
            { client: sender, context, isWebchatConnect: () => true },
          );
          expect(created.ok, JSON.stringify(created.error)).toBe(true);
          expect(created.payload?.runStarted).toBe(true);
          key = created.payload?.key;
          expect(key).toMatch(new RegExp(`^agent:${agentId}:dashboard:`));
          expect(inbox.list(recipient)).toMatchObject({
            ok: true,
            value: {
              items: [
                {
                  senderProfileId: alice.id,
                  sessionKey: key,
                  agentId,
                  excerpt: "@Bob review this",
                },
              ],
            },
          });
          expect(inbox.list(sender)).toMatchObject({ ok: true, value: { items: [] } });
        } finally {
          await waitForCreatedSessionRun(context, storePath, key);
          inbox.dispose();
        }
      }),
  );

  test.each(mentionCreationOwners)(
    "sessions.create rejects stale mention spans before creating a session for %s under %s scope",
    (agentId, scope) =>
      withFixedOwnerSessionStore(scope, async () => {
        const sender = identifiedClient(
          ensureProfileForEmail("alice@invalid-mentions.example.test").id,
        );
        const created = await directSessionReq(
          "sessions.create",
          {
            agentId,
            message: "token was removed",
            mentions: [{ profileId: "bob", start: 0, end: 4 }],
          },
          { client: sender },
        );
        expect(created).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("Select the people again") },
        });
        const listed = await directSessionReq<{ sessions: unknown[] }>("sessions.list", {});
        expect(listed.payload?.sessions).toEqual([]);
      }),
  );
}
