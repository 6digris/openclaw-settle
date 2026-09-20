import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveLegacyInstalledPluginIndexStorePath } from "../plugins/installed-plugin-index-store.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { migrateLegacyConfigMachineState } from "./state-migrations.config-machine-state.js";
import type { PreparedLegacyStateMigrationStep } from "./state-migrations.plan.js";
import { migrateLegacyInstalledPluginIndex } from "./state-migrations.plugin-state.js";
import { createConfigMigrationSources } from "./state-migrations.prelude.js";
import type {
  LegacyStateMigrationEndpoint,
  LegacyStateMigrationStep,
} from "./state-migrations.types.js";

export function createPluginInstallIndexStep(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  hasLegacy: boolean;
}): LegacyStateMigrationStep {
  return {
    id: "plugin-install-index",
    phase: "shared",
    source: [{ kind: "path", path: resolveLegacyInstalledPluginIndexStorePath(params) }],
    target: [
      {
        kind: "sqlite",
        path: resolveOpenClawStateSqlitePath({
          ...params.env,
          OPENCLAW_STATE_DIR: params.stateDir,
        }),
      },
    ],
    requiredness: params.hasLegacy ? "required" : "not-required",
    reversibility: "checkpoint-required",
    collectNotices: true,
    run: () => migrateLegacyInstalledPluginIndex({ stateDir: params.stateDir }),
  };
}

export function createAgentTargetDiscoveryStep(params: {
  configPath: string;
  configIncludedPaths: readonly string[];
  stateDir: string;
  env: NodeJS.ProcessEnv;
  run: LegacyStateMigrationStep["run"];
  refusal?: PreparedLegacyStateMigrationStep["refusal"];
}): LegacyStateMigrationStep {
  return {
    id: "agent-migration-targets",
    phase: "shared",
    source: [
      ...createConfigMigrationSources(params.configPath, params.configIncludedPaths),
      {
        kind: "sqlite",
        path: resolveOpenClawStateSqlitePath({
          ...params.env,
          OPENCLAW_STATE_DIR: params.stateDir,
        }),
      },
      { kind: "path", path: path.join(params.stateDir, "agents") },
    ],
    target: [],
    requiredness: "required",
    reversibility: "not-applicable",
    ...(params.refusal ? { refusal: params.refusal } : {}),
    run: params.run,
  };
}

export function createConfigMachineStateStep(params: {
  config: OpenClawConfig;
  configPath: string;
  configIncludedPaths: readonly string[];
  stateDir: string;
  env: NodeJS.ProcessEnv;
}): LegacyStateMigrationStep {
  const stateEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  return {
    id: "config-machine-state",
    phase: "shared",
    source: createConfigMigrationSources(params.configPath, params.configIncludedPaths),
    target: [{ kind: "sqlite", path: resolveOpenClawStateSqlitePath(stateEnv) }],
    requiredness: "conditional",
    reversibility: "checkpoint-required",
    run: () => migrateLegacyConfigMachineState({ config: params.config, env: stateEnv }),
  };
}

export function createMigrationDetectionStep(params: {
  configPath: string;
  configIncludedPaths: readonly string[];
  stateDir: string;
  run: LegacyStateMigrationStep["run"];
  refusal?: PreparedLegacyStateMigrationStep["refusal"];
}): LegacyStateMigrationStep {
  return {
    id: "migration-detection",
    phase: "shared",
    source: [
      ...createConfigMigrationSources(params.configPath, params.configIncludedPaths),
      { kind: "path", path: params.stateDir },
    ],
    target: [],
    requiredness: "required",
    reversibility: "not-applicable",
    ...(params.refusal ? { refusal: params.refusal } : {}),
    run: params.run,
  };
}

export function createPluginMigrationPreparationStep(params: {
  configPath: string;
  configIncludedPaths: readonly string[];
  pluginIds: readonly string[];
  run: LegacyStateMigrationStep["run"];
  refusal?: PreparedLegacyStateMigrationStep["refusal"];
}): LegacyStateMigrationStep {
  return {
    id: "plugin-migration-preparation",
    phase: "shared",
    source: [
      ...createConfigMigrationSources(params.configPath, params.configIncludedPaths),
      ...params.pluginIds.map((pluginId): LegacyStateMigrationEndpoint => ({
        kind: "owner",
        id: `plugin:${pluginId}`,
      })),
    ],
    target: [],
    requiredness: "required",
    reversibility: "not-applicable",
    ...(params.refusal ? { refusal: params.refusal } : {}),
    run: params.run,
  };
}
