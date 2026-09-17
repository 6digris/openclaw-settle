import path from "node:path";
import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import { resolveConfigPath } from "../../config/paths.js";
import {
  readGatewayServiceCandidates,
  resolveManagedGatewayServiceIdentity,
} from "../../daemon/service-candidates.js";
import { resolveGatewayService, type GatewayServiceState } from "../../daemon/service.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { isCurrentForegroundUpdateHandoffProcess } from "../../infra/update-managed-service-handoff.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import { UpdatePreMutationError } from "./shared.js";
import { formatUpdateAncestryBlockMessage } from "./update-command-handoff.js";
import { captureOwnedManagedUpdatePreflightContext } from "./update-command-managed-context.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  type PreManagedServiceStop,
} from "./update-command-service-maintenance.js";
import {
  collectServiceInspectionFailureFacts,
  GatewayServiceUpdateOwnershipError,
  type ManagedServiceRootRedirect,
} from "./update-command-service-plan.js";
import { inspectGatewayRuntimePublicationSurface } from "./update-command-service-publication.js";

export type UpdateDatabaseProfileAdmission = {
  root: string;
  stopState?: PreManagedServiceStop;
  context: Awaited<ReturnType<typeof captureTargetDatabaseSchemaContext>>;
};

function profileIdentity(profile: Pick<UpdateDatabaseProfileAdmission, "root" | "stopState">) {
  return `${profile.root}\0${
    profile.stopState?.serviceUpdateVerdict?.kind === "owned" && profile.stopState.serviceEnv
      ? resolveManagedGatewayServiceIdentity(profile.stopState.serviceEnv)
      : "caller"
  }`;
}

function profileStateIdentity(context: UpdateDatabaseProfileAdmission["context"]): string {
  return [context.configSnapshot.path, resolveOpenClawStateSqlitePath(context.env)]
    .map((pathname) => resolvePathViaExistingAncestorSync(pathname))
    .join("\0");
}

