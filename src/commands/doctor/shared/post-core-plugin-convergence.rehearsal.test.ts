import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildUpdateRehearsalPathEnv } from "../../../infra/update-rehearsal-paths.js";
const m = vi.hoisted(() => ({ relink: vi.fn(), current: vi.fn(), smoke: vi.fn() }));
// Boundary test only: actual lease/runtime qualification remains with the installed fixture.
vi.mock("../../../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (
    _options: unknown,
    run: (lease: { assertOwned: () => void }) => unknown,
  ) => await run({ assertOwned: m.current }),
}));
vi.mock("../../../plugins/npm-project-roots.js", () => ({
  listManagedPluginNpmRoots: async (root: string) => [root],
}));
vi.mock("../../../plugins/plugin-peer-link.js", () => ({
  relinkOpenClawPeerDependenciesInManagedNpmRoot: m.relink,
  reconcileRegisteredOpenClawHostLinks: async () => ({ repaired: 0 }),
}));
vi.mock("../../doctor-plugin-registry.js", () => ({
  maybeRepairStaleManagedNpmBundledPlugins: () => null,
}));
vi.mock("./missing-configured-plugin-install.js", () => ({
  repairMissingConfiguredPluginInstalls: async () => ({ records: {}, changes: [] }),
}));
vi.mock("../../../plugins/active-payload-verification.js", () => ({
  runActivePluginPayloadSmokeCheck: m.smoke,
  filterRecordsToActive: () => ({}),
}));
import { runPostCorePluginConvergence } from "./post-core-plugin-convergence.js";
let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
  }
  vi.resetAllMocks();
});
it("latches outside-peer refusal despite warning conversion and a derived host-version env", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-d12-convergence-"));
  const env = {
    ...buildUpdateRehearsalPathEnv(root),
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
  };
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", undefined);
  const failures: unknown[] = [];
  const destinations = [path.join(root, "..", "outside-peer"), path.join(root, "inside-peer")];
  m.relink.mockImplementation(
    async (params: { beforePersistentApply: (destination: string) => void }) => {
      for (const destination of destinations) {
        try {
          params.beforePersistentApply(destination);
        } catch (error) {
          failures.push(error);
        }
      }
      return { repaired: 0 };
    },
  );
  await expect(runPostCorePluginConvergence({ cfg: {}, env })).rejects.toThrow(
    "destination escapes",
  );
  expect(failures).toHaveLength(2);
  expect(failures[1]).toBe(failures[0]);
  expect(m.current).toHaveBeenCalled();
  expect(m.smoke).not.toHaveBeenCalled();
});
