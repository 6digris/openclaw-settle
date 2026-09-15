import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshotForWrite } from "../config/io.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import { listMatchingDirs } from "../infra/install-package-dir.test-support.js";
import { selectInstallMutationWriteOptions } from "../plugins/install-config-mutation.js";
import { persistPluginInstall } from "../plugins/install-persistence.js";
import * as installRecordCommit from "../plugins/install-record-commit.js";
import {
  attachPluginInstallTransaction,
  retainPluginInstallTransaction,
  withPluginInstallTransactions,
} from "../plugins/install-transaction.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndexRowSync } from "../plugins/installed-plugin-index-row.js";
import type { PluginLifecycleRuntimeApply } from "../plugins/lifecycle.js";
import {
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "../plugins/managed-npm-retention.js";
import {
  withPluginLifecycleLease,
  type PluginLifecycleLeaseContext,
} from "../plugins/plugin-lifecycle-lease.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import { defaultRuntime } from "../runtime.js";
import { readLeaseDatabase } from "../state/openclaw-state-lease-storage.js";
import * as leaseStore from "../state/openclaw-state-lease-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runPluginUpdateCommand } from "./plugins-update-command.js";

const { updatePreparedPackage } = vi.hoisted(() => ({
  updatePreparedPackage: vi.fn<typeof import("../plugins/update.js").updateNpmInstalledPlugins>(),
}));

vi.mock("../plugins/update.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/update.js")>();
  return { ...actual, updateNpmInstalledPlugins: updatePreparedPackage };
});
vi.mock("./plugins-lifecycle-client.js", () => ({
  resolvePluginLifecycleGateway: async () => null,
}));

afterEach(() => {
  vi.restoreAllMocks();
  updatePreparedPackage.mockReset();
});

function snapshotPackage(directory: string) {
  const identity = fs.statSync(directory, { bigint: true });
  return {
    dev: identity.dev,
    ino: identity.ino,
    entries: fs.readdirSync(directory).toSorted(),
    distEntries: fs.readdirSync(path.join(directory, "dist")).toSorted(),
    packageJson: fs.readFileSync(path.join(directory, "package.json"), "utf8"),
    pluginJson: fs.readFileSync(path.join(directory, "openclaw.plugin.json"), "utf8"),
    entry: fs.readFileSync(path.join(directory, "dist", "index.js"), "utf8"),
  };
}

