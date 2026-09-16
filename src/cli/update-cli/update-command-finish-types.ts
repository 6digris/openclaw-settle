import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import type { UpdateStateSchemaVersion } from "../../infra/update-candidate-state.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import type { readControlPlaneUpdateSentinelMeta } from "../../infra/update-control-plane-sentinel.js";
import type { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { UpdateRestartParams } from "./update-command-service-context-types.js";
import type { UpdateServiceLoadBoundary } from "./update-command-service-load.js";
export type UpdateProfileContext = Pick<
  UpdateRestartParams,
  "preManagedServiceStop" | "ownedManagedUpdateEnv"
> & {
  configSnapshot: ConfigFileSnapshot;
  requestedChannel: UpdateChannel | null;
  storedChannel: UpdateChannel | null;
  preUpdatePluginInstallRecords: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>;
  schemaVersions?: UpdateStateSchemaVersion[];
  previousVerified?: boolean;
  activationConfig?: import("./update-command-config-snapshot.js").UpdateConfigSnapshot;
  packageUpdateNodeRunner?: string;
  serviceRuntimeRefreshRequired?: boolean;
};

type SharedUpdateFinalization = Omit<
  UpdateRestartParams,
  "preManagedServiceStop" | "ownedManagedUpdateEnv" | "serviceRuntimeRefreshRequired"
> & {
  coreAlreadyCurrent?: boolean;
  serviceLoadBoundary?: UpdateServiceLoadBoundary;
  failure?: { cause: unknown; detail: string };
  mutationStarted: boolean;
  expectedVersion?: string;
  previousInstallRoot?: string;
  installKindChanged: boolean;
  channel: UpdateChannel;
  downgradeRisk: boolean;
  opts: UpdateCommandOptions;
  controlPlaneUpdateSentinelMeta: Awaited<ReturnType<typeof readControlPlaneUpdateSentinelMeta>>;
  startedAt: number;
  packageUpdateNodeRunner?: string;
  packageTransaction?: PackageUpdateTransaction;
  candidateSchemaVersions?: OpenClawSchemaVersions;
  previousSchemaVersions?: OpenClawSchemaVersions;
  rollbackBlockedReason?: "state-migrated-no-rollback" | "rollback-state-unverified";
};

export type ProfileFinishUpdateParams = SharedUpdateFinalization & UpdateProfileContext;
export type FinishUpdateParams = SharedUpdateFinalization & {
  profiles: UpdateProfileContext[];
};
