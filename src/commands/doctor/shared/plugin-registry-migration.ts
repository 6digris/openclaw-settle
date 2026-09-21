// Doctor migration from legacy shipped plugin install config into persisted install registry.
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { ReadConfigFileSnapshotForWriteResult } from "../../../config/io.js";
import { ConfigMutationConflictError } from "../../../config/mutation-conflict.js";
import { inspectShippedPluginInstallConfigRecords } from "../../../config/plugin-install-config-migration.js";
import {
  copyPluginInstallRecordMap,
  setPluginInstallRecordMapEntry,
} from "../../../config/plugin-install-record-map.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import {
  assertDeferredPluginMigrationsCurrent,
  type DeferredPluginMigration,
} from "../../../infra/deferred-plugin-migrations.js";
import {
  inspectPersistedInstalledPluginIndexInstallRecordsSync,
  readPersistedInstalledPluginIndexRowSync,
} from "../../../plugins/installed-plugin-index-record-state.js";
import {
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
  readPersistedInstalledPluginIndexInstallRecords,
  withoutPluginInstallRecords,
} from "../../../plugins/installed-plugin-index-records.js";
import { writePersistedInstalledPluginIndex } from "../../../plugins/installed-plugin-index-store-write.js";
import {
  readPersistedInstalledPluginIndexSync,
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "../../../plugins/installed-plugin-index-store.js";
import {
  loadInstalledPluginIndex,
  type InstalledPluginIndex,
  type LoadInstalledPluginIndexParams,
} from "../../../plugins/installed-plugin-index.js";
import {
  isTrustedOfficialPluginInstallRecord,
  resolveTrustedOfficialClawHubPackageName,
  resolveTrustedSourceLinkedOfficialClawHubInstall,
} from "../../../plugins/official-external-install-records.js";
import { createPluginCache, withPluginCache } from "../../../plugins/plugin-cache.js";

/** Backfill shipped ClawHub authority only from a catalog-bound legacy install record. */
export function migrateOfficialPluginInstallProvenance(
  records: Record<string, PluginInstallRecord>,
): Record<string, PluginInstallRecord> {
  const migrated = copyPluginInstallRecordMap(records);
  for (const [pluginId, record] of Object.entries(records)) {
    // Partial or conflicting authority is not a legacy shape. Local sources must
    // be reinstalled; package metadata cannot establish the missing source fact.
    if (
      record.source !== "clawhub" ||
      record.clawhubUrl !== undefined ||
      record.clawhubChannel !== undefined ||
      record.sourcePath !== undefined ||
      !resolveTrustedSourceLinkedOfficialClawHubInstall({ pluginId, record })
    ) {
      continue;
    }
    const normalized: PluginInstallRecord = {
      ...record,
      clawhubUrl: "https://clawhub.ai",
      clawhubChannel: "official",
    };
    const packageName = resolveTrustedOfficialClawHubPackageName(normalized);
    if (isTrustedOfficialPluginInstallRecord({ pluginId, packageName, record: normalized })) {
      setPluginInstallRecordMapEntry(migrated, pluginId, normalized);
    }
  }
  return migrated;
}

type PluginRegistryDoctorMigrationPreflight =
  | {
      /** Migration action selected before reading or writing registry state. */
      action: "skip-existing";
      /** Persisted plugin index path that migration will inspect or write. */
      filePath: string;
      /** Authoritative pre-repair generation used to detect a real inventory change. */
      current: InstalledPluginIndex;
    }
  | {
      action: "initialize" | "migrate";
      filePath: string;
    };

type PluginRegistryDoctorMigrationResult =
  | {
      status: "skip-existing" | "dry-run";
      migrated: false;
      preflight: PluginRegistryDoctorMigrationPreflight;
    }
  | {
      status: "migrated";
      migrated: true;
      preflight: PluginRegistryDoctorMigrationPreflight;
      current: InstalledPluginIndex;
    };

export class InvalidPluginInstallRecordStateError extends Error {}

function invalidPersistedInstallRecordMessage(filePath: string): string {
  return [
    `Persisted plugin install records are invalid at ${filePath}.`,
    "Stop the Gateway, back up this database, delete only the config_machine_state row with state_key='plugins.installedIndex' using SQLite tooling, then rerun `openclaw doctor --fix` to rebuild it.",
  ].join(" ");
}

const INVALID_CONFIG_INSTALL_RECORD_MESSAGE =
  "plugins.installs contains invalid records. Back up openclaw.json, correct or remove the invalid retired plugins.installs record, then rerun `openclaw doctor --fix`.";

function mergeShippedPluginInstallRecords(
  previous: Record<string, PluginInstallRecord>,
  persisted: Record<string, PluginInstallRecord> | null,
  source: Record<string, PluginInstallRecord>,
): Record<string, PluginInstallRecord> {
  const next = copyPluginInstallRecordMap(previous);
  for (const [pluginId, record] of Object.entries(source)) {
    // Authored provenance outranks disk recovery, but never an existing ledger owner.
    if (!persisted || !Object.hasOwn(persisted, pluginId)) {
      setPluginInstallRecordMapEntry(next, pluginId, record);
    }
  }
  return migrateOfficialPluginInstallProvenance(next);
}

/** Preview the same install-record merge that the importer repeats under its lease. */
export function readShippedPluginInstallConfigImportRecords(
  snapshot: ConfigFileSnapshot,
  options: InstalledPluginIndexStoreOptions = {},
): Record<string, PluginInstallRecord> | undefined {
  const source = inspectShippedPluginInstallConfigRecords(snapshot.sourceConfig);
  if (source.status === "missing") {
    return undefined;
  }
  if (source.status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(INVALID_CONFIG_INSTALL_RECORD_MESSAGE);
  }
  return mergeShippedPluginInstallRecords(
    loadInstalledPluginIndexInstallRecordsSync(options),
    readPersistedInstalledPluginIndexInstallRecords(options),
    source.records,
  );
}

/** In-memory admission inventory, not a receipt authorizing removal of source records. */
type PreparedShippedPluginInstallConfigImport = {
  source: Pick<ConfigFileSnapshot, "path" | "hash" | "sourceConfig">;
  databasePath: string;
  installRecords: Record<string, PluginInstallRecord>;
  /** Exact canonical row includes its revision; absence is distinct from an empty index. */
  persistedIndexValue: string | undefined;
  includeFileHashesForWrite: Record<string, string> | undefined;
  includeFileTargetsForWrite: Record<string, string> | undefined;
  assertConfigPathForWrite: (() => void) | undefined;
};

async function readPluginImportSourceForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
  const { createConfigIO } = await import("../../../config/config.js");
  const { createManagedRuntimeEnvBase } = await import("../../../config/io.read-helpers.js");
  const { hasManagedRuntimeConfigWriteOwner } = await import("../../../config/runtime-snapshot.js");
  // "skip" can still collect executable legacy diagnostics on invalid config. Core-only cannot.
  const options = { pluginValidation: "core-only" as const, observe: false };
  const processIo = createConfigIO(options);
  const io = hasManagedRuntimeConfigWriteOwner(processIo.configPath)
    ? createConfigIO({ ...options, env: createManagedRuntimeEnvBase() })
    : processIo;
  const current = await io.readConfigFileSnapshotForWrite();
  current.writeOptions.assertConfigPathForWrite?.();
  return current;
}

