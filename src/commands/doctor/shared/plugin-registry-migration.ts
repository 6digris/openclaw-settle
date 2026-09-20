// Doctor migration from legacy shipped plugin install config into persisted install registry.
import fs from "node:fs";
import {
  extractShippedPluginInstallConfigRecords,
  stripShippedPluginInstallConfigRecords,
} from "../../../config/plugin-install-config-migration.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { loadInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import {
  inspectPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
  resolveInstalledPluginIndexStorePath,
  writePersistedInstalledPluginIndex,
  type InstalledPluginIndexStoreInspection,
  type InstalledPluginIndexStoreOptions,
} from "../../../plugins/installed-plugin-index-store.js";
import {
  loadInstalledPluginIndex,
  type InstalledPluginIndex,
  type LoadInstalledPluginIndexParams,
} from "../../../plugins/installed-plugin-index.js";

export const DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV = "OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION";
export const FORCE_PLUGIN_REGISTRY_MIGRATION_ENV = "OPENCLAW_FORCE_PLUGIN_REGISTRY_MIGRATION";

export type PluginRegistryInstallMigrationPreflightAction =
  | "disabled"
  | "skip-existing"
  | "migrate";

export type PluginRegistryInstallMigrationPreflight = {
  /** Migration action selected before reading or writing registry state. */
  action: PluginRegistryInstallMigrationPreflightAction;
  /** Persisted plugin index path that migration will inspect or write. */
  filePath: string;
  /** True when deprecated force env requested migration despite existing registry. */
  force: boolean;
  /** Deprecation warnings for env toggles that should be shown to users. */
  deprecationWarnings: readonly string[];
};

export type PluginRegistryInstallMigrationResult =
  | {
      status: "disabled" | "skip-existing" | "dry-run";
      migrated: false;
      preflight: PluginRegistryInstallMigrationPreflight;
    }
  | {
      status: "migrated";
      migrated: true;
      preflight: PluginRegistryInstallMigrationPreflight;
      inspection: InstalledPluginIndexStoreInspection;
      current: InstalledPluginIndex;
    };

export type PluginRegistryInstallMigrationParams = LoadInstalledPluginIndexParams &
  InstalledPluginIndexStoreOptions & {
    dryRun?: boolean;
    existsSync?: (path: string) => boolean;
    readConfig?: () => Promise<OpenClawConfig> | OpenClawConfig;
  };

function hasEnvFlag(env: NodeJS.ProcessEnv | undefined, key: string): boolean {
  const value = env?.[key]?.trim().toLowerCase();
  return Boolean(value && value !== "0" && value !== "false" && value !== "no");
}

function forceDeprecationWarning(): string {
  return `${FORCE_PLUGIN_REGISTRY_MIGRATION_ENV} is deprecated and will be removed after the plugin registry migration rollout; use doctor registry repair once available.`;
}

/** Decide whether plugin install registry migration should run for this environment. */
export function preflightPluginRegistryInstallMigration(
  params: PluginRegistryInstallMigrationParams = {},
): PluginRegistryInstallMigrationPreflight {
  const env = params.env ?? process.env;
  const filePath = resolveInstalledPluginIndexStorePath(params);
  const force = hasEnvFlag(env, FORCE_PLUGIN_REGISTRY_MIGRATION_ENV);
  const deprecationWarnings = force ? [forceDeprecationWarning()] : [];
  if (hasEnvFlag(env, DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV)) {
    return {
      action: "disabled",
      filePath,
      force,
      deprecationWarnings,
    };
  }
  const pathExists = params.existsSync ?? fs.existsSync;
  if (!force && pathExists(filePath)) {
    const currentRegistry = readPersistedInstalledPluginIndexSync(params);
    if (currentRegistry) {
      return {
        action: "skip-existing",
        filePath,
        force,
        deprecationWarnings,
      };
    }
  }
  return {
    action: "migrate",
    filePath,
    force,
    deprecationWarnings,
  };
}

async function readMigrationConfig(
  params: PluginRegistryInstallMigrationParams,
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

/** Persist a migrated plugin install registry from legacy config/install records when needed. */
export async function migratePluginRegistryForInstall(
  params: PluginRegistryInstallMigrationParams = {},
): Promise<PluginRegistryInstallMigrationResult> {
  const preflight = preflightPluginRegistryInstallMigration(params);
  if (preflight.action === "disabled") {
    return { status: "disabled", migrated: false, preflight };
  }
  if (preflight.action === "skip-existing") {
    return { status: "skip-existing", migrated: false, preflight };
  }
  if (params.dryRun) {
    return { status: "dry-run", migrated: false, preflight };
  }

  const rawConfig = await readMigrationConfig(params);
  const config = stripShippedPluginInstallConfigRecords(rawConfig) as OpenClawConfig;
  const durableInstallRecords =
    params.installRecords ?? (await loadInstalledPluginIndexInstallRecords(params));
  const installRecords = {
    ...extractShippedPluginInstallConfigRecords(rawConfig),
    ...durableInstallRecords,
  };
  const migrationParams = {
    ...params,
    config,
    installRecords,
  };
  const inspection = await inspectPersistedInstalledPluginIndex(migrationParams);
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
    inspection,
    current,
  };
}
