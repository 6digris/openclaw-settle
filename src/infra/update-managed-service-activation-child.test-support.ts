// Source updater adapter: only service discovery/account identity and the scratch
// root are synthetic. Maintenance, ancestry, leases, activation and helper stay real.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ManagedServiceBoundaryOptions } from "./update-managed-service-handoff-boundary-contract.test-support.js";

export type ManagedActivationScenario =
  | "complete"
  | "invalid-metadata"
  | "revoked-helper"
  | "revoked-after-ack"
  | "revoked-during-stop";

export function createManagedMaintenanceActivationScript(params: {
  kind: "systemd" | "launchd";
  root: string;
  runId: string;
  gatewayPid: number;
  coordinatorDir: string;
  statePath: string;
  sourceRuntimeImport: string;
  updaterScript: string;
  scenario: ManagedActivationScenario;
}): string {
  return `void (async () => {
    ${params.sourceRuntimeImport}
    const { runManagedMaintenanceActivation } = await import(${JSON.stringify(new URL("./update-managed-service-activation-child.test-support.ts", import.meta.url).href)});
    await runManagedMaintenanceActivation(${JSON.stringify({ ...params, sourceRuntimeImport: undefined, updaterScript: undefined })});
    ${params.updaterScript}
  })().catch((error) => { console.error(error); process.exit(18); });`;
}

