import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { z } from "zod";

const SharedProgressRequestsSchema = z.array(
  z.object({
    run: z.string().optional(),
    stage: z.string().optional(),
    call: z.object({ function: z.object({ name: z.string().optional() }).optional() }).optional(),
  }),
);

export async function prepareSharedProgressFixtureConfig(cfg: OpenClawConfig) {
  const root = process.env.OPENCLAW_QA_SHARED_PROGRESS_ROOT;
  const run = process.env.OPENCLAW_QA_SHARED_PROGRESS_RUN;
  const endpoint = new URL(
    process.env.OPENCLAW_QA_SHARED_PROGRESS_PROVIDER_URL ?? "http://invalid",
  );
  if (
    !root ||
    !path.isAbsolute(root) ||
    !run ||
    !/^SP-[a-z0-9-]+$/.test(run) ||
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.pathname !== "/" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      "Shared-progress proof needs an absolute asset root, unique SP-run and explicit loopback provider URL",
    );
  }
  const health = await fetch(new URL("health", endpoint), { signal: AbortSignal.timeout(5000) });
  if (!health.ok || (await health.json()).fixture !== "shared-progress-v1") {
    throw new Error("The owned deterministic shared-progress provider is not ready");
  }
  const rootPatchText = await fs.readFile(path.join(root, "root-config.json"), "utf8");
  // SAFETY: Opt-in proof assets supply this patch; the maintained config.patch owner validates it before use.
  const rootPatch = JSON.parse(rootPatchText) as OpenClawConfig;
  const modelRef = "shared-progress-fixture/model";
  const patch: OpenClawConfig = {
    logging: { ...cfg.logging, ...rootPatch.logging },
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        ...rootPatch.agents?.defaults,
        model: { primary: modelRef },
      },
      list: cfg.agents?.list?.map((agent) => ({ ...agent, model: { primary: modelRef } })),
    },
    tools: rootPatch.tools,
    plugins: {
      ...cfg.plugins,
      entries: { ...cfg.plugins?.entries, ...rootPatch.plugins?.entries },
    },
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        "shared-progress-fixture": {
          baseUrl: new URL("v1", endpoint).href,
          apiKey: "local-synthetic-fixture",
          api: "openai-completions",
          models: [
            {
              id: "model",
              name: "Shared progress synthetic fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
  };
  return { run, endpoint, patch };
}

export async function sharedProgressWorkersAreHolding(endpoint: URL, run: string) {
  const response = await fetch(new URL("debug/requests", endpoint), {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error("Provider decision evidence unavailable");
  }
  const requests = SharedProgressRequestsSchema.parse(await response.json());
  return [
    ["parent-yield", "sessions_yield"],
    ["Maple-hold", "exec"],
    ["Cedar-hold", "exec"],
  ].every(([stage, tool]) =>
    requests.some(
      (row) => row.run === run && row.stage === stage && row.call?.function?.name === tool,
    ),
  );
}
