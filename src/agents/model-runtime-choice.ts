import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveCliRuntimeModelBackendBinding } from "./cli-backends.js";
import { modelKey } from "./model-ref-shared.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";
import { resolveProviderModelMaterializationAuthMode } from "./provider-model-route-auth.js";

/** Bind runtime selection and its commit check to the current published model owner. */
export async function preparePublishedModelRuntimeChoice(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir?: string;
  provider: string;
  model: string;
  runtimeId?: string;
  /** A previous session pin is reusable only while this model still offers its route. */
  preferredRuntimeId?: string;
  sessionEntry?: Pick<
    SessionEntry,
    "authProfileOverride" | "authProfileOverrideSource" | "providerOverride" | "modelProvider"
  >;
}): Promise<
  | { kind: "unavailable"; message: string }
  | { kind: "ready"; runtimeId?: string; validate: () => string | undefined }
> {
  const { getPublishedPreparedModelCatalogOwnerSnapshot, materializePreparedModelCatalogOwner } =
    await import("./prepared-model-catalog.js");
  const { getPreparedModelRuntimeAuthStore } = await import("./prepared-model-runtime-auth.js");
  const { createModelCatalogDecisions } = await import("./model-catalog-decisions.js");
  const { selectModelCatalogRuntimeEntry, resolveUniqueNativeModelRuntime } =
    await import("./model-catalog-view.js");
  const published = getPublishedPreparedModelCatalogOwnerSnapshot({
    config: params.cfg,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
  });
  const unavailable = params.runtimeId
    ? `Runtime "${params.runtimeId}" is not available for ${params.provider}/${params.model}. Refresh the model catalog and choose again.`
    : `Choose an explicit runtime for ${params.provider}/${params.model}; its available routes do not identify one native default.`;
  if (!published) {
    return { kind: "unavailable", message: unavailable };
  }
  const owner = materializePreparedModelCatalogOwner(published);
  const authStore = getPreparedModelRuntimeAuthStore(owner);
  if (!authStore) {
    return { kind: "unavailable", message: unavailable };
  }
  const decisions = createModelCatalogDecisions({
    cfg: owner.config,
    agentId: owner.agentId ?? params.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    snapshot: owner.modelCatalog,
    metadataSnapshot: owner.metadataSnapshot,
    preparedAuthStore: authStore,
    preparedRuntimeAuthModes: owner.authModes,
    pluginRegistry: owner.pluginRegistry,
    observationConfig: owner.observationConfig,
    isCurrent: owner.isCurrent,
    preferredProfileId: params.sessionEntry?.authProfileOverride,
    pinnedProfileId:
      params.sessionEntry?.authProfileOverrideSource === "user"
        ? params.sessionEntry.authProfileOverride
        : undefined,
    profileProvider: params.sessionEntry?.providerOverride ?? params.sessionEntry?.modelProvider,
  });
  let entry = decisions.snapshot.entries.find(
    (row) => modelKey(row.provider, row.id) === modelKey(params.provider, params.model),
  );
  const variants = decisions.snapshot.routeVariants.filter(
    (row) => modelKey(row.provider, row.id) === modelKey(params.provider, params.model),
  );
  const configuredRuntime = normalizeOptionalAgentRuntimeId(
    resolveModelRuntimePolicy({
      config: owner.config,
      agentId: params.agentId,
      provider: params.provider,
      modelId: params.model,
    }).policy?.id,
  );
  let runtimeId =
    params.runtimeId ??
    (!isDefaultAgentRuntimeId(configuredRuntime) ? configuredRuntime : undefined) ??
    resolveCliRuntimeModelBackendBinding({ provider: params.provider, runtime: params.provider })
      ?.runtime;
  if (!entry) {
    // Explicit selections may be outside finite browse inventory. The normal
    // resolver still owns the requested model's provider and physical route.
    const { resolveModelAsync } = await import("./embedded-agent-runner/model.js");
    const { modelCatalogRowToEntry } = await import("./model-catalog-entry.js");
    const selectedAuth = await decisions.evaluateEntry(
      { provider: params.provider, id: params.model },
      undefined,
      runtimeId,
    );
    const authProfileMode = resolveProviderModelMaterializationAuthMode(
      selectedAuth.selectedAuthMode,
    );
    if (selectedAuth.availability !== true || !authProfileMode) {
      return { kind: "unavailable", message: unavailable };
    }
    const resolved = await resolveModelAsync(
      params.provider,
      params.model,
      owner.agentDir,
      owner.config,
      {
        agentId: owner.agentId ?? params.agentId,
        workspaceDir: owner.workspaceDir,
        preparedModelRuntime: owner,
        agentRuntimeId: runtimeId,
        allowBundledStaticCatalogFallback: true,
        // Discovery must retain the prepared account instead of rereading live auth stores.
        authProfileMode,
        ...(selectedAuth.selectedProfileId
          ? { authProfileId: selectedAuth.selectedProfileId }
          : {}),
      },
    );
    if (!resolved.model) {
      return { kind: "unavailable", message: unavailable };
    }
    entry = modelCatalogRowToEntry(resolved.model);
  }
  if (!runtimeId && params.preferredRuntimeId) {
    const choices = await decisions.runtimeChoices(entry, variants.length ? variants : [entry]);
    if (choices?.includes(params.preferredRuntimeId)) {
      runtimeId = params.preferredRuntimeId;
    }
  }
  if (!runtimeId) {
    const routes = variants.length ? variants : [entry];
    const hostRoutes = routes.filter((route) => !route.nativeRuntime);
    const hostEntry = hostRoutes[0];
    if (hostEntry) {
      const host = await decisions.evaluateEntry(hostEntry, hostRoutes);
      const validate = () =>
        decisions.isCurrent() && decisions.evaluateNative(hostEntry, host).availability === true
          ? undefined
          : unavailable;
      if (!validate()) {
        return { kind: "ready", validate };
      }
    }
    const nativeRuntime = resolveUniqueNativeModelRuntime(
      routes.filter((route) => route.nativeRuntime),
    );
    if (!nativeRuntime) {
      return { kind: "unavailable", message: unavailable };
    }
    runtimeId = nativeRuntime;
  }
  const choices = await decisions.runtimeChoices(entry, variants.length ? variants : [entry]);
  if (!choices?.includes(runtimeId)) {
    return { kind: "unavailable", message: unavailable };
  }
  const { entry: runtimeEntry } = selectModelCatalogRuntimeEntry({
    entry,
    routeVariants: variants,
    runtimeId,
  });
  const host = await decisions.evaluateEntry(
    runtimeEntry,
    variants.length ? variants : [entry],
    runtimeId,
  );
  const validate = () =>
    decisions.isCurrent() &&
    decisions.evaluateNative(runtimeEntry, host, runtimeId).availability === true
      ? undefined
      : unavailable;

  return { kind: "ready", runtimeId, validate };
}
