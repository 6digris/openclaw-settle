import path from "node:path";
import { expect, it } from "vitest";
import { resolveStableNodePath } from "./stable-node-path.js";
import type { UpdateRunnerOptions, UpdateRunResult } from "./update-runner-types.js";

type CommandOptions = { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number };
type CommandResponse = { stdout?: string; stderr?: string; code?: number | null };
type CommandRunner = (
  argv: string[],
  options?: CommandOptions,
) => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
}>;

export function registerGitDoctorOwnershipTests(harness: {
  root(): string;
  prepare(): Promise<void>;
  createRunner(params: {
    stableTag: string;
    installCommand: string;
    buildCommand: string;
    uiBuildCommand: string;
    doctorCommand: string;
    onCommand?: (key: string, options?: CommandOptions) => CommandResponse | undefined;
  }): { calls: string[]; runCommand: CommandRunner };
  run(
    command: CommandRunner,
    options: Pick<
      UpdateRunnerOptions,
      | "channel"
      | "deferConfiguredPluginInstallRepair"
      | "allowGatewayServiceRepair"
      | "allowGatewayActivation"
      | "getDoctorEnv"
      | "getUpdateRecoveryBackup"
      | "beforeGitMutation"
    >,
  ): Promise<UpdateRunResult>;
}) {
  it("marks git update doctor passes for configured-plugin repair deferral when requested", async () => {
    await harness.prepare();
    const tempDir = harness.root();
    const stableTag = "v1.0.1-1";
    let doctorEnv: NodeJS.ProcessEnv | undefined;
    const managedStateDir = path.join(tempDir, "managed-state");
    const backup = {
      directory: path.join(tempDir, "recovery"),
      manifestPath: path.join(tempDir, "recovery", "manifest.json"),
      manifestSha256: "a".repeat(64),
    };
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix --update-recovery-owner=driver --update-recovery-backup=${JSON.stringify(backup)}`;
    const { calls, runCommand } = harness.createRunner({
      stableTag,
      installCommand: "pnpm install",
      buildCommand: "pnpm build",
      uiBuildCommand: "pnpm ui:build",
      doctorCommand,
      onCommand: (key, options) => {
        if (key === doctorCommand) {
          doctorEnv = options?.env;
        }
        return undefined;
      },
    });

    const result = await harness.run(runCommand, {
      channel: "stable",
      deferConfiguredPluginInstallRepair: true,
      allowGatewayServiceRepair: true,
      allowGatewayActivation: true,
      getDoctorEnv: () => ({ OPENCLAW_STATE_DIR: managedStateDir }),
      getUpdateRecoveryBackup: () => backup,
    });

    expect(calls).toContain(doctorCommand);
    expect(result.status).toBe("ok");
    expect(doctorEnv?.OPENCLAW_STATE_DIR).toBe(managedStateDir);
    expect(doctorEnv?.OPENCLAW_UPDATE_IN_PROGRESS).toBe("1");
    expect(doctorEnv?.OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR).toBe("1");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE).toBe("1");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART).toBe("1");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR).toBe("1");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION).toBe("1");
  });

  it("uses the pre-mutation activation decision for the git update doctor pass", async () => {
    await harness.prepare();
    const tempDir = harness.root();
    const stableTag = "v1.0.1-1";
    let doctorEnv: NodeJS.ProcessEnv | undefined;
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive`;
    const { runCommand } = harness.createRunner({
      stableTag,
      installCommand: "pnpm install",
      buildCommand: "pnpm build",
      uiBuildCommand: "pnpm ui:build",
      doctorCommand,
      onCommand: (key, options) => {
        if (key === doctorCommand) {
          doctorEnv = options?.env;
        }
        return undefined;
      },
    });

    const result = await harness.run(runCommand, {
      channel: "stable",
      allowGatewayServiceRepair: true,
      allowGatewayActivation: true,
      beforeGitMutation: async () => ({
        allowGatewayServiceRepair: false,
        allowGatewayActivation: false,
      }),
    });

    expect(result.status).toBe("ok");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR).toBe("0");
    expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION).toBe("0");
    expect(doctorEnv?.OPENCLAW_SERVICE_REPAIR_POLICY).toBeUndefined();
  });
}
