import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { invalidateSessionCatalogLists } from "./session-catalog-list-lifetime.js";
import { sessionCatalogHandlers } from "./session-catalog.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
// Node added the public SQLite query diagnostic event in 26.8.0.
const supportsQueryDiagnostics = nodeMajor > 26 || (nodeMajor === 26 && nodeMinor >= 8);

it.skipIf(!supportsQueryDiagnostics).each([false, true])(
  "keeps one ordinary native reader while returning a complete three-agent catalog (close fails=%s)",
  async (failsClose) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const previousRegistry = getActivePluginRegistry() ?? createEmptyPluginRegistry();
      const agentIds = ["main", "research", "writer"] as const;
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { main: {}, research: {}, writer: {} },
        },
      };
      const context: Pick<GatewayRequestContext, "getRuntimeConfig" | "broadcastToConnIds"> = {
        getRuntimeConfig: () => config,
        broadcastToConnIds: vi.fn(),
      };
      const agentPaths = new Set<string>();
      const connections = new Set<DatabaseSync>();
      const observedPaths = new Set<string>();
      const queryChannel = channel("sqlite.db.query");
      const rootsBefore = getActiveGatewayRootWorkCount();
      const root = tryBeginGatewayRootWorkAdmission("catalog-retained-readers");
      expect(root).not.toBeNull();
      const openReaders = () => [...connections].filter((database) => database.isOpen).length;
      let peakReaders = 0;
      let readersAtProviderAdmission: number | undefined;
      let pathsAtProviderAdmission: string[] | undefined;
      let planningSessionKeys: string[] | undefined;
      let providerAdmissions = 0;
      let subscriberError: unknown;
      let finalAgentPath: string | undefined;
      let failedDatabase: DatabaseSync | undefined;
      let restoreClose: (() => void) | undefined;
      let closeCalls: (() => number) | undefined;
      let publishLate: ((host: SessionCatalogHost) => void) | undefined;
      let providerSignal: AbortSignal | undefined;
      const onQuery = (message: unknown) => {
        const event = message as { database?: DatabaseSync };
        const database = event.database;
        try {
          if (!database) {
            return;
          }
          if (!connections.has(database)) {
            const location = database.location();
            if (!location) {
              return;
            }
            const canonicalPath = fs.realpathSync(location);
            if (!agentPaths.has(canonicalPath)) {
              return;
            }
            connections.add(database);
            observedPaths.add(canonicalPath);
            if (failsClose && providerAdmissions > 0 && canonicalPath === finalAgentPath) {
              failedDatabase = database;
              const close = vi.spyOn(database, "close").mockImplementationOnce(() => {
                throw new Error("synthetic final catalog close failure");
              });
              restoreClose = () => close.mockRestore();
              closeCalls = () => close.mock.calls.length;
            }
          }
          peakReaders = Math.max(peakReaders, openReaders());
        } catch (error) {
          // Diagnostic subscriber errors otherwise become process errors.
          subscriberError = error;
        }
      };
      try {
        await state.writeConfig(config);
        for (const agentId of agentIds) {
          runOpenClawAgentWriteTransaction(
            (database) => {
              writeSessionEntry(database, `agent:${agentId}:catalog`, {
                sessionId: `${agentId}-thread`,
                updatedAt: 7,
                pluginOwnerId: "fixture",
              });
            },
            { agentId },
          );
          const pathname = resolveOpenClawAgentSqlitePath({ agentId });
          closeOpenClawAgentDatabaseByPath(pathname);
          agentPaths.add(fs.realpathSync(pathname));
          if (agentId === "writer") {
            finalAgentPath = fs.realpathSync(pathname);
          }
        }
        const host: SessionCatalogHost = {
          hostId: "gateway:local",
          label: "Local",
          kind: "gateway",
          connected: true,
          sessions: agentIds.map((agentId) => ({
            threadId: `${agentId}-thread`,
            sessionKey: `agent:${agentId}:catalog`,
            status: "stored",
            archived: false,
            canContinue: false,
            canArchive: false,
          })),
        };
        const registry = createEmptyPluginRegistry();
        registry.sessionCatalogs.push({
          pluginId: "fixture",
          source: import.meta.url,
          provider: {
            id: "fixture",
            label: "Fixture",
            supportsProcessHomeIsolation: true,
            list: async ({ sessionEntries, onHost, signal }) => {
              providerAdmissions += 1;
              publishLate = onHost;
              providerSignal = signal;
              // Snapshot freeze enumerates every agent before the provider starts.
              readersAtProviderAdmission = openReaders();
              pathsAtProviderAdmission = [...observedPaths].toSorted();
              planningSessionKeys = sessionEntries
                ?.entriesForCatalog?.()
                .map(({ sessionKey }) => sessionKey)
                .toSorted();
              return [structuredClone(host)];
            },
            read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
          },
        });
        setActivePluginRegistry(registry);
        const client = {
          connId: "catalog-readers",
          connect: { scopes: ["operator.admin", "operator.read"] },
        } as GatewayClient;
        const respond = vi.fn();
        queryChannel.subscribe(onQuery);
        try {
          await root!.run(async () =>
            withPluginRuntimeGatewayRequestScope(
              { client, pluginRegistry: registry, isWebchatConnect: () => false },
              () =>
                sessionCatalogHandlers["sessions.catalog.list"]?.({
                  params: { agentId: "main", catalogId: "fixture", progressId: "close-retry" },
                  client,
                  context,
                  respond,
                } as never),
            ),
          );
        } finally {
          root!.release();
        }

        expect(subscriberError).toBeUndefined();
        expect(providerAdmissions).toBe(1);
        expect(planningSessionKeys).toEqual(
          agentIds.map((agentId) => `agent:${agentId}:catalog`).toSorted(),
        );
        expect(pathsAtProviderAdmission).toEqual([...agentPaths].toSorted());
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
          catalogs: [
            {
              id: "fixture",
              label: "Fixture",
              capabilities: { continueSession: false, archive: false },
              hosts: [host],
            },
          ],
        });
        if (failsClose) {
          expect(getActiveGatewayRootWorkCount()).toBe(rootsBefore);
          expect(failedDatabase?.isOpen).toBe(true);
          expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
          expect(providerSignal?.aborted).toBe(true);
          publishLate?.(host);
          expect(context.broadcastToConnIds).not.toHaveBeenCalled();

          await closeOpenClawAgentDatabaseByPathAsync(finalAgentPath!);
          expect(failedDatabase?.isOpen).toBe(false);
          expect(closeCalls?.()).toBe(2);
          publishLate?.(host);
          expect(context.broadcastToConnIds).not.toHaveBeenCalled();
        }
        expect(openReaders()).toBe(0);
        expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
        expect(getActiveGatewayRootWorkCount()).toBe(rootsBefore);
        expect({ readersAtProviderAdmission, peakReaders }).toEqual({
          readersAtProviderAdmission: 1,
          peakReaders: 1,
        });
      } finally {
        queryChannel.unsubscribe(onQuery);
        restoreClose?.();
        invalidateSessionCatalogLists(context as GatewayRequestContext);
        root?.release();
        setActivePluginRegistry(previousRegistry);
        try {
          for (const pathname of agentPaths) {
            await closeOpenClawAgentDatabaseByPathAsync(pathname);
          }
        } finally {
          for (const database of connections) {
            if (database.isOpen) {
              database.close();
            }
          }
        }
      }
    });
  },
);

