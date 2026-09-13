import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, assert, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { listUpdateRuns } from "../infra/update-run-ledger.js";
import { isPidAlive } from "../shared/pid-alive.js";
import {
  formatCliProcessFailure,
  runCliProcessChild,
  waitForCliProcessStderrMarker,
} from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// Keep source transforms reusable across fresh children; each case still owns its state.
const childTempDir = useAutoCleanupTempDirTracker(afterAll).make("openclaw-update-child-tmp-");
const fixture = fileURLToPath(
  new URL("./update-finalization-output.test-support.ts", import.meta.url),
);
const doctorDiagnostics = [
  "OpenClaw doctor",
  "Doctor panel diagnostic",
  "Doctor workspace diagnostic",
  "Doctor console diagnostic",
  "Doctor complete.",
];
const scenarios = [
  "json",
  "inherited-json",
  "doctor-error",
  "plugin-error",
  "human",
  "human-plugin-error",
  "human-plugin-warning",
  "human-recovery-plugin-error",
];
const finalizeScenarios = [
  "json",
  "phase-hang",
  "doctor-hang",
  "doctor-progress",
  "completion-hang",
  "handle-hang",
  "borrowed-phase",
  "borrowed-output",
];

// Windows offline proof uses its native numeric task cache; the service adapter
// process fixture covers POSIX while native-owner tests cover that sibling.
describe.skipIf(process.platform === "win32")("update repair service admission", () => {
  it.each(["online", "late-online", "owning-continuation"] as const)(
    "%s preserves the real config/ledger boundary and service ownership",
    async (scenario) => {
      const home = tempDirs.make("openclaw-repair-admission-");
      const state = path.join(home, ".openclaw");
      const configPath = path.join(state, "openclaw.json");
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if (!address || typeof address === "string") {
        throw new Error("Missing isolated service port");
      }
      await fs.mkdir(state);
      const configBefore = `${JSON.stringify({
        gateway: { mode: "local", port: address.port },
        plugins: { enabled: false, allow: [] },
        update: { channel: "stable" },
        logging: { file: path.join(home, "openclaw.log") },
      })}\n`;
      await fs.writeFile(configPath, configBefore);
      const fixtureUrl = new URL(
        "./update-repair-service-preflight.test-support.ts",
        import.meta.url,
      );
      const result = await runCliProcessChild({
        nodeArgs: [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import { runRepairServicePreflightFixture } from ${JSON.stringify(fixtureUrl.href)};
await runRepairServicePreflightFixture(${JSON.stringify({ entrypoints: runtimeProcessEntrypoints, scenario })});`,
        ],
        env: {
          ESBUILD_WORKER_THREADS: "0",
          PATH: path.dirname(process.execPath),
          HOME: home,
          USERPROFILE: home,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: configPath,
          // Fresh Doctor clears this inherited policy; admission must do the same.
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          XDG_CONFIG_HOME: path.join(home, "xdg-config"),
          XDG_DATA_HOME: path.join(home, "xdg-data"),
          XDG_CACHE_HOME: path.join(home, "xdg-cache"),
          XDG_STATE_HOME: path.join(home, "xdg-state"),
          XDG_RUNTIME_DIR: path.join(home, "xdg-runtime"),
          TMPDIR: childTempDir,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NO_COLOR: "1",
          TERM: "dumb",
        },
      });
      const failure = formatCliProcessFailure({
        reason: `service admission ${scenario}`,
        ...result,
      });
      expect(result.signal, failure).toBeNull();
      expect(result.code, failure).toBe(1);
      const activationRefusal =
        "The update parent owns Gateway activation. Stop the service through its owner before retrying the update; Doctor will not stop or restart it.";
      const output = JSON.parse(result.stdout);
      expect(output, failure).toMatchObject({
        ok: false,
        error: {
          type: "cli_error",
          message: expect.stringContaining(
            scenario === "online" ? activationRefusal : "Updated pre-plugin Doctor failed:",
          ),
        },
      });
      const events = result.stderr
        .split("\n")
        .filter((line) => line.startsWith("repair-fixture "))
        .map((line) => JSON.parse(line.slice("repair-fixture ".length)));
      expect(events, failure).toContainEqual({ event: "eligible-selection", role: "parent" });
      const runs = listUpdateRuns({}, { env: { HOME: home, OPENCLAW_STATE_DIR: state } });
      if (scenario === "owning-continuation") {
        const owner = events.find((event) => event.event === "owning-run");
        expect(owner, failure).toMatchObject({
          runId: expect.any(String),
          pid: expect.any(Number),
        });
        expect(events, failure).toContainEqual({
          event: "doctor-entry",
          role: "doctor",
          runs: 1,
          channel: "dev",
        });
        expect(
          events.filter((event) => event.event.startsWith("mutation:")),
          failure,
        ).toEqual([
          { event: "mutation:stop", role: "doctor", asserted: true },
          {
            event: "mutation:restart",
            role: "doctor",
            asserted: true,
            preserveDefinition: true,
          },
        ]);
        const observations = events.filter((event) => event.event === "continuation-state");
        expect(observations.length, failure).toBeGreaterThan(0);
        for (const observation of observations) {
          expect(observation, failure).toMatchObject({
            runId: owner.runId,
            status: "running",
            recorded: true,
            ownerAlive: "alive",
            // Baseline main has no early inventory. Any parent inventory must
            // observe the public continuation before adoption or config writes.
            adopted: observation.role === "doctor",
            channel: observation.role === "doctor" ? "dev" : "stable",
          });
        }
        const exited = events.find((event) => event.event === "doctor-exit");
        expect(exited, failure).toMatchObject({
          role: "doctor",
          code: 1,
          pid: expect.any(Number),
          parentPid: owner.pid,
          ownerAlive: "alive",
        });
        expect(isPidAlive(exited.pid), failure).toBe(false);
        const errorIndex = events.findIndex((event) => event.event === "repair-error");
        expect(errorIndex, failure).toBeGreaterThan(events.indexOf(exited));
        expect(events[errorIndex], failure).toMatchObject({ role: "parent", pid: owner.pid });
        expect(result.stderr, failure).toContain(
          "Doctor repaired state, but could not restore the managed Gateway: Error: Fixture service manager refused restoration",
        );
        expect(result.stderr, failure).not.toContain(activationRefusal);
        expect(runs, failure).toHaveLength(1);
        const [run] = runs;
        assert(run, failure);
        expect(run, failure).toMatchObject({
          runId: owner.runId,
          status: "running",
          finishedAtMs: null,
          origin: { driver: { pid: owner.pid } },
          steps: expect.arrayContaining([
            expect.objectContaining({ step: "finalize:repair-continuation", status: "completed" }),
            expect.objectContaining({ step: "driver:adopted", status: "completed" }),
            expect.objectContaining({ step: "finalize:doctor", status: "failed" }),
          ]),
        });
        expect(
          run.steps.filter((step) => step.step === "finalize:repair-continuation"),
          failure,
        ).toHaveLength(1);
        expect(
          run.steps.some((step) => step.step === "finalize:repair-takeover"),
          failure,
        ).toBe(false);
        expect(JSON.parse(await fs.readFile(configPath, "utf8")).update.channel, failure).toBe(
          "dev",
        );
        return;
      }
      expect(
        events.filter((event) => event.event === "service-command"),
        failure,
      ).toEqual(
        (scenario === "online" ? ["parent"] : ["parent", "doctor"]).map((role) => ({
          event: "service-command",
          role,
          activation: "0",
          serviceRepair: "0",
          external: null,
          postCore: null,
          marker: null,
          kind: null,
          runtimePid: null,
        })),
      );
      expect(
        events.filter((event) => event.event.startsWith("mutation:")),
        failure,
      ).toEqual([]);
      if (scenario === "online") {
        expect(
          events.filter((event) => event.role === "doctor"),
          failure,
        ).toEqual([]);
        expect(runs, failure).toEqual([]);
        expect(await fs.readFile(configPath, "utf8"), failure).toBe(configBefore);
        await expect(fs.stat(`${configPath}.pre-update`)).rejects.toMatchObject({ code: "ENOENT" });
        expect(result.stderr, failure).not.toContain("Preparing triage diagnostics");
      } else {
        // The standalone run is live but not an inherited repair continuation.
        // Full stderr retains its current driver refusal beyond bounded JSON.
        expect(runs, failure).toHaveLength(1);
        const [run] = runs;
        assert(run, failure);
        expect(result.stderr, failure).toContain(
          `Update ${run.runId} is still in progress (requested); driver PID ${run.origin.driver?.pid}`,
        );
        expect(result.stderr, failure).toContain("liveness: alive");
        expect(result.stderr, failure).toContain(
          "Wait for that update, or stop that driver through its owning host or supervisor and re-run `openclaw update repair`.",
        );
        expect(events, failure).toContainEqual({ event: "eligible-selection", role: "doctor" });
        expect(events, failure).toContainEqual({
          event: "doctor-entry",
          role: "doctor",
          runs: 1,
          channel: "dev",
        });
        expect(
          events.filter((event) => event.event === "service-runtime"),
          failure,
        ).toEqual([
          { event: "service-runtime", role: "parent", status: "stopped" },
          { event: "service-runtime", role: "doctor", status: "running" },
        ]);
        expect(run, failure).toMatchObject({
          status: "failed",
          steps: expect.arrayContaining([
            expect.objectContaining({ step: "finalize:preflight", status: "completed" }),
            expect.objectContaining({
              step: "finalize:targetConfigValidation",
              status: "completed",
            }),
            expect.objectContaining({ step: "finalize:doctor", status: "failed" }),
          ]),
        });
        expect(JSON.parse(await fs.readFile(configPath, "utf8")).update.channel, failure).toBe(
          "dev",
        );
        expect(
          JSON.parse(await fs.readFile(`${configPath}.pre-update`, "utf8")).update.channel,
          failure,
        ).toBe("dev");
      }
    },
  );
});

describe.each(["repair", "finalize"])("update %s process output", (command) => {
  // Both spellings share the finalization action; one matrix covers its output modes.
  it.each(command === "repair" ? scenarios : finalizeScenarios)(
    "%s preserves the output and exit contract without restarting",
    async (scenario) => {
      const root = tempDirs.make("openclaw-update-json-");
      const state = path.join(root, "state");
      const config = path.join(root, "openclaw.json");
      const workspace = path.join(root, "workspace");
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing isolated port");
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      expect(address.port).not.toBe(18789);
      await fs.mkdir(state);
      await fs.mkdir(workspace);
      await fs.writeFile(
        config,
        JSON.stringify({
          gateway: { mode: "local", port: address.port, auth: { mode: "none" } },
          plugins: { enabled: false, allow: [] },
          agents: { defaults: { workspace } },
          logging: { file: path.join(root, "openclaw.log") },
        }),
      );
      const json = !scenario.startsWith("human");
      const blockedPhase =
        scenario === "doctor-hang" || scenario === "doctor-progress"
          ? "doctor"
          : scenario === "phase-hang"
            ? "configSnapshot"
            : scenario === "completion-hang"
              ? "completionCache"
              : undefined;
      const args = [
        "update",
        ...(scenario === "inherited-json" ? ["--json"] : []),
        command,
        "--channel",
        "dev",
        ...(scenario === "human-recovery-plugin-error" ? [] : ["--yes"]),
        "--no-restart",
        ...(blockedPhase ? [] : ["--timeout", scenario === "borrowed-phase" ? "1" : "9"]),
        ...(json && scenario !== "inherited-json" ? ["--json"] : []),
      ];
      const readRun = () =>
        listUpdateRuns({ limit: 1 }, { env: { HOME: root, OPENCLAW_STATE_DIR: state } })[0];
      let observedPhaseStart: ReturnType<typeof readRun> | undefined;
      const result = await runCliProcessChild({
        ...(scenario === "phase-hang"
          ? {
              interact: async (
                child: import("node:child_process").ChildProcessWithoutNullStreams,
              ) => {
                child.stdin.end();
                await waitForCliProcessStderrMarker(child, "fixture configSnapshot entered");
                try {
                  observedPhaseStart = readRun();
                } catch (error) {
                  throw new Error("Could not read the phase-start ledger", { cause: error });
                }
              },
            }
          : {}),
        nodeArgs: [
          "--import",
          "tsx",
          fixture,
          JSON.stringify(runtimeProcessEntrypoints),
          scenario,
          ...args,
        ],
        env: {
          ESBUILD_WORKER_THREADS: "0",
          PATH: path.dirname(process.execPath),
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: config,
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          OPENCLAW_GATEWAY_PORT: String(address.port),
          XDG_CONFIG_HOME: path.join(root, "xdg-config"),
          XDG_DATA_HOME: path.join(root, "xdg-data"),
          XDG_CACHE_HOME: path.join(root, "xdg-cache"),
          XDG_STATE_HOME: path.join(root, "xdg-state"),
          XDG_RUNTIME_DIR: path.join(root, "xdg-runtime"),
          TMPDIR: childTempDir,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NO_COLOR: "1",
          TERM: "dumb",
        },
      });
      const failure = formatCliProcessFailure({ reason: `${command} ${scenario}`, ...result });
      expect(result.signal, failure).toBeNull();
      expect(result.code, failure).toBe(
        scenario.endsWith("error") || scenario === "phase-hang" || blockedPhase === "doctor"
          ? 1
          : 0,
      );
      if (blockedPhase === "doctor") {
        const output = JSON.parse(result.stdout);
        expect(output, failure).toMatchObject({ status: "failed", stuckPhase: "doctor" });
        for (const marker of ["STEP completed fixture-schema", "STEP active fixture-validation"]) {
          expect(JSON.stringify(output.doctorOutput), failure).toContain(marker);
          expect(result.stderr, failure).toContain(marker);
          expect(readRun(), failure).toMatchObject({
            status: "failed",
            steps: expect.arrayContaining([
              expect.objectContaining({
                step: "finalize:doctor",
                status: "failed",
                detail: expect.stringContaining(marker),
              }),
            ]),
          });
        }
        const timing = output.phaseTimings.find(
          (entry: { phase: string }) => entry.phase === "doctor",
        );
        expect(timing.durationMs, failure).toBeGreaterThanOrEqual(1_000);
        expect(timing.durationMs, failure).toBeLessThan(3_000);
        if (scenario === "doctor-progress") {
          expect(output.doctorOutput.stderr.excerpt, failure).toContain(
            "PROGRESS fixture-validation",
          );
        }
        return;
      }
      if (scenario.startsWith("borrowed-")) {
        expect(result.stderr, failure).toContain("Borrowed caller completed.");
        expect(result.stderr, failure).not.toContain("Process still alive after terminal output");
        if (scenario === "borrowed-phase") {
          const timing = JSON.parse(result.stdout).phaseTimings.find(
            (entry: { phase: string }) => entry.phase === "configSnapshot",
          );
          expect(timing, failure).toMatchObject({ outcome: "completed" });
          expect(timing.durationMs, failure).toBeGreaterThanOrEqual(1_000);
        }
      }
      if (blockedPhase) {
        if (scenario === "phase-hang") {
          expect(observedPhaseStart?.steps, failure).toContainEqual(
            expect.objectContaining({
              step: "finalize:configSnapshot",
              status: "in_progress",
              startedAtMs: expect.any(Number),
            }),
          );
        }
        const output = JSON.parse(result.stdout);
        expect(output).toMatchObject({
          status: scenario === "phase-hang" ? "failed" : "ok",
          restart: false,
        });
        if (scenario === "phase-hang") {
          expect(output.stuckPhase).toBe(blockedPhase);
          const pid = Number(await fs.readFile(path.join(root, "blocked-child.pid"), "utf8"));
          expect(output.childProcesses, failure).toContainEqual({
            pid,
            parentPid: expect.any(Number),
            command: expect.stringMatching(/^node(?:\.exe)?$/u),
          });
          expect(output.childProcessInspection, failure).toBe("complete");
          expect(result.stdout + result.stderr, failure).not.toContain("fixture-private-argument");
          const prerequisite = output.phaseTimings.find(
            (entry: { phase: string }) => entry.phase === "targetConfigValidation",
          );
          expect(prerequisite, failure).toMatchObject({ outcome: "completed" });
          expect(prerequisite.durationMs, failure).toBeGreaterThanOrEqual(1_000);
        } else {
          expect(output.stuckPhase).toBeUndefined();
          const pid = Number(await fs.readFile(path.join(root, "completion.pid"), "utf8"));
          expect(pid).toBeGreaterThan(0);
          expect(isPidAlive(pid)).toBe(false);
        }
        expect(output.phaseTimings).toContainEqual(
          expect.objectContaining({
            phase: blockedPhase,
            outcome: "failed",
            durationMs: expect.any(Number),
          }),
        );
        expect(result.stderr).toContain(`finalize:${blockedPhase}`);
        expect(readRun()).toMatchObject({
          status: scenario === "phase-hang" ? "failed" : "succeeded",
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: `finalize:${blockedPhase}`,
              status: "failed",
              startedAtMs: expect.any(Number),
              endedAtMs: expect.any(Number),
            }),
          ]),
        });
        return;
      }
      if (scenario === "handle-hang") {
        expect(result.stderr).toContain("activeResources");
        expect(result.stderr).toContain("unsettledDisposers");
        const pid = Number(await fs.readFile(path.join(root, "blocked-child.pid"), "utf8"));
        const diagnostic = result.stderr
          .split("\n")
          .find((line) => line.includes("Process still alive after terminal output:"));
        expect(diagnostic, failure).toBeDefined();
        const payload = JSON.parse(diagnostic!.slice(diagnostic!.indexOf("{")));
        expect(payload.childProcesses, failure).toContainEqual({
          pid,
          parentPid: expect.any(Number),
          command: expect.stringMatching(/^node(?:\.exe)?$/u),
        });
        expect(payload.unsettledDisposers, failure).toContain("fixture-stdin-child");
        expect(result.stdout + result.stderr, failure).not.toContain("fixture-private-argument");
        expect(readRun()).toMatchObject({
          status: "succeeded",
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: "finalize:exit",
              detail: expect.stringContaining("activeResources"),
            }),
          ]),
        });
      }
      const diagnostics = json ? result.stderr : result.stdout;
      for (const diagnostic of doctorDiagnostics) {
        expect(diagnostics, failure).toContain(diagnostic);
      }
      expect(diagnostics.match(/Doctor console diagnostic/gu), failure).toHaveLength(1);
      expect(result.stderr, failure).toContain("Doctor stderr diagnostic");
      if (scenario === "human-recovery-plugin-error") {
        expect(result.stdout, failure).toContain("Update finalization failed.");
        expect(result.stdout, failure).toContain("Interactive recovery completed.");
        expect(result.stderr, failure).not.toContain("Process still alive after terminal output");
        return;
      }
      const triageNotice = "Update failed. Preparing triage diagnostics...";
      if (!scenario.endsWith("error")) {
        expect(result.stdout + result.stderr, failure).not.toContain(triageNotice);
        expect(result.stdout + result.stderr, failure).not.toContain("triage-fixture-prompt.md");
      }
      if (!json) {
        const terminal =
          scenario === "human-plugin-error"
            ? "Update finalization failed."
            : scenario === "human-plugin-warning"
              ? "Update finalization completed with warnings."
              : "Update finalization completed.";
        if (scenario === "human-plugin-error") {
          expect(result.stdout, failure).toContain(terminal);
          const triageIndex = result.stdout.indexOf(triageNotice);
          const promptIndex = result.stdout.indexOf("Debugging prompt:");
          const guidanceIndex = result.stdout.indexOf("Ready-to-run agent handoffs:");
          expect(triageIndex, failure).toBeGreaterThan(result.stdout.indexOf(terminal));
          expect(promptIndex, failure).toBeGreaterThan(triageIndex);
          expect(guidanceIndex, failure).toBeGreaterThan(promptIndex);
          expect(result.stdout.trimEnd().endsWith("openclaw triage --run"), failure).toBe(true);
        } else {
          expect(result.stdout.trimEnd().endsWith(terminal), failure).toBe(true);
        }
        return;
      }
      // Parse the whole pipe: accepting a suffix would hide Clack's direct stdout writes.
      const output = JSON.parse(result.stdout);
      if (scenario.endsWith("error")) {
        expect(result.stderr, failure).not.toContain("Process still alive after terminal output");
        expect(result.stderr, failure).toContain(triageNotice);
        expect(result.stderr, failure).toContain('"promptPath":');
        expect(result.stderr, failure).toContain("triage-fixture-prompt.md");
        expect(result.stderr, failure).not.toContain("Triage could not complete:");
        expect(result.stdout, failure).not.toContain("triage-fixture-prompt.md");
      }
      if (scenario === "doctor-error") {
        expect(output).toMatchObject({
          ok: false,
          error: { type: "cli_error", message: expect.stringContaining("Doctor repair failed") },
        });
      } else {
        expect(output).toMatchObject({
          status: scenario === "plugin-error" ? "error" : "ok",
          mode: "finalize",
          restart: false,
          channel: "dev",
          postUpdate: { doctor: { status: "ok" } },
        });
      }
    },
  );
});