describe("plugin update command settlement authority", () => {
  it.each([
    { entrypoint: "CLI records", configWrite: false, refuse: false },
    { entrypoint: "CLI records", configWrite: false, refuse: true },
    { entrypoint: "CLI config", configWrite: true, refuse: false },
    { entrypoint: "CLI config", configWrite: true, refuse: true },
    { entrypoint: "direct install", configWrite: false, refuse: false },
    { entrypoint: "direct install", configWrite: false, refuse: true },
  ])(
    "keeps package settlement with its metadata owner through $entrypoint (refusal: $refuse)",
    async ({ entrypoint, configWrite, refuse }) => {
      await withOpenClawTestState({ label: "plugin-update-commit-authority" }, async (state) => {
        const config = { plugins: { enabled: false } };
        await state.writeConfig(config);
        const pluginId = "authority-demo";
        const packageName = "@acme/authority-demo";
        const targetDir = writeManagedNpmPlugin({
          stateDir: state.stateDir,
          packageName,
          pluginId,
          version: "1.0.0",
        });
        const sourceDirs = new Map(
          ["2.0.0", "3.0.0"].map(
            (version) =>
              [
                version,
                writeManagedNpmPlugin({
                  stateDir: state.path(`source-${version}`),
                  packageName,
                  pluginId,
                  version,
                }),
              ] as const,
          ),
        );
        const recordsFor = (version: string): Record<string, PluginInstallRecord> => ({
          [pluginId]: {
            source: "npm",
            spec: `${packageName}@${version}`,
            installPath: targetDir,
            version,
            resolvedName: packageName,
            resolvedVersion: version,
            installedAt: "2026-09-01T00:00:00.000Z",
          },
        });
        await seedInstalledPluginIndex(recordsFor("1.0.0"), { config, env: state.env });
        await markRetainedManagedNpmInstall({
          packageDir: targetDir,
          pluginId,
          reason: "retained-package",
        });
        const markerPath = resolveRetainedManagedNpmInstallMarkerPath(targetDir);
        const markerDir = path.dirname(markerPath);
        const markerDirectoryBefore = fs.statSync(markerDir, { bigint: true });
        const configBefore = fs.readFileSync(state.configPath, "utf8");
        const previousRow = readPersistedInstalledPluginIndexRowSync({ env: state.env });
        const events: string[] = [];
        const publications: Array<{
          transaction: NonNullable<ReturnType<typeof resolvePackageDirInstallTransaction>>;
          lease: PluginLifecycleLeaseContext;
          backupPath: string;
          backup: ReturnType<typeof snapshotPackage>;
          published: ReturnType<typeof snapshotPackage>;
        }> = [];
        let version = "2.0.0";
        const publishPackage = async (
          lease: PluginLifecycleLeaseContext,
          assertCurrent: () => void,
        ) => {
          let backupPath = "";
          const installed = await installPackageDir(
            requestDeferredPackageDirInstall(
              {
                sourceDir: expectDefined(sourceDirs.get(version), "prepared package directory"),
                targetDir,
                mode: "update" as const,
                timeoutMs: 1_000,
                hasDeps: false,
                copyErrorPrefix: "failed to copy plugin",
                depsLogMessage: "",
                afterBackup: async (directory: string) => {
                  backupPath = directory;
                  return { ok: true as const };
                },
              },
              assertCurrent,
            ),
          );
          expect(installed.ok).toBe(true);
          const transaction = expectDefined(
            resolvePackageDirInstallTransaction(installed),
            "real deferred package transaction",
          );
          for (const action of ["commit", "rollback"] as const) {
            const settle = transaction[action];
            vi.spyOn(transaction, action).mockImplementation(async () => {
              events.push(`package-${action}`);
              await settle();
            });
          }
          publications.push({
            transaction,
            lease,
            backupPath,
            backup: snapshotPackage(backupPath),
            published: snapshotPackage(targetDir),
          });
          events.push("package-published");
          return transaction;
        };

        // Supply a prepared package at the updater seam. Lifecycle ownership,
        // directory publication, metadata persistence, and caller settlement remain real.
        updatePreparedPackage.mockImplementation((params) =>
          withPluginLifecycleLease({}, (lease) =>
            withPluginInstallTransactions(
              params,
              () => lease.assertOwned(),
              async (owned, guard) => {
                const transaction = await publishPackage(lease, guard);
                retainPluginInstallTransaction(
                  owned,
                  attachPluginInstallTransaction({}, transaction),
                );
                return {
                  config: {
                    ...params.config,
                    ...(configWrite ? { gateway: { port: 18792 } } : {}),
                    plugins: { ...params.config.plugins, installs: recordsFor(version) },
                  },
                  changed: true,
                  outcomes: [
                    { pluginId, status: "updated" as const, message: "Updated fixture plugin." },
                  ],
                };
              },
            ),
          ),
        );
        vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
        vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
          throw new Error(`Unexpected CLI exit ${code}`);
        });

        let tentativeRow: ReturnType<typeof readPersistedInstalledPluginIndexRowSync>;
        let failNextRead = false;
        let failedReads = 0;
        let metadataRefusal: unknown;
        let recoveredExpiry: number | undefined;
        const readFailure = Object.assign(new Error("database is locked"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 5,
        });
        const readExpiry = leaseStore.readOpenClawStateLeaseExpiry;
        let refusedIdentity: Parameters<typeof readExpiry>[1] | undefined;
        let refusedDatabase: Parameters<typeof readExpiry>[0] | undefined;
        vi.spyOn(leaseStore, "readOpenClawStateLeaseExpiry").mockImplementation((...args) => {
          if (failNextRead) {
            failNextRead = false;
            failedReads += 1;
            [refusedDatabase, refusedIdentity] = args;
            events.push("lease-read-refused");
            throw readFailure;
          }
          return readExpiry(...args);
        });
        const rm = fs.promises.rm.bind(fs.promises);
        vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
          if (target === markerPath) {
            tentativeRow = readPersistedInstalledPluginIndexRowSync({ env: state.env });
            events.push("index-committed");
          }
          await rm(target, options);
          if (target === markerPath) {
            events.push("marker-removed");
            failNextRead = refuse;
          }
        });
        const observeCommit = async <T>(commit: () => Promise<T>): Promise<T> => {
          try {
            const result = await commit();
            events.push("metadata-committed");
            return result;
          } catch (error) {
            metadataRefusal = error;
            events.push("metadata-refused");
            if (refusedIdentity) {
              const identity = refusedIdentity;
              recoveredExpiry = readLeaseDatabase(
                { scope: "shared", options: { env: state.env } },
                (database) => readExpiry(database, identity),
              );
              events.push("underlying-read-recovered");
            }
            throw error;
          }
        };
        const commitOnly = installRecordCommit.commitPluginInstallRecordsOnly;
        const commitConfig = installRecordCommit.commitPluginInstallRecordsWithConfig;
        vi.spyOn(installRecordCommit, "commitPluginInstallRecordsOnly").mockImplementation(
          (params) => observeCommit(() => commitOnly(params)),
        );
        vi.spyOn(installRecordCommit, "commitPluginInstallRecordsWithConfig").mockImplementation(
          (params) => observeCommit(() => commitConfig(params)),
        );

        const applyRuntime = vi.fn<PluginLifecycleRuntimeApply>(async ({ pluginIds }) => ({
          operationId: "fixture-runtime-application",
          generation: 1,
          pluginIds: [...pluginIds],
        }));
        const runUpdate = async () => {
          if (entrypoint !== "direct install") {
            return runPluginUpdateCommand({ id: pluginId, opts: {} });
          }
          await withPluginLifecycleLease({}, async (lease) => {
            const prepared = await readConfigFileSnapshotForWrite();
            expect(prepared.snapshot.valid).toBe(true);
            const transaction = await publishPackage(lease, () => lease.assertOwned());
            await persistPluginInstall({
              snapshot: {
                config: prepared.snapshot.sourceConfig,
                baseHash: prepared.snapshot.hash ?? undefined,
                writeOptions: selectInstallMutationWriteOptions(prepared.writeOptions),
              },
              pluginId,
              install: expectDefined(recordsFor(version)[pluginId], "next install record"),
              transaction,
              enable: false,
              invalidateRuntimeCache: false,
              // Runtime application is a separate owner; observe its admission only.
              applyRuntime,
              beforePersistentApply: () => lease.assertOwned(),
            });
          });
        };
        const [outcome] = await Promise.allSettled([runUpdate()]);
        const first = expectDefined(publications[0], "first package publication");
        expect(updatePreparedPackage).toHaveBeenCalledTimes(
          entrypoint === "direct install" ? 0 : 1,
        );
        expect(tentativeRow).toBeDefined();
        expect(tentativeRow).not.toEqual(previousRow);
        expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(
          recordsFor("2.0.0"),
        );
        expect(snapshotPackage(targetDir)).toEqual(first.published);
        expect(fs.existsSync(markerPath)).toBe(false);

        if (!refuse) {
          expect(outcome.status).toBe("fulfilled");
          expect(failedReads).toBe(0);
          expect(events).toEqual([
            "package-published",
            "index-committed",
            "marker-removed",
            "metadata-committed",
            "package-commit",
          ]);
          expect(fs.existsSync(first.backupPath)).toBe(false);
          expect(fs.existsSync(markerDir)).toBe(false);
          expect(applyRuntime).toHaveBeenCalledTimes(entrypoint === "direct install" ? 1 : 0);
          expect(JSON.parse(fs.readFileSync(state.configPath, "utf8"))).toMatchObject({
            ...config,
            ...(configWrite ? { gateway: { port: 18792 } } : {}),
          });
          return;
        }

        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected") {
          throw new Error("Expected the metadata refusal to reject the update");
        }
        expect(metadataRefusal).toBeInstanceOf(Error);
        expect(metadataRefusal).toHaveProperty("code", "OPENCLAW_STATE_LEASE_STORAGE_FAILED");
        expect((metadataRefusal as Error).cause).toBe(readFailure);
        expect(outcome.reason).toBeInstanceOf(AggregateError);
        expect(outcome.reason.cause).toBe(metadataRefusal);
        expect(outcome.reason.errors).toHaveLength(2);
        expect(outcome.reason.errors[0]).toBe(metadataRefusal);
        expect(outcome.reason.errors[1]).toBe(metadataRefusal);
        expect(failedReads).toBe(1);
        expect(applyRuntime).not.toHaveBeenCalled();
        expect(recoveredExpiry).toBeGreaterThan(Date.now());
        expect(events).toEqual([
          "package-published",
          "index-committed",
          "marker-removed",
          "lease-read-refused",
          "metadata-refused",
          "underlying-read-recovered",
          "package-rollback",
        ]);
        expect(readPersistedInstalledPluginIndexRowSync({ env: state.env })).toEqual(tentativeRow);
        expect(snapshotPackage(first.backupPath)).toEqual(first.backup);
        const markerDirectoryAfter = fs.statSync(markerDir, { bigint: true });
        expect([markerDirectoryAfter.dev, markerDirectoryAfter.ino]).toEqual([
          markerDirectoryBefore.dev,
          markerDirectoryBefore.ino,
        ]);
        expect(fs.readFileSync(state.configPath, "utf8")).toBe(configBefore);
        expect(
          await listMatchingDirs(path.dirname(targetDir), ".openclaw-install-rollback-"),
        ).toEqual([]);
        const assertOldOwnerRefused = async () => {
          const database = expectDefined(refusedDatabase, "refused lease verification database");
          await expect(Promise.resolve().then(() => first.lease.assertOwned())).rejects.toBe(
            metadataRefusal,
          );
          await expect(
            Promise.resolve().then(() => first.lease.assertOwnedInTransaction(database)),
          ).rejects.toBe(metadataRefusal);
          await expect(first.transaction.commit()).rejects.toBe(metadataRefusal);
          await expect(first.transaction.rollback()).rejects.toBe(metadataRefusal);
        };
        await assertOldOwnerRefused();

        version = "3.0.0";
        await expect(runUpdate()).resolves.toBeUndefined();
        const recovered = expectDefined(publications[1], "fresh owner package publication");
        expect(recovered.lease).not.toBe(first.lease);
        expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(
          recordsFor("3.0.0"),
        );
        expect(snapshotPackage(targetDir)).toEqual(recovered.published);
        expect(fs.existsSync(recovered.backupPath)).toBe(false);
        await withPluginLifecycleLease({ env: state.env }, async () => {
          await assertOldOwnerRefused();
        });
        expect(snapshotPackage(targetDir)).toEqual(recovered.published);
        expect(snapshotPackage(first.backupPath)).toEqual(first.backup);
      });
    },
  );
});
