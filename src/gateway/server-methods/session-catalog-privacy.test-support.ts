import { expect, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import {
  listAdoptedSessionCatalogSessions,
  type SessionCatalogEntrySnapshot,
  type SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionCatalogHandlers } from "./session-catalog.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export async function withCatalog(
  run: (fixture: Awaited<ReturnType<typeof createCatalog>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const previousRegistry = getActivePluginRegistry() ?? createEmptyPluginRegistry();
    try {
      await run(await createCatalog());
    } finally {
      setActivePluginRegistry(previousRegistry);
    }
  });
}

async function createCatalog() {
  const caller = ensureProfileForEmail("catalog-caller@example.test");
  const other = ensureProfileForEmail("catalog-other@example.test");
  const config: OpenClawConfig = {
    gateway: {
      roles: {
        default: "writer",
        definitions: {
          writer: {
            sessions: { others: "write" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    },
  };
  for (const [id, profileId, source, visibility] of [
    ["foreign", other.id, "profile", "shared"],
    ["owned", caller.id, "profile", "draft"],
    ["collision", caller.id, "channel", "draft"],
  ] as const) {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: `agent:main:${id}` },
      {
        sessionId: id,
        updatedAt: 1,
        visibility,
        pluginOwnerId: "fixture",
        createdVia: source === "profile" ? "operator" : "channel",
        createdActor: { type: "human", source, id: profileId },
      },
    );
  }
  const host: SessionCatalogHost = {
    hostId: "gateway:local",
    label: "Local",
    kind: "gateway",
    connected: true,
    sessions: ["foreign", "owned", "collision"].map((id) => ({
      threadId: id,
      sessionKey: `agent:main:${id}`,
      status: "stored",
      archived: false,
      canContinue: true,
      canArchive: true,
    })),
  };
  const runtime = createPluginRuntime();
  const enumerate = (sessionEntries?: SessionCatalogEntrySnapshot): SessionCatalogHost => {
    const adopted = listAdoptedSessionCatalogSessions({
      agentId: "main",
      config,
      pluginId: "fixture",
      runtime,
      sessionEntries,
      sourceFromEntry: (entry) => ({ hostId: host.hostId, threadId: entry.sessionId }),
    });
    return {
      ...host,
      sessions: host.sessions.map(({ sessionKey: _key, ...session }) => {
        const sessionKey = adopted.get(`${host.hostId}\0${session.threadId}`);
        return sessionKey ? { ...session, sessionKey } : session;
      }),
    };
  };
  const list = vi.fn<SessionCatalogProvider["list"]>(async ({ sessionEntries }) => [
    enumerate(sessionEntries),
  ]);
  const read = vi.fn<SessionCatalogProvider["read"]>(async ({ hostId, threadId }) => ({
    hostId,
    threadId,
    items: [],
  }));
  const continueSession = vi.fn(async () => ({ sessionKey: "agent:main:owned" }));
  const archive = vi.fn(async () => ({ ok: true as const }));
  const registry = createEmptyPluginRegistry();
  registry.sessionCatalogs.push({
    pluginId: "fixture",
    source: new URL("./session-catalog-privacy.test.ts", import.meta.url).href,
    provider: { id: "fixture", label: "Fixture", list, read, continueSession, archive },
  });
  setActivePluginRegistry(registry);
  const client = (profileId: string) =>
    ({
      connId: profileId,
      connect: { scopes: ["operator.read", "operator.write"] },
      authenticatedUserProfile: { profileId },
    }) as GatewayClient;
  const owner = client(caller.id);
  const foreignOwner = client(other.id);
  const broadcast = vi.fn();
  const context = {
    getRuntimeConfig: () => config,
    broadcastToConnIds: broadcast,
  } satisfies Pick<GatewayRequestContext, "getRuntimeConfig" | "broadcastToConnIds">;
  const startCall = (
    method: keyof typeof sessionCatalogHandlers = "sessions.catalog.list",
    params: Record<string, unknown> = {},
    requestClient = owner,
    options: { onResponse?: RespondFn; signal?: AbortSignal } = {},
  ) => {
    const respond = vi.fn();
    if (options.onResponse) {
      respond.mockImplementation(options.onResponse);
    }
    const completion = Promise.resolve(
      withPluginRuntimeGatewayRequestScope(
        { client: requestClient, pluginRegistry: registry, isWebchatConnect: () => false },
        () =>
          sessionCatalogHandlers[method]?.({
            params,
            client: requestClient,
            respond,
            context,
            ...(options.signal ? { signal: options.signal } : {}),
          } as never),
      ),
    );
    return { completion, respond };
  };
  const call = async (...args: Parameters<typeof startCall>) => {
    const pending = startCall(...args);
    await pending.completion;
    return pending.respond;
  };
  const closeStore = () =>
    closeOpenClawAgentDatabaseByPathAsync(resolveOpenClawAgentSqlitePath({ agentId: "main" }));
  const changeForeign = (patch: { visibility?: "draft" | "shared"; incognito?: true }) =>
    upsertSessionEntryCore({ agentId: "main", sessionKey: "agent:main:foreign" }, patch);
  const replaceForeign = async () => {
    const sessionKey = "agent:main:foreign";
    const removed = await deleteSessionEntryLifecycle({
      agentId: "main",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      archiveTranscript: false,
      expectedSessionId: "foreign",
    });
    expect(removed.deleted).toBe(true);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "replacement",
        updatedAt: 2,
        visibility: "draft",
        createdVia: "operator",
        createdActor: { type: "human", source: "profile", id: caller.id },
      },
    );
    expect(
      loadSessionEntryReadOnly({ agentId: "main", sessionKey })?.pluginOwnerId,
    ).toBeUndefined();
  };
  return {
    broadcast,
    context,
    call,
    startCall,
    closeStore,
    config,
    registry,
    provider: registry.sessionCatalogs[0]!.provider,
    changeForeign,
    replaceForeign,
    enumerate,
    callerId: caller.id,
    foreignOwner,
    owner,
    host,
    list,
    read,
    continueSession,
    archive,
  };
}

export const rows = (respond: ReturnType<typeof vi.fn>) =>
  respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions.map(
    (row: { threadId: string }) => row.threadId,
  );
