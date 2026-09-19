import { beforeEach, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../../packages/gateway-protocol/src/client-info.js";
import { setRuntimeConfigSnapshot } from "../../../config/io.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../../server-chat.agent-events.test-helpers.js";
import type { GatewayRequestHandler } from "../../server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

beforeEach(() => {
  resetGatewayWorkAdmission();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

async function createFixture() {
  const cfg: OpenClawConfig = {
    agents: { entries: { main: { default: true }, child: {}, other: {} } },
  };
  setRuntimeConfigSnapshot(cfg);
  const profile = ensureProfileForEmail("router-owner@example.test");
  const createdActor = { type: "human", source: "profile", id: profile.id } as const;
  const canary = { agentId: "main", sessionKey: "agent:main:canary" };
  await upsertSessionEntryCore(canary, {
    sessionId: "main-canary",
    updatedAt: 1,
    label: "retained",
    createdActor,
  });
  const client = createOperatorWsClient({ scopes: ["operator.read", "operator.write"] });
  client.connect.caps = [GATEWAY_CLIENT_CAPS.CANONICAL_SESSION_KEYS];
  client.authenticatedUserProfile = {
    profileId: profile.id,
    displayName: null,
    avatarRevision: "1",
    hasAvatar: false,
    updatedAt: 1,
  };
  const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
    respond(true, { dispatched: true }),
  );
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const harness = createDispatchTestHarness({
    buildRequestContext: () => context,
    extraHandlers: {
      agent: handler,
      "sessions.create": handler,
      "sessions.patchMany": handler,
      "sessions.patch": handler,
      "sessions.delete": handler,
      "sessions.compact": handler,
    },
  });
  let nextId = 0;
  const dispatch = async (method: string, params: Record<string, unknown>) => {
    const id = `owner-${++nextId}`;
    await harness.dispatcher.dispatch({ type: "req", id, method, params }, client);
    return await harness.awaitResponseFrame(id);
  };
  return { cfg, client, context, handler, dispatch, createdActor, canary };
}

it.each([
  { method: "agent", params: { sessionKey: "agent:!!!:main" } },
  { method: "agent", params: { sessionKey: "agent::notes" } },
  { method: "agent", params: { sessionKey: "agent:main:" } },
  { method: "agent", params: { sessionKey: "agent:main:canary", agentId: "!!!" } },
  { method: "agent", params: { sessionKey: "agent:main:canary", agentId: " " } },
  {
    method: "sessions.patchMany",
    params: { targets: [{ key: "agent:main:canary", agentId: " " }], patch: { label: "changed" } },
  },
])(
  "rejects malformed session ownership at authenticated dispatch: %j",
  async ({ method, params }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = await createFixture();
      const before = loadSessionEntryReadOnly(fixture.canary);
      const result = await fixture.dispatch(method, {
        ...(method === "agent" ? { message: "test", idempotencyKey: "invalid-owner" } : {}),
        ...params,
      });
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      expect(fixture.handler).not.toHaveBeenCalled();
      expect(loadSessionEntryReadOnly(fixture.canary)).toEqual(before);
    });
  },
);

it.each([
  ["sessions.patch", { key: "agent:typo:main", label: "Typo" }],
  ["sessions.delete", { key: "agent:typo:main" }],
  ["sessions.compact", { key: "agent:typo:main" }],
] as const)(
  "rejects an unknown owner in a capless global alias before %s",
  async (method, params) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = await createFixture();
      fixture.client.connect.caps = [];
      fixture.client.connect.scopes = ["operator.admin"];
      fixture.cfg.session = { scope: "global" };
      const before = loadSessionEntryReadOnly(fixture.canary);
      const result = await fixture.dispatch(method, params);
      expect(result).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: 'Unknown agent id "typo"' },
      });
      expect(fixture.handler).not.toHaveBeenCalled();
      expect(loadSessionEntryReadOnly(fixture.canary)).toEqual(before);
    });
  },
);

it("rejects malformed owners before capless fixed-store alias translation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await createFixture();
    fixture.client.connect.caps = [];
    fixture.cfg.agents = {
      entries: { ops: {}, research: {} },
      defaults: { sessionStore: { agentId: "ops" } },
    };
    fixture.cfg.session = { store: state.statePath("shared-sessions.sqlite") };
    const canary = {
      agentId: "ops",
      sessionKey: "agent:ops:main",
      storePath: fixture.cfg.session.store,
    };
    await upsertSessionEntryCore(canary, {
      sessionId: "fixed-store-canary",
      updatedAt: 1,
      label: "retained",
      createdActor: fixture.createdActor,
    });
    const before = loadSessionEntryReadOnly(canary);
    for (const agentId of ["!!!", " "]) {
      const result = await fixture.dispatch("agent", {
        sessionKey: "agent:main:main",
        agentId,
      });
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
    expect(fixture.handler).not.toHaveBeenCalled();
    expect(loadSessionEntryReadOnly(canary)).toEqual(before);
  });
});

it.each([false, true])(
  "keeps operational failures unavailable with canonical=%s",
  async (canonical) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = await createFixture();
      fixture.client.connect.caps = canonical ? [GATEWAY_CLIENT_CAPS.CANONICAL_SESSION_KEYS] : [];
      fixture.context.getRuntimeConfig = () => {
        throw new Error("synthetic backend offline");
      };
      const result = await fixture.dispatch("agent", { sessionKey: "agent:main:canary" });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: expect.stringContaining("synthetic backend offline"),
        },
      });
      expect(fixture.handler).not.toHaveBeenCalled();
    });
  },
);

it("keeps incognito existence hidden at authenticated dispatch", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = await createFixture();
    const existing = "agent:main:dashboard:incognito-existing";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: existing },
      { sessionId: "private", updatedAt: 1, incognito: true, createdActor: fixture.createdActor },
    );
    for (const sessionKey of [existing, "agent:main:dashboard:incognito-missing"]) {
      const result = await fixture.dispatch("agent", { sessionKey });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: `Incognito session "${sessionKey}" was not found.`,
        },
      });
    }
    expect(fixture.handler).not.toHaveBeenCalled();
  });
});

it("resolves a qualified foreign parent independently of the child owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = await createFixture();
    const parentSessionKey = "agent:other:parent";
    await upsertSessionEntryCore(
      { agentId: "other", sessionKey: parentSessionKey },
      { sessionId: "parent", updatedAt: 1, createdActor: fixture.createdActor },
    );
    const result = await fixture.dispatch("sessions.create", {
      agentId: "child",
      parentSessionKey,
      fork: true,
    });
    expect(result).toMatchObject({ ok: true, payload: { dispatched: true } });
    expect(fixture.handler).toHaveBeenCalledOnce();
  });
});
