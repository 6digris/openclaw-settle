import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { inspectPluginMigrationAvailability } from "./plugin-migration-availability.js";
const m = vi.hoisted(() => ({
  plugin: {} as Record<string, unknown>,
  selected: true,
  known: true,
  active: true,
  policy: true,
  bundled: false,
  metadata: true,
}));
vi.mock("../../../config/config-env-vars.js", () => ({}));
vi.mock("../../../config/deferred-plugin-migration-config.js", () => ({
  resolveDeferredPluginMigrationConfigPaths: () => ({}),
}));
vi.mock("../../../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginMetadataSnapshot: () => ({
    plugins: m.metadata ? [m.plugin] : [],
    index: {},
  }),
}));
vi.mock("../../../infra/path-guards.js", () => ({}));
vi.mock("../../../infra/update-rehearsal-paths.js", () => ({
  resolveUpdateRehearsalRoot: () => undefined,
}));
vi.mock("../../../plugins/config-state.js", () => ({ normalizePluginsConfig: () => ({}) }));
vi.mock("../../../plugins/current-plugin-metadata-snapshot.js", () => ({
  withPluginMetadataSnapshotScope: (_: unknown, run: () => unknown) => run(),
}));
vi.mock("../../../plugins/doctor-contract-artifact.js", () => ({
  resolvePluginDoctorContractArtifact: () => "doctor.js",
}));
vi.mock("../../../plugins/installed-plugin-index-scope-lookup.js", () => ({
  createInstalledPluginIndexScopeLookup: () => ({}),
}));
vi.mock("../../../plugins/installed-plugin-index-store-path.js", () => ({}));
vi.mock("../../../plugins/manifest-contract-eligibility.js", () => ({}));
vi.mock("../../../plugins/manifest-owner-policy.js", () => ({
  isActivatedManifestOwner: () => m.active,
  passesManifestOwnerBasePolicy: () => m.policy,
}));
vi.mock("../../../plugins/payload-verification.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/payload-verification.js")>()),
  isPayloadMissing: () => false,
}));
vi.mock("../../../plugins/plugin-cache.js", () => ({
  createPluginCache: () => ({}),
  withPluginCache: (_: unknown, run: () => unknown) => run(),
}));
vi.mock("../../../state/openclaw-state-db-readonly.js", () => ({
  isArtifactPreservingStateRead: () => false,
}));
vi.mock("./configured-runtime-plugin-installs.js", () => ({
  collectConfiguredRuntimeIds: () => [],
}));
vi.mock("./missing-configured-plugin-install.candidates.js", () => ({
  collectUpdateDeferredPluginIds: () => new Set(m.selected ? ["owner"] : []),
  resolveConfiguredPluginInstallContext: async () => ({
    configuredChannelOwnerPluginIds: [],
    bundledPluginsById: new Map(m.bundled ? [["owner", {}]] : []),
    knownIds: new Set(m.known ? ["owner"] : []),
    records: {},
    installedPluginIdsWithRepairablePackages: new Set(),
    configuredPluginIdsWithStaleDescriptors: new Set(),
  }),
}));
vi.mock("./missing-configured-plugin-install.ids.js", () => ({
  collectBlockedPluginIds: () => [],
  collectConfiguredChannelIds: () => [],
  collectConfiguredPluginIds: () => ["owner"],
}));
beforeEach(() => {
  m.selected = true;
  m.known = true;
  m.active = true;
  m.policy = true;
  m.bundled = false;
  m.metadata = true;
  m.plugin = { id: "owner", origin: "global", channels: [], rootDir: "/plugin" };
});
it.each(["configRepair", "resolveSessionStoreAgentIds", "sessionRouteStateOwners"])(
  "retains %s owners as inspection-required instead of proving them stateless",
  async (capability) => {
    m.plugin.doctorContract = { stateMigrations: false, [capability]: true };
    const result = await inspectPluginMigrationAvailability({
      cfg: {},
      env: {},
      installRecords: {},
      deferInstallation: false,
    });
    expect(result.inspectionRequiredPluginIds).toEqual(["owner"]);
    expect(result.statelessPluginIds).toEqual([]);
  },
);
it.each([true, ["state-step"]])(
  "preserves explicit required state migration %s",
  async (stateMigrations) => {
    m.plugin.doctorContract = { stateMigrations };
    const result = await inspectPluginMigrationAvailability({
      cfg: {},
      env: {},
      installRecords: {},
      deferInstallation: true,
    });
    expect(result.requiredPluginIds).toEqual(["owner"]);
    expect(result.pending[0]).toMatchObject({ requiresStateMigration: true });
  },
);
it("keeps a genuinely stateless owner eligible for advisory deferral", async () => {
  m.plugin.doctorContract = { stateMigrations: false };
  const result = await inspectPluginMigrationAvailability({
    cfg: {},
    env: {},
    installRecords: {},
    deferInstallation: false,
  });
  expect(result.statelessPluginIds).toEqual(["owner"]);
  expect(result.inspectionRequiredPluginIds).toEqual([]);
});

