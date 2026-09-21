import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";

const state = vi.hoisted(() => ({
  persisted: {} as Record<string, PluginInstallRecord>,
  recovered: {} as Record<string, PluginInstallRecord>,
  snapshot: {} as ConfigFileSnapshot,
  databasePath: "/state/openclaw.db",
  leasePath: "/state/openclaw.db",
  owned: true,
  includeHashes: { "/config/included.json": "include-before" },
  includeTargets: { "/config/included.json": "/config/target.json" },
  pathCurrent: true,
  events: [] as string[],
  commits: 0,
  revision: 1,
  rowMissing: false,
  managedRuntime: false,
  readOptions: [] as unknown[],
  writes: 0,
  beforeVerify: undefined as (() => void) | undefined,
}));

vi.mock("../../../infra/deferred-plugin-migrations.js", () => ({
  assertDeferredPluginMigrationsCurrent: vi.fn(),
}));

vi.mock("../../../plugins/installed-plugin-index-record-state.js", () => ({
  inspectPersistedInstalledPluginIndexInstallRecordsSync: vi.fn(),
  readPersistedInstalledPluginIndexRowSync: () =>
    state.rowMissing
      ? undefined
      : {
          value_json: JSON.stringify({
            revision: state.revision,
            index: { installRecords: state.persisted },
          }),
        },
}));
vi.mock("../../../plugins/plugin-cache.js", () => ({
  createPluginCache: () => ({}),
  withPluginCache: (_cache: unknown, run: () => unknown) => run(),
}));
vi.mock("../../../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecordsSync: () => structuredClone(state.recovered),
  loadInstalledPluginIndexInstallRecords: async () => structuredClone(state.recovered),
  readPersistedInstalledPluginIndexInstallRecords: () =>
    Object.assign(Object.create(null), structuredClone(state.persisted)),
  withoutPluginInstallRecords: (config: ConfigFileSnapshot["config"]) => {
    const result = structuredClone(config);
    delete result.plugins?.installs;
    return result;
  },
}));
vi.mock("../../../plugins/installed-plugin-index-store-write.js", () => ({
  writePersistedInstalledPluginIndex: vi.fn(),
}));
vi.mock("../../../plugins/installed-plugin-index-store.js", () => ({
  readPersistedInstalledPluginIndexSync: vi.fn(),
  resolveInstalledPluginIndexStorePath: () => state.databasePath,
}));
vi.mock("../../../plugins/installed-plugin-index.js", () => ({
  loadInstalledPluginIndex: vi.fn(),
}));
vi.mock("../../../plugins/official-external-install-records.js", () => ({
  isTrustedOfficialPluginInstallRecord: () => false,
  resolveTrustedOfficialClawHubPackageName: () => undefined,
  resolveTrustedSourceLinkedOfficialClawHubInstall: () => undefined,
}));
vi.mock("../../../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (
    _options: unknown,
    run: (lease: unknown) => Promise<unknown>,
  ) => {
    state.events.push("lease");
    return await run({
      databasePath: state.leasePath,
      assertOwned: () => {
        if (!state.owned) {
          throw new Error("lease lost");
        }
      },
    });
  },
}));
vi.mock("../../../config/io.read-helpers.js", () => ({
  createManagedRuntimeEnvBase: () => ({ MANAGED_IMPORT_FIXTURE: "1" }),
}));
vi.mock("../../../config/runtime-snapshot.js", () => ({
  hasManagedRuntimeConfigWriteOwner: () => state.managedRuntime,
}));
vi.mock("../../../config/config.js", () => {
  const read = async (options?: unknown) => {
    state.readOptions.push(options);
    return {
      snapshot: structuredClone(state.snapshot),
      writeOptions: {
        includeFileHashesForWrite: structuredClone(state.includeHashes),
        includeFileTargetsForWrite: structuredClone(state.includeTargets),
        assertConfigPathForWrite: () => {
          if (!state.pathCurrent) {
            throw new Error("config path changed");
          }
        },
      },
    };
  };
  return {
    withConfigMutationExclusive: async (run: () => Promise<unknown>) => {
      state.events.push("config-lock");
      return await run();
    },
    readConfigFileSnapshotForWrite: read,
    createConfigIO: (options: unknown) => ({
      configPath: state.snapshot.path,
      readConfigFileSnapshotForWrite: () => read(options),
    }),
  };
});
vi.mock("../../../plugins/install-record-commit.js", () => ({
  // External persistence seam. Production's revision-CAS compensation is unchanged.
  commitPluginInstallRecordsOnly: async (params: {
    nextInstallRecords: Record<string, PluginInstallRecord>;
    verifyConfigFresh: () => Promise<void>;
  }) => {
    state.commits++;
    state.events.push("commit");
    state.beforeVerify?.();
    await params.verifyConfigFresh();
    state.persisted = structuredClone(params.nextInstallRecords);
    state.writes++;
    state.revision++;
  },
}));