it.skipIf(!supportsQueryDiagnostics).each([false, true])(
  "preserves archive success and retires every listing when a retained native close fails (reload=%s)",
  async (reloadConfig) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const previousRegistry = getActivePluginRegistry() ?? createEmptyPluginRegistry();
      const config: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {} } },
      };
      let currentConfig = config;
      const context: Pick<GatewayRequestContext, "getRuntimeConfig" | "broadcastToConnIds"> = {
        getRuntimeConfig: () => currentConfig,
        broadcastToConnIds: vi.fn(),
      };
      const late = createDeferredCore();
      const publications: Promise<void>[] = [];
      const signals: Array<AbortSignal | undefined> = [];
      const connections = new Set<DatabaseSync>();
      const queryChannel = channel("sqlite.db.query");
      const rootsBefore = getActiveGatewayRootWorkCount();
      let pathname: string | undefined;
      let subscriberError: unknown;
      let restoreClose: (() => void) | undefined;
      const onQuery = (message: unknown) => {
        const database = (message as { database?: DatabaseSync }).database;
        try {
          const location = database?.location();
          if (database && location && fs.realpathSync(location) === pathname) {
            connections.add(database);
          }
        } catch (error) {
          subscriberError = error;
        }
      };
      try {
        await state.writeConfig(config);
        runOpenClawAgentWriteTransaction(
          (database) => {
            writeSessionEntry(database, "agent:main:catalog", {
              sessionId: "archive-thread",
              updatedAt: 7,
              pluginOwnerId: "fixture",
            });
          },
          { agentId: "main" },
        );
        pathname = resolveOpenClawAgentSqlitePath({ agentId: "main" });
        closeOpenClawAgentDatabaseByPath(pathname);
        pathname = fs.realpathSync(pathname);
        const host: SessionCatalogHost = {
          hostId: "gateway:local",
          label: "Local",
          kind: "gateway",
          connected: true,
          sessions: [
            {
              threadId: "archive-thread",
              status: "stored",
              archived: false,
              canContinue: false,
              canArchive: true,
            },
          ],
        };
        let archived = false;
        const archive = vi.fn(async () => {
          archived = true;
          return { ok: true as const };
        });
        const registry = createEmptyPluginRegistry();
        registry.sessionCatalogs.push({
          pluginId: "fixture",
          source: import.meta.url,
          provider: {
            id: "fixture",
            label: "Fixture",
            supportsProcessHomeIsolation: true,
            list: async ({ onHost, signal, waitUntil }) => {
              const result = { ...host, sessions: archived ? [] : host.sessions };
              if (waitUntil) {
                signals.push(signal);
                const publication = late.promise.then(() => onHost?.(result));
                publications.push(publication);
                waitUntil(publication);
              }
              return [result];
            },
            read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
            archive,
          },
        });
        setActivePluginRegistry(registry);
        const call = async (
          method: "sessions.catalog.list" | "sessions.catalog.archive",
          params: Record<string, unknown>,
          connId: string,
        ) => {
          const client = {
            connId,
            connect: { scopes: ["operator.admin", "operator.read"] },
          } as GatewayClient;
          const root = tryBeginGatewayRootWorkAdmission("catalog-close-archive");
          expect(root).not.toBeNull();
          const respond = vi.fn();
          try {
            await root!.run(async () =>
              withPluginRuntimeGatewayRequestScope(
                { client, pluginRegistry: registry, isWebchatConnect: () => false },
                () =>
                  sessionCatalogHandlers[method]?.({ params, client, context, respond } as never),
              ),
            );
            return respond;
          } finally {
            root!.release();
          }
        };
        queryChannel.subscribe(onQuery);
        for (const connId of ["first", "second"]) {
          expect(
            await call(
              "sessions.catalog.list",
              { agentId: "main", catalogId: "fixture", progressId: connId },
              connId,
            ),
          ).toHaveBeenCalledExactlyOnceWith(true, {
            catalogs: [expect.objectContaining({ hosts: [host] })],
          });
        }
        const readers = [...connections].filter((database) => database.isOpen);
        expect(readers).toHaveLength(2);
        expect(getActiveGatewayRootWorkCount()).toBe(rootsBefore + 2);
        if (reloadConfig) {
          currentConfig = structuredClone(config);
        }
        const failedDatabase = readers[0]!;
        const close = vi.spyOn(failedDatabase, "close").mockImplementationOnce(() => {
          throw new Error("synthetic archive reader close failure");
        });
        restoreClose = () => close.mockRestore();

        const response = await call(
          "sessions.catalog.archive",
          {
            catalogId: "fixture",
            hostId: host.hostId,
            threadId: "archive-thread",
            confirmNoOtherRunner: true,
          },
          "archiver",
        );
        expect(archive).toHaveBeenCalledOnce();
        expect(response).toHaveBeenCalledExactlyOnceWith(true, { ok: true });
        expect(signals).toHaveLength(2);
        expect(signals.every((signal) => signal?.aborted)).toBe(true);
        expect(failedDatabase.isOpen).toBe(true);
        expect(readers[1]!.isOpen).toBe(false);
        expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
        expect(getActiveGatewayRootWorkCount()).toBe(rootsBefore + 2);
        late.resolve();
        await Promise.all(publications);
        expect(context.broadcastToConnIds).not.toHaveBeenCalled();
        expect(getActiveGatewayRootWorkCount()).toBe(rootsBefore);

        await closeOpenClawAgentDatabaseByPathAsync(pathname);
        expect(failedDatabase.isOpen).toBe(false);
        expect(close).toHaveBeenCalledTimes(2);
        expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
        expect(subscriberError).toBeUndefined();
      } finally {
        queryChannel.unsubscribe(onQuery);
        restoreClose?.();
        invalidateSessionCatalogLists(context as GatewayRequestContext);
        late.resolve();
        await Promise.allSettled(publications);
        setActivePluginRegistry(previousRegistry);
        if (pathname) {
          await closeOpenClawAgentDatabaseByPathAsync(pathname);
        }
        for (const database of connections) {
          if (database.isOpen) {
            database.close();
          }
        }
      }
    });
  },
);
