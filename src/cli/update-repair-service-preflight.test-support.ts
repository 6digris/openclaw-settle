// Real repair admission, config writes, ledger, fresh-child execution, and Doctor
// maintenance. Only the native service adapter and OS account home are controlled.
import fs from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";

type FixtureParams = {
  entrypoints: typeof runtimeProcessEntrypoints;
  scenario: "online" | "late-online" | "owning-continuation";
  doctor?: boolean;
};

export async function runRepairServicePreflightFixture(params: FixtureParams): Promise<void> {
  const home = process.env.HOME!;
  const root = path.join(home, "install");
  const role = params.doctor ? "doctor" : "parent";
  const entry = path.join(root, "dist", "index.js");
  const configPath = path.join(home, ".openclaw", "openclaw.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const account = os.userInfo();
  Object.defineProperty(os, "homedir", { value: () => home });
  Object.defineProperty(os, "userInfo", { value: () => ({ ...account, homedir: home }) });
  syncBuiltinESMExports();
  const sourceUrl = (relative: string) => new URL(relative, import.meta.url).href;
  const eventSource = `
const event = (event, facts = {}) => process.stderr.write('repair-fixture ' + JSON.stringify({event, role: ${JSON.stringify(role)}, ...facts}) + '\\n');
`;
  const serviceUrl = sourceUrl("../daemon/service.ts");
  const systemdUrl = sourceUrl("../daemon/systemd.ts");
  const continuation = params.scenario === "owning-continuation";
  const running = params.scenario !== "late-online" || params.doctor === true;
  const replacements = new Map([
    [
      serviceUrl,
      `export * from ${JSON.stringify(`${serviceUrl}?fixture-original`)};
import { readFileSync } from 'node:fs';
import { getUpdateRun } from ${JSON.stringify(sourceUrl("../infra/update-run-ledger.ts"))};
import { inspectUpdateRunDriver } from ${JSON.stringify(sourceUrl("../infra/update-run-driver.ts"))};
${eventSource}
const forbidden = (name) => async () => { event('mutation:' + name); throw new Error('Unexpected native service mutation: ' + name); };
let running = ${JSON.stringify(running)};
const observeContinuation = () => {
  if (!${JSON.stringify(continuation)}) return;
  const run = getUpdateRun(process.env.OPENCLAW_UPDATE_RUN_ID);
  event('continuation-state', {
    runId: run?.runId, status: run?.status,
    recorded: run?.steps.some((step) => step.step === 'finalize:repair-continuation'),
    adopted: run?.steps.some((step) => step.step === 'driver:adopted'),
    ownerAlive: run?.origin.driver && inspectUpdateRunDriver(run.origin.driver),
    channel: JSON.parse(readFileSync(${JSON.stringify(configPath)}, 'utf8')).update?.channel,
  });
};
const service = {
  label: 'fixture', loadedText: 'loaded', notLoadedText: 'not loaded',
  stage: forbidden('stage'), install: forbidden('install'), uninstall: forbidden('uninstall'),
  start: forbidden('start'),
  stop: ${JSON.stringify(continuation && params.doctor === true)} ? async (params) => {
    if (typeof params.assertCurrent !== 'function') throw new Error('Missing native stop assertion');
    params.assertCurrent();
    event('mutation:stop', {asserted: true});
    running = false;
  } : forbidden('stop'),
  restart: ${JSON.stringify(continuation && params.doctor === true)} ? async (params) => {
    if (typeof params.assertCurrent !== 'function') throw new Error('Missing native restart assertion');
    params.assertCurrent();
    observeContinuation();
    event('mutation:restart', {asserted: true, preserveDefinition: params.preserveDefinition});
    throw new Error('Fixture service manager refused restoration');
  } : forbidden('restart'),
  isLoaded: async () => true,
  isEnabled: async () => false,
  readDefinitionMutationCapability: async () => ({kind: 'writable'}),
  readCommand: async (env) => {
    observeContinuation();
    event('service-command', {
      activation: env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION,
      serviceRepair: env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR,
      external: env.OPENCLAW_SERVICE_REPAIR_POLICY ?? null,
      postCore: env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE ?? null,
      marker: env.OPENCLAW_SERVICE_MARKER ?? null,
      kind: env.OPENCLAW_SERVICE_KIND ?? null,
      runtimePid: env.OPENCLAW_GATEWAY_SERVICE_PID ?? null,
    });
    return {programArguments: [process.execPath, ${JSON.stringify(entry)}, 'gateway', '--port', ${JSON.stringify(String(config.gateway.port))}], environment: {HOME: ${JSON.stringify(home)}}};
  },
  readRuntime: async () => {
    event('service-runtime', {status: running ? 'running' : 'stopped'});
    return {status: running ? 'running' : 'stopped', systemd: {managerUid: ${account.uid}}};
  },
};
export const resolveGatewayService = () => service;`,
    ],
    [
      systemdUrl,
      `export * from ${JSON.stringify(`${systemdUrl}?fixture-original`)};
export const findInstalledSystemdGatewayScope = async () => ({scope: 'user'});`,
    ],
    [
      sourceUrl("../infra/runtime-process-entrypoints.ts"),
      `export const runtimeProcessEntrypoints = ${JSON.stringify(params.entrypoints)};
export const SQLITE_READONLY_CHILD_ARG = '--openclaw-sqlite-readonly-child';`,
    ],
  ]);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(".") || specifier.startsWith("file:")) {
        const url = new URL(specifier, context.parentURL).href.replace(/\.js$/, ".ts");
        const source = replacements.get(url);
        if (source !== undefined) {
          return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
  });
  const event = (event: string, facts: Record<string, unknown> = {}) =>
    process.stderr.write(`repair-fixture ${JSON.stringify({ event, role, ...facts })}\n`);
  const { isDefaultInstallIdentity } = await import("../config/paths.js");
  if (!isDefaultInstallIdentity(process.env)) {
    throw new Error("Fixture must select the real canonical default installation");
  }
  event("eligible-selection");

  const { defaultRuntime } = await import("../runtime.js");
  if (params.doctor) {
    const { getUpdateRun, listUpdateRuns } = await import("../infra/update-run-ledger.js");
    event("doctor-entry", { runs: listUpdateRuns().length, channel: config.update?.channel });
    if (continuation) {
      const { inspectUpdateRunDriver } = await import("../infra/update-run-driver.js");
      const run = getUpdateRun(process.env.OPENCLAW_UPDATE_RUN_ID!);
      const owner = run?.origin.driver;
      if (!owner || inspectUpdateRunDriver(owner) !== "alive" || owner.pid !== process.ppid) {
        throw new Error("Fixture must retain its real owning parent through Doctor maintenance");
      }
      process.once("exit", (code) =>
        event("doctor-exit", {
          code,
          pid: process.pid,
          parentPid: owner.pid,
          ownerAlive: inspectUpdateRunDriver(owner),
        }),
      );
    }
    // The installed fixture reaches real maintenance and, for continuation,
    // its restoration failure. It never simulates successful convergence.
    const { beginDoctorMaintenance } = await import("../commands/doctor-maintenance.js");
    const maintenance = await beginDoctorMaintenance({
      options: { repair: true, nonInteractive: true, yes: true },
      root,
      runtime: defaultRuntime,
    });
    if (continuation) {
      if (!maintenance) {
        throw new Error("Fixture expected owning-run Doctor maintenance");
      }
      await maintenance.finish(config);
      throw new Error("Fixture expected the native restoration failure");
    }
    await maintenance?.release();
    throw new Error("Fixture expected the real Doctor maintenance refusal");
  }

  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module" }),
  );
  await fs.writeFile(path.join(root, "openclaw.mjs"), "// Fixture invocation shim.\n");
  // This installed-entry fixture loads source from another cwd. Bind its workspace
  // aliases to the same source tree instead of discovering them from the install root.
  await fs.writeFile(
    entry,
    `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
register({ tsconfig: ${JSON.stringify(fileURLToPath(new URL("../../tsconfig.json", import.meta.url)))} });
try {
  if (process.argv[2] !== 'doctor') throw new Error('This fixture only executes Doctor maintenance');
  const { runRepairServicePreflightFixture } = await import(${JSON.stringify(import.meta.url)});
  await runRepairServicePreflightFixture(${JSON.stringify({ ...params, doctor: true })});
} catch (error) { console.error(error.message); process.exitCode = 1; }
`,
  );
  const { Command } = await import("commander");
  const { registerUpdateCli } = await import("./update-cli.js");
  const { formatCliJsonFailure } = await import("./failure-output.js");
  const { runCliWithExitFinalization } = await import("./one-shot-exit.js");
  const { withCliProcessScope } = await import("./runtime-cleanup-scope.js");
  const { enableConsoleCapture } = await import("../logging/console.js");
  const { withConsoleLogsRoutedToStderrForJson } = await import("./json-output-mode.js");
  if (continuation) {
    const { readUpdateRunDriver } = await import("../infra/update-run-driver.js");
    const { createUpdateRun } = await import("../infra/update-run-ledger.js");
    const driver = readUpdateRunDriver();
    if (!driver) {
      throw new Error("Fixture requires the real update driver identity");
    }
    const run = createUpdateRun({ trigger: "cli", origin: { driver } });
    process.env.OPENCLAW_UPDATE_RUN_ID = run.runId;
    event("owning-run", { runId: run.runId, pid: driver.pid });
  }
  process.argv = [
    process.execPath,
    path.join(root, "openclaw.mjs"),
    "update",
    "repair",
    "--channel",
    "dev",
    "--yes",
    "--json",
  ];
  enableConsoleCapture();
  await runCliWithExitFinalization({
    run: () =>
      withCliProcessScope(() =>
        withConsoleLogsRoutedToStderrForJson(
          process.argv,
          async () => {
            const program = new Command().name("openclaw");
            registerUpdateCli(program);
            await program.parseAsync(process.argv);
          },
          { retainRoutingUntilProcessExit: true },
        ),
      ),
    onError: (error) => {
      event("repair-error", { pid: process.pid });
      defaultRuntime.writeJson(formatCliJsonFailure(error));
      process.exitCode = 1;
    },
  });
}
