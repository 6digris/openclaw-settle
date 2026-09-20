import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateDoctorSessionGroups } from "../commands/doctor-session-groups.js";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import * as stateDatabase from "../state/openclaw-state-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { sessionGroupSectionOrderKey } from "../state/session-group-ownership.js";
import {
  deleteSessionGroup,
  ensureSessionGroupRegistered,
  listSessionGroupDefaults,
  listSidebarSectionOrder,
  listSessionGroups,
  putSessionGroups,
  renameSessionGroup,
  resolveSessionGroupMutationTargetsByName,
  SessionGroupNotEmptyError,
  updateSessionGroupDefaults,
} from "./session-groups.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

describe("session groups catalog", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const cfg = {} as OpenClawConfig;

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-session-groups-"));
    env = {
      ...process.env,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    await migrateDoctorSessionGroups(cfg, env);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seedSessionStore(
    entries: Record<string, SessionEntry>,
    agentId = "main",
  ): Promise<string> {
    const storePath = path.join(root, "agents", agentId, "sessions", "sessions.json");
    for (const [sessionKey, entry] of Object.entries(entries)) {
      await replaceSessionEntry({ agentId, storePath, sessionKey }, entry);
    }
    return storePath;
  }

  it("replaces the ordered catalog with deduped trimmed names", () => {
    expect(listSessionGroups("main", env)).toEqual([]);
    const groups = putSessionGroups({
      agentId: "main",
      cfg,
      names: ["Work", "  Personal  ", "Work", ""],
      env,
    });
    expect(groups).toEqual([
      { name: "Work", position: 0 },
      { name: "Personal", position: 1 },
    ]);
    expect(listSessionGroups("main", env)).toEqual(groups);
    expect(putSessionGroups({ agentId: "main", cfg, names: ["Personal"], env })).toEqual([
      { name: "Personal", position: 0 },
    ]);
  });

  it("rejects dropping a group that still has member sessions", async () => {
    const groups = putSessionGroups({ agentId: "main", cfg, names: ["Keep", "Gone"], env });
    const sessionKey = "agent:main:dashboard:a";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "a1", updatedAt: Date.now(), category: "Gone" },
    });
    const sessionTarget = { agentId: "main", storePath, sessionKey };

    expect(() => putSessionGroups({ agentId: "main", cfg, names: ["Keep"], env })).toThrow(
      SessionGroupNotEmptyError,
    );
    expect(() => putSessionGroups({ agentId: "main", cfg, names: ["Keep"], env })).toThrow(
      '"Gone" (1)',
    );
    expect(listSessionGroups("main", env)).toEqual(groups);
    expect(loadSessionEntry(sessionTarget)?.category).toBe("Gone");

    await deleteSessionGroup({ agentId: "main", cfg, name: "Gone", env });
    expect(loadSessionEntry(sessionTarget)?.category).toBeUndefined();
    expect(putSessionGroups({ agentId: "main", cfg, names: ["Keep"], env })).toEqual([
      { name: "Keep", position: 0 },
    ]);
  });

  it("propagates changed member authorization before reporting a non-empty drop", async () => {
    const groups = putSessionGroups({ agentId: "main", cfg, names: ["Keep", "Gone"], env });
    const sessionKey = "agent:main:dashboard:changed-member";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "changed-member", updatedAt: Date.now(), category: "Gone" },
    });
    const error = new SessionMutationAuthorizationChangedError({
      code: "INVALID_REQUEST",
      message: "session changed before sessions.groups.put; retry the request",
    });
    const assertTargetCurrent = vi.fn(() => {
      throw error;
    });

    expect(() =>
      putSessionGroups({ agentId: "main", cfg, names: ["Keep"], env, assertTargetCurrent }),
    ).toThrow(error);
    expect(assertTargetCurrent).toHaveBeenCalledExactlyOnceWith({ agentId: "main", sessionKey });
    expect(listSessionGroups("main", env)).toEqual(groups);
    expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })?.category).toBe("Gone");
  });

  it("roundtrips normalized sidebar order, including catalog section ids", () => {
    putSessionGroups({
      agentId: "main",
      cfg,
      names: ["Alpha", " Beta ", "Alpha"],
      sectionOrder: [
        " work ",
        " catalog: codex ",
        "category:Beta",
        "category:Missing",
        "category: Alpha ",
        "groups",
        "groups",
        "catalog:",
        "catalog:codex",
        "pinned",
        "",
      ],
      env,
    });
    expect(listSessionGroups("main", env).map((group) => group.name)).toEqual(["Alpha", "Beta"]);
    const expectedSectionOrder = [
      "work",
      "catalog:codex",
      "category:Beta",
      "category:Alpha",
      "groups",
    ];
    expect(listSidebarSectionOrder("main", env)).toEqual(expectedSectionOrder);
    expect(readConfigMachineState(sessionGroupSectionOrderKey("main"), { env })).toEqual(
      expectedSectionOrder,
    );

    putSessionGroups({ agentId: "main", cfg, names: ["Beta", "Alpha"], env });
    expect(listSidebarSectionOrder("main", env)).toEqual(expectedSectionOrder);
  });

  it("keeps owned catalog operations schema-read-only and ignores retired global rows and order", async () => {
    const { db } = openOpenClawStateDatabase({ env });
    const schemaVersion = () => db.prepare("PRAGMA schema_version").get();
    const schema = schemaVersion();
    db.prepare("INSERT INTO session_groups (name, position, created_at) VALUES (?, ?, ?)").run(
      "Legacy",
      0,
      1,
    );
    db.prepare(
      "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
    ).run("sidebar.sectionOrder", JSON.stringify(["category:Legacy", "work"]), 1);
    expect(listSidebarSectionOrder("main", env)).toEqual([]);
    expect(listSessionGroups("main", env)).toEqual([]);
    putSessionGroups({
      agentId: "main",
      cfg,
      names: ["Client"],
      sectionOrder: ["category:Client"],
      env,
    });
    expect(listSessionGroupDefaults("main", env)).toEqual([{ name: "Client" }]);
    await renameSessionGroup({ agentId: "main", cfg, name: "Client", to: "Customer", env });
    updateSessionGroupDefaults("main", "Customer", { cwd: "/repos/customer", worktree: true }, env);
    expect(schemaVersion()).toEqual(schema);
    expect(listSidebarSectionOrder("main", env)).toEqual(["category:Customer"]);
    expect(readConfigMachineState("sidebar.sectionOrder", { env })).toEqual([
      "category:Legacy",
      "work",
    ]);
    expect(db.prepare("SELECT name FROM session_groups").all()).toEqual([{ name: "Legacy" }]);
    expect(listSessionGroupDefaults("main", env)).toEqual([
      { name: "Customer", cwd: "/repos/customer", worktree: true },
    ]);
  });

  it("preserves New Session defaults through reorder and rename", async () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Client", "Other"], env });
    expect(
      updateSessionGroupDefaults("main", "Client", { cwd: "/repos/client", worktree: true }, env),
    ).toContainEqual({
      name: "Client",
      cwd: "/repos/client",
      worktree: true,
    });

    putSessionGroups({ agentId: "main", cfg, names: ["Other", "Client"], env });
    await renameSessionGroup({ agentId: "main", cfg, name: "Client", to: "Customer", env });
    expect(listSessionGroupDefaults("main", env)).toContainEqual({
      name: "Customer",
      cwd: "/repos/client",
      worktree: true,
    });
  });

  it("rejects renaming an unknown group after defaults have been configured", async () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Client"], env });
    updateSessionGroupDefaults("main", "Client", { cwd: "/repos/client", worktree: true }, env);

    await expect(
      renameSessionGroup({ agentId: "main", cfg, name: "Missing", to: "Other", env }),
    ).rejects.toThrow("unknown session group: Missing");
    expect(listSessionGroups("main", env)).toEqual([{ name: "Client", position: 0 }]);
    expect(listSessionGroupDefaults("main", env)).toEqual([
      { name: "Client", cwd: "/repos/client", worktree: true },
    ]);
  });

  it("clears New Session defaults without removing the group", () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Client"], env });
    updateSessionGroupDefaults("main", "Client", { cwd: "/repos/client", worktree: true }, env);

    expect(
      updateSessionGroupDefaults("main", "Client", { cwd: null, worktree: false }, env),
    ).toEqual([{ name: "Client", worktree: false }]);
  });

  it("does not recreate a deleted group from a stale defaults update", async () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Client"], env });
    await deleteSessionGroup({ agentId: "main", cfg, name: "Client", env });

    expect(
      updateSessionGroupDefaults("main", "Client", { cwd: "/repos/client", worktree: true }, env),
    ).toBeNull();
    expect(listSessionGroups("main", env)).toEqual([]);
  });

  it("does not recreate a missing owned group from a same-name retired global entry", () => {
    const { db } = openOpenClawStateDatabase({ env });
    db.prepare("INSERT INTO session_groups (name, position, created_at) VALUES (?, ?, ?)").run(
      "Missing",
      0,
      1,
    );
    const schema = db.prepare("PRAGMA schema_version").get();
    expect(
      updateSessionGroupDefaults("main", "Missing", { cwd: "/repos/missing", worktree: true }, env),
    ).toBeNull();
    expect(listSessionGroups("main", env)).toEqual([]);
    expect(db.prepare("PRAGMA schema_version").get()).toEqual(schema);
    expect(db.prepare("SELECT name FROM session_groups").all()).toEqual([{ name: "Missing" }]);
  });

  it("absorbs ad-hoc categories at the end of the catalog", () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Work"], env });
    ensureSessionGroupRegistered("main", "Travel", env);
    ensureSessionGroupRegistered("main", "Travel", env);
    expect(listSessionGroups("main", env)).toEqual([
      { name: "Work", position: 0 },
      { name: "Travel", position: 1 },
    ]);
  });

  it("does not admit a write transaction for an existing normalized category", () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Work"], env });
    const transaction = vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction");

    expect(ensureSessionGroupRegistered("main", "  Work  ", env)).toBe(false);

    expect(transaction).not.toHaveBeenCalled();
    expect(listSessionGroups("main", env)).toEqual([{ name: "Work", position: 0 }]);
  });

  it("rechecks a missing category after another writer registers it", () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Work"], env });
    const originalTransaction = stateDatabase.runOpenClawStateWriteTransaction;
    vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction").mockImplementationOnce(
      (operation, options, transactionOptions) => {
        // Commit a competing registration between the optimistic read and admission.
        originalTransaction(
          ({ db }) => {
            db.prepare(
              "INSERT INTO agent_session_groups (agent_id, name, position, created_at) VALUES (?, ?, ?, ?)",
            ).run("main", "Travel", 1, 123);
          },
          { env },
        );
        return originalTransaction(operation, options, transactionOptions);
      },
    );

    expect(ensureSessionGroupRegistered("main", "Travel", env)).toBe(false);
    expect(listSessionGroups("main", env)).toEqual([
      { name: "Work", position: 0 },
      { name: "Travel", position: 1 },
    ]);
    expect(ensureSessionGroupRegistered("main", "Later", env)).toBe(true);
    expect(listSessionGroups("main", env).at(-1)).toEqual({ name: "Later", position: 2 });
  });

  it("renames a group and repoints member categories without bumping updatedAt", async () => {
    putSessionGroups({
      agentId: "main",
      cfg,
      names: ["Old", "Other"],
      sectionOrder: ["ungrouped", "category:Old", "work", "category:Other"],
      env,
    });
    // Store saves run maintenance pruning; stale timestamps would be dropped.
    const updatedAtA = Date.now() - 1_000;
    const updatedAtB = Date.now() - 2_000;
    const storePath = await seedSessionStore({
      "agent:main:dashboard:a": { sessionId: "a1", updatedAt: updatedAtA, category: "Old" },
      "agent:main:dashboard:b": { sessionId: "b1", updatedAt: updatedAtB, category: "Other" },
    });

    const result = await renameSessionGroup({ agentId: "main", cfg, name: "Old", to: "New", env });
    expect(result.updatedSessions).toBe(1);
    expect(result.groups.map((group) => group.name)).toEqual(["New", "Other"]);
    expect(result.sectionOrder).toEqual(["ungrouped", "category:New", "work", "category:Other"]);

    const sessionA = loadSessionEntry({
      agentId: "main",
      storePath,
      sessionKey: "agent:main:dashboard:a",
    });
    const sessionB = loadSessionEntry({
      agentId: "main",
      storePath,
      sessionKey: "agent:main:dashboard:b",
    });
    expect(sessionA?.category).toBe("New");
    expect(sessionA?.updatedAt).toBe(updatedAtA);
    expect(sessionB?.category).toBe("Other");
  });

  it("deletes a group and clears member categories", async () => {
    putSessionGroups({
      agentId: "main",
      cfg,
      names: ["Gone"],
      sectionOrder: ["category:Gone", "ungrouped", "work"],
      env,
    });
    const storePath = await seedSessionStore({
      "agent:main:dashboard:a": { sessionId: "a1", updatedAt: Date.now(), category: "Gone" },
    });

    const result = await deleteSessionGroup({ agentId: "main", cfg, name: "Gone", env });
    expect(result.updatedSessions).toBe(1);
    expect(result.groups).toEqual([]);
    expect(result.sectionOrder).toEqual(["ungrouped", "work"]);

    expect(
      loadSessionEntry({
        agentId: "main",
        storePath,
        sessionKey: "agent:main:dashboard:a",
      })?.category,
    ).toBeUndefined();
  });

  it.each([
    { action: "rename", targetExists: false },
    { action: "rename", targetExists: true },
    { action: "delete", targetExists: false },
  ])(
    "keeps the selected group coherent when $action loses authority (target exists: $targetExists)",
    async ({ action, targetExists }) => {
      const groupCfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, other: {} },
        },
      };
      putSessionGroups({
        agentId: "main",
        cfg: groupCfg,
        names: targetExists ? ["Old", "New"] : ["Old"],
        sectionOrder: ["category:Old", "work", ...(targetExists ? ["category:New"] : [])],
        env,
      });
      updateSessionGroupDefaults("main", "Old", { cwd: "/repos/old", worktree: true }, env);
      if (targetExists) {
        updateSessionGroupDefaults("main", "New", { cwd: "/repos/new", worktree: false }, env);
      }
      const stores = new Map<string, string>();
      for (const agentId of ["main", "other"]) {
        stores.set(
          agentId,
          await seedSessionStore(
            {
              [`agent:${agentId}:dashboard:closing-caller`]: {
                sessionId: `${agentId}-closing-caller`,
                updatedAt: Date.now(),
                category: "Old",
              },
            },
            agentId,
          ),
        );
      }
      const category = (agentId: string) =>
        loadSessionEntry({
          agentId,
          storePath: stores.get(agentId),
          sessionKey: `agent:${agentId}:dashboard:closing-caller`,
        })?.category;
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("caller authority closed");
        }
      };
      const params = {
        agentId: "main",
        cfg: groupCfg,
        name: "Old",
        env,
        assertCurrent,
        assertTargetCurrent: ({ agentId }: { agentId: string }) => {
          assertCurrent();
          if (agentId === "main") {
            queueMicrotask(() => {
              current = false;
            });
          }
        },
      };
      await expect(
        action === "rename"
          ? renameSessionGroup({ ...params, to: "New" })
          : deleteSessionGroup(params),
      ).rejects.toThrow("caller authority closed");
      expect(category("main")).toBe("Old");
      expect(category("other")).toBe("Old");
      expect(listSessionGroups("main", env)).toContainEqual({ name: "Old", position: 0 });
      expect(listSidebarSectionOrder("main", env)).toContain("category:Old");
      if (action === "rename") {
        expect(listSessionGroupDefaults("main", env)).toContainEqual({
          name: "New",
          cwd: targetExists ? "/repos/new" : "/repos/old",
          worktree: !targetExists,
        });
      }
      const retry = { agentId: "main", cfg: groupCfg, name: "Old", env };
      await (action === "rename"
        ? renameSessionGroup({ ...retry, to: "New" })
        : deleteSessionGroup(retry));
      expect(category("main")).toBe(action === "rename" ? "New" : undefined);
      expect(category("other")).toBe("Old");
      expect(listSessionGroups("main", env).map(({ name }) => name)).toEqual(
        action === "rename" ? ["New"] : [],
      );
      expect(listSidebarSectionOrder("main", env)).not.toContain("category:Old");
    },
  );

  it("merges a rename into an existing target group", async () => {
    putSessionGroups({
      agentId: "main",
      cfg,
      names: ["A", "B"],
      sectionOrder: ["category:A", "ungrouped", "category:B"],
      env,
    });
    await seedSessionStore({
      "agent:main:dashboard:a": { sessionId: "a1", updatedAt: Date.now(), category: "A" },
    });
    const result = await renameSessionGroup({ agentId: "main", cfg, name: "A", to: "B", env });
    expect(result.groups).toEqual([{ name: "B", position: 1 }]);
    expect(result.sectionOrder).toEqual(["ungrouped", "category:B"]);
    expect(result.updatedSessions).toBe(1);
  });

  it("stops a rename if its empty destination is removed during member planning", async () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Old"], env });
    const sessionKey = "agent:main:dashboard:removed-destination";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "removed-destination", updatedAt: Date.now(), category: "Old" },
    });
    let removed = false;
    await expect(
      renameSessionGroup({
        agentId: "main",
        cfg,
        name: "Old",
        to: "New",
        env,
        assertTargetCurrent: () => {
          if (!removed) {
            removed = true;
            queueMicrotask(() => {
              putSessionGroups({ agentId: "main", cfg, names: ["Old"], env });
            });
          }
        },
      }),
    ).rejects.toThrow(/New/);
    expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })?.category).toBe("Old");
    expect(listSessionGroups("main", env)).toContainEqual({ name: "Old", position: 0 });
  });

  it("keeps absent-group deletion and same-name rename idempotent", async () => {
    const sessionKey = "agent:main:dashboard:orphan-group";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "orphan-group", updatedAt: Date.now(), category: "Missing" },
    });
    expect(
      await renameSessionGroup({ agentId: "main", cfg, name: "Missing", to: "Missing", env }),
    ).toMatchObject({
      groups: [],
      updatedSessions: 0,
    });
    expect(await deleteSessionGroup({ agentId: "main", cfg, name: "Missing", env })).toMatchObject({
      groups: [],
      updatedSessions: 1,
    });
    expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })?.category).toBeUndefined();
    expect(await deleteSessionGroup({ agentId: "main", cfg, name: "Missing", env })).toMatchObject({
      groups: [],
      updatedSessions: 0,
    });
  });

  it("retains source defaults changed while a rename moves its members", async () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Old"], sectionOrder: ["category:Old"], env });
    updateSessionGroupDefaults("main", "Old", { cwd: "/repos/before", worktree: false }, env);
    const sessionKey = "agent:main:dashboard:changed-group";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "changed-group", updatedAt: Date.now(), category: "Old" },
    });
    await expect(
      renameSessionGroup({
        agentId: "main",
        cfg,
        name: "Old",
        to: "New",
        env,
        assertTargetCurrent: () => {
          updateSessionGroupDefaults("main", "Old", { cwd: "/repos/after", worktree: true }, env);
        },
      }),
    ).rejects.toThrow(/changed/);
    expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })?.category).toBe("New");
    expect(listSessionGroupDefaults("main", env)).toEqual(
      expect.arrayContaining([
        { name: "Old", cwd: "/repos/after", worktree: true },
        { name: "New", cwd: "/repos/before", worktree: false },
      ]),
    );
    expect(listSidebarSectionOrder("main", env)).toContain("category:Old");
  });

  it("retains a group when a member is assigned after its store was swept", async () => {
    const groupCfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, other: {} },
      },
    };
    putSessionGroups({
      agentId: "main",
      cfg: groupCfg,
      names: ["Old"],
      sectionOrder: ["category:Old"],
      env,
    });
    const mainKey = "agent:main:dashboard:existing";
    const lateKey = "agent:main:dashboard:late";
    const mainStore = await seedSessionStore({
      [mainKey]: { sessionId: "existing", updatedAt: Date.now(), category: "Old" },
    });
    let inserted = false;
    await expect(
      renameSessionGroup({
        agentId: "main",
        cfg: groupCfg,
        name: "Old",
        to: "New",
        env,
        assertCurrent: () => {
          if (
            inserted ||
            loadSessionEntry({ agentId: "main", storePath: mainStore, sessionKey: mainKey })
              ?.category !== "New"
          ) {
            return;
          }
          inserted = true;
          expect(
            loadSessionEntry({ agentId: "main", storePath: mainStore, sessionKey: mainKey })
              ?.category,
          ).toBe("New");
          runOpenClawAgentWriteTransaction(
            (database) => {
              writeSessionEntry(database, lateKey, {
                sessionId: "late",
                updatedAt: Date.now(),
                category: "Old",
              });
            },
            { agentId: "main", env },
          );
        },
      }),
    ).rejects.toThrow("still has members");
    expect(inserted).toBe(true);
    expect(
      loadSessionEntry({ agentId: "main", storePath: mainStore, sessionKey: lateKey })?.category,
    ).toBe("Old");
    expect(listSessionGroups("main", env).map(({ name }) => name)).toEqual(
      expect.arrayContaining(["Old", "New"]),
    );
    expect(listSidebarSectionOrder("main", env)).toContain("category:Old");
  });

  it("keeps the source sidebar slot when the merge target has no stored slot", async () => {
    putSessionGroups({
      agentId: "main",
      cfg,
      names: ["A", "B"],
      sectionOrder: ["category:A", "work"],
      env,
    });

    const result = await renameSessionGroup({ agentId: "main", cfg, name: "A", to: "B", env });

    expect(result.groups).toEqual([{ name: "B", position: 1 }]);
    expect(result.sectionOrder).toEqual(["category:B", "work"]);
  });
  it("keeps same-name catalogs, defaults, empty groups and section order independent after reopen", async () => {
    const agentConfig: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
    };
    putSessionGroups({
      cfg: agentConfig,
      agentId: "alpha",
      names: ["Shared", "Empty"],
      sectionOrder: ["category:Empty", "category:Shared", "work"],
      env,
    });
    putSessionGroups({
      cfg: agentConfig,
      agentId: "beta",
      names: ["Empty", "Shared"],
      sectionOrder: ["work", "category:Shared", "category:Empty"],
      env,
    });
    updateSessionGroupDefaults("alpha", "Shared", { cwd: "/repos/alpha", worktree: true }, env);
    updateSessionGroupDefaults("beta", "Shared", { cwd: "/repos/beta", worktree: false }, env);
    const alpha = {
      groups: listSessionGroups("alpha", env),
      defaults: listSessionGroupDefaults("alpha", env),
      order: listSidebarSectionOrder("alpha", env),
    };
    closeOpenClawStateDatabaseForTest();
    expect(listSessionGroups("alpha", env)).toEqual([
      { name: "Shared", position: 0 },
      { name: "Empty", position: 1 },
    ]);
    expect(listSessionGroups("beta", env)).toEqual([
      { name: "Empty", position: 0 },
      { name: "Shared", position: 1 },
    ]);
    expect(listSessionGroupDefaults("beta", env)).toEqual([
      { name: "Empty" },
      { name: "Shared", cwd: "/repos/beta", worktree: false },
    ]);
    await renameSessionGroup({
      cfg: agentConfig,
      agentId: "beta",
      name: "Shared",
      to: "Beta renamed",
      env,
    });
    expect(listSidebarSectionOrder("beta", env)).toEqual([
      "work",
      "category:Beta renamed",
      "category:Empty",
    ]);
    expect(listSessionGroupDefaults("beta", env)).toContainEqual({
      name: "Beta renamed",
      cwd: "/repos/beta",
      worktree: false,
    });
    await deleteSessionGroup({ cfg: agentConfig, agentId: "beta", name: "Beta renamed", env });
    putSessionGroups({ cfg: agentConfig, agentId: "beta", names: [], sectionOrder: [], env });
    closeOpenClawStateDatabaseForTest();
    expect(listSessionGroups("beta", env)).toEqual([]);
    expect(listSessionGroupDefaults("beta", env)).toEqual([]);
    expect(listSidebarSectionOrder("beta", env)).toEqual([]);
    expect({
      groups: listSessionGroups("alpha", env),
      defaults: listSessionGroupDefaults("alpha", env),
      order: listSidebarSectionOrder("alpha", env),
    }).toEqual(alpha);
  });

  it.each(["rename", "delete"])(
    "does not change alpha's same-name members when beta requests %s",
    async (action) => {
      const agentConfig: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
      };
      const stores = new Map<string, string>();
      const updatedAt = Date.now();
      for (const agentId of ["alpha", "beta"]) {
        putSessionGroups({ cfg: agentConfig, agentId, names: ["Shared", "Empty"], env });
        const sessionKey = "agent:" + agentId + ":member";
        stores.set(
          agentId,
          await seedSessionStore(
            { [sessionKey]: { sessionId: agentId + "-member", updatedAt, category: "Shared" } },
            agentId,
          ),
        );
      }
      const alphaBefore = loadSessionEntry({
        agentId: "alpha",
        storePath: stores.get("alpha"),
        sessionKey: "agent:alpha:member",
      });
      const params = { cfg: agentConfig, agentId: "beta", name: "Shared", env };
      const result = await (action === "rename"
        ? renameSessionGroup({ ...params, to: "Beta renamed" })
        : deleteSessionGroup(params));
      expect(result.updatedSessions).toBe(1);
      expect(
        loadSessionEntry({
          agentId: "beta",
          storePath: stores.get("beta"),
          sessionKey: "agent:beta:member",
        })?.category,
      ).toBe(action === "rename" ? "Beta renamed" : undefined);
      expect(
        loadSessionEntry({
          agentId: "alpha",
          storePath: stores.get("alpha"),
          sessionKey: "agent:alpha:member",
        }),
      ).toEqual(alphaBefore);
      expect(listSessionGroups("alpha", env)).toEqual([
        { name: "Shared", position: 0 },
        { name: "Empty", position: 1 },
      ]);
    },
  );

  it("registers an equal category independently in each committed owner", () => {
    expect(ensureSessionGroupRegistered("alpha", "Shared", env)).toBe(true);
    expect(ensureSessionGroupRegistered("beta", "Shared", env)).toBe(true);
    expect(ensureSessionGroupRegistered("alpha", " Shared ", env)).toBe(false);
    expect(listSessionGroups("alpha", env)).toEqual([{ name: "Shared", position: 0 }]);
    expect(listSessionGroups("beta", env)).toEqual([{ name: "Shared", position: 0 }]);
  });

  it("appends against current committed names without replacing defaults or order", () => {
    putSessionGroups({
      cfg,
      agentId: "main",
      names: ["Keep"],
      sectionOrder: ["work", "category:Keep"],
      env,
    });
    updateSessionGroupDefaults("main", "Keep", { cwd: "/repos/keep", worktree: false }, env);
    putSessionGroups({ cfg, agentId: "other", names: ["Foreign"], env });
    const originalTransaction = stateDatabase.runOpenClawStateWriteTransaction;
    vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction").mockImplementationOnce(
      (operation, options, transactionOptions) => {
        // Commit another client's create/default change at the append admission boundary.
        putSessionGroups({ cfg, agentId: "main", names: ["Racer"], append: true, env });
        updateSessionGroupDefaults("main", "Keep", { cwd: "/repos/newer", worktree: true }, env);
        return originalTransaction(operation, options, transactionOptions);
      },
    );
    expect(
      putSessionGroups({
        cfg,
        agentId: "main",
        names: ["Keep", "Import", "Import", "Racer"],
        append: true,
        env,
      }),
    ).toEqual([
      { name: "Keep", position: 0 },
      { name: "Racer", position: 1 },
      { name: "Import", position: 2 },
    ]);
    expect(listSessionGroupDefaults("main", env)).toEqual([
      { name: "Keep", cwd: "/repos/newer", worktree: true },
      { name: "Racer" },
      { name: "Import" },
    ]);
    expect(listSidebarSectionOrder("main", env)).toEqual(["work", "category:Keep"]);
    expect(listSessionGroups("other", env)).toEqual([{ name: "Foreign", position: 0 }]);
    expect(() =>
      putSessionGroups({
        cfg,
        agentId: "main",
        names: ["Rejected"],
        append: true,
        sectionOrder: [],
        env,
      }),
    ).toThrow(/append/);
    expect(listSessionGroups("main", env).map(({ name }) => name)).toEqual([
      "Keep",
      "Racer",
      "Import",
    ]);
  });

  it("rechecks defaults authority inside the shared-state transaction", () => {
    putSessionGroups({ cfg, agentId: "main", names: ["Shared"], env });
    updateSessionGroupDefaults("main", "Shared", { cwd: "/repos/before", worktree: false }, env);
    const originalTransaction = stateDatabase.runOpenClawStateWriteTransaction;
    let current = true;
    vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction").mockImplementationOnce(
      (operation, options, transactionOptions) => {
        current = false;
        return originalTransaction(operation, options, transactionOptions);
      },
    );
    expect(() =>
      updateSessionGroupDefaults(
        "main",
        "Shared",
        { cwd: "/repos/after", worktree: true },
        env,
        () => {
          if (!current) {
            throw new Error("owner retired before commit");
          }
        },
      ),
    ).toThrow("owner retired before commit");
    expect(listSessionGroupDefaults("main", env)).toEqual([
      { name: "Shared", cwd: "/repos/before", worktree: false },
    ]);
  });

  it.each(["rename", "delete"])(
    "filters logical owners in a shared physical store during %s",
    async (action) => {
      const storePath = path.join(root, "shared.sqlite");
      const agentConfig: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
        session: { store: storePath },
      };
      for (const agentId of ["alpha", "beta"]) {
        putSessionGroups({ cfg: agentConfig, agentId, names: ["Shared"], env });
        await replaceSessionEntry(
          { agentId, storePath, sessionKey: "agent:" + agentId + ":member", env },
          { sessionId: agentId + "-member", updatedAt: Date.now(), category: "Shared" },
        );
      }
      const alphaTarget = { agentId: "alpha", storePath, sessionKey: "agent:alpha:member", env };
      const alpha = loadSessionEntry(alphaTarget);
      expect(resolveSessionGroupMutationTargetsByName(agentConfig, "beta", env)).toEqual(
        new Map([["Shared", [{ agentId: "beta", sessionKey: "agent:beta:member" }]]]),
      );
      const params = { cfg: agentConfig, agentId: "beta", name: "Shared", env };
      const result = await (action === "rename"
        ? renameSessionGroup({ ...params, to: "Beta" })
        : deleteSessionGroup(params));
      expect(result.updatedSessions).toBe(1);
      expect(loadSessionEntry(alphaTarget)).toEqual(alpha);
      expect(
        loadSessionEntry({ agentId: "beta", storePath, sessionKey: "agent:beta:member", env })
          ?.category,
      ).toBe(action === "rename" ? "Beta" : undefined);
      expect(listSessionGroups("alpha", env)).toEqual([{ name: "Shared", position: 0 }]);
    },
  );
  it.each(["rename", "delete"])(
    "keeps partial %s progress within the selected owner's stores and permits a scoped retry",
    async (action) => {
      const customStore = path.join(root, "custom", "agents", "main", "sessions", "sessions.json");
      const agentConfig: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, other: {} } },
        session: {
          store: path.join(root, "custom", "agents", "{agentId}", "sessions", "sessions.json"),
        },
      };
      putSessionGroups({ cfg: agentConfig, agentId: "main", names: ["Old"], env });
      putSessionGroups({ cfg: agentConfig, agentId: "other", names: ["Old"], env });
      const customKey = "agent:main:custom-member";
      const defaultKey = "agent:main:default-member";
      await replaceSessionEntry(
        { agentId: "main", storePath: customStore, sessionKey: customKey, env },
        { sessionId: "custom-member", updatedAt: Date.now(), category: "Old" },
      );
      const defaultStore = await seedSessionStore({
        [defaultKey]: { sessionId: "default-member", updatedAt: Date.now(), category: "Old" },
      });
      const foreignKey = "agent:other:member";
      const foreignStore = await seedSessionStore(
        { [foreignKey]: { sessionId: "foreign-member", updatedAt: Date.now(), category: "Old" } },
        "other",
      );
      const params = { cfg: agentConfig, agentId: "main", name: "Old", env };
      const guarded = {
        ...params,
        assertTargetCurrent: ({ agentId, sessionKey }: { agentId: string; sessionKey: string }) => {
          expect(agentId).toBe("main");
          if (sessionKey === defaultKey) {
            throw new Error("selected owner second store unavailable");
          }
        },
      };
      await expect(
        action === "rename"
          ? renameSessionGroup({ ...guarded, to: "New" })
          : deleteSessionGroup(guarded),
      ).rejects.toThrow("selected owner second store unavailable");
      expect(
        loadSessionEntry({ agentId: "main", storePath: customStore, sessionKey: customKey, env })
          ?.category,
      ).toBe(action === "rename" ? "New" : undefined);
      expect(
        loadSessionEntry({ agentId: "main", storePath: defaultStore, sessionKey: defaultKey, env })
          ?.category,
      ).toBe("Old");
      expect(listSessionGroups("main", env).map(({ name }) => name)).toContain("Old");
      await (action === "rename"
        ? renameSessionGroup({ ...params, to: "New" })
        : deleteSessionGroup(params));
      expect(
        loadSessionEntry({ agentId: "main", storePath: defaultStore, sessionKey: defaultKey, env })
          ?.category,
      ).toBe(action === "rename" ? "New" : undefined);
      expect(listSessionGroups("main", env).map(({ name }) => name)).toEqual(
        action === "rename" ? ["New"] : [],
      );
      expect(
        loadSessionEntry({ agentId: "other", storePath: foreignStore, sessionKey: foreignKey, env })
          ?.category,
      ).toBe("Old");
      expect(listSessionGroups("other", env)).toEqual([{ name: "Old", position: 0 }]);
    },
  );

  it.each(["rename", "delete"])(
    "rechecks owner authority before %s member commits, not just catalog retirement",
    async (action) => {
      putSessionGroups({ cfg, agentId: "main", names: ["Old"], env });
      const sessionKey = "agent:main:owner-retired-before-member-commit";
      const storePath = await seedSessionStore({
        [sessionKey]: { sessionId: "owner-retired", updatedAt: Date.now(), category: "Old" },
      });
      let current = true;
      const params = {
        cfg,
        agentId: "main",
        name: "Old",
        env,
        assertCurrent: () => {
          if (!current) {
            throw new Error("owner retired");
          }
        },
        assertTargetCurrent: () => {
          queueMicrotask(() => {
            current = false;
          });
        },
      };
      await expect(
        action === "rename"
          ? renameSessionGroup({ ...params, to: "New" })
          : deleteSessionGroup(params),
      ).rejects.toThrow("owner retired");
      expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })?.category).toBe("Old");
      expect(listSessionGroups("main", env)).toContainEqual({ name: "Old", position: 0 });
    },
  );
});
