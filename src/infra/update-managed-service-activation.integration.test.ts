/** Real maintenance/client/generated-helper flow with shim service managers, not native macOS proof. */
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createManagedServiceManagerBoundary } from "./update-managed-service-handoff-boundary.test-support.js";
import { signalMockManagedUpdateHandoffReady } from "./update-managed-service-handoff.test-support.js";

const { spawnMock, resolvePreferredOpenClawTmpDirMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolvePreferredOpenClawTmpDirMock: vi.fn(),
}));
vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessModule } =
    await import("../gateway/server-methods/node-child-process.test-support.js");
  return mockNodeChildProcessModule({
    spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
  });
});
vi.mock("../process/child-process-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/child-process-tree.js")>()),
  forceKillChildProcessTree: vi.fn(),
}));
vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));

const tempDirs = new Set<string>();
const cleanups = new Set<() => Promise<void>>();
const leaseCleanups = new Set<() => void>();
const runBoundary = createManagedServiceManagerBoundary({ spawnMock, tempDirs, cleanups });

beforeEach(() => {
  resolvePreferredOpenClawTmpDirMock.mockReturnValue(
    coordinatorDirs.make("openclaw-activation-coordinator-"),
  );
  spawnMock.mockReset();
  spawnMock.mockImplementation((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      pid: process.pid,
      exitCode: null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      unref: vi.fn(),
    });
    process.nextTick(() =>
      signalMockManagedUpdateHandoffReady({
        child,
        paramsPath: args.at(-1) ?? "",
        cleanups: leaseCleanups,
      }),
    );
    return child;
  });
});
afterEach(async () => {
  await Promise.all([...cleanups].map((cleanup) => cleanup()));
  cleanups.clear();
  for (const cleanup of leaseCleanups) {
    cleanup();
  }
  closeOpenClawStateDatabaseForTest();
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
  vi.resetModules();
});

const coordinatorDirs = useAutoCleanupTempDirTracker(afterEach);

// This uses host-native child identities and actual Gateway -> helper -> updater
// ancestry. Only the policy selector and service manager/account boundary are shims.
describe.skipIf(process.platform === "win32")(
  "managed maintenance activation through generated helper",
  () => {
    it.each(["systemd", "launchd"] as const)(
      "keeps %s online through validation, then activates through the helper without direct stop",
      async (kind) => {
        const result = await runBoundary(kind, {
          ledger: true,
          controlDisconnect: "transferred",
          maintenanceActivation: "complete",
          updaterExitCode: 0,
          updaterResult: { status: "ok", mode: "npm" },
        });
        expect(result.state).toMatchObject({
          validationGateReleased: true,
          realGatewayAncestor: true,
          parked: true,
          maintenanceStopped: true,
          stoppedCallback: true,
          acknowledged: true,
          maintenanceVerdict: "owned",
        });
        expect(
          new Set([result.state.gatewayPid, result.state.helperPid, result.state.updaterPid]).size,
        ).toBe(3);
        expect(result.state.directStop).toBeUndefined();
        expect(result.state.maintenanceBlock).toBeUndefined();
        expect(result.state.maintenanceError).toBeUndefined();
        expect(
          result.commands.some((command) =>
            command.includes(kind === "launchd" ? "bootout" : "stop"),
          ),
        ).toBe(true);
        expect(result.run).toMatchObject({ status: "succeeded", phase: "finished" });
      },
    );

    it.each(["invalid-metadata", "revoked-helper"] as const)(
      "refuses %s without native stop or package mutation",
      async (maintenanceActivation) => {
        const result = await runBoundary("launchd", {
          ledger: true,
          controlDisconnect: "transferred",
          maintenanceActivation,
          helperExitCode: maintenanceActivation === "revoked-helper" ? 1 : 18,
          updaterExitCode: 0,
          updaterResult: { status: "ok", mode: "npm" },
        });
        expect(result.state.realGatewayAncestor).toBe(true);
        expect(result.state.maintenanceError).toMatch(
          maintenanceActivation === "invalid-metadata"
            ? /inside the gateway process tree/
            : /ownership is no longer current/,
        );
        expect(result.state.stoppedCallback).toBe(false);
        expect(result.state.acknowledged).toBe(false);
        expect(result.state.directStop).toBeUndefined();
        expect(result.state.parked).toBeUndefined();
        expect(result.commands).toEqual([]);
      },
    );

    it("joins a dispatched native stop before lease revocation retires the lifecycle owner", async () => {
      const result = await runBoundary("launchd", {
        ledger: true,
        controlDisconnect: "transferred",
        maintenanceActivation: "revoked-during-stop",
        launchdTeardown: { waitForNativeTimeout: true },
        helperExitCode: 1,
        updaterExitCode: 0,
        updaterResult: { status: "ok", mode: "npm" },
      });
      expect(result.state.nativeStopSettledBeforeRetirement).toBe(true);
      expect(result.state.directStop).toBeUndefined();
      expect(result.state.maintenanceStopped).toBeUndefined();
    });

    it("retains the acknowledged stop when executor authority is revoked before return", async () => {
      const result = await runBoundary("launchd", {
        ledger: true,
        controlDisconnect: "transferred",
        maintenanceActivation: "revoked-after-ack",
        helperExitCode: 18,
        updaterExitCode: 0,
        updaterResult: { status: "ok", mode: "npm" },
      });
      expect(result.state).toMatchObject({
        parked: true,
        stoppedCallback: true,
        acknowledged: true,
      });
      expect(result.state.maintenanceError).toContain(
        "Update executor was lost during native preparation",
      );
      expect(result.state.directStop).toBeUndefined();
    });
  },
);
