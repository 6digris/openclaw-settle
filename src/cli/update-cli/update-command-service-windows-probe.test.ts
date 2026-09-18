import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { beginDoctorMaintenance } from "../../commands/doctor-maintenance.js";
import * as doctorServicePolicy from "../../commands/doctor-service-repair-policy.js";
import { buildTaskScript, readScheduledTaskCommand } from "../../daemon/schtasks-layout.js";
import { readScheduledTaskRuntime } from "../../daemon/schtasks-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const mocks = vi.hoisted(() => ({ service: vi.fn<() => GatewayService>() }));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(() => ({
    pid: 0,
    output: [null, JSON.stringify({ state: 4, lastRunResult: 0 }), ""],
    stdout: JSON.stringify({ state: 4, lastRunResult: 0 }),
    stderr: "",
    status: 0,
    signal: null,
  })),
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => mockSystemAccountHome());
afterEach(() => vi.restoreAllMocks());

async function withServiceHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = dirs.make("openclaw-update-windows-probe-");
  vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(home);
  await withEnvAsync(
    {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData"),
      OPENCLAW_GATEWAY_PORT: undefined,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_SERVICE_MARKER: undefined,
      OPENCLAW_SERVICE_KIND: undefined,
    },
    () => run(home),
  );
}

it.each([
  { code: "ETIMEDOUT", failures: 1, recovered: true },
  { code: "ETIMEDOUT", failures: 2, recovered: false },
  { code: "ETIMEDOUT", failures: 2, recovered: false, admitted: true },
  { code: "ENOENT", failures: 1, recovered: false },
])("handles Scheduled Task probe failures before update: %j", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("win32");
    vi.mocked(spawnSync).mockReset();
    for (let attempt = 0; attempt < scenario.failures; attempt++) {
      vi.mocked(spawnSync).mockReturnValueOnce({
        pid: 0,
        output: [null, "", ""],
        stdout: "",
        stderr: "",
        status: null,
        signal: null,
        error: Object.assign(new Error(`spawnSync powershell.exe ${scenario.code}`), {
          code: scenario.code,
        }),
      });
    }
    const service = createMockGatewayService({
      readCommand: vi.fn(async () => ({
        programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
        environment: { HOME: home },
      })),
      readRuntime: readScheduledTaskRuntime,
      isLoaded: async () => true,
    });
    mocks.service.mockReturnValue(service);

    const inspection = maybeStopManagedServiceBeforeMutableUpdate({
      root: process.cwd(),
      updateInstallKind: "package",
      shouldRestart: true,
      phase: "inspect",
      jsonMode: true,
      timeoutMs: 30_000,
      expectedService: scenario.admitted
        ? {
            serviceUpdateVerdict: {
              kind: "owned",
              root: process.cwd(),
              fingerprint: "admitted-definition",
              refreshDefinition: true,
            },
          }
        : undefined,
    });

    if (scenario.admitted) {
      await expect(inspection).rejects.toThrow("Scheduled Task probe timed out after 30000 ms");
    } else {
      const inspected = await inspection;
      expect(inspected.blockMessage).toBeUndefined();
      if (scenario.recovered) {
        expect(inspected.serviceUpdateVerdict?.kind).toBe("owned");
        expect(inspected.running).toBe(true);
      } else {
        expect(inspected.serviceUpdateVerdict?.kind).toBe("unavailable");
        expect(inspected.serviceMutationSkipMessage).toContain(
          "Restart the Gateway you launched manually after the update.",
        );
        if (scenario.code === "ETIMEDOUT") {
          expect(inspected.serviceMutationSkipMessage).toContain(
            "Scheduled Task probe timed out after 30000 ms",
          );
          expect(inspected.serviceMutationSkipMessage).toContain("ETIMEDOUT");
        }
      }
    }
    const attempts = scenario.code === "ETIMEDOUT" ? 2 : 1;
    expect(spawnSync).toHaveBeenCalledTimes(attempts);
    expect(service.readCommand).toHaveBeenCalledTimes(attempts);
    for (const call of vi.mocked(spawnSync).mock.calls) {
      expect(call[2]?.timeout).toBe(30_000);
    }
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  }),
);

