import { readAgentRosterProperty } from "../agents/agent-scope-config.js";
import { createConfigRuntimeEnvBase } from "./config-env-vars.js";
import { restoreEnvVarRefsFromResolved } from "./env-preserve.js";
import { coerceConfig, resolveConfigForRead } from "./io.read-helpers.js";
import type { ConfigWriteInputBasis } from "./io.types.js";
import type { projectAuthoredAgentRosterForWrite as ProjectAuthoredAgentRosterForWrite } from "./io.write-prepare.js";
import { setConfigResolutionFacts } from "./resolution-facts.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

export type ConfigWriteSourceProjectionParams = {
  inputBasis?: ConfigWriteInputBasis;
  runtimeConfig: unknown;
  sourceConfig: unknown;
  nextConfig: unknown;
  unsetPaths?: readonly string[][];
  explicitSetPaths?: readonly (readonly string[])[];
  explicitSetValueSource?: unknown;
};

/** Keep reference identity for persistence separate from values used by physical owners. */
export function prepareConfigWriteValues(
  params: {
    snapshot: ConfigFileSnapshot;
    nextConfig: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    lowerPrecedenceEnv?: Readonly<Record<string, string>>;
    explicitSetPaths?: readonly (readonly string[])[];
    explicitSetValueSource?: OpenClawConfig;
  },
  projectAuthoredAgentRosterForWrite: typeof ProjectAuthoredAgentRosterForWrite,
) {
  const { snapshot } = params;
  const source = snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
  const authored = snapshot.authoredConfig ?? snapshot.parsed;
  const restore = (config: OpenClawConfig, explicitSetPaths?: readonly (readonly string[])[]) => {
    const canonicalRoster = readAgentRosterProperty(config)?.kind === "entries";
    const project = (value: unknown) =>
      canonicalRoster
        ? projectAuthoredAgentRosterForWrite({
            rootAuthoredConfig: value,
            sourceConfigBeforeMigrations: source,
          })
        : value;
    return coerceConfig(
      restoreEnvVarRefsFromResolved(config, project(authored), project(source), explicitSetPaths),
    );
  };
  const authoredConfig = restore(params.nextConfig, params.explicitSetPaths);
  const resolution = resolveConfigForRead(
    authoredConfig,
    createConfigRuntimeEnvBase(source, params.env),
    params.lowerPrecedenceEnv,
  );
  const resolvedConfig = coerceConfig(resolution.resolvedConfigRaw);
  setConfigResolutionFacts(resolvedConfig, resolution.resolutionFacts);
  return {
    authoredConfig,
    resolutionEnv: resolution.envSnapshotForRestore,
    explicitSetValueSource: params.explicitSetValueSource
      ? restore(params.explicitSetValueSource, params.explicitSetPaths)
      : authoredConfig,
    resolvedConfig,
    authoredSourceConfig: restore(snapshot.sourceConfig),
    authoredRuntimeConfig: restore(snapshot.runtimeConfig),
  };
}
