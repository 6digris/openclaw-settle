import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runWithSpawnBroker } from "../../process/spawn-broker/context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "../../process/spawn-broker/host.js";
import { ensureTool } from "./tools-manager.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("tool availability through the spawn broker", () => {
  let host: SpawnBrokerHost;
  beforeAll(async () => {
    host = createSpawnBrokerHost();
    await host.ready();
  });
  afterAll(async () => {
    await host.close();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fetchWithSsrFGuardMock.mockClear();
  });

  it.each([
    { tool: "rg", installed: "rg", commands: [{ name: "rg", exitCode: 0 }] },
    { tool: "fd", installed: "fd", commands: [{ name: "fd", exitCode: 0 }] },
    {
      tool: "fd",
      installed: "fdfind",
      commands: [
        { name: "fd", exitCode: 1 },
        { name: "fdfind", exitCode: 0 },
      ],
    },
  ] as const)("checks installed $installed without forking the Gateway", async (fixture) => {
    const directory = tempDirs.make("openclaw-tool-probe-");
    const parentFile = join(directory, "parents");
    vi.stubEnv("OPENCLAW_AGENT_DIR", join(directory, "agent"));
    vi.stubEnv("OPENCLAW_CLI", "synthetic-preserved");
    vi.stubEnv("OPENCLAW_TOOL_PROBE_PARENT_FILE", parentFile);
    vi.stubEnv("PATH", `${directory}${delimiter}${process.env.PATH ?? ""}`);
    for (const command of fixture.commands) {
      writeFileSync(
        join(directory, command.name),
        `#!/bin/sh\n[ "$1" = "--version" ] || exit 2\n[ "$OPENCLAW_CLI" = "synthetic-preserved" ] || exit 3\nprintf '%s\\n' "$PPID" >> "$OPENCLAW_TOOL_PROBE_PARENT_FILE"\nexit ${command.exitCode}\n`,
        { mode: 0o755 },
      );
    }

    await expect(runWithSpawnBroker(host, () => ensureTool(fixture.tool, true))).resolves.toBe(
      fixture.installed,
    );

    const parents = (await readFile(parentFile, "utf8")).trim().split("\n").map(Number);
    expect(parents).toEqual(fixture.commands.map(() => host.pid));
    expect(parents).not.toContain(process.pid);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});