function readImportIndexValue(databasePath: string): string | undefined {
  return readPersistedInstalledPluginIndexRowSync({
    filePath: databasePath,
    artifactPreservingReadOnly: true,
  })?.value_json;
}

function assertPreparedImportCurrent(
  staged: PreparedShippedPluginInstallConfigImport,
  current: ReadConfigFileSnapshotForWriteResult,
): void {
  staged.assertConfigPathForWrite?.();
  current.writeOptions.assertConfigPathForWrite?.();
  if (
    staged.databasePath !== resolveInstalledPluginIndexStorePath() ||
    !isDeepStrictEqual(staged.source, {
      path: current.snapshot.path,
      hash: current.snapshot.hash,
      sourceConfig: current.snapshot.sourceConfig,
    }) ||
    !isDeepStrictEqual(
      staged.includeFileHashesForWrite,
      current.writeOptions.includeFileHashesForWrite,
    ) ||
    !isDeepStrictEqual(
      staged.includeFileTargetsForWrite,
      current.writeOptions.includeFileTargetsForWrite,
    )
  ) {
    throw new ConfigMutationConflictError("config changed after plugin install preparation");
  }
  if (readImportIndexValue(staged.databasePath) !== staged.persistedIndexValue) {
    throw new ConfigMutationConflictError("plugin index revision changed after preparation");
  }
}

