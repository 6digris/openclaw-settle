import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as schtasksExec from "../../daemon/schtasks-exec.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  taskState: 3 as number | string,
  prepareCutover: vi.fn(),
  cutoverAssert: vi.fn(),
  cutoverRefresh: vi.fn(),
  cutoverRelease: vi.fn(),
}));

vi.mock("../daemon-cli/update-cutover.js", () => ({
  prepareGatewayUpdateCutover: mocks.prepareCutover,
}));

vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(() => ({
    pid: 0,
    output: [null, JSON.stringify({ state: mocks.taskState, lastRunResult: 0 }), ""],
    stdout: JSON.stringify({ state: mocks.taskState, lastRunResult: 0 }),
    stderr: "",
    status: 0,
    signal: null,
  })),
}));

beforeEach(() => {
  mockSystemAccountHome();
  mocks.cutoverAssert.mockReset();
  mocks.cutoverRefresh.mockReset().mockResolvedValue(undefined);
  mocks.cutoverRelease.mockReset().mockResolvedValue(undefined);
  mocks.prepareCutover.mockReset().mockResolvedValue({
    assertCurrent: mocks.cutoverAssert,
    refresh: mocks.cutoverRefresh,
    release: mocks.cutoverRelease,
  });
});
afterEach(() => vi.restoreAllMocks());

async function withServiceHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await makeTempWorkspace("openclaw-update-service-");
  vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(home);
  try {
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
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

it.each(["before request", "lost reply", "reported mutation"] as const)(
  "restores Windows autostart but only reopens admission before native stop: %s",
  (failureAt) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("win32");
      let enabled = true;
      const mutations: string[] = [];
      vi.spyOn(schtasksExec, "execSchtasks").mockImplementation(async (args) => {
        if (args[0] === "/Query") {
          return {
            code: 0,
            stdout: `<Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`,
            stderr: "",
          };
        }
        expect(args[0]).toBe("/Change");
        const action = args.at(-1);
        if (action !== "/ENABLE" && action !== "/DISABLE") {
          throw new Error("Unexpected Scheduled Task mutation");
        }
        mutations.push(action);
        enabled = action === "/ENABLE";
        return { code: 0, stdout: "", stderr: "" };
      });
      const service = createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
        readRuntime: async () => ({ status: "running", pid: 543210 }),
        isLoaded: async () => true,
        stop: vi.fn(async (args) => {
          args.assertCurrent?.();
          // Model /End accepted but its reply lost before the success notification.
          mutations.push("/End");
          if (failureAt === "reported mutation") {
            args.onMutation?.({ mode: "schtasks-stop" });
          }
          throw new Error("native stop reply lost");
        }),
      });
      mocks.service.mockReturnValue(service);
      if (failureAt === "before request") {
        mocks.cutoverRefresh.mockRejectedValue(new Error("cutover stale"));
      }
      const onStopped = vi.fn();
      await expect(
        maybeStopManagedServiceBeforeMutableUpdate({
          root: process.cwd(),
          updateInstallKind: "package",
          shouldRestart: true,
          jsonMode: true,
          onStopped,
        }),
      ).rejects.toThrow(
        failureAt === "before request" ? "cutover stale" : "native stop reply lost",
      );
      expect(enabled).toBe(true);
      expect(mutations).toEqual(
        failureAt === "before request" ? ["/DISABLE", "/ENABLE"] : ["/DISABLE", "/End", "/ENABLE"],
      );
      expect(service.stop).toHaveBeenCalledTimes(failureAt === "before request" ? 0 : 1);
      expect(onStopped).toHaveBeenCalledTimes(failureAt === "reported mutation" ? 1 : 0);
      expect(mocks.cutoverRelease).toHaveBeenCalledTimes(failureAt === "before request" ? 1 : 0);
    }),
);

it.each(["busy", "unavailable", "timeout", "stale"])(
  "defers direct CLI stop on mandatory cutover %s",
  (reason) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("linux");
      const service = createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
        readRuntime: async () => ({
          status: "running",
          pid: 543210,
          systemd: { managerUid: 2001 },
        }),
        isLoaded: async () => true,
      });
      mocks.service.mockReturnValue(service);
      if (reason === "stale") {
        mocks.cutoverRefresh.mockRejectedValue(new Error("cutover stale"));
      } else {
        mocks.prepareCutover.mockRejectedValue(new Error(`cutover ${reason}`));
      }
      await expect(
        maybeStopManagedServiceBeforeMutableUpdate({
          root: process.cwd(),
          updateInstallKind: "package",
          shouldRestart: true,
          jsonMode: true,
        }),
      ).rejects.toThrow(`cutover ${reason}`);
      expect(mocks.prepareCutover).toHaveBeenCalledWith(
        expect.objectContaining({ expectedPid: 543210 }),
      );
      expect(service.stop).not.toHaveBeenCalled();
      if (reason === "stale") {
        expect(mocks.cutoverRelease).toHaveBeenCalledOnce();
      }
    }),
);
