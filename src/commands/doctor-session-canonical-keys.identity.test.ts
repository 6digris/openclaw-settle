import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lookupSessionGoalOperation,
  writeSessionGoalOperationReceipt,
} from "../config/sessions/goals-operations.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  loadSessionEntryReadOnly,
  loadExactSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { ensureSessionGoalOperationsSchema } from "../state/openclaw-agent-goal-operations-schema.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnvAsync } from "../test-utils/env.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";
import {
  preflightCanonicalSessionKeys,
  repairCanonicalSessionKeys,
} from "./doctor-session-canonical-keys.js";
import {
  insertLegacySession,
  openSessionDatabase,
} from "./doctor-session-canonical-keys.test-support.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";
import { doctorCommand } from "./doctor.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("doctor canonical session-key repair", () => {
  it("keeps an explicit SQLite inspection scoped away from configured collisions", async () => {
    await withStateDirEnv("openclaw-targeted-doctor-preflight-", async ({ stateDir, tempRoot }) => {
      const configPath = path.join(tempRoot, "openclaw.json");
      await withEnvAsync(
        { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_UPDATE_IN_PROGRESS: undefined },
        async () => {
          const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
          const storePath = path.join(stateDir, "configured.sqlite");
          const targetPath = path.join(stateDir, "inspect.sqlite");
          const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
          fs.writeFileSync(configPath, JSON.stringify(cfg));
          for (const [sessionKey, sessionId] of [
            ["global", "legacy"],
            ["agent:main:global", "qualified"],
          ] as const) {
            insertLegacySession({
              agentId: "main",
              env,
              storePath,
              sessionKey,
              entry: { sessionId, updatedAt: 1 },
            });
          }
          const configured = openSessionDatabase("main", env, storePath);
          configured.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();
          const before = configured.db
            .prepare("SELECT * FROM session_nodes ORDER BY session_key")
            .all();
          replaceSessionEntrySync(
            { agentId: "main", env, storePath: targetPath, sessionKey: "agent:main:inspect" },
            { sessionId: "inspect", updatedAt: 1 },
          );
          await expect(prepareDoctorDatabasePreflight()).rejects.toThrow(
            /session identity conflict/,
          );
          const runtime = {
            log: vi.fn<RuntimeEnv["log"]>(),
            error: vi.fn(),
            exit: vi.fn(),
          };
          await expect(
            doctorCommand(runtime, {
              sessionSqlite: "inspect",
              sessionSqliteStore: targetPath,
              json: true,
            }),
          ).rejects.toMatchObject({ code: 0 });
          expect(runtime.exit).toHaveBeenCalledWith(0);
          expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toMatchObject({
            mode: "inspect",
            targets: [{ storePath: targetPath, sqliteEntries: 1 }],
          });
          expect(
            configured.db.prepare("SELECT * FROM session_nodes ORDER BY session_key").all(),
          ).toEqual(before);
        },
      );
    });
  });

  it("moves a legacy global heartbeat sibling to its agent-qualified key", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-global-heartbeat-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "historian2", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "historian2" }] },
        session: { scope: "global", store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "historian2",
        entry: {
          heartbeatIsolatedBaseSessionKey: "global",
          lastHeartbeatText: "legacy heartbeat",
          sessionId: "heartbeat-session",
          updatedAt: 10,
        },
        env,
        sessionKey: "global:heartbeat",
        storePath,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "historian2",
          env,
          sessionKey: "agent:historian2:global:heartbeat",
          storePath,
        })?.entry,
      ).toMatchObject({
        heartbeatIsolatedBaseSessionKey: "agent:historian2:global",
        lastHeartbeatText: "legacy heartbeat",
        sessionId: "heartbeat-session",
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "historian2",
          env,
          sessionKey: "global:heartbeat",
          storePath,
        }),
      ).toBeUndefined();
    });
  });

  it.each(["global", "unknown"])(
    "qualifies legacy %s rows without mixing agent history or receipts",
    async (alias) => {
      await withStateDirEnv("openclaw-doctor-canonical-sentinels-", async ({ stateDir }) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
        const cfg = {
          agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
          session: { store: storeTemplate },
        } as OpenClawConfig;
        const operation = {
          action: "clear" as const,
          operationId: "clear-goal",
          goalId: "saved-goal",
          issuedAtMs: Date.now(),
          requestFingerprint: "clear-goal",
        };
        for (const agentId of ["main", "ops"]) {
          const storePath = resolveSessionStorePathCore(storeTemplate, { agentId, env });
          insertLegacySession({
            agentId,
            env,
            sessionKey: alias,
            storePath,
            eventText: `${agentId} history`,
            entry: { sessionId: `${agentId}-${alias}`, updatedAt: 10 },
          });
          const database = openSessionDatabase(agentId, env, storePath);
          ensureSessionGoalOperationsSchema(database.db);
          writeSessionGoalOperationReceipt(
            database.db,
            alias,
            `${agentId}-${alias}`,
            operation,
            undefined,
          );
        }
        expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
          foundGroups: 2,
          repairedGroups: 2,
        });
        for (const agentId of ["main", "ops"]) {
          const storePath = resolveSessionStorePathCore(storeTemplate, { agentId, env });
          const scope = { agentId, env, storePath, sessionKey: `agent:${agentId}:${alias}` };
          expect(loadExactSessionEntryReadOnly(scope)?.entry.sessionId).toBe(`${agentId}-${alias}`);
          await expect(
            loadTranscriptEvents({ ...scope, sessionId: `${agentId}-${alias}` }),
          ).resolves.toEqual([
            expect.objectContaining({
              message: expect.objectContaining({ content: `${agentId} history` }),
            }),
          ]);
          expect(
            lookupSessionGoalOperation({
              ...scope,
              expectedSessionId: `${agentId}-${alias}`,
              operation,
            }),
          ).toMatchObject({
            status: "cleared",
            sessionId: `${agentId}-${alias}`,
            operationId: operation.operationId,
          });
          const database = openSessionDatabase(agentId, env, storePath);
          expect(
            database.db
              .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
              .get(alias),
          ).toBeUndefined();
          expect(
            database.db.prepare("SELECT session_key FROM session_goal_operations").all(),
          ).toEqual([{ session_key: scope.sessionKey }]);
        }
        expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
          foundGroups: 0,
          repairedGroups: 0,
        });
      });
    },
  );

  it.each([true, false])(
    "qualifies a shared store alias only with its persisted owner (configured=%s)",
    async (configured) => {
      await withStateDirEnv("openclaw-doctor-canonical-fixed-sentinel-", async ({ stateDir }) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const storePath = path.join(stateDir, "shared.sqlite");
        const cfg = {
          agents: {
            ...(configured ? { defaults: { sessionStore: { agentId: "ops" } } } : {}),
            list: [{ id: "main", default: true }, { id: "ops" }],
          },
          session: { store: storePath },
        } as OpenClawConfig;
        insertLegacySession({
          agentId: "ops",
          env,
          sessionKey: "global",
          storePath,
          entry: { sessionId: "owned-global", updatedAt: 10 },
          eventText: "owned history",
        });
        if (!configured) {
          await expect(repairCanonicalSessionKeys({ apply: true, cfg, env })).rejects.toThrow(
            "explicit agents.defaults.sessionStore.agentId owner",
          );
          expect(
            openSessionDatabase("ops", env, storePath)
              .db.prepare("SELECT session_key FROM session_nodes")
              .all(),
          ).toEqual([{ session_key: "global" }]);
          return;
        }
        expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
          foundGroups: 1,
          repairedGroups: 1,
        });
        expect(
          loadExactSessionEntryReadOnly({
            agentId: "ops",
            env,
            storePath,
            sessionKey: "agent:ops:global",
          })?.entry.sessionId,
        ).toBe("owned-global");
        expect(
          openSessionDatabase("ops", env, storePath)
            .db.prepare("SELECT session_key FROM session_nodes")
            .all(),
        ).toEqual([{ session_key: "agent:ops:global" }]);
      });
    },
  );

  it.each(["global", "unknown"])(
    "repairs legacy %s aliases proven to share one physical generation",
    async (alias) => {
      await withStateDirEnv("openclaw-doctor-canonical-same-generation-", async ({ stateDir }) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const storePath = path.join(stateDir, "agent.sqlite");
        const canonicalKey = `agent:main:${alias}`;
        const entry = { sessionId: "shared-generation", updatedAt: 10 };
        const cfg = {
          agents: { list: [{ id: "main", default: true }] },
          session: { store: storePath },
        } as OpenClawConfig;
        insertLegacySession({
          agentId: "main",
          env,
          storePath,
          sessionKey: alias,
          entry,
          eventText: "shared history",
        });
        const database = openSessionDatabase("main", env, storePath);
        database.db
          .prepare(
            "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run(canonicalKey, entry.sessionId, JSON.stringify(entry), entry.updatedAt);
        database.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();
        expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
          foundGroups: 1,
          repairedGroups: 1,
        });
        const scope = { agentId: "main", env, storePath, sessionKey: canonicalKey };
        expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe(entry.sessionId);
        await expect(
          loadTranscriptEvents({ ...scope, sessionId: entry.sessionId }),
        ).resolves.toEqual([
          expect.objectContaining({
            message: expect.objectContaining({ content: "shared history" }),
          }),
        ]);
        expect(database.db.prepare("SELECT session_key FROM session_nodes").all()).toEqual([
          { session_key: canonicalKey },
        ]);
      });
    },
  );

  it.each([
    ["global", false],
    ["unknown", false],
    ["global", true],
  ] as const)(
    "refuses a distinct legacy %s collision before changing any stored state (promoted=%s)",
    async (alias, promoted) => {
      await withStateDirEnv("openclaw-doctor-canonical-collision-", async ({ stateDir }) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const storePath = path.join(stateDir, "agent.sqlite");
        const canonicalKey = `agent:main:${alias}`;
        const cfg = {
          agents: { list: [{ id: "main", default: true }] },
          session: { store: storePath, mainKey: "work" },
        } as OpenClawConfig;
        for (const [sessionKey, sessionId] of [
          [alias, "legacy-history"],
          [canonicalKey, "qualified-history"],
        ] as const) {
          insertLegacySession({
            agentId: "main",
            env,
            storePath,
            sessionKey,
            entry: { sessionId, updatedAt: sessionKey === alias ? 20 : 10 },
            eventText: sessionId,
          });
        }
        insertLegacySession({
          agentId: "main",
          env,
          storePath,
          sessionKey: "agent:main:child",
          entry: { sessionId: "child-history", updatedAt: 30, parentSessionKey: canonicalKey },
        });
        const database = openSessionDatabase("main", env, storePath);
        database.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();
        ensureSessionGoalOperationsSchema(database.db);
        for (const [sessionKey, sessionId] of [
          [alias, "legacy-history"],
          [canonicalKey, "qualified-history"],
        ] as const) {
          writeSessionGoalOperationReceipt(
            database.db,
            sessionKey,
            sessionId,
            {
              action: "clear",
              operationId: "retained-receipt",
              goalId: `${sessionId}-goal`,
              issuedAtMs: Date.now(),
              requestFingerprint: sessionId,
            },
            undefined,
          );
        }
        if (promoted) {
          database.db
            .prepare(
              "UPDATE session_nodes SET entry_json = '{', entry_valid = 0 WHERE session_key = ?",
            )
            .run(alias);
        }
        const snapshot = () =>
          database.db
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
            .all()
            .map(({ name }) => [
              name,
              database.db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all(),
            ]);
        const before = snapshot();
        const changes = database.db.prepare("SELECT total_changes() AS count").get();
        await expect(preflightCanonicalSessionKeys({ cfg, env })).rejects.toThrow(
          /session identity conflict/,
        );
        expect(snapshot()).toEqual(before);
        expect(database.db.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
        for (const apply of [false, true]) {
          await expect(repairCanonicalSessionKeys({ apply, cfg, env })).rejects.toThrow(
            /session identity conflict/,
          );
          expect(snapshot()).toEqual(before);
          expect(database.db.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
        }
        await expect(noteSessionTranscriptHealth({ cfg, env, shouldRepair: true })).rejects.toThrow(
          /session identity conflict/,
        );
        expect(snapshot()).toEqual(before);
        expect(database.db.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
        expect(() =>
          loadSessionEntryReadOnly({ agentId: "main", env, storePath, sessionKey: canonicalKey }),
        ).toThrow("openclaw doctor --fix");
        expect(snapshot()).toEqual(before);
      });
    },
  );

  it("preflights current-store collisions before full Doctor's retired-agent repair", async () => {
    await withStateDirEnv("openclaw-doctor-current-preflight-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storePath = path.join(stateDir, "agent.sqlite");
      const cfg = {
        agents: {
          entries: { ops: { default: true } },
          defaults: { sessionStore: { agentId: "ops" } },
        },
        session: { store: storePath },
      } as OpenClawConfig;
      for (const [sessionKey, sessionId] of [
        ["global", "raw-global"],
        ["agent:ops:global", "qualified-global"],
        ["agent:main:legacy", "retired-owner-history"],
      ] as const) {
        insertLegacySession({
          agentId: "ops",
          env,
          storePath,
          sessionKey,
          entry: { sessionId, updatedAt: 10 },
          eventText: sessionId,
        });
      }
      const database = openSessionDatabase("ops", env, storePath);
      database.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();
      const snapshot = () =>
        database.db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
          .all()
          .map(({ name }) => [
            name,
            database.db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all(),
          ]);
      const before = snapshot();
      const changes = database.db.prepare("SELECT total_changes() AS count").get();
      await expect(noteSessionTranscriptHealth({ cfg, env, shouldRepair: true })).rejects.toThrow(
        /session identity conflict/,
      );
      expect(snapshot()).toEqual(before);
      expect(database.db.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
    });
  });

  it("inspects older stores without changing schema versions or rows", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-old-preflight-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storePath = path.join(stateDir, "agent.sqlite");
      const database = openSessionDatabase("main", env, storePath);
      database.db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1}`);
      database.db
        .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
        .run(OPENCLAW_AGENT_SCHEMA_VERSION - 1);
      const before = database.db.prepare("SELECT total_changes() AS count").get();
      await expect(
        preflightCanonicalSessionKeys({
          cfg: { agents: { entries: { main: {} } }, session: { store: storePath } },
          env,
        }),
      ).resolves.toBeUndefined();
      expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION - 1,
      });
      expect(database.db.prepare("SELECT total_changes() AS count").get()).toEqual(before);
    });
  });

  it.each([false, true])(
    "preserves retained placeholder ownership during collision preflight (owner evidence=%s)",
    async (ownerEvidence) => {
      await withStateDirEnv("openclaw-canonical-placeholder-preflight-", async ({ stateDir }) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const storePath = path.join(stateDir, "agent.sqlite");
        const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
        for (const [sessionKey, sessionId] of [
          ["global", "retained-history"],
          ["agent:main:global", "qualified-history"],
        ] as const) {
          insertLegacySession({
            agentId: "main",
            env,
            storePath,
            sessionKey,
            entry: { sessionId, updatedAt: 10 },
            eventText: sessionId,
          });
        }
        const { db } = openSessionDatabase("main", env, storePath);
        db.prepare("UPDATE session_nodes SET entry_valid = 1").run();
        db.prepare(
          "UPDATE session_nodes SET entry_json = '{}', entry_valid = -1 WHERE session_key = 'global'",
        ).run();
        if (ownerEvidence) {
          db.prepare(
            "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 10)",
          ).run(
            "agent:main:owner",
            "retained-history",
            JSON.stringify({ sessionId: "retained-history", updatedAt: 10 }),
          );
          db.prepare(
            "UPDATE session_nodes SET entry_valid = 1 WHERE session_key = 'agent:main:owner'",
          ).run();
          db.prepare(
            "UPDATE session_windows SET session_key = 'agent:main:owner' WHERE session_id = 'retained-history'",
          ).run();
        }
        const before = db.prepare("SELECT * FROM session_nodes ORDER BY session_key").all();
        await expect(preflightCanonicalSessionKeys({ cfg, env })).resolves.toBeUndefined();
        await expect(repairCanonicalSessionKeys({ apply: false, cfg, env })).resolves.toMatchObject(
          {
            foundGroups: ownerEvidence ? 1 : 0,
          },
        );
        expect(db.prepare("SELECT * FROM session_nodes ORDER BY session_key").all()).toEqual(
          before,
        );
      });
    },
  );

  it.each(
    [false, true].flatMap((collision) =>
      [false, true].map((registered) => ({ collision, registered })),
    ),
  )(
    "preflights a logical JSON store (collision=$collision, registered=$registered)",
    async ({ collision, registered }) => {
      await withStateDirEnv("openclaw-canonical-json-preflight-", async ({ stateDir }) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const storePath = path.join(stateDir, "fixed", "sessions.json");
        const sqlitePath = path.join(stateDir, "fixed", "openclaw-agent.sqlite");
        const cfg: OpenClawConfig = {
          agents: {
            entries: { main: {}, ops: {} },
            defaults: { sessionStore: { agentId: "ops" } },
          },
          session: { store: storePath },
        };
        const { db } = openOpenClawAgentDatabase({ agentId: "ops", env, path: sqlitePath });
        for (const [sessionKey, sessionId] of [
          ["global", "legacy-history"],
          [`agent:${collision ? "ops" : "main"}:global`, "qualified-history"],
        ] as const) {
          insertLegacySession({
            agentId: "ops",
            env,
            storePath,
            sessionKey,
            entry: { sessionId, updatedAt: 10 },
            eventText: sessionId,
          });
        }
        db.prepare("UPDATE session_nodes SET entry_valid = 1").run();
        if (!registered) {
          unregisterOpenClawAgentDatabase({ agentId: "ops", env, path: sqlitePath });
        }
        const before = db.prepare("SELECT * FROM session_nodes ORDER BY session_key").all();
        const preflight = prepareDoctorDatabasePreflight({ cfg });
        if (collision) {
          await expect(preflight).rejects.toThrow(/identity conflict.*agent:ops:global/);
        } else {
          await expect(preflight).resolves.toMatchObject({ incompatible: [] });
        }
        expect(db.prepare("SELECT * FROM session_nodes ORDER BY session_key").all()).toEqual(
          before,
        );
      });
    },
  );

  it("preserves qualified session and lineage identities after routing configuration changes", async () => {
    await withStateDirEnv("openclaw-doctor-qualified-routing-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storePath = path.join(stateDir, "agent.sqlite");
      for (const key of ["agent:main:main", "agent:main:custom"]) {
        replaceSessionEntrySync(
          { agentId: "main", env, storePath, sessionKey: key },
          { sessionId: key.endsWith(":main") ? "original-main" : "original-custom", updatedAt: 10 },
        );
      }
      replaceSessionEntrySync(
        { agentId: "main", env, storePath, sessionKey: "agent:main:child" },
        {
          sessionId: "qualified-child",
          updatedAt: 10,
          parentSessionKey: "agent:main:main",
          spawnedBy: "agent:main:custom",
        },
      );
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storePath, mainKey: "custom", scope: "global" },
      } as OpenClawConfig;
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
      const scope = { agentId: "main", env, storePath };
      expect(loadSessionEntryReadOnly({ ...scope, sessionKey: "agent:main:main" })?.sessionId).toBe(
        "original-main",
      );
      expect(
        loadSessionEntryReadOnly({ ...scope, sessionKey: "agent:main:custom" })?.sessionId,
      ).toBe("original-custom");
      expect(loadSessionEntryReadOnly({ ...scope, sessionKey: "agent:main:child" })).toMatchObject({
        parentSessionKey: "agent:main:main",
        spawnedBy: "agent:main:custom",
      });
    });
  });

  it.each([false, true])(
    "resolves bare lineage from its physical store owner for a foreign child (shared=%s)",
    async (shared) => {
      await withStateDirEnv("openclaw-doctor-physical-lineage-", async ({ stateDir }) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const store = path.join(stateDir, shared ? "shared.sqlite" : "{agentId}.sqlite");
        const sourceStore = resolveSessionStorePathCore(store, { agentId: "ops", env });
        const destinationStore = resolveSessionStorePathCore(store, { agentId: "research", env });
        const cfg = {
          agents: {
            entries: { ops: { default: true }, research: {} },
            ...(shared ? { defaults: { sessionStore: { agentId: "ops" } } } : {}),
          },
          session: { store, scope: "global" },
        } as OpenClawConfig;
        for (const [sessionKey, sessionId] of [
          ["global", "ops-parent"],
          ["agent:research:global", "research-parent"],
        ] as const) {
          insertLegacySession({
            agentId: "ops",
            env,
            storePath: sourceStore,
            sessionKey,
            entry: { sessionId, updatedAt: 10 },
            eventText: sessionId,
          });
        }
        for (const [name, parentSessionKey, parentSessionId] of [
          ["raw", "global", "ops-parent"],
          ["qualified", "agent:research:global", "research-parent"],
        ] as const) {
          insertLegacySession({
            agentId: "ops",
            env,
            storePath: sourceStore,
            sessionKey: `agent:research:${name}-child`,
            entry: {
              sessionId: `${name}-child`,
              updatedAt: 20,
              parentSessionKey,
              parentSessionId,
              spawnedBy: parentSessionKey,
              heartbeatIsolatedBaseSessionKey: parentSessionKey,
              forkSource: {
                sessionKey: parentSessionKey,
                sessionId: parentSessionId,
                entryId: "fork-entry",
              },
            },
          });
        }
        await repairCanonicalSessionKeys({ apply: true, cfg, env });
        for (const [name, parentSessionKey, parentSessionId] of [
          ["raw", "agent:ops:global", "ops-parent"],
          ["qualified", "agent:research:global", "research-parent"],
        ] as const) {
          expect(
            loadSessionEntryReadOnly({
              agentId: "research",
              env,
              storePath: destinationStore,
              sessionKey: `agent:research:${name}-child`,
            }),
          ).toMatchObject({
            parentSessionKey,
            parentSessionId,
            spawnedBy: parentSessionKey,
            heartbeatIsolatedBaseSessionKey: parentSessionKey,
            forkSource: {
              sessionKey: parentSessionKey,
              sessionId: parentSessionId,
              entryId: "fork-entry",
            },
          });
        }
      });
    },
  );
});