it.each(["missing", "inactive", "disabled", "bundled-inactive"])(
  "keeps a retained-only %s owner pending",
  async (kind) => {
    m.selected = false;
    m.plugin.doctorContract = { stateMigrations: true };
    if (kind === "missing") {
      m.known = false;
      m.metadata = false;
    }
    if (kind === "inactive" || kind === "bundled-inactive") {
      m.active = false;
    }
    if (kind === "disabled") {
      m.policy = false;
      m.active = false;
    }
    if (kind === "bundled-inactive") {
      m.bundled = true;
    }
    const result = await inspectPluginMigrationAvailability({
      cfg: {},
      env: {},
      installRecords: {},
      retainedPluginIds: ["owner"],
      deferInstallation: false,
    });
    expect(result.pending).toEqual([expect.objectContaining({ pluginId: "owner" })]);
    expect(result.statelessPluginIds).toEqual([]);
  },
);
it("allows an available active retained-only required owner to attempt its migration", async () => {
  m.selected = false;
  m.plugin.doctorContract = { stateMigrations: true };
  const result = await inspectPluginMigrationAvailability({
    cfg: {},
    env: {},
    installRecords: {},
    retainedPluginIds: ["owner"],
    deferInstallation: false,
  });
  expect(result.requiredPluginIds).toEqual(["owner"]);
  expect(result.pending).toEqual([]);
});

const retainedPayloadDirs = useAutoCleanupTempDirTracker(afterEach);
it.each([false, true])(
  "verifies a retained bundled payload before admitting migration (present=%s)",
  async (present) => {
    const rootDir = retainedPayloadDirs.make("openclaw-retained-payload-");
    const marker = path.join(rootDir, "executed");
    fs.writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "@example/owner", main: "index.cjs" }),
    );
    if (present) {
      fs.writeFileSync(
        path.join(rootDir, "index.cjs"),
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");`,
      );
    }
    m.selected = false;
    m.bundled = true;
    m.plugin = {
      id: "owner",
      origin: "bundled",
      channels: [],
      rootDir,
      doctorContract: { stateMigrations: true },
    };
    const result = await inspectPluginMigrationAvailability({
      cfg: {},
      env: {},
      installRecords: {},
      retainedPluginIds: ["owner"],
      deferInstallation: false,
      verifyRetainedPayloads: true,
    });
    expect(result.requiredPluginIds).toEqual(["owner"]);
    if (present) {
      expect(result.pending).toEqual([]);
    } else {
      expect(result.pending).toEqual([
        expect.objectContaining({
          pluginId: "owner",
          requiresStateMigration: true,
          reason: expect.stringContaining("missing-main-entry"),
        }),
      ]);
    }
    expect(fs.existsSync(marker)).toBe(false);
  },
);