export async function inspectUpdateDatabaseContexts(params: {
  roots: readonly string[];
  scope?: "installation" | "profile-maintenance";
  updateInstallKind: "package" | "git";
  shouldRestart: boolean;
  jsonMode: boolean;
  timeoutMs: number;
  invocationCwd?: string;
  legacyConfigPlan?: LegacyConfigUpdatePlan;
  managedServiceRootRedirect: ManagedServiceRootRedirect | null;
  expectedProfiles?: readonly UpdateDatabaseProfileAdmission[];
}) {
  const scope = params.scope ?? "installation";
  if (scope === "profile-maintenance" && params.updateInstallKind !== "package") {
    throw new UpdatePreMutationError(
      "managed-service-preflight",
      "Profile maintenance requires a known-current package without shared runtime publication.",
    );
  }
  const roots: readonly string[] = [...new Set(params.roots)];
  const profiles: UpdateDatabaseProfileAdmission[] = [];
  const externalConsumers: { root: string; state: GatewayServiceState }[] = [];
  let fallbackStopState: PreManagedServiceStop | undefined;
  let selectedServiceOwned = false;
  const inspect = async (
    root: string,
    env: NodeJS.ProcessEnv,
    expectedService?: PreManagedServiceStop,
    preparedState?: GatewayServiceState,
  ) => {
    const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
      root,
      env,
      preparedState,
      updateInstallKind: params.updateInstallKind,
      shouldRestart: params.shouldRestart,
      jsonMode: params.jsonMode,
      timeoutMs: params.timeoutMs,
      phase: "inspect",
      expectedService,
    }).catch((error: unknown) => {
      if (error instanceof GatewayServiceUpdateOwnershipError) {
        throw new UpdatePreMutationError("managed-service-preflight", error.message, {
          failureFacts: error.failureFacts,
        });
      }
      throw error;
    });
    const blockMessage =
      inspected.blockMessage ??
      (inspected.serviceUpdateVerdict?.kind === "unavailable" &&
      inspected.serviceUpdateVerdict.inspectionReason === "launchd-system-owned"
        ? inspected.serviceUpdateVerdict.message
        : undefined);
    if (blockMessage) {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        formatUpdateAncestryBlockMessage(blockMessage),
        { failureFacts: collectServiceInspectionFailureFacts(inspected.serviceUpdateVerdict) },
      );
    }
    return inspected;
  };
  const admit = async (root: string, stopState: PreManagedServiceStop) => {
    const context = await captureOwnedManagedUpdatePreflightContext({
      stopState,
      processEnv: process.env,
      invocationCwd: params.invocationCwd,
      legacyConfigPlan: params.legacyConfigPlan,
    });
    if (!context || !stopState.serviceEnv) {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        stopState.serviceMutationSkipMessage ??
          "The managed Gateway service changed before database admission. Retry so its package root and state can be inspected together.",
      );
    }
    profiles.push({ root, stopState, context });
  };

  // Revalidation keeps the admitted native selectors even if the caller's environment changes.
  const selected = params.expectedProfiles?.length
    ? params.expectedProfiles
    : [{ root: undefined, stopState: undefined }];
  for (const previous of selected) {
    // A synthetic caller carries state, not a native service selection.
    if (params.expectedProfiles && previous.stopState === undefined) {
      continue;
    }
    const env = previous.stopState?.serviceEnv ?? process.env;
    for (const root of previous.root ? [previous.root] : roots) {
      if (
        !previous.stopState &&
        (await isCurrentForegroundUpdateHandoffProcess({
          root,
          runId: env[UPDATE_RUN_ID_ENV],
          env,
        }))
      ) {
        // The helper owns this foreground process; discovery below still admits
        // every real native consumer, including a stopped unit for this profile.
        break;
      }
      const inspected = await inspect(root, env, previous.stopState);
      if (inspected.serviceUpdateVerdict?.kind === "owned") {
        await admit(root, inspected);
        selectedServiceOwned ||= previous === selected[0];
        break;
      }
      fallbackStopState ??= inspected;
    }
  }

  if (roots.length > 0) {
    const candidates = await readGatewayServiceCandidates(resolveGatewayService(), {
      env: process.env,
      timeoutMs: params.timeoutMs,
      knownServiceEnvs: profiles.flatMap((profile) =>
        profile.stopState?.serviceEnv ? [profile.stopState.serviceEnv] : [],
      ),
      onInspectionUnavailable: (error) =>
        fallbackStopState?.serviceUpdateVerdict?.kind === "unavailable" &&
        fallbackStopState.serviceUpdateVerdict.inspectionReason === error.reason,
    }).catch((error: unknown) => {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        error instanceof Error
          ? error.message
          : "Gateway service candidates could not be inspected.",
      );
    });
    for (const state of candidates) {
      const externalPlist = state.externalLaunchdPlist;
      const refuseExternal = () =>
        new UpdatePreMutationError(
          "managed-service-preflight",
          `Gateway system service ${JSON.stringify(resolveManagedGatewayServiceIdentity(state.env))}${externalPlist ? ` from ${JSON.stringify(externalPlist)}` : ""} uses this installation or has unverified state. Have its deployment owner coordinate this update; automatic user-service updates do not manage system services.`,
        );
      for (const root of roots) {
        const inspected = externalPlist
          ? undefined
          : await inspect(root, state.env, undefined, state);
        if (externalPlist) {
          const surface = await inspectGatewayRuntimePublicationSurface({
            root,
            readState: async () => state,
            assertCurrent() {},
          }).catch(() => {
            throw refuseExternal();
          });
          if (surface.disjoint) {
            continue;
          }
        } else if (inspected?.serviceUpdateVerdict?.kind !== "owned") {
          continue;
        }
        if (externalPlist || state.systemdInstallation?.kind === "system") {
          if (scope === "installation") {
            throw refuseExternal();
          }
          // Only explicit paths attest an external profile; the caller's HOME cannot supply them.
          const metadata = state.command?.environment;
          if (
            externalPlist &&
            (!path.isAbsolute(metadata?.OPENCLAW_STATE_DIR ?? "") ||
              !path.isAbsolute(metadata?.OPENCLAW_CONFIG_PATH ?? ""))
          ) {
            throw refuseExternal();
          }
          externalConsumers.push({
            root,
            state: externalPlist
              ? {
                  ...state,
                  env: { ...metadata, OPENCLAW_LAUNCHD_LABEL: state.env.OPENCLAW_LAUNCHD_LABEL },
                }
              : state,
          });
        } else if (inspected) {
          await admit(root, inspected);
        }
        break;
      }
    }
  }

  if (params.managedServiceRootRedirect && profiles.length === 0) {
    throw new UpdatePreMutationError(
      "managed-service-preflight",
      "The managed Gateway service changed before database admission. Retry so its package root and state can be inspected together.",
    );
  }
  // Redirected package replacement does not own the invoking installation's stores.
  const contexts = params.managedServiceRootRedirect
    ? []
    : [
        await captureTargetDatabaseSchemaContext(process.env, {
          legacyConfigPlan: params.legacyConfigPlan,
        }),
      ];
  const caller = contexts[0];
  if (roots[0] && caller && !selectedServiceOwned) {
    const callerIdentity = profileStateIdentity(caller);
    const originIndex = profiles.findIndex(
      (profile) => profileStateIdentity(profile.context) === callerIdentity,
    );
    const origin =
      originIndex < 0
        ? { root: roots[0], stopState: fallbackStopState, context: caller }
        : profiles.splice(originIndex, 1)[0]!;
    profiles.unshift(origin);
  }
  contexts.push(
    ...profiles.map((profile) => profile.context).filter((context) => context !== caller),
  );
  const origin = profiles[0]?.context;
  if (origin && externalConsumers.length > 0) {
    const configPath = resolvePathViaExistingAncestorSync(origin.configSnapshot.path);
    const databasePath = resolvePathViaExistingAncestorSync(
      resolveOpenClawStateSqlitePath(origin.env),
    );
    for (const { state } of externalConsumers) {
      if (
        resolvePathViaExistingAncestorSync(resolveConfigPath(state.env)) === configPath ||
        resolvePathViaExistingAncestorSync(resolveOpenClawStateSqlitePath(state.env)) ===
          databasePath
      ) {
        throw new UpdatePreMutationError(
          "managed-service-preflight",
          `Gateway system service ${JSON.stringify(resolveManagedGatewayServiceIdentity(state.env))} shares the selected profile's configuration or state database. Have its deployment owner coordinate profile maintenance.`,
        );
      }
    }
  }
  if (params.expectedProfiles) {
    const expected = new Set(params.expectedProfiles.map(profileIdentity));
    if (
      expected.size !== profiles.length ||
      profiles.some((profile) => !expected.has(profileIdentity(profile)))
    ) {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        "The managed Gateway profile group changed after database admission. Retry so every service sharing the installation can be inspected together.",
      );
    }
  }
  return { scope, roots, profiles, contexts, externalConsumers };
}