import {
  assertShippedPluginInstallConfigImportCurrent,
  importShippedPluginInstallConfigForDoctor,
  prepareShippedPluginInstallConfigImport,
} from "./plugin-registry-migration.js";

const record = (spec: string): PluginInstallRecord => ({ source: "npm", spec });
function snapshot(): ConfigFileSnapshot {
  const config = {
    plugins: {
      installs: { "migration-proof-plugin": record("migration-proof-plugin@1") },
      entries: { "migration-proof-plugin": { enabled: true, config: { invalid: true } } },
    },
  };
  return {
    path: "/config/openclaw.json",
    exists: true,
    raw: JSON.stringify(config),
    parsed: config,
    sourceConfig: config,
    resolved: config,
    runtimeConfig: config,
    config,
    hash: "root-before",
    valid: false,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

beforeEach(() => {
  state.persisted = {};
  state.recovered = {};
  state.snapshot = snapshot();
  state.databasePath = "/state/openclaw.db";
  state.leasePath = state.databasePath;
  state.owned = true;
  state.includeHashes = { "/config/included.json": "include-before" };
  state.includeTargets = { "/config/included.json": "/config/target.json" };
  state.pathCurrent = true;
  state.events = [];
  state.commits = 0;
  state.revision = 1;
  state.rowMissing = false;
  state.managedRuntime = false;
  state.readOptions = [];
  state.writes = 0;
  state.beforeVerify = undefined;
});

async function stage() {
  const prepared = await prepareShippedPluginInstallConfigImport(state.snapshot);
  expect(prepared).toBeDefined();
  return prepared!;
}

describe("staged shipped plugin inventory", () => {
  it("exposes authored and recovered inventory without publishing invalid record-only config", async () => {
    const original = structuredClone(state.snapshot);
    state.recovered = { recovered: record("recovered@1") };
    const prepared = await stage();
    expect(prepared.installRecords).toEqual({
      recovered: record("recovered@1"),
      "migration-proof-plugin": record("migration-proof-plugin@1"),
    });
    expect(prepared.source).toEqual({
      path: original.path,
      hash: original.hash,
      sourceConfig: original.sourceConfig,
    });
    expect(state.persisted).toEqual({});
    expect(state.snapshot).toEqual(original);
    expect(state.events).toEqual([]);
    expect(state.readOptions).toEqual([{ pluginValidation: "core-only", observe: false }]);
    expect(state.commits).toBe(0);
    expect(prepared).not.toHaveProperty("pluginInventoryChanged");
    expect(() => assertShippedPluginInstallConfigImportCurrent(state.snapshot, undefined)).toThrow(
      /config changed/,
    );
    expect(() =>
      assertShippedPluginInstallConfigImportCurrent(state.snapshot, prepared as never),
    ).toThrow(/config changed/);
  });

  it("keeps every staged source read core-only and retains managed environment selection", async () => {
    state.managedRuntime = true;
    const prepared = await stage();
    await importShippedPluginInstallConfigForDoctor(state.snapshot, {
      prepared,
      expectedPending: [],
      validateRecords: async () => {},
    });
    expect(state.readOptions.length).toBeGreaterThan(2);
    for (const options of state.readOptions) {
      expect(options).toEqual({
        pluginValidation: "core-only",
        observe: false,
        env: { MANAGED_IMPORT_FIXTURE: "1" },
      });
    }
  });

  it("keeps persisted ownership ahead of authored provenance and authored ahead of recovery", async () => {
    state.persisted = { "migration-proof-plugin": record("persisted@3") };
    state.recovered = { ...state.persisted, recovered: record("disk@1") };
    state.snapshot.sourceConfig!.plugins!.installs!.recovered = record("authored@2");
    const prepared = await stage();
    expect(prepared.installRecords).toEqual({
      "migration-proof-plugin": record("persisted@3"),
      recovered: record("authored@2"),
    });
    expect(state.persisted).toEqual({ "migration-proof-plugin": record("persisted@3") });
  });

  it("does not alias the source or recovered records", async () => {
    state.recovered = { recovered: record("disk@1") };
    const prepared = await stage();
    prepared.installRecords.recovered!.spec = "mutated";
    prepared.source.sourceConfig!.plugins!.installs!["migration-proof-plugin"]!.spec = "mutated";
    expect(state.recovered.recovered!.spec).toBe("disk@1");
    expect(state.snapshot.sourceConfig!.plugins!.installs!["migration-proof-plugin"]!.spec).toBe(
      "migration-proof-plugin@1",
    );
  });

  it("refuses malformed source records without effects", async () => {
    state.snapshot.sourceConfig!.plugins!.installs = { bad: { source: "unknown" } } as never;
    await expect(stage()).rejects.toThrow(/invalid records/);
    expect(state.events).toEqual([]);
  });

  it("returns no staged inventory when retired source records are absent", async () => {
    delete state.snapshot.sourceConfig!.plugins!.installs;
    await expect(prepareShippedPluginInstallConfigImport(state.snapshot)).resolves.toBeUndefined();
    expect(state.events).toEqual([]);
  });

  it("awaits async validation refusal before any publication (legacy callback compatibility)", async () => {
    let rejectValidation!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectValidation = reject;
    });
    // Observe the rejection even on the historical importer that ignored the returned promise.
    void pending.catch(() => {});
    const validateRecords = vi.fn(() => pending);
    const importing = importShippedPluginInstallConfigForDoctor(state.snapshot, {
      validateRecords,
    });
    const settled = importing.then(
      () => "published",
      () => "refused",
    );
    await vi.waitFor(() => expect(validateRecords).toHaveBeenCalledOnce());
    const beforeRefusal = state.commits;
    rejectValidation(new Error("invalid plugin configuration"));
    expect(await settled).toBe("refused");
    expect(beforeRefusal).toBe(0);
    expect(state.persisted).toEqual({});
  });

  it("preserves an empty canonical index when full staged validation refuses", async () => {
    const prepared = await stage();
    await expect(
      importShippedPluginInstallConfigForDoctor(state.snapshot, {
        prepared,
        expectedPending: [],
        validateRecords: async (records) => {
          expect(records["migration-proof-plugin"]).toEqual(record("migration-proof-plugin@1"));
          throw new Error("invalid plugin configuration");
        },
      }),
    ).rejects.toThrow(/invalid plugin configuration/);
    expect(state.persisted).toEqual({});
    expect(state.commits).toBe(0);
  });

  it("publishes once only after full validation succeeds and returns a source-removal receipt", async () => {
    const original = structuredClone(state.snapshot);
    const prepared = await stage();
    const imported = await importShippedPluginInstallConfigForDoctor(state.snapshot, {
      prepared,
      expectedPending: [],
      validateRecords: async (records) => {
        await Promise.resolve();
        expect(records).toEqual(prepared.installRecords);
        expect(state.commits).toBe(0);
        state.events.push("full-validation");
      },
    });
    expect(state.events).toEqual(["lease", "config-lock", "full-validation", "commit"]);
    expect(state.persisted).toEqual(prepared.installRecords);
    expect(state.writes).toBe(1);
    expect(state.snapshot).toEqual(original);
    expect(imported?.pluginInventoryChanged).toBe(true);
    expect(() =>
      assertShippedPluginInstallConfigImportCurrent(state.snapshot, imported),
    ).not.toThrow();
  });

  it("does not let the validator mutate the published inventory", async () => {
    const prepared = await stage();
    await importShippedPluginInstallConfigForDoctor(state.snapshot, {
      prepared,
      expectedPending: [],
      validateRecords: async (records) => {
        records["migration-proof-plugin"]!.spec = "not-validated";
      },
    });
    expect(state.persisted["migration-proof-plugin"]!.spec).toBe("migration-proof-plugin@1");
  });

  it("refuses inventory drift without rolling back the new owner", async () => {
    const prepared = await stage();
    state.persisted = { other: record("another-writer@1") };
    state.recovered = structuredClone(state.persisted);
    const validateRecords = vi.fn();
    await expect(
      importShippedPluginInstallConfigForDoctor(state.snapshot, {
        prepared,
        expectedPending: [],
        validateRecords,
      }),
    ).rejects.toThrow(/(?:inventory|index revision) changed/);
    expect(validateRecords).not.toHaveBeenCalled();
    expect(state.persisted).toEqual({ other: record("another-writer@1") });
    expect(state.commits).toBe(0);
  });

  it.each(["path", "hash", "source", "database", "lease-database"] as const)(
    "refuses changed %s between preparation and import",
    async (kind) => {
      const prepared = await stage();
      if (kind === "path") {
        state.snapshot.path = "/config/replaced.json";
      }
      if (kind === "hash") {
        state.snapshot.hash = "changed";
      }
      if (kind === "source") {
        state.snapshot.sourceConfig!.plugins!.installs!.new = record("new@1");
      }
      if (kind === "database") {
        state.databasePath = "/state/replaced.db";
      }
      if (kind === "lease-database") {
        state.leasePath = "/state/replaced.db";
      }
      const validateRecords = vi.fn();
      await expect(
        importShippedPluginInstallConfigForDoctor(state.snapshot, {
          prepared,
          expectedPending: [],
          validateRecords,
        }),
      ).rejects.toThrow(/changed/);
      expect(validateRecords).not.toHaveBeenCalled();
      expect(state.commits).toBe(0);
    },
  );

  it("rechecks lease authority after async validation", async () => {
    await expect(
      importShippedPluginInstallConfigForDoctor(state.snapshot, {
        prepared: await stage(),
        expectedPending: [],
        validateRecords: async () => {
          state.owned = false;
        },
      }),
    ).rejects.toThrow(/lease lost/);
    expect(state.commits).toBe(0);
  });

  it.each(["root", "include-hash", "include-target", "write-path"] as const)(
    "retains the final %s freshness guard",
    async (kind) => {
      state.beforeVerify = () => {
        if (kind === "root") {
          state.snapshot.hash = "changed";
        }
        if (kind === "include-hash") {
          state.includeHashes["/config/included.json"] = "changed";
        }
        if (kind === "include-target") {
          state.includeTargets["/config/included.json"] = "/other.json";
        }
        if (kind === "write-path") {
          state.pathCurrent = false;
        }
      };
      await expect(
        importShippedPluginInstallConfigForDoctor(state.snapshot, {
          prepared: await stage(),
          expectedPending: [],
          validateRecords: async () => {},
        }),
      ).rejects.toThrow(/config.*changed/);
      expect(state.writes).toBe(0);
    },
  );

  it.each(["include-hash", "include-target"] as const)(
    "refuses prepared %s drift even when root bytes and resolved values match",
    async (kind) => {
      const prepared = await stage();
      if (kind === "include-hash") {
        state.includeHashes["/config/included.json"] = "different-authored-bytes";
      } else {
        state.includeTargets["/config/included.json"] = "/config/other-target.json";
      }
      await expect(
        importShippedPluginInstallConfigForDoctor(state.snapshot, {
          prepared,
          expectedPending: [],
          validateRecords: async () => {},
        }),
      ).rejects.toThrow(/config changed/);
      expect(state.commits).toBe(0);
    },
  );

  it.each(["revision", "deletion", "source", "include-hash", "include-target"] as const)(
    "refuses %s drift during awaited validation before any tentative publication",
    async (kind) => {
      state.persisted = { "migration-proof-plugin": record("migration-proof-plugin@1") };
      state.recovered = structuredClone(state.persisted);
      const prepared = await stage();
      const validateRecords = async () => {
        await Promise.resolve();
        if (kind === "revision") {
          state.revision++;
        }
        if (kind === "deletion") {
          state.persisted = {};
          state.recovered = {};
          state.revision++;
        }
        if (kind === "source") {
          state.snapshot.hash = "new-root";
        }
        if (kind === "include-hash") {
          state.includeHashes["/config/included.json"] = "changed";
        }
        if (kind === "include-target") {
          state.includeTargets["/config/included.json"] = "/other.json";
        }
      };
      await expect(
        importShippedPluginInstallConfigForDoctor(state.snapshot, {
          prepared,
          expectedPending: [],
          validateRecords,
        }),
      ).rejects.toThrow(/changed/);
      expect(state.commits).toBe(0);
      if (kind === "deletion") {
        expect(state.persisted).toEqual({});
      }
    },
  );

  it("distinguishes an absent canonical row from an empty canonical index", async () => {
    state.rowMissing = true;
    const prepared = await stage();
    state.rowMissing = false;
    await expect(
      importShippedPluginInstallConfigForDoctor(state.snapshot, {
        prepared,
        expectedPending: [],
        validateRecords: async () => {},
      }),
    ).rejects.toThrow(/revision changed/);
    expect(state.commits).toBe(0);
  });

  it("validates even when records already match and avoids a redundant commit", async () => {
    state.persisted = { "migration-proof-plugin": record("migration-proof-plugin@1") };
    state.recovered = structuredClone(state.persisted);
    const validateRecords = vi.fn(async () => {});
    const result = await importShippedPluginInstallConfigForDoctor(state.snapshot, {
      prepared: await stage(),
      expectedPending: [],
      validateRecords,
    });
    expect(validateRecords).toHaveBeenCalledOnce();
    expect(result?.pluginInventoryChanged).toBe(false);
    expect(state.commits).toBe(0);
  });
});
