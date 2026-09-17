import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import * as launchdSystem from "./launchd-system.js";
import { readGatewayServiceState } from "./service.js";
import { createMockGatewayService } from "./service.test-helpers.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe.runIf(process.platform === "darwin")("external launchd definition inspection", () => {
  it.each(["LaunchAgents", "LaunchDaemons"])(
    "reads the exact %s plist without adopting its native or state selectors",
    async (directory) => {
      const root = dirs.make("external-launchd-");
      const plist = path.join(root, directory, "vendor-gateway.plist");
      const programArguments = [
        process.execPath,
        path.join(root, "package", "openclaw.mjs"),
        "gateway",
      ];
      const environment = {
        HOME: path.join(root, "service-home"),
        OPENCLAW_PROFILE: "external",
        OPENCLAW_STATE_DIR: path.join(root, "service-state"),
        OPENCLAW_LAUNCHD_LABEL: "unadopted-selector",
      };
      await fs.mkdir(path.dirname(plist));
      await fs.writeFile(
        plist,
        buildLaunchAgentPlist({
          label: "external-service",
          programArguments,
          environment,
          stdoutPath: path.join(root, "stdout.log"),
          stderrPath: path.join(root, "stderr.log"),
        }),
      );
      const env = {
        HOME: path.join(root, "caller"),
        OPENCLAW_PROFILE: "caller",
        OPENCLAW_LAUNCHD_LABEL: "external-service",
      };
      const service = createMockGatewayService();
      const state = await readGatewayServiceState(service, { env, externalLaunchdPlist: plist });

      expect(state.command).toMatchObject({ programArguments, environment, sourcePath: plist });
      expect(state.env).toEqual(env);
      expect(state.externalLaunchdPlist).toBe(plist);
      expect(state.loadState.status).toBe("unknown");
      expect(state.runtime?.status).toBe("unknown");
      expect(state.definitionMutationCapability).toMatchObject({
        kind: "sealed",
        reason: "system-owned",
      });
      for (const method of [
        service.readCommand,
        service.readRuntime,
        service.isLoaded,
        service.start,
        service.stop,
        service.install,
      ]) {
        expect(method).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["absent", "loaded", "unverifiable", "global-agent", "label-changed"] as const)(
    "requires native absence bound to the captured definition: %s",
    async (outcome) => {
      const label = `ai.openclaw.proof-${randomUUID()}`;
      const plist = `/Library/${outcome === "global-agent" ? "LaunchAgents" : "LaunchDaemons"}/${label}.plist`;
      const contents = Buffer.from(
        buildLaunchAgentPlist({
          label: outcome === "label-changed" ? `${label}-changed` : label,
          programArguments: [process.execPath, "/isolated/package/openclaw.mjs", "gateway"],
          stdoutPath: "/dev/null",
          stderrPath: "/dev/null",
        }),
      );
      const readFile = fs.readFile;
      vi.spyOn(fs, "readFile").mockImplementation((...args) =>
        args[0] === plist ? Promise.resolve(contents) : readFile(...args),
      );
      const probe = vi.spyOn(launchdSystem, "inspectSystemLaunchDaemonOwnership");
      if (outcome === "loaded") {
        probe.mockResolvedValue({ status: "loaded", serviceTarget: `system/${label}` });
      } else if (outcome === "unverifiable") {
        probe.mockResolvedValue({
          status: "unverifiable",
          serviceTarget: `system/${label}`,
          operation: "launchctl",
          detail: "inspection unavailable",
        });
      }
      const read = readGatewayServiceState(createMockGatewayService(), {
        externalLaunchdPlist: plist,
        env: { OPENCLAW_LAUNCHD_LABEL: label },
      });
      if (outcome === "label-changed") {
        await expect(read).rejects.toThrow();
        expect(probe).not.toHaveBeenCalled();
        return;
      }
      const state = await read;
      expect(state.loadState.status).toBe(outcome === "absent" ? "not-loaded" : "unknown");
      expect(state.runtime?.status).toBe(outcome === "absent" ? "stopped" : "unknown");
      if (outcome === "global-agent") {
        expect(probe).not.toHaveBeenCalled();
      } else {
        expect(probe).toHaveBeenCalledWith(
          label,
          expect.objectContaining({ scanInstalledPlists: false }),
        );
      }
    },
  );

  it.each(["missing", "malformed"])(
    "refuses an uninspectable %s external definition",
    async (kind) => {
      const plist = path.join(dirs.make("external-launchd-"), "external.plist");
      if (kind === "malformed") {
        await fs.writeFile(plist, "<plist>invalid");
      }
      const service = createMockGatewayService();
      await expect(
        readGatewayServiceState(service, { externalLaunchdPlist: plist }),
      ).rejects.toThrow();
      expect(service.readCommand).not.toHaveBeenCalled();
      expect(service.stop).not.toHaveBeenCalled();
    },
  );
});