/** Stage merged source inventory without publishing it or loading executable plugin contracts. */
export async function prepareShippedPluginInstallConfigImport(
  snapshot: ConfigFileSnapshot,
): Promise<PreparedShippedPluginInstallConfigImport | undefined> {
  const source = inspectShippedPluginInstallConfigRecords(snapshot.sourceConfig);
  if (source.status === "missing") {
    return undefined;
  }
  if (source.status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(INVALID_CONFIG_INSTALL_RECORD_MESSAGE);
  }
  // Capture include ownership without executing the payload being admitted or observing writes.
  const current = await readPluginImportSourceForWrite();
  const databasePath = resolveInstalledPluginIndexStorePath();
  const persistedIndexValue = readImportIndexValue(databasePath);
  const installRecords = withPluginCache(createPluginCache(), () =>
    readShippedPluginInstallConfigImportRecords(snapshot, {
      filePath: databasePath,
      artifactPreservingReadOnly: true,
    }),
  );
  const staged: PreparedShippedPluginInstallConfigImport = {
    source: structuredClone({
      path: snapshot.path,
      hash: snapshot.hash,
      sourceConfig: snapshot.sourceConfig,
    }),
    databasePath,
    installRecords: copyPluginInstallRecordMap(structuredClone(installRecords)),
    persistedIndexValue,
    includeFileHashesForWrite: structuredClone(current.writeOptions.includeFileHashesForWrite),
    includeFileTargetsForWrite: structuredClone(current.writeOptions.includeFileTargetsForWrite),
    assertConfigPathForWrite: current.writeOptions.assertConfigPathForWrite,
  };
  assertPreparedImportCurrent(staged, current);
  return staged;
}

type ShippedPluginInstallConfigImportOptions =
  | {
      prepared: PreparedShippedPluginInstallConfigImport;
      /** Persisted debt generation admitted by the caller, not staged convergence output. */
      expectedPending: readonly DeferredPluginMigration[];
      /** Full plugin-aware validation after required-owner convergence; throw to refuse. */
      validateRecords: (records: Record<string, PluginInstallRecord>) => void | Promise<void>;
    }
  | {
      prepared?: undefined;
      expectedPending?: undefined;
      validateRecords?: (records: Record<string, PluginInstallRecord>) => void | Promise<void>;
    };

export type ShippedPluginInstallConfigImport = {
  source: Pick<ConfigFileSnapshot, "path" | "hash" | "sourceConfig">;
  databasePath: string;
  pluginInventoryChanged: boolean;
};

/** Check the accepted source again inside the config writer's lock. */
export function assertShippedPluginInstallConfigImportCurrent(
  snapshot: ConfigFileSnapshot,
  imported: ShippedPluginInstallConfigImport | undefined,
): void {
  const source = inspectShippedPluginInstallConfigRecords(snapshot.sourceConfig);
  if (source.status === "missing") {
    return;
  }
  if (source.status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(INVALID_CONFIG_INSTALL_RECORD_MESSAGE);
  }
  if (
    !imported ||
    typeof imported.pluginInventoryChanged !== "boolean" ||
    imported.databasePath !== resolveInstalledPluginIndexStorePath() ||
    !isDeepStrictEqual(imported.source, {
      path: snapshot.path,
      hash: snapshot.hash,
      sourceConfig: snapshot.sourceConfig,
    })
  ) {
    throw new ConfigMutationConflictError("config changed after plugin install migration");
  }
}

/**
 * Publish retired source records before Doctor can restore or rewrite their config.
 * Automatic admission must stage inventory first and pass it back only after convergence.
 * Its validator must perform full plugin-aware validation, not the core-only repair preview.
 */
