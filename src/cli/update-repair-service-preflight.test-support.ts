// Real repair admission, config writes, ledger, fresh-child execution, and Doctor
// maintenance. Only the native service adapter and OS account home are controlled.
import fs from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import type { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";

type FixtureParams = {
  entrypoints: typeof runtimeProcessEntrypoints;
  scenario: "online" | "late-online";
  doctor?: boolean;
};

export async function runRepairServicePreflightFixture(params: FixtureParams): Promise<void> {
  const home = process.env.HOME!;
  const root = path.join(home, "install");
  const role = params.doctor ? "doctor" : "parent";
  const entry = path.join(root, "dist", "index.js");
  const configPath = path.join(home, ".openclaw", "openclaw.json");
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
  const running = params.scenario === "online" || params.doctor === true;
  const replacements = new Map([
    [
      serviceUrl,
      `export * from ${JSON.stringify(`${serviceUrl}?fixture-original`)};
${eventSource}
const forbidden = (name) => async () => { event('mutation:' + name); throw new Error('Unexpected native service mutation: ' + name); };
const service = {
  label: 'fixture', loadedText: 'loaded', notLoadedText: 'not loaded',
  stage: forbidden('stage'), install: forbidden('install'), uninstall: forbidden('uninstall'),
  start: forbidden('start'), stop: forbidden('stop'), restart: forbidden('restart'),
  isLoaded: async () => true,
  isEnabled: async () => false,
  readDefinitionMutationCapability: async () => ({kind: 'writable'}),
  readCommand: async (env) => {
    event('service-command', {
      activation: env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION,
      serviceRepair: env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR,
      external: env.OPENCLAW_SERVICE_REPAIR_POLICY ?? null,
      postCore: env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE ?? null,
      marker: env.OPENCLAW_SERVICE_MARKER ?? null,
      kind: env.OPENCLAW_SERVICE_KIND ?? null,
      runtimePid: env.OPENCLAW_GATEWAY_SERVICE_PID ?? null,
    });
    return {programArguments: [process.execPath, ${JSON.stringify(entry)}, 'gateway'], environment: {HOME: ${JSON.stringify(home)}}};
  },
  readRuntime: async () => {
    event('service-runtime', {status: ${JSON.stringify(running ? "running" : "stopped")}});
    return {status: ${JSON.stringify(running ? "running" : "stopped")}, systemd: {managerUid: ${account.uid}}};
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
    const { listUpdateRuns } = await import("../infra/update-run-ledger.js");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    event("doctor-entry", { runs: listUpdateRuns().length, channel: config.update?.channel });
    // The installed fixture ends at the real maintenance guard. It does not
    // replace that owner or simulate a successful Doctor/convergence result.
    const { beginDoctorMaintenance } = await import("../commands/doctor-maintenance.js");
    const maintenance = await beginDoctorMaintenance({
      options: { repair: true, nonInteractive: true, yes: true },
      root,
      runtime: defaultRuntime,
    });
    await maintenance?.release();
    throw new Error("Fixture expected the real Doctor maintenance refusal");
  }

  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module" }),
  );
  await fs.writeFile(path.join(root, "openclaw.mjs"), "// Fixture invocation shim.\n");
  await fs.writeFile(
    entry,
    `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
register();
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
      defaultRuntime.writeJson(formatCliJsonFailure(error));
      process.exitCode = 1;
    },
  });
}
