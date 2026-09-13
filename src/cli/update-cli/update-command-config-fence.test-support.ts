import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO, type ConfigWriteOptions } from "../../config/io.js";
import { replaceConfigFile } from "../../config/mutate.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshotRefreshHandler,
} from "../../config/runtime-snapshot.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";

export function captureFiles(paths: string[]) {
  return paths.map((target) => {
    const stat = syncFs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
    return stat
      ? {
          bytes: syncFs.readFileSync(target),
          dev: stat.dev,
          ino: stat.ino,
          mode: stat.mode,
          mtimeNs: stat.mtimeNs,
          ctimeNs: stat.ctimeNs,
        }
      : null;
  });
}

export function useConfigWriterFixture() {
  // Each consuming suite owns its cleanup hooks so executor and runtime state
  // cannot leak between the publication and lifecycle cases.
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    setRuntimeConfigSnapshotRefreshHandler(null);
    resetConfigRuntimeState();
    vi.restoreAllMocks();
  });

  return async function withConfigWriter(
    included: boolean,
    consume: (fixture: {
      home: string;
      configPath: string;
      includePath: string;
      targetPath: string;
      original: string;
      includedRaw: string;
      publicPaths: string[];
      env: NodeJS.ProcessEnv;
      io: ReturnType<typeof createConfigIO>;
      assertCurrent: () => void;
      revoke: () => void;
      write: (options?: ConfigWriteOptions) => Promise<unknown>;
    }) => Promise<void>,
  ) {
    const home = await fs.realpath(dirs.make("update-config-commit-fence-"));
    const stateDir = path.join(home, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const control = path.join(home, "control");
    await fs.mkdir(control);
    vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_HOME: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const options = { env };
    const run = createUpdateRun({ trigger: "cli" }, options);
    const includePath = path.join(stateDir, "includes", "gateway.json");
    const targetPath = included ? includePath : configPath;
    const includedRaw = '{"mode":"local","port":18789}\n';
    const original = included
      ? '{"gateway":{"$include":"./includes/gateway.json"}}\n'
      : '{"gateway":{"mode":"local","port":18789}}\n';
    await fs.writeFile(configPath, original);
    if (included) {
      await fs.mkdir(path.dirname(includePath));
      if (process.platform !== "win32") {
        await fs.chmod(path.dirname(includePath), 0o3700);
      }
      await fs.writeFile(includePath, includedRaw);
    }
    const publicPaths: string[] = [];
    for (const target of included ? [configPath, includePath] : [configPath]) {
      publicPaths.push(target);
      for (const suffix of [".bak", ".bak.1", ".bak.2", ".bak.3", ".bak.4"]) {
        const backupPath = `${target}${suffix}`;
        await fs.writeFile(backupPath, `retained ${path.basename(backupPath)}\n`);
        publicPaths.push(backupPath);
      }
    }
    const io = createConfigIO({ env, observe: false, pluginValidation: "skip" });
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      const fence = await executor.enter(home, { preflight: true });
      const revoke = () => releaseUpdateCommandPreflightForHandoff(fence);
      const write = async (writeOptions: ConfigWriteOptions = {}) => {
        if (!included) {
          return io.writeConfigFile(
            { gateway: { mode: "local", port: 18791 } },
            { skipPluginValidation: true, ...writeOptions },
          );
        }
        const prepared = await io.readConfigFileSnapshotForWrite({ observe: false });
        return replaceConfigFile({
          snapshot: prepared.snapshot,
          baseHash: prepared.snapshot.hash,
          nextConfig: {
            ...prepared.snapshot.sourceConfig,
            gateway: { ...prepared.snapshot.sourceConfig.gateway, port: 18791 },
          },
          writeOptions: { ...prepared.writeOptions, skipPluginValidation: true, ...writeOptions },
          io,
        });
      };
      await consume({
        home,
        configPath,
        includePath,
        targetPath,
        original,
        includedRaw,
        publicPaths,
        env,
        io,
        assertCurrent: fence.assertCurrent,
        revoke,
        write,
      });
    });
  };
}