export async function importShippedPluginInstallConfigForDoctor(
  snapshot: ConfigFileSnapshot,
  options: ShippedPluginInstallConfigImportOptions = {},
): Promise<ShippedPluginInstallConfigImport | undefined> {
  const staged = options.prepared;
  if (staged && !Array.isArray(options.expectedPending)) {
    throw new ConfigMutationConflictError(
      "plugin migration admission requires its debt generation",
    );
  }
  // A validator must not be able to replace the generation after asynchronous admission.
  const expectedPending = staged ? structuredClone(options.expectedPending) : undefined;
  const assertDebtCurrent = expectedPending
    ? () => assertDeferredPluginMigrationsCurrent({ expectedPending })
    : undefined;
  if (
    staged &&
    (!isDeepStrictEqual(staged.source, {
      path: snapshot.path,
      hash: snapshot.hash,
      sourceConfig: snapshot.sourceConfig,
    }) ||
      staged.databasePath !== resolveInstalledPluginIndexStorePath())
  ) {
    throw new ConfigMutationConflictError("config changed after plugin install preparation");
  }
  const source = inspectShippedPluginInstallConfigRecords(snapshot.sourceConfig);
  if (source.status === "missing") {
    return undefined;
  }
  if (source.status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(INVALID_CONFIG_INSTALL_RECORD_MESSAGE);
  }
  const { readConfigFileSnapshotForWrite, withConfigMutationExclusive } =
    await import("../../../config/config.js");
  const sourceIdentity = {
    path: snapshot.path,
    hash: snapshot.hash,
    sourceConfig: snapshot.sourceConfig,
  };
  const receipt = (databasePath: string, pluginInventoryChanged: boolean) => ({
    source: structuredClone(sourceIdentity),
    databasePath,
    pluginInventoryChanged,
  });
  if (!staged && Object.keys(source.records).length === 0) {
    return receipt(resolveInstalledPluginIndexStorePath(), false);
  }
  const { commitPluginInstallRecordsOnly } =
    await import("../../../plugins/install-record-commit.js");
  const { withPluginLifecycleLease } = await import("../../../plugins/plugin-lifecycle-lease.js");
  // Installers take the plugin lease before the config lock; retain that order here.
  // Nested index writers inherit this authority and invoke it synchronously from
  // assertOwnedInTransaction under the canonical write's coordinator/transaction.
  // An async validation precheck cannot cover the later publication boundary.
  return await withPluginLifecycleLease({ assertCurrent: assertDebtCurrent }, async (lease) =>
    withConfigMutationExclusive(async () => {
      lease.assertOwned();
      if (staged && staged.databasePath !== lease.databasePath) {
        throw new ConfigMutationConflictError("plugin index changed after preparation");
      }
      const readCurrentSource = () =>
        staged ? readPluginImportSourceForWrite() : readConfigFileSnapshotForWrite();
      const prepared = await readCurrentSource();
      if (staged) {
        assertPreparedImportCurrent(staged, prepared);
      }
      if (
        prepared.snapshot.path !== snapshot.path ||
        prepared.snapshot.hash !== snapshot.hash ||
        !isDeepStrictEqual(prepared.snapshot.sourceConfig, snapshot.sourceConfig)
      ) {
        throw new ConfigMutationConflictError("config changed before plugin install migration");
      }
      const storeOptions = { filePath: lease.databasePath, artifactPreservingReadOnly: true };
      const readInventory = async () => {
        const previousInstallRecords = await loadInstalledPluginIndexInstallRecords(storeOptions);
        const persisted = readPersistedInstalledPluginIndexInstallRecords(storeOptions);
        const nextInstallRecords = mergeShippedPluginInstallRecords(
          previousInstallRecords,
          persisted,
          source.records,
        );
        return { previousInstallRecords, persisted, nextInstallRecords };
      };
      const { previousInstallRecords, persisted, nextInstallRecords } = staged
        ? await withPluginCache(createPluginCache(), readInventory)
        : await readInventory();
      if (
        staged &&
        !isDeepStrictEqual(nextInstallRecords, copyPluginInstallRecordMap(staged.installRecords))
      ) {
        throw new ConfigMutationConflictError("plugin inventory changed after preparation");
      }
      // Await refusal before the first canonical write. Do not let validation mutate the merge.
      await options.validateRecords?.(
        copyPluginInstallRecordMap(structuredClone(nextInstallRecords)),
      );
      lease.assertOwned();
      if (staged) {
        // Validation/convergence may await: identical merged records do not fence deletions or ABA.
        const current = await readCurrentSource();
        const refreshed = withPluginCache(createPluginCache(), () =>
          readShippedPluginInstallConfigImportRecords(current.snapshot, storeOptions),
        );
        lease.assertOwned();
        assertPreparedImportCurrent(staged, current);
        if (!isDeepStrictEqual(refreshed, nextInstallRecords)) {
          throw new ConfigMutationConflictError("plugin inventory changed during validation");
        }
      }
      if (isDeepStrictEqual(nextInstallRecords, persisted)) {
        return receipt(lease.databasePath, false);
      }
      await commitPluginInstallRecordsOnly({
        previousInstallRecords,
        nextInstallRecords,
        nextConfig: withoutPluginInstallRecords(snapshot.sourceConfig),
        verifyConfigFresh: async () => {
          prepared.writeOptions.assertConfigPathForWrite?.();
          const current = await readCurrentSource();
          // Includes can change without changing the root hash; retain the whole write ownership.
          if (
            current.snapshot.path !== prepared.snapshot.path ||
            current.snapshot.hash !== prepared.snapshot.hash ||
            !isDeepStrictEqual(
              current.writeOptions.includeFileHashesForWrite,
              prepared.writeOptions.includeFileHashesForWrite,
            ) ||
            !isDeepStrictEqual(
              current.writeOptions.includeFileTargetsForWrite,
              prepared.writeOptions.includeFileTargetsForWrite,
            )
          ) {
            throw new ConfigMutationConflictError("config changed during plugin install migration");
          }
        },
      });
      return receipt(lease.databasePath, true);
    }),
  );
}

