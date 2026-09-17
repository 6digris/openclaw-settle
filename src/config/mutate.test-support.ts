import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

export function createSnapshot(params: {
  hash: string;
  path?: string;
  parsed?: unknown;
  sourceConfig: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
}): ConfigFileSnapshot {
  const runtimeConfig = (params.runtimeConfig ??
    params.sourceConfig) as ConfigFileSnapshot["config"];
  const sourceConfig = params.sourceConfig as ConfigFileSnapshot["sourceConfig"];
  const parsed = params.parsed ?? params.sourceConfig;
  return {
    path: params.path ?? "/tmp/openclaw.json",
    exists: true,
    raw: `${JSON.stringify(parsed, null, 2)}\n`,
    parsed,
    sourceConfig,
    resolved: sourceConfig,
    valid: true,
    runtimeConfig,
    config: runtimeConfig,
    hash: params.hash,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}
