import { beforeEach, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.js";
import { planAutomaticConfigRepair } from "./doctor/shared/automatic-startup-config-repair.js";

const metadata = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("plugin metadata tripwire");
  }),
);
vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginMetadataSnapshot: metadata,
}));

beforeEach(() => {
  vi.clearAllMocks();
});
function sourceSnapshot(): ConfigFileSnapshot {
  const source = {
    gateway: { mode: "local" as const },
    agents: { entries: { main: {} } },
    tools: { exec: { timeoutSeconds: 45 } },
    session: { scope: "per-sender" as const, idleMinutes: 30 },
  };
  return {
    path: "/synthetic/config.json",
    exists: true,
    raw: JSON.stringify(source),
    parsed: source,
    resolved: source,
    runtimeConfig: source,
    sourceConfig: source,
    config: source,
    valid: false,
    issues: [{ path: "session.idleMinutes", message: "retired" }],
    warnings: [],
    legacyIssues: [{ path: "session.idleMinutes", message: "retired" }],
  };
}
it("core repair preview uses the real shared transforms without resolving plugin metadata", () => {
  const snapshot = sourceSnapshot();
  const original = JSON.stringify(snapshot);
  const plan = planAutomaticConfigRepair(snapshot, { pluginContracts: false, installRecords: {} });
  expect(plan?.snapshot.valid).toBe(true);
  expect(plan?.config.session?.reset?.idleMinutes).toBe(30);
  expect(metadata).not.toHaveBeenCalled();
  expect(JSON.stringify(snapshot)).toBe(original);
});
it("the default repair plan still requires complete plugin validation", () => {
  expect(() => planAutomaticConfigRepair(sourceSnapshot(), { installRecords: {} })).toThrow(
    "plugin metadata tripwire",
  );
  expect(metadata).toHaveBeenCalled();
});
