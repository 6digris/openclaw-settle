import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function extractShellFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf("\n}\n", start);
  if (start < 0 || end < start) {
    throw new Error(`missing shell function ${name}`);
  }
  return source.slice(start, end + 3);
}

describe("upgrade survivor 2026.7.33 AI runtime repair", () => {
  it("installs the exact omitted runtime dependency before using the baseline CLI", () => {
    const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
    const repair = extractShellFunction(source, "repair_2026_7_33_ai_runtime");
    const fixtureDir = mkdtempSync(join(tmpdir(), "openclaw-upgrade-ai-runtime-"));
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
set -euo pipefail
${repair}
fixture_root="$PWD/root"
mkdir -p "$fixture_root"
printf '%s\n' '{"name":"openclaw","version":"2026.7.33","dependencies":{"@openclaw/ai":"2026.7.33"}}' > "$fixture_root/package.json"
package_root() { printf '%s' "$fixture_root"; }
openclaw_e2e_maybe_timeout() { shift; "$@"; }
openclaw_e2e_print_log() { cat "$1"; }
npm() {
  expected="@openclaw/ai@2026.7.33"
  [ "\${!#}" = "$expected" ]
  mkdir -p "$fixture_root/node_modules/@openclaw/ai"
  printf '%s\n' '{"name":"@openclaw/ai","version":"2026.7.33"}' > "$fixture_root/node_modules/@openclaw/ai/package.json"
}
baseline_version="2026.7.33"
BASELINE_INSTALL_LOG="$PWD/baseline.log"
repair_2026_7_33_ai_runtime
test -f "$fixture_root/node_modules/@openclaw/ai/package.json"
`,
        ],
        { cwd: fixtureDir, encoding: "utf8" },
      );

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("Repairing published 2026.7.33 baseline");
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
