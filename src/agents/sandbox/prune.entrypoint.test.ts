import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { CreateSandboxBackendParams } from "./backend.types.js";

vi.mock("../../skills/loading/workspace-skill-sync.runtime.js", () => ({
  syncWorkspaceSkills: async () => [],
}));
vi.mock("../../skills/runtime/remote.js", () => ({ getRemoteSkillEligibility: () => undefined }));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  (await import("../../state/openclaw-state-db.js")).closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("preserves a live process when another session provisions, then prunes after settlement", async () => {
  const dir = dirs.make("prune-entrypoint-");
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  const { setRuntimeConfigSnapshot } = await import("../../config/config.js");
  const { resolveSandboxConfigForAgent } = await import("./config.js");
  const { createSandboxBackend, registerSandboxBackend } = await import("./backend.js");
  const { readRegistryEntry, updateRegistry } = await import("./registry.js");
  const { resolveSandboxContext } = await import("./context.js");
  const { runExecProcess } = await import("../bash-tools.exec-runtime.js");
  const { maybePruneSandboxes } = await import("./prune.js");
  const backendId = "entrypoint-proof";
  const config = {
    agents: {
      defaults: {
        workspace: dir,
        sandbox: {
          mode: "all" as const,
          backend: backendId,
          scope: "session" as const,
          workspaceRoot: path.join(dir, "sandboxes"),
          prune: { idleHours: 24, maxAgeDays: 7 },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
  const cfg = resolveSandboxConfigForAgent(config);
  const marker = path.join(dir, "process-ready");
  const remove = vi.fn(async () => {});
  const restore = registerSandboxBackend(backendId, {
    factory: async (params: CreateSandboxBackendParams) => ({
      id: backendId,
      runtimeId: params.scopeKey,
      runtimeLabel: params.scopeKey,
      workdir: dir,
      buildExecSpec: async () => ({
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(" +
            JSON.stringify(marker) +
            ", 'ready'); setInterval(() => {}, 1000)",
        ],
        env: process.env,
        stdinMode: "pipe-closed" as const,
      }),
      runShellCommand: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    }),
    manager: {
      describeRuntime: async () => ({ running: true, configLabelMatch: true }),
      removeRuntime: remove,
    },
  });
  let run: Awaited<ReturnType<typeof runExecProcess>> | undefined;
  try {
    const runtimeId = "agent:main:active";
    await updateRegistry({
      containerName: runtimeId,
      backendId,
      sessionKey: runtimeId,
      createdAtMs: Date.now() - 8 * 86400000,
      lastUsedAtMs: Date.now(),
      image: cfg.docker.image,
    });
    const backend = await createSandboxBackend({
      sessionKey: runtimeId,
      scopeKey: runtimeId,
      cfg,
      workspaceDir: dir,
      agentWorkspaceDir: dir,
    });
    run = await runExecProcess({
      command: "hold",
      workdir: dir,
      env: {},
      sandbox: {
        containerName: runtimeId,
        workspaceDir: dir,
        containerWorkdir: dir,
        buildExecSpec: (params) => backend.buildExecSpec(params),
        finalizeExec: backend.finalizeExec,
      },
      usePty: false,
      warnings: [],
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      notifyOnExit: false,
      timeoutSec: null,
    });
    await vi.waitFor(async () => expect(await fs.readFile(marker, "utf8")).toBe("ready"));
    await resolveSandboxContext({ config, sessionKey: "agent:main:other", workspaceDir: dir });
    expect(remove).not.toHaveBeenCalled();
    expect(await readRegistryEntry(runtimeId)).not.toBeNull();
    run.kill();
    await run.promise;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60000);
    await maybePruneSandboxes(cfg);
    expect(remove.mock.calls).toHaveLength(1);
    expect(await readRegistryEntry(runtimeId)).toBeNull();
  } finally {
    run?.kill();
    await run?.promise;
    restore();
  }
});
