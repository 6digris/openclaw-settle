import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import * as sessions from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveExistingAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler, RespondFn } from "./server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import * as storeLookup from "./session-utils-store-lookup.js";
import {
  resolveGatewaySessionStoreTargetWithStore,
  resolveGatewaySessionStoreTargetsReadOnly,
} from "./session-utils-store-lookup.js";

afterEach(() => vi.restoreAllMocks());

it.each(["global", "per-sender"] as const)(
  "resolves capless retired-main aliases at wire ingress in %s scope",
  async (scope) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const received = vi.fn();
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { research: {} } },
        session: { scope, mainKey: "new-home" },
      };
      const harness = createDispatchTestHarness({
        buildRequestContext: () => ({ getRuntimeConfig: () => cfg }),
        extraHandlers: {
          "sessions.get": ({ params, respond }) => {
            received(params);
            respond(true, {});
          },
        },
      });
      const params = { key: "agent:main:main" };
      await harness.dispatcher.dispatch(
        { type: "req", id: "legacy-main", method: "sessions.get", params },
        createOperatorWsClient(),
      );
      expect(received).toHaveBeenCalledExactlyOnceWith({
        key: scope === "global" ? "agent:research:global" : "agent:research:new-home",
      });
      expect(params.key).toBe("agent:main:main");
    });
  },
);

it.each(["default", "template", "shared"] as const)(
  "keeps retired main history and grouped reads bound to the %s physical store",
  async (layout) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const store =
        layout === "shared"
          ? state.statePath("shared.sqlite")
          : layout === "template"
            ? state.statePath("alternate", "agents", "{agentId}", "sessions", "sessions.json")
            : undefined;
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { research: {} } },
        session: { mainKey: "new-home", ...(store ? { store } : {}) },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      if (layout === "shared") {
        openOpenClawAgentDatabase({ agentId: "research", path: store });
      }
      for (const [agentId, suffix, sessionId] of [
        ["main", "main", "main-history"],
        ["research", "main", "research-history"],
        ["research", "new-home", "home-canary"],
      ] as const) {
        const sessionKey = `agent:${agentId}:${suffix}`;
        const scope = {
          agentId,
          sessionKey,
          sessionId,
          storePath: resolveSessionStorePathCore(store, { agentId }),
        };
        await sessions.replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        await sessions.persistSessionTranscriptTurn(scope, {
          messages: [
            {
              eventId: `${sessionId}-message`,
              message: {
                role: "user",
                content: suffix === "main" ? `${agentId} retained history` : "current Home canary",
              },
            },
          ],
          touchSessionEntry: false,
        });
        await sessions.waitForSessionTranscriptProjection(scope);
      }
      const key = "agent:main:main";
      const expectedPath = resolveSessionStorePathCore(store, { agentId: "main" });
      const physical = resolveSqliteTargetFromSessionStorePath(expectedPath, { agentId: "main" });
      const databaseAgentId = expectDefined(physical.agentId, "Fixture store has no owner");
      const unrelatedStore = { [key]: { sessionId: "borrowed-wrong-store", updatedAt: 99 } };
      const selected = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key,
        store: unrelatedStore,
        readOnly: true,
        exactRead: true,
      });
      expect(selected).toMatchObject({
        agentId: "main",
        canonicalKey: key,
        storePath: expectedPath,
        store: { [key]: { sessionId: "main-history" } },
        readSource: { agentId: databaseAgentId, path: physical.path },
      });
      expect(selected.store).not.toBe(unrelatedStore);
      const respond = vi.fn<RespondFn>();
      await handleGatewayRequest({
        req: { type: "req", id: "retired-main-history", method: "sessions.get", params: { key } },
        client: null,
        isWebchatConnect: () => false,
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        respond,
      });
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(respond.mock.calls[0]?.[1]).toMatchObject({
        messages: [{ content: "main retained history" }],
      });
      const readBatch = vi.spyOn(sessions, "loadExactSessionEntryCandidatesReadOnlyBatch");
      const results = resolveGatewaySessionStoreTargetsReadOnly({
        cfg,
        targets: [{ key }, { key: "agent:research:main" }, { key }],
      });
      expect(results.map((target) => target.store[target.canonicalKey]?.sessionId)).toEqual([
        "main-history",
        "research-history",
        "main-history",
      ]);
      expect(results[0]?.readSource).toEqual(results[2]?.readSource);
      expect(readBatch).toHaveBeenCalledOnce();
      expect(readBatch.mock.calls[0]?.[0]).toHaveLength(3);
      readBatch.mockClear();
      expect(() =>
        resolveGatewaySessionStoreTargetsReadOnly({ cfg, targets: [{ key, agentId: "research" }] }),
      ).toThrow('belongs to "main"');
      expect(readBatch).not.toHaveBeenCalled();
      const legacy = createDispatchTestHarness({
        buildRequestContext: () => createDirectChatContext({ getRuntimeConfig: () => cfg }),
      });
      for (const canonical of [false, true]) {
        const client = createOperatorWsClient();
        client.connect.caps = canonical ? [GATEWAY_CLIENT_CAPS.CANONICAL_SESSION_KEYS] : [];
        const id = `retained-main-${canonical}`;
        await legacy.dispatcher.dispatch(
          { type: "req", id, method: "sessions.get", params: { key } },
          client,
        );
        expect(await legacy.awaitResponseFrame(id)).toMatchObject({
          ok: true,
          payload: { messages: [{ content: "main retained history" }] },
        });
      }
      const repeatedRead = vi.spyOn(sessions, "loadExactSessionEntryCandidates");
      const received = vi.fn<GatewayRequestHandler>(({ respond: reply }) => reply(true, {}));
      const repeated = createDispatchTestHarness({
        buildRequestContext: () => createDirectChatContext({ getRuntimeConfig: () => cfg }),
        extraHandlers: { "sessions.patchMany": received },
      });
      await repeated.dispatcher.dispatch(
        {
          type: "req",
          id: "repeated",
          method: "sessions.patchMany",
          params: {
            targets: [{ key }, { key }],
            patch: { label: "synthetic" },
          },
        },
        createOperatorWsClient(),
      );
      expect(await repeated.awaitResponseFrame("repeated")).toMatchObject({ ok: true });
      expect(received.mock.calls[0]?.[0].params.targets).toEqual([{ key }, { key }]);
      expect(repeatedRead).toHaveBeenCalledOnce();
      repeatedRead.mockClear();
      for (const agentId of ["research", "!!!", " ", 7]) {
        const id = `invalid-owner-${agentId}`;
        await legacy.dispatcher.dispatch(
          { type: "req", id, method: "sessions.get", params: { key, agentId } },
          createOperatorWsClient(),
        );
        expect(await legacy.awaitResponseFrame(id)).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST" },
        });
      }
      expect(repeatedRead).not.toHaveBeenCalled();
      const damaged = openOpenClawAgentDatabase({ agentId: databaseAgentId, path: physical.path })
        .db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run("{", key);
      expect(damaged.changes).toBe(1);
      expect(() =>
        sessions.loadExactSessionEntryCandidates({
          agentId: "main",
          storePath: expectedPath,
          readOnly: true,
          sessionKeys: [key],
        }),
      ).toThrow(`invalid persisted session row requires repair for ${key}`);
      expect(() =>
        resolveGatewaySessionStoreTargetWithStore({ cfg, key, readOnly: true, exactRead: true }),
      ).toThrow(`invalid persisted session row requires repair for ${key}`);
      if (layout === "shared") {
        expect(() => resolveExistingAgentSessionStoreTargetsSync(cfg, "main")).toThrow(
          `invalid persisted session row requires repair for ${key}`,
        );
      }
      for (const canonical of [false, true]) {
        const client = createOperatorWsClient();
        client.connect.caps = canonical ? [GATEWAY_CLIENT_CAPS.CANONICAL_SESSION_KEYS] : [];
        const id = `corrupt-retired-main-${canonical}`;
        await legacy.dispatcher.dispatch(
          { type: "req", id, method: "sessions.get", params: { key } },
          client,
        );
        expect(await legacy.awaitResponseFrame(id)).toMatchObject({
          ok: false,
          error: {
            message: expect.stringContaining(
              `invalid persisted session row requires repair for ${key}`,
            ),
          },
        });
      }
    });
  },
);

