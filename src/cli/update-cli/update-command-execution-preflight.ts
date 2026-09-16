import { defaultRuntime } from "../../runtime.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import {
  checkTargetDatabaseSchemasForContexts,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import { UpdatePreMutationError } from "./shared.js";
import { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import { revalidateUpdateDatabaseContext } from "./update-command-managed-context.js";
export async function recheckUpdateExecutionSchemas(
  params: MutableUpdateExecutionParams,
  admission: Awaited<ReturnType<typeof inspectUpdateDatabaseContexts>> | undefined,
  versions: OpenClawSchemaVersions | undefined,
): Promise<void> {
  const { opts, updateStepTimeoutMs } = params;

  if (!admission) {
    throw new UpdatePreMutationError(
      "database-schema-preflight",
      "Database admission was not inspected.",
    );
  }
  await inspectUpdateDatabaseContexts({
    roots: [...admission.services.keys()],
    updateInstallKind: params.updateInstallKind === "git" ? "git" : "package",
    shouldRestart: params.shouldRestart,
    jsonMode: Boolean(opts.json),
    timeoutMs: updateStepTimeoutMs,
    invocationCwd: params.invocationCwd,
    managedServiceRootRedirect: params.managedServiceRootRedirect,
    expectedServices: admission.services,
    legacyConfigPlan: params.legacyConfigPlan,
  });
  admission.contexts = await Promise.all(admission.contexts.map(revalidateUpdateDatabaseContext));
  const schemas = await checkTargetDatabaseSchemasForContexts(versions, admission.contexts);
  if (hasSchemaRefusal(schemas)) {
    throw new UpdatePreMutationError(
      "database-schema-preflight",
      formatSchemaRefusalLines(schemas).join("\n"),
    );
  }
}

export async function preflightUpdateExecutionPlugins(
  params: MutableUpdateExecutionParams,
  admission: Awaited<ReturnType<typeof inspectUpdateDatabaseContexts>>,
  targetVersion: string | null,
): Promise<void> {
  const { opts } = params;

  const { preflightConfiguredNpmPluginTargets } =
    await import("./update-command-plugin-preflight.js");
  const context = admission!.contexts.at(-1)!;
  const warnings = await preflightConfiguredNpmPluginTargets({
    config: context.configSnapshot.sourceConfig,
    env: context.env,
    targetVersion,
    channel: params.channel,
    timeoutMs: params.updateStepTimeoutMs,
  });
  for (const warning of warnings) {
    defaultRuntime[opts.json ? "error" : "log"](warning.message);
  }
}

export function resolveMutableUpdateMode(params: MutableUpdateExecutionParams) {
  return params.updateInstallKind === "git"
    ? "git"
    : (params.packageInstallTarget?.manager ?? "unknown");
}
