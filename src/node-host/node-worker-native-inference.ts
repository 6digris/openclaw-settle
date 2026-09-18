import path from "node:path";
import { readSecretFileSync } from "../infra/secret-file.js";
import {
  NativeInferenceStartupSchema,
  type NativeInferenceStartup,
} from "../worker/native-inference-startup.js";

export type NodeWorkerNativeInferenceStartup = NativeInferenceStartup;

/** The trusted supervisor captures file bytes and named credentials before yielding. */
export function snapshotNodeWorkerNativeInference(
  configPath: string | undefined,
  env: NodeJS.ProcessEnv,
): NodeWorkerNativeInferenceStartup | undefined {
  if (configPath === undefined) {
    return undefined;
  }
  if (!path.isAbsolute(configPath) || configPath.includes("\0")) {
    throw new Error("Node worker native inference configuration requires an absolute path");
  }
  let startup: NodeWorkerNativeInferenceStartup;
  try {
    startup = NativeInferenceStartupSchema.parse({
      config: JSON.parse(
        readSecretFileSync(configPath, "Node worker native inference configuration", {
          maxBytes: 1024 * 1024,
        }),
      ),
      credentials: {},
    });
  } catch {
    // Parser and filesystem errors can contain source bytes or operator paths.
    throw new Error("Node worker native inference configuration is invalid or unavailable");
  }
  for (const model of startup.config.models) {
    const value = Object.hasOwn(env, model.apiKeyEnv) ? env[model.apiKeyEnv] : undefined;
    if (!value?.trim()) {
      throw new Error("Node worker native inference credential is unavailable");
    }
    Object.defineProperty(startup.credentials, model.apiKeyEnv, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return startup;
}

/** Diagnostic scrubbing conservatively covers startup headers, including ordinary metadata. */
export function nodeWorkerNativeInferenceSecrets(
  startup: NodeWorkerNativeInferenceStartup,
): string[] {
  return [
    ...Object.values(startup.credentials),
    ...startup.config.models.flatMap((model) => Object.values(model.headers ?? {})),
  ].filter((value) => value.length > 0);
}