it.each(["scope", "profile", "startup"] as const)(
  "keeps legacy store lookup behind the %s authorization fence",
  async (fence) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = { agents: { entries: { research: {} } } };
      setRuntimeConfigSnapshot(cfg, cfg);
      await sessions.replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:main" },
        {
          sessionId: "retained-main",
          updatedAt: 1,
        },
      );
      openOpenClawAgentDatabase({ agentId: "main" })
        .db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run("{", "agent:main:main");
      const read = vi.spyOn(sessions, "loadExactSessionEntryCandidates");
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, {}));
      const client = createOperatorWsClient({ scopes: fence === "scope" ? [] : ["operator.read"] });
      if (fence === "profile") {
        client.authenticatedGitHubIdentitySync = async () => {
          throw new Error("profile unavailable");
        };
      }
      const harness = createDispatchTestHarness({
        buildRequestContext: () =>
          createDirectChatContext({
            getRuntimeConfig: () => cfg,
            unavailableGatewayMethods: new Set(fence === "startup" ? ["sessions.get"] : []),
          }),
        extraHandlers: { "sessions.get": handler },
      });
      await harness.dispatcher.dispatch(
        {
          type: "req",
          id: fence,
          method: "sessions.get",
          params: { key: "agent:main:main" },
          ...(fence === "profile" ? { expectedProfileId: "unresolved-profile" } : {}),
        },
        client,
      );
      expect(await harness.awaitResponseFrame(fence)).toMatchObject({ ok: false });
      expect(handler).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    });
  },
);

