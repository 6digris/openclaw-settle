import { realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isPathInside } from "../infra/path-guards.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { NativeRuntimeConfigSchema } from "./native-runtime-config.js";

/** Private node-to-worker startup carrier, never part of a Gateway turn envelope. */
export const WORKER_NATIVE_INFERENCE_STARTUP_ENV = "OPENCLAW_WORKER_NATIVE_INFERENCE_STARTUP";
export const NativeInferenceStartupSchema = z.strictObject({
  config: NativeRuntimeConfigSchema,
  credentials: z.record(z.string(), z.string()),
});
export type NativeInferenceStartup = z.infer<typeof NativeInferenceStartupSchema>;

/** Consume before running tools; no model credentials remain in child-process environments. */
export function takeNativeInferenceStartup(
  env: NodeJS.ProcessEnv = process.env,
): NativeInferenceStartup | undefined {
  const value = env[WORKER_NATIVE_INFERENCE_STARTUP_ENV];
  delete env[WORKER_NATIVE_INFERENCE_STARTUP_ENV];
  if (value === undefined) {
    return undefined;
  }
  try {
    return NativeInferenceStartupSchema.parse(JSON.parse(value));
  } catch {
    throw new Error("Invalid node-local inference startup configuration");
  }
}

export function assertNativeInferenceAssignment(
  startup: NativeInferenceStartup,
  descriptor: WorkerLaunchDescriptor,
): void {
  const assignment = descriptor.assignment;
  const grant = startup.config.workspaces.find((workspace) => workspace.id === assignment.agentId);
  const modelRef = assignment.modelRef.provider + "/" + assignment.modelRef.model;
  if (
    assignment.inference !== "runtime-local" ||
    !grant ||
    !(
      path.resolve(grant.path) === path.resolve(assignment.workspaceDir) ||
      (grant.scope === "subdirectories" &&
        isPathInside(path.resolve(grant.path), path.resolve(assignment.workspaceDir)))
    ) ||
    (grant.sessionId !== undefined && grant.sessionId !== descriptor.admission.sessionId) ||
    (grant.models !== undefined && !grant.models.includes(modelRef)) ||
    !startup.config.models.some(
      (model) =>
        model.provider === assignment.modelRef.provider && model.id === assignment.modelRef.model,
    )
  ) {
    throw new Error(
      "Node-local inference is not authorized for this agent, session, workspace, or model",
    );
  }
}

/** A child receives only this grant and its permitted models, never another agent's credentials. */
export function projectNativeInferenceStartup(
  startup: NativeInferenceStartup,
  descriptor: WorkerLaunchDescriptor,
): NativeInferenceStartup {
  assertNativeInferenceAssignment(startup, descriptor);
  const grant = startup.config.workspaces.find(
    (entry) => entry.id === descriptor.assignment.agentId,
  )!;
  const root = realpathSync(grant.path);
  const workspace = realpathSync(descriptor.assignment.workspaceDir);
  if (workspace !== root && !(grant.scope === "subdirectories" && isPathInside(root, workspace))) {
    throw new Error("Node-local inference workspace escapes its provisioned root");
  }
  const models = startup.config.models.filter(
    (model) => grant.models === undefined || grant.models.includes(model.provider + "/" + model.id),
  );
  return NativeInferenceStartupSchema.parse({
    config: { models, workspaces: [{ ...grant, path: root }] },
    credentials: Object.fromEntries(
      models.map((model) => [model.apiKeyEnv, startup.credentials[model.apiKeyEnv]]),
    ),
  });
}
