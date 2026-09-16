import { getEventListeners } from "node:events";
import { performance } from "node:perf_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { GatewayRequestEntryLifetime } from "../server-request-entry.js";
import { catalogLog } from "./session-catalog-log.test-support.js";
import {
  call,
  createCatalogTestContext,
  hoisted,
  markPluginRegistryActive,
  provider,
  resetSessionCatalogTestState,
  startCall,
  type PluginRegistry,
  type SessionCatalogProvider,
} from "./session-catalog.test-helpers.js";

describe("session catalog progress ownership", () => {
  beforeEach(resetSessionCatalogTestState);

  it("releases constructor listeners when final caller admission throws", async () => {
    const request = new GatewayRequestEntryLifetime();
    const drain = getGatewayRestartDrainSignal();
    const listeners = getEventListeners(drain, "abort");
    const instance = { instanceId: "catalog-instance", runId: "catalog-run" };
    const identity: AgentRuntimeIdentity = {
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "agent:main:catalog",
      operationalRunInstance: instance,
      delegatedAuthority: {
        kind: "local",
        lifecycleGeneration: "catalog-generation",
        claimId: "catalog-claim",
        operationalRunInstance: instance,
      },
    };
    const client = {
      connect: { scopes: ["operator.admin"] },
      internal: { agentRuntimeIdentity: identity },
    };
    const error = new Error("caller authority lookup failed");
    try {
      await expect(
        call(
          "sessions.catalog.list",
          {},
          createCatalogTestContext(
            {},
            {
              requestEntryLifetime: request,
              validateAgentRuntimeApprovalAuthority: () => {
                throw error;
              },
            },
          ),
          client,
        ),
      ).rejects.toBe(error);
      expect(getEventListeners(drain, "abort")).toEqual(listeners);
    } finally {
      request.beginClose();
      await request.sealAndJoin();
    }
  });

  it("streams completed hosts to only the requesting connection", async () => {
    const broadcastToConnIds = vi.fn();
    const host = {
      hostId: "node:fast",
      label: "Fast node",
      kind: "node" as const,
      connected: true,
      nodeId: "fast",
      sessions: [],
    };
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("codex", {
          list: vi.fn(async ({ onHost }) => {
            onHost?.(host);
            return [host];
          }),
        }),
      },
    ];

    const respond = await call(
      "sessions.catalog.list",
      { progressId: "progress-1" },
      createCatalogTestContext({}, { broadcastToConnIds }),
      { connId: "requester", connect: {} },
    );

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.catalog.host",
      {
        progressId: "progress-1",
        agentId: "main",
        catalog: expect.objectContaining({ id: "codex", hosts: [host] }),
      },
      new Set(["requester"]),
      { dropIfSlow: true },
    );
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ id: "codex", hosts: [host] })],
    });
  });

  it("single-flights identical concurrent lists for one caller and fans progress to active followers", async () => {
    const previousDiagnostics = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const enabled = catalogLog.isEnabled.mockReset().mockReturnValue(true);
    const warn = catalogLog.warn.mockReset().mockImplementation(() => {});
    const { promise: gate, resolve: release } = createDeferredCore();
    const host = {
      hostId: "gateway:local",
      label: "Local",
      kind: "gateway" as const,
      connected: true,
      sessions: [],
    };
    const late = createDeferredCore();
    const publications: Promise<void>[] = [];
    const list = vi.fn<SessionCatalogProvider["list"]>(async ({ onHost, waitUntil }) => {
      const publication = late.promise.then(() => onHost?.(host));
      publications.push(publication);
      waitUntil?.(publication);
      await gate;
      onHost?.(host);
      return [host];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const config = { agents: { list: [{ id: "main" }, { id: "research" }] } };
    const broadcastToConnIds = vi.fn();
    const context = createCatalogTestContext(config, { broadcastToConnIds });
    const sharedClient = { connId: "requester" };
    const leader = startCall(
      "sessions.catalog.list",
      { progressId: "leader-progress", agentId: "main" },
      context,
      sharedClient,
    );
    const follower = startCall(
      "sessions.catalog.list",
      { progressId: "follower-progress", agentId: "main" },
      context,
      sharedClient,
    );
    const otherAgent = startCall("sessions.catalog.list", { agentId: "research" }, context);
    const otherParams = startCall(
      "sessions.catalog.list",
      { search: "other", agentId: "main" },
      context,
    );

    try {
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
      clock = 1_500;
      release();
      await Promise.all([
        leader.completion,
        follower.completion,
        otherAgent.completion,
        otherParams.completion,
      ]);

      expect(
        broadcastToConnIds.mock.calls.map(([, frame, recipients]) => [
          frame.progressId,
          recipients,
        ]),
      ).toEqual([
        ["leader-progress", new Set(["requester"])],
        ["follower-progress", new Set(["requester"])],
      ]);
      expect(warn).toHaveBeenCalledTimes(3);
      for (const [message, fields] of warn.mock.calls) {
        expect(message).toBe("slow session catalog provider list");
        expect(fields).toMatchObject({ providerElapsedMs: 1_500, returnedGatewayHostCount: 1 });
      }
      for (const pending of [leader, follower, otherAgent, otherParams]) {
        expect(pending.respond).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ id: "codex", hosts: [host] })],
        });
      }
      await call(
        "sessions.catalog.list",
        { progressId: "settled-progress", agentId: "main" },
        context,
        sharedClient,
      );
      clock = 5_000;
      late.resolve();
      await Promise.all(publications);
      expect(broadcastToConnIds.mock.calls.map(([, frame]) => frame.progressId)).toEqual([
        "leader-progress",
        "follower-progress",
        "leader-progress",
        "follower-progress",
      ]);
      expect(list).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      release();
      late.resolve();
      await Promise.allSettled([
        leader.completion,
        follower.completion,
        otherAgent.completion,
        otherParams.completion,
        ...publications,
      ]);
      now.mockRestore();
      enabled.mockReset();
      warn.mockReset();
      setDiagnosticsEnabledForProcess(previousDiagnostics);
    }
  });

  it.each(["old-first", "new-first"] as const)(
    "keeps reloaded cache generations independent when replies settle %s",
    async (order) => {
      let config = {};
      const context = createCatalogTestContext(config, { getRuntimeConfig: () => config });
      const client = { connId: "config-reload-requester" };
      const releases = [createDeferredCore(), createDeferredCore()];
      const signals: AbortSignal[] = [];
      const hosts = ["before-reload", "after-reload", "next-reload"].map(
        (hostId): SessionCatalogHost => ({
          hostId,
          label: hostId,
          kind: "gateway",
          connected: true,
          sessions: [],
        }),
      );
      const list = vi.fn<SessionCatalogProvider["list"]>(async ({ signal }) => {
        const index = signals.length;
        expect(signal).toBeDefined();
        signals.push(signal!);
        await releases[index]?.promise;
        return [hosts[index]!];
      });
      hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
      const original = startCall("sessions.catalog.list", {}, context, client);
      const pending = [original];
      try {
        await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
        config = {};
        const refreshed = startCall("sessions.catalog.list", {}, context, client);
        pending.push(refreshed);
        await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
        expect(signals[0]?.aborted).toBe(false);
        expect(original.respond).not.toHaveBeenCalled();
        const first = order === "old-first" ? 0 : 1;
        releases[first]!.resolve();
        await pending[first]!.completion;
        const follower = startCall("sessions.catalog.list", {}, context, client);
        pending.push(follower);
        releases[1 - first]!.resolve();
        await Promise.all(pending.map(({ completion }) => completion));
        expect(original.respond).toHaveBeenCalledExactlyOnceWith(true, {
          catalogs: [expect.objectContaining({ hosts: [hosts[0]] })],
        });
        for (const current of [refreshed, follower]) {
          expect(current.respond).toHaveBeenCalledExactlyOnceWith(true, {
            catalogs: [expect.objectContaining({ hosts: [hosts[1]] })],
          });
        }
        expect(list).toHaveBeenCalledTimes(2);
        config = {};
        expect(await call("sessions.catalog.list", {}, context, client)).toHaveBeenCalledWith(
          true,
          { catalogs: [expect.objectContaining({ hosts: [hosts[2]] })] },
        );
        expect(list).toHaveBeenCalledTimes(3);
      } finally {
        for (const release of releases) {
          release.resolve();
        }
        await Promise.allSettled(pending.map(({ completion }) => completion));
      }
    },
  );

  it("keeps pending callers shared and settles late publications under completed-query pressure", async () => {
    const release = createDeferredCore();
    const late = createDeferredCore();
    const publications: Promise<void>[] = [];
    const host = {
      hostId: "gateway:pruned",
      label: "Pruned",
      kind: "gateway" as const,
      connected: true,
      sessions: [],
    };
    const list = vi.fn<SessionCatalogProvider["list"]>(async ({ search, onHost, waitUntil }) => {
      if (search === "original") {
        const publication = late.promise.then(() => onHost?.(host));
        publications.push(publication);
        waitUntil?.(publication);
        await release.promise;
      }
      return [host];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
    const client = { connId: "pruned-requester" };
    const broadcastToConnIds = vi.fn();
    const context = createCatalogTestContext({}, { broadcastToConnIds });
    const leader = startCall(
      "sessions.catalog.list",
      { search: "original", progressId: "leader" },
      context,
      client,
    );
    const follower = startCall("sessions.catalog.list", { search: "original" }, context, client);
    try {
      await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
      for (let index = 0; index < 128; index += 1) {
        await call("sessions.catalog.list", { search: `other-${index}` }, context, client);
      }
      release.resolve();
      await Promise.all([leader.completion, follower.completion]);
      late.resolve();
      await Promise.all(publications);
      for (const pending of [leader, follower]) {
        expect(pending.respond).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ hosts: [host] })],
        });
      }
      expect(broadcastToConnIds).toHaveBeenCalledOnce();
      const callsBefore = list.mock.calls.length;
      await call("sessions.catalog.list", { search: "original" }, context, client);
      expect(list).toHaveBeenCalledTimes(callsBefore);
    } finally {
      release.resolve();
      late.resolve();
      await Promise.allSettled([leader.completion, follower.completion, ...publications]);
    }
  });

  it.each([false, true])(
    "settles abort-honoring callers after archive (query pressure=%s)",
    async (queryPressure) => {
      const release = createDeferredCore();
      const abortError = new Error("catalog discovery aborted by archive");
      const host: SessionCatalogHost = {
        hostId: "gateway:archived",
        label: "Archived",
        kind: "gateway" as const,
        connected: true,
        sessions: [
          {
            threadId: "deleted-thread",
            status: "stored",
            archived: false,
            canContinue: false,
            canArchive: true,
          },
        ],
      };
      let archived = false;
      let originalSignal: AbortSignal | undefined;
      const list = vi.fn<SessionCatalogProvider["list"]>(async ({ search, signal }) => {
        if (search === "original" && !archived) {
          originalSignal = signal;
          const aborted = createDeferredCore();
          const abort = () => aborted.reject(abortError);
          signal?.addEventListener("abort", abort, { once: true });
          try {
            await Promise.race([release.promise, aborted.promise]);
          } finally {
            signal?.removeEventListener("abort", abort);
          }
        }
        return [{ ...host, sessions: archived ? [] : host.sessions }];
      });
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider("fixture", {
            list,
            archive: async () => {
              archived = true;
              return { ok: true };
            },
          }),
        },
      ];
      const client = { connId: "archive-requester" };
      const broadcastToConnIds = vi.fn();
      const context = createCatalogTestContext({}, { broadcastToConnIds });
      const leader = startCall(
        "sessions.catalog.list",
        {
          search: "original",
          progressId: "leader",
        },
        context,
        client,
      );
      const follower = startCall("sessions.catalog.list", { search: "original" }, context, client);
      try {
        await vi.waitFor(() => expect(originalSignal).toBeDefined());
        for (let index = 0; index < (queryPressure ? 128 : 0); index += 1) {
          await call("sessions.catalog.list", { search: `other-${index}` }, context, client);
        }
        expect(
          await call(
            "sessions.catalog.archive",
            {
              catalogId: "fixture",
              hostId: host.hostId,
              threadId: "deleted-thread",
              confirmNoOtherRunner: true,
            },
            context,
            client,
          ),
        ).toHaveBeenCalledWith(true, { ok: true });
        expect(originalSignal?.aborted).toBe(true);
        await Promise.all([leader.completion, follower.completion]);
        for (const pending of [leader, follower]) {
          expect(pending.respond).toHaveBeenCalledExactlyOnceWith(true, {
            catalogs: [
              expect.objectContaining({
                hosts: [],
                error: { code: "catalog_error", message: abortError.message },
              }),
            ],
          });
        }
        expect(broadcastToConnIds).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([leader.completion, follower.completion]);
      }
    },
  );

  it("suppresses archived late publications after the completed aggregate was pruned", async () => {
    const late = createDeferredCore();
    const host: SessionCatalogHost = {
      hostId: "gateway:late-archive",
      label: "Late archive",
      kind: "gateway" as const,
      connected: true,
      sessions: [
        {
          threadId: "deleted-thread",
          status: "stored",
          archived: false,
          canContinue: false,
          canArchive: true,
        },
      ],
    };
    let archived = false;
    let originalSignal: AbortSignal | undefined;
    let publication: Promise<void> | undefined;
    const list = vi.fn<SessionCatalogProvider["list"]>(
      async ({ search, signal, onHost, waitUntil }) => {
        if (search === "original" && !archived) {
          originalSignal = signal;
          publication = late.promise.then(() => onHost?.(host));
          waitUntil?.(publication);
        }
        return [{ ...host, sessions: archived ? [] : host.sessions }];
      },
    );
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("fixture", {
          list,
          archive: async () => {
            archived = true;
            return { ok: true };
          },
        }),
      },
    ];
    const client = { connId: "late-archive-requester" };
    const broadcastToConnIds = vi.fn();
    const context = createCatalogTestContext({}, { broadcastToConnIds });
    try {
      const original = await call(
        "sessions.catalog.list",
        {
          search: "original",
          progressId: "before-archive",
        },
        context,
        client,
      );
      expect(original).toHaveBeenCalledWith(true, {
        catalogs: [expect.objectContaining({ hosts: [host] })],
      });
      expect(originalSignal?.aborted).toBe(false);
      for (let index = 0; index < 128; index += 1) {
        await call("sessions.catalog.list", { search: `other-${index}` }, context, client);
      }
      expect(
        await call(
          "sessions.catalog.archive",
          {
            catalogId: "fixture",
            hostId: host.hostId,
            threadId: "deleted-thread",
            confirmNoOtherRunner: true,
          },
          context,
          client,
        ),
      ).toHaveBeenCalledWith(true, { ok: true });
      late.resolve();
      await publication;
      expect(broadcastToConnIds).not.toHaveBeenCalled();
      expect(originalSignal?.aborted).toBe(true);
      const refreshed = await call(
        "sessions.catalog.list",
        { search: "original" },
        context,
        client,
      );
      expect(refreshed).toHaveBeenCalledWith(true, {
        catalogs: [expect.objectContaining({ hosts: [{ ...host, sessions: [] }] })],
      });
      expect(list.mock.calls.filter(([params]) => params.search === "original")).toHaveLength(2);
    } finally {
      late.resolve();
      await publication;
    }
  });

  it.each(["disconnected", "synthetic", "revoked"] as const)(
    "preserves admitted final-response authority for a %s client",
    async (kind) => {
      const release = createDeferredCore();
      const connection = new AbortController();
      let connected = kind !== "synthetic";
      const client = {
        connId: "admitted-caller",
        connect: {},
        connectionSignal: connection.signal,
        invalidated: false,
        ...(kind === "synthetic" ? { internal: { syntheticClient: true as const } } : {}),
      };
      const host = {
        hostId: "gateway:admitted",
        label: "Admitted",
        kind: "gateway" as const,
        connected: true,
        sessions: [],
      };
      const list = vi.fn<SessionCatalogProvider["list"]>(async ({ onHost }) => {
        await release.promise;
        onHost?.(host);
        return [host];
      });
      hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
      const broadcastToConnIds = vi.fn();
      const pending = startCall(
        "sessions.catalog.list",
        kind === "synthetic" ? {} : { progressId: "admitted" },
        createCatalogTestContext({}, { broadcastToConnIds, isConnectionActive: () => connected }),
        client,
      );
      try {
        await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
        if (kind === "revoked") {
          client.invalidated = true;
        } else if (kind === "disconnected") {
          connected = false;
          connection.abort();
        }
        release.resolve();
        if (kind === "revoked") {
          await expect(pending.completion).rejects.toMatchObject({ name: "AbortError" });
          expect(pending.respond).not.toHaveBeenCalled();
        } else {
          await pending.completion;
          expect(pending.respond).toHaveBeenCalledWith(true, {
            catalogs: [expect.objectContaining({ hosts: [host] })],
          });
        }
        expect(broadcastToConnIds).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([pending.completion]);
      }
    },
  );

  it.each([0, 128])(
    "keeps an active list shared after %i distinct lists settle",
    async (completedQueries) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const started = createDeferredCore();
      const release = createDeferredCore();
      const list = vi.fn<SessionCatalogProvider["list"]>(async ({ search }) => {
        if (search === "held") {
          started.resolve();
          await release.promise;
        }
        return [];
      });
      hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
      const context = createCatalogTestContext();
      const client = { connId: "requester" };
      const request = { catalogId: "fixture", search: "held" };
      const leader = startCall("sessions.catalog.list", request, context, client);
      const pending = [leader];
      try {
        await started.promise;
        now.mockReturnValue(5_000);
        for (let index = 0; index < completedQueries; index += 1) {
          const respond = await call(
            "sessions.catalog.list",
            { catalogId: "fixture", search: `completed-${index}` },
            context,
            client,
          );
          expect(respond).toHaveBeenCalledWith(true, {
            catalogs: [expect.objectContaining({ id: "fixture", hosts: [] })],
          });
        }
        pending.push(startCall("sessions.catalog.list", request, context, client));
        release.resolve();
        await Promise.all(pending.map(({ completion }) => completion));
        for (const { respond } of pending) {
          expect(respond).toHaveBeenCalledWith(true, {
            catalogs: [expect.objectContaining({ id: "fixture", hosts: [] })],
          });
        }
        expect(list.mock.calls.filter(([params]) => params.search === "held")).toHaveLength(1);
        now.mockReturnValue(7_999);
        await call("sessions.catalog.list", request, context, client);
        expect(list.mock.calls.filter(([params]) => params.search === "held")).toHaveLength(1);
        now.mockReturnValue(8_000);
        await call("sessions.catalog.list", request, context, client);
        expect(list.mock.calls.filter(([params]) => params.search === "held")).toHaveLength(2);
      } finally {
        release.resolve();
        await Promise.allSettled(pending.map(({ completion }) => completion));
        now.mockRestore();
      }
    },
  );

  it.each(["settled", "in-flight"] as const)(
    "refreshes %s lists immediately after archiving a session",
    async (listingState) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const gate = createDeferredCore();
      const started = createDeferredCore();
      const late = createDeferredCore();
      const publications: Promise<void>[] = [];
      const broadcastToConnIds = vi.fn();
      const session = {
        threadId: "deleted-thread",
        status: "stored",
        archived: false,
        canContinue: false,
        canArchive: true,
      };
      const host = {
        hostId: "gateway:local",
        label: "Local",
        kind: "gateway" as const,
        connected: true,
        sessions: [session],
      };
      let archived = false;
      const list = vi.fn<SessionCatalogProvider["list"]>(async ({ onHost, waitUntil }) => {
        const resultHost = { ...host, sessions: archived ? [] : [session] };
        const publication = late.promise.then(() => onHost?.(resultHost));
        publications.push(publication);
        waitUntil?.(publication);
        started.resolve();
        await gate.promise;
        return [resultHost];
      });
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider("fixture", {
            list,
            archive: async () => {
              archived = true;
              return { ok: true };
            },
          }),
        },
      ];
      const context = createCatalogTestContext({}, { broadcastToConnIds });
      const client = { connId: "requester" };
      const original = startCall(
        "sessions.catalog.list",
        { progressId: "before-delete" },
        context,
        client,
      );
      try {
        await started.promise;
        if (listingState === "settled") {
          gate.resolve();
          await original.completion;
        }
        const deletion = await call(
          "sessions.catalog.archive",
          {
            catalogId: "fixture",
            hostId: host.hostId,
            threadId: session.threadId,
            confirmNoOtherRunner: true,
          },
          context,
          client,
        );
        expect(deletion).toHaveBeenCalledWith(true, { ok: true });
        late.resolve();
        await publications[0];
        gate.resolve();
        await original.completion;
        expect(original.respond).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ hosts: [host] })],
        });

        const refreshed = await call(
          "sessions.catalog.list",
          { progressId: "after-delete" },
          context,
          client,
        );
        expect(refreshed).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ hosts: [{ ...host, sessions: [] }] })],
        });
        expect(list).toHaveBeenCalledTimes(2);
        expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
          "sessions.catalog.host",
          {
            progressId: "after-delete",
            agentId: "main",
            catalog: {
              id: "fixture",
              label: "FIXTURE",
              capabilities: { archive: true, continueSession: false },
              hosts: [{ ...host, sessions: [] }],
            },
          },
          new Set(["requester"]),
          { dropIfSlow: true },
        );
      } finally {
        gate.resolve();
        late.resolve();
        await original.completion;
        await Promise.allSettled(publications);
        now.mockRestore();
      }
    },
  );

  it("retires pending progress when aggregate projection fails", async () => {
    const late = createDeferredCore();
    const broadcastToConnIds = vi.fn();
    let publication: Promise<void> | undefined;
    let signal: AbortSignal | undefined;
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("fixture", {
          list: async (params) => {
            signal = params.signal;
            publication = late.promise.then(() =>
              params.onHost?.({
                hostId: "late",
                label: "Late",
                kind: "node",
                connected: true,
                sessions: [],
              }),
            );
            params.waitUntil?.(publication);
            return [];
          },
        }),
      },
    ];
    const getRuntimeConfig = vi
      .fn()
      .mockReturnValueOnce({})
      .mockImplementation(() => {
        throw new Error("current config unavailable");
      });
    try {
      await expect(
        call(
          "sessions.catalog.list",
          { progressId: "failed" },
          createCatalogTestContext(
            {},
            {
              getRuntimeConfig,
              broadcastToConnIds,
            },
          ),
          { connId: "requester" },
        ),
      ).rejects.toThrow("current config unavailable");
      expect(signal?.aborted).toBe(true);
      late.resolve();
      await publication;
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    } finally {
      late.resolve();
      await publication;
    }
  });

  it.each(["registry-reactivation", "gateway-close", "disconnect"] as const)(
    "fences old publications after %s while a replacement request can publish",
    async (retirement) => {
      const releases = [createDeferredCore(), createDeferredCore()];
      const publications: Promise<void>[] = [];
      const connection = new AbortController();
      const gateway = new GatewayRequestEntryLifetime();
      const broadcastToConnIds = vi.fn();
      let producerSignal: AbortSignal | undefined;
      const list = vi.fn<SessionCatalogProvider["list"]>(async (params) => {
        producerSignal = params.signal;
        const publication = releases[publications.length]!.promise.then(() =>
          params.onHost?.({
            hostId: "node:late",
            label: "Late",
            kind: "node",
            connected: true,
            sessions: [],
          }),
        );
        publications.push(publication);
        params.waitUntil?.(publication);
        return [];
      });
      hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
      const config = {};
      const context = createCatalogTestContext(config, {
        broadcastToConnIds,
        requestEntryLifetime: gateway,
      });
      try {
        await call("sessions.catalog.list", { progressId: "original" }, context, {
          connId: "old",
          connectionSignal: connection.signal,
        });
        if (retirement === "registry-reactivation") {
          markPluginRegistryActive(hoisted.activeRegistry as PluginRegistry);
        } else if (retirement === "gateway-close") {
          gateway.beginClose();
        } else {
          connection.abort();
        }
        expect(producerSignal?.aborted).toBe(retirement !== "disconnect");
        const replacementContext =
          retirement === "gateway-close"
            ? createCatalogTestContext(config, { broadcastToConnIds })
            : context;
        await call("sessions.catalog.list", { progressId: "replacement" }, replacementContext, {
          connId: "new",
        });
        releases[0]!.resolve();
        await publications[0];
        expect(broadcastToConnIds).not.toHaveBeenCalled();
        expect(list).toHaveBeenCalledTimes(2);
        releases[1]!.resolve();
        await publications[1];
        expect(broadcastToConnIds).toHaveBeenCalledOnce();
        expect(broadcastToConnIds.mock.calls[0]?.[1]?.progressId).toBe("replacement");
        expect(broadcastToConnIds.mock.calls[0]?.[2]).toEqual(new Set(["new"]));
      } finally {
        gateway.beginClose();
        for (const release of releases) {
          release.resolve();
        }
        await Promise.allSettled(publications);
        await gateway.sealAndJoin();
      }
    },
  );
});
