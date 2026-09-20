// Entry-point coverage: external startup repair must use the same correlated result protocol.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAgentCleanupScope } from "../agents/run-cleanup-timeout.js";
import type { TriageBackingReference } from "../infra/triage-backing.js";
import type { runStartupTriageRepair, StartupTriageResult } from "./triage-startup.js";
import { triageCommand } from "./triage.js";
import { createTriageRuntime } from "./triage.test-support.js";

const mocks = vi.hoisted(() => ({
  external: vi.fn(),
  startup: vi.fn(),
  task: vi.fn(),
  executable: vi.fn(),
}));
vi.mock("./doctor-lint.js", () => ({ collectDoctorFindings: async () => [] }));
vi.mock("../infra/executable-path.js", async (original) => ({
  ...(await original<typeof import("../infra/executable-path.js")>()),
  resolveExecutablePath: (binary: string) => (binary === "claude" ? mocks.executable() : undefined),
}));
vi.mock("../process/exec.js", async (original) => ({
  ...(await original<typeof import("../process/exec.js")>()),
  runUtf8CommandWithTimeout: mocks.external,
}));
vi.mock("./triage-startup.js", () => ({ runStartupTriageRepair: mocks.startup }));
vi.mock("./triage-task.js", () => ({ startTriageRepairTask: mocks.task }));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  { healthy: true, exitCode: 0 },
  { healthy: false, exitCode: 0 },
  { healthy: false, exitCode: 17 },
  { healthy: true, exitCode: 0, unavailable: true },
  { healthy: false, exitCode: 1, unavailable: true },
])(
  "verifies external startup before and after repair (healthy=$healthy, exit=$exitCode, unavailable=$unavailable)",
  async ({ healthy, exitCode, unavailable }) => {
    mocks.executable.mockReturnValue(unavailable ? undefined : "/fixture/claude");
    const root = dirs.make("startup-external-route-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    await fs.writeFile(path.join(root, "openclaw.json"), "{}");
    const backing: TriageBackingReference = {
      kind: "triage",
      installationRoot: root,
      leaseDatabase: {
        databasePath: path.join(root, "lease.sqlite"),
        databaseIdentity: "1:2",
        parentIdentity: "1:1",
      },
      generation: {
        version: 2,
        owner: "original-generation",
        helper: { pid: 100, startIdentity: "helper" },
        executor: { pid: 101, startIdentity: "executor" },
        lifetime: {
          kind: "foreground",
          boot: { platform: "linux", identity: "00000000-0000-0000-0000-000000000001" },
        },
      },
    };
    const taskId = "c95a7c4c-d4ee-4d76-a7c4-d32dbde3b148";
    mocks.task.mockReturnValue(taskId);
    mocks.external.mockResolvedValue({
      code: exitCode,
      termination: "exit",
      cleanup: "normal",
      stdout: "agent output",
      stderr: "",
    });
    const valid = {
      ok: true,
      port: 12345,
      bootId: "observed-boot",
      version: "2026.9.11",
      summary: "startup-verified" as const,
    };
    const invalid = { ok: false, port: 12345, summary: "startup-unhealthy" as const };
    mocks.startup.mockImplementation(
      async (params: Parameters<typeof runStartupTriageRepair>[0]) => {
        // The real verifier owns health proof; this fixture checks that the CLI obeys its run/result contract.
        expect(mocks.external).not.toHaveBeenCalled();
        const result = healthy ? undefined : await params.run();
        const report: StartupTriageResult = {
          kind: "startup-repair",
          installationRoot: root,
          generationOwner: backing.generation.owner,
          failure: { kind: "gateway-startup", phase: "startup", gateway: "verify-running" },
          attempted: !healthy,
          before: healthy ? valid : invalid,
          after: healthy || exitCode === 0 ? valid : invalid,
          ...(result ? { agentExitCode: result.exitCode, repairTaskId: result.repairTaskId } : {}),
        };
        return report;
      },
    );
    const runtime = createTriageRuntime();
    const cleanup = createAgentCleanupScope();
    const execution = cleanup.run(() =>
      triageCommand(
        runtime,
        { noExport: true },
        {
          signal: new AbortController().signal,
          assertCurrent: () => {},
          backing,
          failure: {
            kind: "gateway-startup",
            phase: "startup",
            error: "original startup failed",
            gateway: "verify-running",
            installationRoot: root,
          },
        },
      ),
    );
    if (unavailable && !healthy) {
      await expect(execution).rejects.toThrow("No configured embedded agent");
      expect(mocks.startup).toHaveBeenCalledOnce();
      expect(mocks.external).not.toHaveBeenCalled();
      expect(mocks.task).not.toHaveBeenCalled();
      expect(runtime.writeJson).not.toHaveBeenCalled();
      return;
    }
    await execution;
    expect(mocks.startup).toHaveBeenCalledOnce();
    expect(mocks.external).toHaveBeenCalledTimes(healthy ? 0 : 1);
    expect(mocks.task).toHaveBeenCalledTimes(healthy ? 0 : 1);
    expect(runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "startup-repair",
        generationOwner: backing.generation.owner,
        attempted: !healthy,
        after: expect.objectContaining({ ok: healthy || exitCode === 0 }),
        ...(healthy ? {} : { agentExitCode: exitCode, repairTaskId: taskId }),
      }),
      2,
    );
    expect(runtime.exit).not.toHaveBeenCalled();
    if (!healthy) {
      expect(cleanup.outcome).toBe("uncertain");
    }
  },
);
