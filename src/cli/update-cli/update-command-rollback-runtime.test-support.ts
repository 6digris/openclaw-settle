import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/config.js";
import type { PreManagedServiceStop } from "./update-command-service-maintenance.js";

const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  restart: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(),
  serviceState: vi.fn<typeof import("../../daemon/service.js").readGatewayServiceState>(),
  revalidateService:
    vi.fn<
      typeof import("./update-command-service-maintenance.js").revalidateManagedGatewayServiceAfterUpdate
    >(),
  execSchtasks: vi.fn<typeof import("../../daemon/schtasks-exec.js").execSchtasks>(),
}));
vi.mock("../../daemon/schtasks-exec.js", () => ({ execSchtasks: mocks.execSchtasks }));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: mocks.serviceState,
}));
vi.mock("./update-command-service-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-maintenance.js")>()),
  createWindowsTaskAutoStartGuard: () => async () => {},
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidateService,
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stop,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate: async (
    stopped: PreManagedServiceStop | undefined,
    safe: boolean,
    guard?: () => Promise<void>,
  ) => stopped?.windowsTaskAutoStartRecovery?.restore(safe, guard),
}));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: async () => "accepted",
}));
vi.mock("./update-command-service.js", () => ({ maybeRestartService: mocks.restart }));
vi.mock("./update-command-service-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-plan.js")>()),
  resolveUpdatedGatewayRestartPort: async () => 19101,
}));

export const dirs = useAutoCleanupTempDirTracker(afterEach);
export let candidateRoot: string;
export let previousRoot: string;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
export async function readPreviousConfig(env: NodeJS.ProcessEnv) {
  return createConfigIO({ env, pluginValidation: "skip" }).readConfigFileSnapshot();
}
export function setVersion(file: string, version: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  previousRoot = fs.realpathSync(dirs.make("rollback-previous-runtime-"));
  candidateRoot = fs.realpathSync(dirs.make("rollback-candidate-runtime-"));
  for (const [root, version] of [
    [previousRoot, "2026.9.1"],
    [candidateRoot, "2026.9.3"],
  ] as const) {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", version }));
  }
  const worker = "dist/infra/update-candidate-state.worker.js";
  fs.mkdirSync(path.dirname(path.join(candidateRoot, worker)), { recursive: true });
  fs.writeFileSync(
    path.join(candidateRoot, worker),
    `import ${JSON.stringify(pathToFileURL(path.resolve(worker)).href)};\n`,
  );
  vi.resetAllMocks();
  mocks.serviceState.mockResolvedValue({
    installed: true,
    loadState: { status: "loaded" },
    running: false,
    env: {},
    command: {
      programArguments: [process.execPath, path.join(previousRoot, "dist", "index.js"), "gateway"],
    },
  });
  mocks.revalidateService.mockResolvedValue({
    kind: "owned",
    root: previousRoot,
    fingerprint: "fixture",
    refreshDefinition: true,
  });
  mocks.stop.mockResolvedValue({
    stopped: true,
    stoppedAtMs: 100,
    serviceUpdateVerdict: {
      kind: "owned",
      root: candidateRoot,
      fingerprint: "fixture",
      refreshDefinition: true,
    },
  });
  mocks.restart.mockImplementation(async ({ onVerified }) => {
    onVerified?.(125);
    return "ok";
  });
});

export { mocks };
