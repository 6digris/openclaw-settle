import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createConfigIO } from "./io.factory.js";
import { readConfigFileSnapshot, readConfigFileSnapshotWithPluginMetadata } from "./io.js";

const detector = vi.hoisted(() => vi.fn(() => []));
vi.mock("../commands/doctor/shared/legacy-config-issues.js", () => ({
  findDoctorLegacyConfigIssues: detector,
}));
const roots = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => detector.mockClear());
afterEach(() => vi.unstubAllEnvs());

it.each(["factory", "snapshot", "metadata"] as const)(
  "%s defers executable diagnostics without accepting invalid schema or writing state",
  async (reader) => {
    const home = roots.make("openclaw-d03-diagnostics-");
    const configPath = path.join(home, "openclaw.json");
    const raw = JSON.stringify({ gateway: { port: "invalid" }, plugins: { enabled: false } });
    fs.writeFileSync(configPath, raw);
    vi.stubEnv("OPENCLAW_HOME", home);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "state"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "");
    const options = { observe: false, deferDoctorLegacyIssues: true };
    const snapshot =
      reader === "factory"
        ? await createConfigIO(options).readConfigFileSnapshot()
        : reader === "snapshot"
          ? await readConfigFileSnapshot(options)
          : (await readConfigFileSnapshotWithPluginMetadata(options)).snapshot;
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "gateway.port" })]),
    );
    expect(detector).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
    expect(fs.existsSync(path.join(home, "state"))).toBe(false);
    // The ordinary reader retains diagnostics after the admitted boundary.
    const full = await readConfigFileSnapshot({ observe: false });
    expect(full.valid).toBe(false);
    expect(detector).toHaveBeenCalledOnce();
  },
);
