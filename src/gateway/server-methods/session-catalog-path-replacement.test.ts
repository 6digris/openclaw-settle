import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import { listSessionEntriesReadOnly } from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionCatalogHandlers } from "./session-catalog.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
// Node added the public SQLite query diagnostic event in 26.8.0.
const supportsQueryDiagnostics = nodeMajor > 26 || (nodeMajor === 26 && nodeMinor >= 8);

it.skipIf(!supportsQueryDiagnostics)(
  "rejects stale final catalog rows when the database path changes during the final native stamp",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const previousRegistry = getActivePluginRegistry() ?? createEmptyPluginRegistry();
      const queryChannel = channel("sqlite.db.query");
      const connections = new Set<DatabaseSync>();
      const canonicalPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const canonicalDirectory = path.dirname(canonicalPath);
      const originalDirectory = state.path("original");
      const replacementDirectory = state.path("replacement");
      const originalPath = path.join(originalDirectory, path.basename(canonicalPath));
      const replacementPath = path.join(replacementDirectory, path.basename(canonicalPath));
      let finalDelivery = false;
      let stampQueries = 0;
      let replaced = false;
      let nativeOpenDuringReplacement: boolean | undefined;
      let subscriberError: unknown;
      const onQuery = (message: unknown) => {
        const event = message as { database?: DatabaseSync; sql?: string };
        const database = event.database;
        try {
          const location = database?.location();
          if (!database || !location || fs.realpathSync(location) !== originalPath) {
            return;
          }
          connections.add(database);
          if (!finalDelivery || replaced || event.sql !== "PRAGMA data_version") {
            return;
          }
          // Row-cache validation also reads data_version. Target only the retained
          // connection's second stamp, after its row operation has finished.
          if (!new Error().stack?.includes("readStamp")) {
            return;
          }
          stampQueries += 1;
          if (stampQueries === 2) {
            fs.rmSync(canonicalDirectory, { recursive: true });
            fs.symlinkSync(replacementDirectory, canonicalDirectory, "junction");
            replaced = true;
            nativeOpenDuringReplacement = database.isOpen;
          }
        } catch (error) {
          // Native diagnostic subscriber errors otherwise become process errors.
          subscriberError = error;
        }
      };
      try {
        const caller = ensureProfileForEmail("catalog-caller@example.test");
        const other = ensureProfileForEmail("catalog-other@example.test");
        const config: OpenClawConfig = {
          agents: { ownership: "explicit", entries: { main: {} } },
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
        await state.writeConfig(config);
        const sessionKey = "agent:main:foreign";
        for (const [filename, visibility] of [
          [originalPath, "shared"],
          [replacementPath, "draft"],
        ] as const) {
          runOpenClawAgentWriteTransaction(
            (database) => {
              writeSessionEntry(database, sessionKey, {
                sessionId: "foreign-session",
                updatedAt: 7,
                visibility,
                pluginOwnerId: "fixture",
                createdVia: "operator",
                createdActor: { type: "human", source: "profile", id: other.id },
              });
            },
            { agentId: "main", path: filename },
          );
          closeOpenClawAgentDatabaseByPath(filename);
        }
        fs.mkdirSync(path.dirname(canonicalDirectory), { recursive: true });
        fs.symlinkSync(originalDirectory, canonicalDirectory, "junction");
        const originalInode = fs.statSync(canonicalPath, { bigint: true }).ino;
        const host: SessionCatalogHost = {
          hostId: "gateway:local",
          label: "Local",
          kind: "gateway",
          connected: true,
          sessions: [
            {
              threadId: "foreign-session",
              sessionKey,
              status: "stored",
              archived: false,
              canContinue: false,
              canArchive: false,
            },
          ],
        };
        const registry = createEmptyPluginRegistry();
        registry.sessionCatalogs.push({
          pluginId: "fixture",
          source: import.meta.url,
          provider: {
            id: "fixture",
            label: "Fixture",
            supportsProcessHomeIsolation: true,
            list: async () => {
              finalDelivery = true;
              return [host];
            },
            read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
          },
        });
        setActivePluginRegistry(registry);
        const client = {
          connId: caller.id,
          connect: { scopes: ["operator.read", "operator.write"] },
          authenticatedUserProfile: { profileId: caller.id },
        } as GatewayClient;
        const context = {
          getRuntimeConfig: () => config,
          broadcastToConnIds: vi.fn(),
        } satisfies Pick<GatewayRequestContext, "getRuntimeConfig" | "broadcastToConnIds">;
        const call = (search: string, respond: ReturnType<typeof vi.fn>) =>
          Promise.resolve(
            withPluginRuntimeGatewayRequestScope(
              { client, pluginRegistry: registry, isWebchatConnect: () => false },
              () =>
                sessionCatalogHandlers["sessions.catalog.list"]?.({
                  params: { agentId: "main", search },
                  client,
                  context,
                  respond,
                } as never),
            ),
          );
        const currentResponse = vi.fn();
        await call("before-replacement", currentResponse);
        expect(currentResponse.mock.calls[0]?.[0]).toBe(true);
        expect(currentResponse.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([
          expect.objectContaining({ sessionKey }),
        ]);

        finalDelivery = false;
        queryChannel.subscribe(onQuery);
        const interruptedResponse = vi.fn();
        let readError: unknown;
        try {
          await call("during-replacement", interruptedResponse);
        } catch (error) {
          readError = error;
        } finally {
          queryChannel.unsubscribe(onQuery);
        }
        const freshResponse = vi.fn();
        await call("during-replacement", freshResponse);

        expect(subscriberError).toBeUndefined();
        expect(stampQueries).toBe(2);
        expect(replaced).toBe(true);
        expect(nativeOpenDuringReplacement).toBe(true);
        expect(fs.statSync(canonicalPath, { bigint: true }).ino).not.toBe(originalInode);
        expect(listSessionEntriesReadOnly({ agentId: "main", projection: "list" })).toEqual([
          expect.objectContaining({
            sessionKey,
            entry: expect.objectContaining({ sessionId: "foreign-session", visibility: "draft" }),
          }),
        ]);
        expect(freshResponse.mock.calls[0]?.[0]).toBe(true);
        expect(freshResponse.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([]);
        expect(connections.size).toBeGreaterThan(0);
        expect([...connections].every((database) => !database.isOpen)).toBe(true);
        expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
        expect(interruptedResponse).not.toHaveBeenCalled();
        expect(readError).toMatchObject({ message: expect.stringMatching(/path changed during/u) });
      } finally {
        queryChannel.unsubscribe(onQuery);
        setActivePluginRegistry(previousRegistry);
        try {
          for (const filename of [canonicalPath, originalPath, replacementPath]) {
            await closeOpenClawAgentDatabaseByPathAsync(filename);
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