export async function runManagedMaintenanceActivation(params: {
  kind: "systemd" | "launchd";
  root: string;
  runId: string;
  gatewayPid: number;
  coordinatorDir: string;
  statePath: string;
  scenario: ManagedActivationScenario;
}): Promise<void> {
  const { root, statePath, scenario } = params;
  const validation = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(validation.validationGateReleased, true);
  const source = (relative: string) => new URL(relative, import.meta.url).href;
  os.userInfo = new Proxy(os.userInfo, {
    apply(target, receiver, args) {
      const account = Reflect.apply(target, receiver, args);
      return { ...account, homedir: Buffer.isBuffer(account.homedir) ? Buffer.from(root) : root };
    },
  });
  os.homedir = () => root;
  syncBuiltinESMExports();
  process.env.HOME = root;
  delete process.env.OPENCLAW_SERVICE_MARKER;
  delete process.env.OPENCLAW_SERVICE_KIND;
  delete process.env.OPENCLAW_GATEWAY_SERVICE_PID;
  delete process.env.OPENCLAW_SUPERVISOR_MODE;
  delete process.env.OPENCLAW_PROFILE;

  // Cache native PID readers before selecting the launchd policy branch on Linux.
  // Helper and updater must use the host's actual start identities, never fake PIDs.
  const pidIdentity = await import("../shared/pid-alive.js");
  pidIdentity.getFileLockProcessStartTime(process.pid);
  const hostPlatform = process.platform;
  const nativeExecFileSync = childProcess.execFileSync;
  // Darwin policy asks ps for lstart. Translate that single native probe back to
  // the host's real PID birth identity so it still matches the helper's lease.
  if (params.kind === "launchd" && hostPlatform === "linux") {
    const procStarts = (pid: number) => {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return Number(
        stat
          .slice(stat.lastIndexOf(")") + 1)
          .trim()
          .split(/\s+/)[19],
      );
    };
    childProcess.execFileSync = new Proxy(nativeExecFileSync, {
      apply(target, receiver, args: unknown[]) {
        const [file, argv] = args;
        if (
          file === "/bin/ps" &&
          Array.isArray(argv) &&
          argv[0] === "-o" &&
          argv[1] === "lstart="
        ) {
          return new Date(procStarts(Number(argv[3])) * 1000).toUTCString().replace(/ GMT$/, "");
        }
        return Reflect.apply(target, receiver, args);
      },
    });
    syncBuiltinESMExports();
  }
  const replacements = new Map([
    [
      source("./tmp-openclaw-dir.ts"),
      `export * from ${JSON.stringify(source("./tmp-openclaw-dir.ts") + "?fixture-original")};
       export function resolvePreferredOpenClawTmpDir() { return ${JSON.stringify(params.coordinatorDir)}; }`,
    ],
    [
      source("../daemon/service.ts"),
      `
      import fs from "node:fs";
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      export * from ${JSON.stringify(source("../daemon/service.ts") + "?fixture-original")};
      export function resolveGatewayService() {
        return {
          label: ${JSON.stringify(params.kind)}, loadedText: "loaded", notLoadedText: "not loaded",
          isLoaded: async () => true,
          isEnabled: async () => true,
          readCommand: async () => ({
            programArguments: [process.execPath, ${JSON.stringify(path.join(root, "dist", "index.js"))}, "gateway", "run"],
            environment: {},
          }),
          readRuntime: async () => ({ status: "running", pid: ${params.gatewayPid}, systemd: { managerUid: ${process.getuid?.() ?? 501} } }),
          stop: async () => {
            await require(${JSON.stringify(createRequire(import.meta.url).resolve("@openclaw/fs-safe/store"))}).jsonStore({
              filePath: ${JSON.stringify(statePath)}, lock: true,
            }).updateOr({}, state => ({ ...state, directStop: true }));
            throw new Error("direct service.stop must not replace managed activation");
          },
        };
      }
    `,
    ],
  ]);
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      const replacement = replacements.get(url);
      return replacement === undefined
        ? nextLoad(url, context)
        : {
            format: "module",
            source: replacement,
            shortCircuit: true,
          };
    },
  });
  // Actual service discovery is deliberately substituted; retain all policy and
  // ownership checks on its snapshot, including the real ancestor walk.
  const { maybeStopManagedServiceBeforeMutableUpdate } =
    await import("../cli/update-cli/update-command-service-maintenance.js");
  const { createManagedHandoffLeaseStore } =
    await import("./update-managed-service-handoff-lease.js");
  const { getSelfAndAncestorPidsSync } = await import("./restart-stale-pids.js");
  const { jsonStore } = await import("@openclaw/fs-safe/store");
  const record = (values: Record<string, unknown>) =>
    jsonStore<Record<string, unknown>>({ filePath: statePath, lock: true }).updateOr(
      {},
      (state) => ({
        ...state,
        ...values,
      }),
    );
  const readState = (): Record<string, unknown> => JSON.parse(fs.readFileSync(statePath, "utf8"));
  const store = createManagedHandoffLeaseStore();
  const claim = store.read(root);
  assert.equal(claim.kind, "current");
  if (claim.kind !== "current") {
    throw new Error("missing fixture lease");
  }
  assert.equal(claim.lease.executor.pid, process.pid);
  assert.equal(claim.lease.helper.pid, process.ppid);
  assert.notEqual(claim.lease.helper.pid, claim.lease.executor.pid);
  assert.equal(store.owns(claim.lease, "executor"), true);
  assert.equal(getSelfAndAncestorPidsSync().has(params.gatewayPid), true);
  await record({
    gatewayPid: params.gatewayPid,
    helperPid: process.ppid,
    updaterPid: process.pid,
    realGatewayAncestor: true,
  });

  // On a non-macOS host only the policy selector is emulated. Keep native process
  // identity probes on the real host while exercising the unchanged Darwin guard.
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  if (params.kind === "launchd") {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
  }
  let stopped = false;
  let acknowledged = false;
  // Observe delivery without adding a data listener that would itself resume
  // stdin and accidentally hide a missing resume in the production client.
  const nativeEmit = process.stdin.emit.bind(process.stdin);
  process.stdin.emit = new Proxy(nativeEmit, {
    apply(target, receiver, args: unknown[]) {
      if (args[0] === "data" && String(args[1]) === "parked\n") {
        acknowledged = true;
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  const assertCurrent = () => {
    if (scenario === "revoked-after-ack" && acknowledged) {
      throw new Error("fixture executor revoked after parked acknowledgement");
    }
  };
  const { withUpdateCommandExecutor } =
    await import("../cli/update-cli/update-command-executor.js");
  try {
    await withUpdateCommandExecutor(params.runId, async (executor) => {
      const executorFence = await executor.enter(root);
      if (scenario === "invalid-metadata") {
        const metaPath = process.env.OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META!;
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        meta.meta.runId = "another-update-run";
        fs.writeFileSync(metaPath, JSON.stringify(meta));
      }
      if (scenario === "revoked-helper") {
        // Simulate external revocation of this exact fixture row. An executor is
        // deliberately not allowed to release its live helper through store.release.
        const db = new DatabaseSync(
          path.join(params.coordinatorDir, "managed-update-handoffs.sqlite"),
        );
        try {
          const removed = db
            .prepare(
              "DELETE FROM managed_update_handoffs WHERE install_root = ? AND owner = ? AND payload_json = ?",
            )
            .run(root, claim.lease.owner, claim.lease.payload);
          assert.equal(removed.changes, 1);
        } finally {
          db.close();
        }
      }
      const result = await maybeStopManagedServiceBeforeMutableUpdate({
        root,
        updateInstallKind: "package",
        shouldRestart: true,
        jsonMode: true,
        phase: "prepare",
        updateRun: { runId: params.runId, env: process.env, executorFence },
        assertCurrent,
        onStopped: (state) => {
          stopped = state.stopped;
          assert.equal(acknowledged, true, "onStopped precedes helper acknowledgement");
          assert.equal(readState().parked, true);
        },
      });
      await record({
        maintenanceStopped: result.stopped,
        stoppedCallback: stopped,
        acknowledged,
        maintenanceBlock: result.blockMessage,
        maintenanceVerdict: result.serviceUpdateVerdict?.kind,
        maintenanceSkip: result.serviceMutationSkipMessage,
      });
      assert.equal(result.serviceUpdateVerdict?.kind, "owned", JSON.stringify(result));
      assert.equal(
        result.blockMessage,
        undefined,
        result.blockMessage ?? "unexpected service refusal",
      );
      assert.equal(result.stopped, true, "maintenance did not observe a parked service");
      assert.equal(stopped, true);
    });
  } catch (error) {
    await record({ maintenanceError: String(error), stoppedCallback: stopped, acknowledged });
    throw error;
  } finally {
    process.stdin.emit = nativeEmit;
    Object.defineProperty(process, "platform", platformDescriptor);
    childProcess.execFileSync = nativeExecFileSync;
    syncBuiltinESMExports();
    hooks.deregister();
  }
}

export function managedActivationExpectation(options: ManagedServiceBoundaryOptions | undefined) {
  const activated =
    options?.controlDisconnect === "transferred" &&
    !options.validationResult &&
    (!options.maintenanceActivation ||
      ["complete", "revoked-after-ack", "revoked-during-stop"].includes(
        options.maintenanceActivation,
      )) &&
    !options.cancelDuringValidation &&
    !options.cancelAtActivation &&
    !options.revokeWhileValidating &&
    !["refuse-stop", "fail-preparation", "fail-persistence-ack", "fail-commit-ack"].includes(
      options.nativePreparation ?? "",
    );
  return {
    activated,
    updated:
      activated &&
      options.nativePreparation !== "timeout-stop" &&
      options.maintenanceActivation !== "revoked-after-ack" &&
      options.maintenanceActivation !== "revoked-during-stop",
  };
}
