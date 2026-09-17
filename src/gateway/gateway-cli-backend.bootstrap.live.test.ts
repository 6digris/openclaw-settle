// Credential-free proof of the CLI fixture's bootstrap/provenance path in the live pool.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createMemoryRuntime } from "../../extensions/memory-core/src/runtime-provider.js";
import { buildBootstrapInjectionStats } from "../agents/bootstrap-budget.js";
import { resolveBootstrapContextForRun } from "../agents/bootstrap-files.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordMemoryArtifactWriteProvenance } from "../memory/memory-artifact-provenance.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { classifyActiveMemoryWorkspacePaths } from "../plugins/memory-runtime.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBootstrapWorkspace } from "./gateway-cli-backend.live-helpers.js";

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
});

it("reports the CLI workspace USER.md while retaining untrusted-memory exclusion", async () => {
  await withOpenClawTestState({ label: "cli-bootstrap-provenance" }, async (state) => {
    const workspace = await createBootstrapWorkspace(state.root);
    const config: OpenClawConfig = {
      agents: {
        defaults: { workspace: workspace.workspaceRootDir },
        entries: { dev: {} },
      },
      plugins: {
        enabled: true,
        allow: ["memory-core"],
        slots: { memory: "memory-core" },
      },
    };
    await state.writeConfig(config);
    // Only registry selection is supplied by the fixture; classifier, broker and stores are real.
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({
      id: "memory-core",
      source: "/plugins/memory-core/index.js",
      origin: "config",
      enabled: true,
      configSchema: false,
    });
    const instance = new PluginInstance(record.id, { record, registry });
    registry.plugins.push(record);
    registry.memoryCapabilities.push({
      pluginId: record.id,
      memorySlotSelected: true,
      capability: instance.wrap({ runtime: createMemoryRuntime() }),
    });
    try {
      await withPluginRuntimeRegistryScope(registry, async () => {
        const warnings: string[] = [];
        const params = {
          config,
          agentId: "dev",
          workspaceDir: workspace.workspaceDir,
          sessionKey: "agent:dev:live-cli-backend",
          warn: (message: string) => warnings.push(message),
        };
        const prepared = await resolveBootstrapContextForRun(params);
        const stats = buildBootstrapInjectionStats({
          bootstrapFiles: prepared.bootstrapFiles,
          injectedFiles: prepared.contextFiles,
        });
        for (const expected of workspace.expectedInjectedFiles) {
          expect(
            stats.map((entry) => entry.name),
            warnings.join("\n"),
          ).toContain(expected);
        }
        expect(stats.find((entry) => entry.name === "USER.md")?.injectedChars).toBeGreaterThan(0);
        const classification = {
          cfg: config,
          agentId: "dev",
          workspaceDir: workspace.workspaceDir,
          relativePaths: ["USER.md"],
        };
        await expect(classifyActiveMemoryWorkspacePaths(classification)).resolves.toEqual({
          status: "classified",
          classifications: [{ relativePath: "USER.md", originClass: "agent" }],
        });

        const content = await fs.readFile(path.join(workspace.workspaceDir, "USER.md"), "utf8");
        await recordMemoryArtifactWriteProvenance({
          workspaceDir: workspace.workspaceDir,
          relativePath: "USER.md",
          contentBefore: content,
          contentAfter: content,
          originClass: "untrusted",
          observedAt: 1,
        });
        const restricted = await resolveBootstrapContextForRun(params);
        expect(restricted.bootstrapFiles.map((file) => file.name)).not.toContain("USER.md");
        expect(restricted.contextFiles.some((file) => path.basename(file.path) === "USER.md")).toBe(
          false,
        );
        await expect(classifyActiveMemoryWorkspacePaths(classification)).resolves.toEqual({
          status: "classified",
          classifications: [{ relativePath: "USER.md", originClass: "untrusted" }],
        });
        expect(warnings).toEqual([]);
      });
    } finally {
      await instance.dispose();
    }
  });
});