export type PluginRegistryDoctorMigrationParams = LoadInstalledPluginIndexParams &
  InstalledPluginIndexStoreOptions & {
    dryRun?: boolean;
    existsSync?: (path: string) => boolean;
    readConfig?: () => Promise<OpenClawConfig> | OpenClawConfig;
  };

/** Decide whether Doctor should migrate the plugin registry in this environment. */
export function preflightPluginRegistryDoctorMigration(
  params: PluginRegistryDoctorMigrationParams = {},
): PluginRegistryDoctorMigrationPreflight {
  const filePath = resolveInstalledPluginIndexStorePath(params);
  const persistedState = inspectPersistedInstalledPluginIndexInstallRecordsSync(params);
  if (persistedState.status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(invalidPersistedInstallRecordMessage(filePath));
  }
  const configInstallState = params.config
    ? inspectShippedPluginInstallConfigRecords(params.config)
    : undefined;
  if (configInstallState?.status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(INVALID_CONFIG_INSTALL_RECORD_MESSAGE);
  }
  const pathExists = params.existsSync ?? fs.existsSync;
  if (pathExists(filePath)) {
    const currentRegistry = readPersistedInstalledPluginIndexSync(params);
    if (currentRegistry) {
      return {
        action: "skip-existing",
        filePath,
        current: currentRegistry,
      };
    }
    // Install records without a readable index is a half-written registry, not a fresh root:
    // report it as a migration so doctor keeps warning and rebuilds from what survived.
    if (persistedState.status !== "missing") {
      return { action: "migrate", filePath };
    }
  }
  const hasConfigInstallRecords =
    configInstallState?.status === "valid" && Object.keys(configInstallState.records).length > 0;
  // Only a caller that supplied config can prove nothing is left to migrate. Without config, or with
  // retired plugins.installs records still present, stay on "migrate" so the warning is not lost.
  return {
    action: params.config && !hasConfigInstallRecords ? "initialize" : "migrate",
    filePath,
  };
}

async function readMigrationConfig(
  params: PluginRegistryDoctorMigrationParams,
): Promise<OpenClawConfig> {
  if (params.config) {
    return params.config;
  }
  if (params.readConfig) {
    return await params.readConfig();
  }
  const configModule = await import("../../../config/config.js");
  return await configModule.readBestEffortConfig();
}

/** Rebuild Doctor's plugin registry from canonical install records when needed. */
export async function migratePluginRegistryForDoctor(
  params: PluginRegistryDoctorMigrationParams = {},
): Promise<PluginRegistryDoctorMigrationResult> {
  const preflight = preflightPluginRegistryDoctorMigration(params);
  if (preflight.action === "skip-existing") {
    return { status: "skip-existing", migrated: false, preflight };
  }
  if (params.dryRun) {
    return { status: "dry-run", migrated: false, preflight };
  }

  const rawConfig = await readMigrationConfig(params);
  if (inspectShippedPluginInstallConfigRecords(rawConfig).status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(INVALID_CONFIG_INSTALL_RECORD_MESSAGE);
  }
  const config = withoutPluginInstallRecords(rawConfig);
  const installRecords = migrateOfficialPluginInstallProvenance(
    params.installRecords ?? (await loadInstalledPluginIndexInstallRecords(params)),
  );
  const migrationParams = {
    ...params,
    config,
    installRecords,
  };
  const candidateIndex = loadInstalledPluginIndex({
    ...migrationParams,
  });
  const current: InstalledPluginIndex = {
    ...candidateIndex,
    refreshReason: "migration",
  };
  await writePersistedInstalledPluginIndex(current, params);
  return {
    status: "migrated",
    migrated: true,
    preflight,
    current,
  };
}
