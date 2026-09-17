import { vi } from "vitest";
import type { runUtf8CommandWithTimeout } from "../../process/exec.js";
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
