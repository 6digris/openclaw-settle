import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../../packages/gateway-protocol/src/client-info.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSessionEventSubscriberRegistry } from "../../server-chat-state.js";
import { createHistoryReadContext } from "../../server-methods/chat-history.test-helpers.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

it.each([
  { canonical: true, fixed: false },
  { canonical: false, fixed: false },
  { canonical: true, fixed: true },
  { canonical: false, fixed: true },
])(
  "publishes the admitted history identity (canonical=$canonical, fixed=$fixed)",
  async ({ canonical, fixed }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const store = fixed ? state.statePath("shared.sqlite") : undefined;
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { research: {}, ops: {} },
          ...(fixed ? { defaults: { sessionStore: { agentId: "ops" } } } : {}),
        },
        session: { scope: "global", ...(store ? { store } : {}) },
      };
      await state.writeConfig(cfg);
      const entries = [
        ["ops", "global"],
        ["research", "global"],
        ["research", "main"],
        ["research", "dashboard:12345678-0aaa-4000-8000-000000000001"],
      ] as const;
      for (const [agentId, suffix] of entries) {
        const sessionKey = `agent:${agentId}:${suffix}`;
        const scope = { agentId, sessionKey, storePath: store, sessionId: `${agentId}-${suffix}` };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
        await appendTranscriptMessage(scope, {
          message: { role: "user", content: scope.sessionId },
        });
      }
      const subscribers = createSessionEventSubscriberRegistry(() => true);
      const context = await createHistoryReadContext({
        getRuntimeConfig: () => cfg,
        subscribeSessionEvents: subscribers.subscribe,
        getSessionEventSubscriberConnIds: subscribers.getAll,
      });
      const harness = createDispatchTestHarness({ buildRequestContext: () => context });
      const client = createOperatorWsClient();
      client.connect.caps = canonical ? [GATEWAY_CLIENT_CAPS.CANONICAL_SESSION_KEYS] : [];
      let sequence = 0;
      const dispatch = async (params: Record<string, unknown>, method = "chat.history") => {
        const id = `history-identity-${++sequence}`;
        await harness.dispatcher.dispatch({ type: "req", id, method, params }, client);
        return await harness.awaitResponseFrame(id);
      };
      const implicitOwner = fixed ? "ops" : "research";
      const aliasOwner = fixed ? {} : { agentId: implicitOwner };
      const cases = [
        {
          sessionKey: "global",
          ...aliasOwner,
          selected: `agent:${implicitOwner}:global`,
          sessionId: `${implicitOwner}-global`,
        },
        {
          sessionKey: "main",
          ...aliasOwner,
          selected: `agent:${implicitOwner}:global`,
          sessionId: `${implicitOwner}-global`,
        },
        { sessionKey: "agent:ops:global", selected: "agent:ops:global", sessionId: "ops-global" },
        {
          sessionKey: "agent:research:main",
          selected: canonical ? "agent:research:main" : "agent:research:global",
          sessionId: canonical ? "research-main" : "research-global",
        },
        {
          sessionKey: "notes-missing",
          ...aliasOwner,
          selected: `agent:${implicitOwner}:notes-missing`,
          sessionId: undefined,
        },
      ];
      for (const { selected, sessionId, ...params } of cases) {
        const response = await dispatch(params);
        expect(response.ok).toBe(true);
        const payload = expectDefined(asOptionalRecord(response.payload), "full history response");
        expect(payload.sessionKey).toBe(canonical ? selected : params.sessionKey);
        expect(payload.sessionId).toBe(sessionId);
        expect(payload.messages).toEqual(
          sessionId ? [expect.objectContaining({ content: sessionId })] : [],
        );
        expect(payload.sessionInfo).toMatchObject({
          key: canonical || !selected.endsWith(":global") ? selected : "global",
        });
        const startup = await dispatch(params, "chat.startup");
        expect(startup).toMatchObject({
          ok: true,
          payload: { sessionKey: canonical ? selected : params.sessionKey, sessionId },
        });
        if (params.sessionKey === "global") {
          expect(typeof payload.deltaCursor).toBe("string");
          for (const method of ["chat.history", "chat.startup"]) {
            const delta = await dispatch({ ...params, cursor: payload.deltaCursor }, method);
            expect(delta).toMatchObject({ ok: true, payload: { kind: "delta" } });
            expect(delta.payload).not.toHaveProperty("sessionKey");
          }
        }
        if (!sessionId) {
          expect(
            loadSessionEntryReadOnly({
              agentId: implicitOwner,
              sessionKey: selected,
              storePath: store,
            }),
          ).toBeUndefined();
          for (const method of ["chat.history", "chat.startup"]) {
            const reset = await dispatch({ ...params, cursor: "missing-cursor" }, method);
            expect(reset).toMatchObject({ ok: true, payload: { kind: "reset" } });
            expect(reset.payload).not.toHaveProperty("sessionKey");
          }
          expect(
            loadSessionEntryReadOnly({
              agentId: implicitOwner,
              sessionKey: selected,
              storePath: store,
            }),
          ).toBeUndefined();
        }
      }
      const shortKey = "agent:research:dashboard:12345678-0aaa-4000-8000-000000000001";
      expect(
        await dispatch({ shortId: "12345678", agentId: "research" }, "chat.startup"),
      ).toMatchObject({
        ok: true,
        payload: {
          sessionKey: shortKey,
          resolution: { ok: true, key: shortKey, agentId: "research" },
          sessionInfo: { key: shortKey },
          messages: [
            expect.objectContaining({
              content: "research-dashboard:12345678-0aaa-4000-8000-000000000001",
            }),
          ],
        },
      });
      for (const params of [
        { sessionKey: "agent:ops:global", agentId: "research" },
        { sessionKey: "global", agentId: "!!!" },
        ...(fixed ? [{ sessionKey: "global", agentId: "research" }] : [{ sessionKey: "global" }]),
      ]) {
        expect(await dispatch(params)).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST" },
        });
      }
      for (const [agentId, suffix] of entries) {
        expect(
          loadSessionEntryReadOnly({
            agentId,
            sessionKey: `agent:${agentId}:${suffix}`,
            storePath: store,
          }),
        ).toMatchObject({ sessionId: `${agentId}-${suffix}` });
      }
    });
  },
);
