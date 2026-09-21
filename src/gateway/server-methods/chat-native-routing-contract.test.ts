import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession } from "./chat-send-session.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

type RoutingCase = {
  id: string;
  scope: "global" | "per-sender";
  requestKey: string;
  canonicalKey: string;
  isMain: boolean;
  stored: boolean;
  agentId: string;
  mainKey: string;
  nativeWritable: boolean;
};
const { cases } = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/talk-native-routing-contract.json", import.meta.url),
    "utf8",
  ),
) as { cases: RoutingCase[] };

it("projects a native address that chat.send preserves, except the explicit literal-global refusal", async () => {
  for (const scope of ["global", "per-sender"] as const) {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        session: { scope, mainKey: "main" },
        agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
      const client = identifiedClient("native-routing-operator");
      client.connect.scopes = ["operator.admin"];
      for (const row of cases.filter((candidate) => candidate.scope === scope)) {
        if (row.stored) {
          await upsertSessionEntryCore(
            { agentId: row.agentId, sessionKey: row.canonicalKey },
            { sessionId: row.id, updatedAt: 1 },
          );
        }
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          chatHistoryHandlers["chat.history"],
          "history handler",
        )({
          params: { sessionKey: row.requestKey, agentId: row.agentId, limit: 1, maxChars: 1 },
          context,
          req: { type: "req", id: row.id, method: "chat.history" },
          client,
          isWebchatConnect: () => false,
          respond,
        });
        const [ok, payload, error] = expectDefined(respond.mock.calls[0], row.id);
        expect(error, row.id).toBeUndefined();
        expect(ok, row.id).toBe(true);
        const info = expectDefined(
          asOptionalRecord(asOptionalRecord(payload)?.sessionInfo),
          row.id,
        );
        expect(info, row.id).toMatchObject({
          key: row.canonicalKey,
          agentId: row.agentId,
          isMain: row.isMain,
        });
        const normalized = normalizeChatSendRequest({
          params: {
            sessionKey: row.canonicalKey,
            agentId: row.agentId,
            message: "Native route contract",
            idempotencyKey: row.id,
          },
          client,
        });
        if (!normalized.ok) {
          throw new Error(normalized.error);
        }
        const prepared = prepareChatSendSession({ request: normalized.value, context, client });
        if (!prepared.ok) {
          throw new Error(JSON.stringify(prepared.error));
        }
        expect(prepared.value.sessionKey, row.id).toBe(
          row.nativeWritable ? row.canonicalKey : "agent:beta:main",
        );
        expect(prepared.value.agentId, row.id).toBe(row.agentId);
      }
    });
  }
});
