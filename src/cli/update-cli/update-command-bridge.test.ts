import { afterEach, expect, it, vi } from "vitest";
import * as entrypointOwner from "../../daemon/gateway-entrypoint.js";
import * as rootOwner from "../../infra/openclaw-root.js";
import * as supervisor from "../../infra/supervisor-markers.js";
import * as handoffOwner from "../../infra/update-managed-service-handoff.js";
import { resolveUpdateRoot } from "./shared.js";
import * as executorOwner from "./update-command-executor.js";
import { handoffUpdateFromGateway } from "./update-command-handoff.js";
import { assertBridgePackageTarget, prepareUpdateCommand } from "./update-command-run.js";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("leaves normal invocation root discovery with its existing owner", async () => {
  const resolve = vi
    .spyOn(rootOwner, "resolveOpenClawPackageRoot")
    .mockResolvedValue("/normal-install");
  expect(await resolveUpdateRoot()).toBe("/normal-install");
  expect(resolve).toHaveBeenCalled();
});

it("rejects a structural bridge context instead of accepting it as a root override", async () => {
  const resolve = vi.spyOn(rootOwner, "resolveOpenClawPackageRoot");
  await expect(resolveUpdateRoot({ kind: "update-bridge" })).rejects.toThrow("never admitted");
  expect(resolve).not.toHaveBeenCalled();
});

it("refuses bridge continuation before runtime or mutable preparation", async () => {
  await expect(
    prepareUpdateCommand({
      bridge: { kind: "update-bridge" },
      recovery: {},
    }),
  ).rejects.toThrow(/cannot adopt|fresh shell/);
});

it.runIf(process.platform === "linux" || process.platform === "darwin")(
  "refuses a required managed handoff before releasing the fence or resolving the old entrypoint",
  async () => {
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", undefined);
    vi.spyOn(supervisor, "detectRespawnSupervisor").mockReturnValue("systemd");
    const release = vi.spyOn(executorOwner, "releaseUpdateCommandPreflightForHandoff");
    const entrypoint = vi.spyOn(entrypointOwner, "resolveGatewayInstallEntrypoint");
    const start = vi.spyOn(handoffOwner, "startManagedServiceUpdateHandoff");
    const stopProgress = vi.fn();
    const fence = { assertCurrent: vi.fn() };
    const opts = {
      bridge: { kind: "update-bridge" as const },
      run: { runId: "bridge-test", env: {}, executorFence: fence },
    };
    await expect(
      handoffUpdateFromGateway({
        state: {
          installed: true,
          loadState: { status: "loaded" },
          running: true,
          command: null,
          env: {},
          runtime: { status: "running", pid: 42 },
        },
        root: "/old-install",
        mode: "npm",
        opts,
        timeoutMs: 1000,
        stopProgress,
      }),
    ).rejects.toThrow("cannot transfer to the installed updater");
    expect(stopProgress).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(entrypoint).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(opts.run.executorFence).toBe(fence);
  },
);

it("refuses package-manager selection of the executing install instead of the bound target", () => {
  const target = {
    root: "/old-install",
    updateInstallKind: "package",
    packageInstallTarget: { packageRoot: "/executing-bridge" },
  };
  expect(() => assertBridgePackageTarget({ bridge: { kind: "update-bridge" } }, target)).toThrow(
    "package-manager target",
  );
  expect(() => assertBridgePackageTarget({}, target)).not.toThrow();
});
