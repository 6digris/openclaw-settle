import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { updateRecoveryBackupRefSchema } from "../../infra/update-recovery-backup-contract.js";
import type { runCommandWithTimeout, runUtf8CommandWithTimeout } from "../../process/exec.js";
import { createCommandResult as commandResult } from "../../test-utils/npm-spec-install-test-helpers.js";

export const doctorProcessResult = (
  overrides: Partial<Awaited<ReturnType<typeof runUtf8CommandWithTimeout>>> = {},
): Awaited<ReturnType<typeof runUtf8CommandWithTimeout>> => ({
  ...commandResult(),
  cleanup: "normal",
  ...overrides,
});

/** Run the actual read-only watchdog against private CLI fixtures, even when
 * native service tests have replaced the general child-process transport. */
export async function runUpdateProgressProbeFixture(
  argv: string[],
  options: Parameters<typeof runUtf8CommandWithTimeout>[1],
  host: { hostCwd: string; hostEnv: NodeJS.ProcessEnv },
) {
  const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const config = typeof options === "number" ? { timeoutMs: options } : options;
  const result = native.spawnSync(process.execPath, argv.slice(1), {
    cwd: host.hostCwd,
    env: host.hostEnv,
    input: config.input,
    timeout: config.timeoutMs,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  return doctorProcessResult({
    code: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

/** Keep real child binding and settlement around the suite's Doctor effect double. */
export async function runDelegatedDoctorFixture(
  argv: string[],
  options: Parameters<typeof runUtf8CommandWithTimeout>[1],
  transport: {
    run: typeof runCommandWithTimeout;
    hostCwd: string;
    hostEnv: NodeJS.ProcessEnv;
    npmPrefix: string;
  },
) {
  const { createUpdateCommandTransportFixture } =
    await import("./update-command-transport.test-support.js");
  const { buildUpdateRecoveryDoctorArgs } = await import("../../infra/update-runner-doctor.js");
  if (typeof options === "number") {
    throw new Error("Delegated Doctor requires private input");
  }
  const input: import("./update-command-migrated-types.js").UpdateDoctorInput = JSON.parse(
    String(expectDefined(options.input, "Doctor input")),
  );
  const run = await createUpdateCommandTransportFixture({
    ...transport,
    run: async () =>
      transport.run(
        [
          argv[0]!,
          path.join(input.root, "dist", "index.js"),
          "doctor",
          "--repair",
          "--non-interactive",
          ...(input.workspaceSuggestions ? [] : ["--no-workspace-suggestions"]),
          ...(input.yes ? ["--yes"] : []),
          ...buildUpdateRecoveryDoctorArgs(input.updateRecoveryBackup),
        ],
        options,
      ),
  });
  return doctorProcessResult(await run(argv, options));
}

function expectRecoveryCapture(value: unknown) {
  const ref = updateRecoveryBackupRefSchema.parse(value);
  expect(path.dirname(ref.directory)).toMatch(/\.update-captures$/u);
  expect(ref.manifestPath).toBe(path.join(ref.directory, "manifest.json"));
  expect(ref.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(fs.existsSync(ref.manifestPath)).toBe(true);
}

export function capturedDoctorArgs(argv: string[]): string[] {
  const encoded = expectDefined(
    argv.find((arg) => arg.startsWith("--update-recovery-backup=")),
    "Doctor recovery capture",
  );
  expectRecoveryCapture(JSON.parse(encoded.slice("--update-recovery-backup=".length)));
  return ["--update-recovery-owner=driver", encoded];
}

export function expectFreshDoctorFixture(
  calls: Parameters<typeof runUtf8CommandWithTimeout>[],
  entrypoint: string,
  params: { yes: boolean; workspaceSuggestions?: boolean },
) {
  const matches = calls.filter(([argv, options]) =>
    argv[2] === "--doctor"
      ? typeof options !== "number" && !options.env?.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE
      : argv[1] === entrypoint && argv[2] === "doctor",
  );
  expect(matches).toHaveLength(1);
  const [argv, options] = expectDefined(matches[0], "Doctor invocation");
  if (argv[2] === "--doctor" && typeof options !== "number") {
    expect(options.beforeInput).toEqual(expect.any(Function));
    const input = JSON.parse(String(options.input));
    expect(input).toMatchObject({
      repair: true,
      yes: params.yes,
      workspaceSuggestions: params.workspaceSuggestions === true,
    });
    expectRecoveryCapture(input.updateRecoveryBackup);
  } else {
    expect(argv.slice(1)).toEqual([
      entrypoint,
      "doctor",
      "--repair",
      "--non-interactive",
      ...(params.workspaceSuggestions ? [] : ["--no-workspace-suggestions"]),
      ...(params.yes ? ["--yes"] : []),
      ...capturedDoctorArgs(argv),
    ]);
  }
}

export function mockDelegatedDoctorEffectOnce(
  command: typeof runUtf8CommandWithTimeout,
  transport: Parameters<typeof runDelegatedDoctorFixture>[2],
  effect: typeof runCommandWithTimeout,
) {
  const original = expectDefined(vi.mocked(command).getMockImplementation(), "worker transport");
  let used = false;
  vi.mocked(command).mockImplementation((argv, options) => {
    // Metadata probes must remain real and must not consume the Doctor effect.
    if (!used && argv[2] === "--doctor") {
      used = true;
      return runDelegatedDoctorFixture(argv, options, { ...transport, run: effect });
    }
    return original(argv, options);
  });
}