it.each([
  { stage: "registration", responses: ["timeout", "found", "found", "found"], recovered: true },
  {
    stage: "revalidation",
    responses: ["found", "timeout", "found", "found", "found"],
    recovered: true,
  },
  { stage: "registration", responses: ["timeout", "timeout"], recovered: false },
  { stage: "revalidation", responses: ["found", "timeout", "found", "timeout"], recovered: false },
  {
    stage: "command then runtime",
    responses: ["timeout", "found", "found", "timeout"],
    recovered: false,
  },
  { stage: "unavailable", responses: ["unavailable"], recovered: false },
])("keeps strict Scheduled Task inspection through $stage failures: $responses", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("win32");
    const scriptPath = "C:\\Registered Service\\gateway.cmd";
    const script = Buffer.from(
      buildTaskScript({
        programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
        environment: { HOME: home },
      }),
    );
    const nativeReadFile = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementation(async (pathname, options) =>
      pathname === scriptPath ? script : nativeReadFile(pathname, options),
    );
    vi.mocked(spawnSync).mockReset();
    for (const response of scenario.responses) {
      const stdout =
        response === "found"
          ? JSON.stringify({
              taskPath: "\\OpenClaw Gateway",
              state: 4,
              actions: [{ type: 0, path: scriptPath, arguments: "", workingDirectory: "" }],
            })
          : "";
      vi.mocked(spawnSync).mockReturnValueOnce({
        pid: 0,
        output: [null, stdout, ""],
        stdout,
        stderr: "",
        status: response === "found" ? 0 : response === "unavailable" ? 2 : null,
        signal: null,
        ...(response === "timeout"
          ? { error: Object.assign(new Error("probe timed out"), { code: "ETIMEDOUT" }) }
          : {}),
      });
    }
    const service = createMockGatewayService({
      readCommand: vi.fn(readScheduledTaskCommand),
      readRuntime: readScheduledTaskRuntime,
      isLoaded: async () => true,
    });
    mocks.service.mockReturnValue(service);
    const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
      root: process.cwd(),
      updateInstallKind: "package",
      shouldRestart: true,
      phase: "inspect",
      jsonMode: true,
      timeoutMs: 47_000,
    });
    expect(inspected.serviceUpdateVerdict?.kind).toBe(scenario.recovered ? "owned" : "unavailable");
    if (scenario.recovered) {
      expect(inspected.running).toBe(true);
      expect(inspected.serviceEnv?.HOME).toBe(home);
    } else {
      expect(inspected.serviceMutationSkipMessage).toContain(
        scenario.stage === "unavailable"
          ? "Scheduled Task probe failed (exit 2): no output from PowerShell."
          : "Scheduled Task probe timed out after 47000 ms (ETIMEDOUT).",
      );
      expect(inspected.serviceEnv).toBeUndefined();
    }
    expect(spawnSync).toHaveBeenCalledTimes(scenario.responses.length);
    for (const call of vi.mocked(spawnSync).mock.calls) {
      expect(call[2]?.timeout).toBe(47_000);
    }
    expect(service.readCommand).toHaveBeenCalledTimes(scenario.stage === "unavailable" ? 1 : 2);
    for (const [, options] of vi.mocked(service.readCommand).mock.calls) {
      expect(options).toMatchObject({
        requireEffective: true,
        requireLoaded: true,
        timeoutMs: 47_000,
      });
    }
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  }),
);

it("preserves a silent Scheduled Task probe failure through update and Doctor warnings", () =>
  withServiceHome(async (home) => {
    mockProcessPlatform("win32");
    vi.spyOn(doctorServicePolicy, "shouldManageGatewayService").mockResolvedValue(true);
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 2,
      signal: null,
    });
    const service = createMockGatewayService({
      readCommand: async () => ({
        programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
        environment: { HOME: home },
      }),
      readRuntime: readScheduledTaskRuntime,
      isLoaded: async () => true,
    });
    mocks.service.mockReturnValue(service);
    const inspection = await maybeStopManagedServiceBeforeMutableUpdate({
      root: process.cwd(),
      updateInstallKind: "package",
      shouldRestart: true,
      phase: "inspect",
      jsonMode: true,
    });
    expect(inspection).toMatchObject({
      stopped: false,
      serviceMutationAllowed: false,
      serviceUpdateVerdict: { kind: "unavailable" },
    });
    const detail = "Scheduled Task probe failed (exit 2): no output from PowerShell.";
    expect(inspection.blockMessage).toBeUndefined();
    expect(inspection.serviceMutationSkipMessage).toContain(detail);
    const maintenance = await beginDoctorMaintenance({
      root: process.cwd(),
      options: { repair: true },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    try {
      expect(maintenance?.warnings).toEqual([expect.stringContaining(detail)]);
      expect(maintenance?.warnings?.[0]).toContain(
        "Restart the Gateway you launched manually after the update.",
      );
      await maintenance?.finish({});
    } finally {
      await maintenance?.release();
    }
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  }));