it.each([false, true])(
  "admits write-only legacy agent requests with retained=%s",
  async (retained) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = {
        agents: { entries: { research: {} } },
        session: { mainKey: "new-home" },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      if (retained) {
        await sessions.replaceSessionEntry(
          { agentId: "main", sessionKey: "agent:main:main" },
          {
            sessionId: "retained-main",
            updatedAt: 1,
            visibility: "shared",
          },
        );
      }
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, {}));
      const harness = createDispatchTestHarness({
        buildRequestContext: () => createDirectChatContext({ getRuntimeConfig: () => cfg }),
        extraHandlers: { agent: handler },
      });
      await harness.dispatcher.dispatch(
        {
          type: "req",
          id: "write-only",
          method: "agent",
          params: {
            sessionKey: "agent:main:main",
            message: "synthetic turn",
            idempotencyKey: "write-only",
          },
        },
        createOperatorWsClient({ scopes: ["operator.write"] }),
      );
      expect(await harness.awaitResponseFrame("write-only")).toMatchObject({ ok: true });
      expect(handler.mock.calls[0]?.[0].params.sessionKey).toBe(
        retained ? "agent:main:main" : "agent:research:new-home",
      );
    });
  },
);

it.each(["none", "view", "write"] as const)(
  "keeps private retired reads hidden across inconclusive legacy probes with others=%s",
  async (others) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const key = "agent:main:main";
      const cfg: OpenClawConfig = {
        agents: { entries: { research: {} } },
        session: { mainKey: "new-home" },
        gateway: {
          roles: {
            default: "limited",
            definitions: {
              limited: {
                sessions: { others },
                agents: "*",
                scopes: ["operator.read", "operator.write"],
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      const viewerId = ensureProfileForEmail("retired-viewer@example.test").id;
      const ownerId = ensureProfileForEmail("retired-owner@example.test").id;
      for (const [agentId, sessionKey, sessionId, creator, visibility, content] of [
        ["main", key, "private-retired", ownerId, "draft", "private retained canary"],
        [
          "research",
          "agent:research:new-home",
          "visible-home",
          viewerId,
          "shared",
          "visible Home canary",
        ],
      ] as const) {
        const scope = { agentId, sessionKey, sessionId };
        await sessions.replaceSessionEntry(scope, {
          sessionId,
          updatedAt: 1,
          visibility,
          createdActor: { type: "human", source: "profile", id: creator },
        });
        await sessions.persistSessionTranscriptTurn(scope, {
          messages: [{ eventId: `${sessionId}-message`, message: { role: "user", content } }],
          touchSessionEntry: false,
        });
        await sessions.waitForSessionTranscriptProjection(scope);
      }
      const client = createOperatorWsClient({ scopes: ["operator.read"] });
      client.authenticatedUserProfile = {
        profileId: viewerId,
        displayName: null,
        avatarRevision: "1",
        hasAvatar: false,
        updatedAt: 1,
      };
      const projection = await createSessionRowProjection({ cfg });
      try {
        const context = createDirectChatContext({
          getRuntimeConfig: () => cfg,
          ...bindSessionRowProjection({}, () => projection),
        });
        const harness = createDispatchTestHarness({ buildRequestContext: () => context });
        const lookup = vi.spyOn(storeLookup, "resolveGatewaySessionStoreTargetWithStore");
        for (const method of ["sessions.get", "sessions.resolve"]) {
          const params =
            method === "sessions.get" ? { key } : { reference: { key }, allowMissing: true };
          client.connect.caps = [GATEWAY_CLIENT_CAPS.CANONICAL_SESSION_KEYS];
          const id = `canonical-${method}`;
          await harness.dispatcher.dispatch({ type: "req", id, method, params }, client);
          const { id: _id, ...canonical } = await harness.awaitResponseFrame(id);
          expect(canonical).toMatchObject(
            method === "sessions.get"
              ? others === "none"
                ? {
                    ok: false,
                    error: { code: "INVALID_REQUEST", message: `Session "${key}" was not found.` },
                  }
                : { ok: true, payload: { messages: [] } }
              : { ok: true, payload: { ok: false } },
          );
          client.connect.caps = [];
          for (const failProbe of [false, true]) {
            if (failProbe) {
              lookup.mockImplementationOnce(() => {
                throw new Error("synthetic private probe details");
              });
            }
            const legacyId = `legacy-${method}-${failProbe}`;
            await harness.dispatcher.dispatch(
              { type: "req", id: legacyId, method, params },
              client,
            );
            const { id: _legacyId, ...legacy } = await harness.awaitResponseFrame(legacyId);
            expect(legacy).toEqual(canonical);
          }
        }
      } finally {
        projection.dispose();
      }
    });
  },
);
