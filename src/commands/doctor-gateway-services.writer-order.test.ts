import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, type ConfigFileSnapshot } from "../config/config.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runWriteConfigHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { runGatewayServicesHealth } from "../flows/doctor-health-contribution-runners.gateway.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

const service = vi.hoisted(() => ({
  readCommand: vi.fn(),
  install: vi.fn(),
  stage: vi.fn(),
  restart: vi.fn(),
  buildPlan: vi.fn(),
}));

// Package repairs and platform effects are outside this fixture. Config planning,
// validation, the registered gateway runner, and atomic config writes remain real.
vi.mock("./doctor/repair-sequencing.js", () => ({
  runDoctorRepairSequence: async (
    params: Parameters<typeof import("./doctor/repair-sequencing.js").runDoctorRepairSequence>[0],
  ) => ({
    state: params.state,
    changeNotes: [],
    configChangeNotes: [],
    warningNotes: [],
    authProfilesRepaired: false,
    modelRetirementRepairRan: false,
  }),
}));
vi.mock("./doctor-gateway-services.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-gateway-services.js")>()),
  maybeScanExtraGatewayServices: vi.fn(),
  maybeResolveDuelingSystemdGatewayScopes: vi.fn(),
}));
vi.mock("./doctor-foreign-launchd-jobs.js", () => ({ noteMacForeignLaunchdJobs: vi.fn() }));
vi.mock("./doctor-platform-notes.js", () => ({
  noteMacLaunchAgentOverrides: vi.fn(),
  noteMacStaleOpenClawUpdateLaunchdJobs: vi.fn(),
  noteMacLaunchctlGatewayEnvOverrides: vi.fn(),
}));
vi.mock("../infra/container-environment.js", () => ({ isContainerEnvironment: () => false }));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    ...service,
    readDefinitionMutationCapability: async () => ({ kind: "writable" }),
  }),
}));
vi.mock("../daemon/service-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service-audit.js")>()),
  auditGatewayServiceConfig: async () => ({
    ok: false,
    issues: [
      {
        code: "gateway-token-embedded",
        message: "Gateway service contains an embedded token.",
        level: "recommended",
      },
    ],
  }),
}));
vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: service.buildPlan,
}));

describe("Doctor gateway config writer ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
  });

  it.each(["success", "validation-refusal", "service-failure"])(
    "uses Doctor's persisted baseline through service repair (%s)",
    async (outcome) => {
      await withDoctorConfigPreflightHome(async (home) => {
        vi.spyOn(os, "userInfo").mockReturnValue({
          homedir: home,
          username: "doctor-fixture",
          uid: process.getuid?.() ?? 1000,
          gid: process.getgid?.() ?? 1000,
          shell: "/bin/sh",
        });
        await withEnvAsync(
          {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_PROFILE: undefined,
            OPENCLAW_NIX_MODE: undefined,
            OPENCLAW_CONFIG_READONLY: undefined,
            OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
            OPENCLAW_SUPERVISOR_MODE: undefined,
            OPENCLAW_SERVICE_KIND: undefined,
            OPENCLAW_SYSTEMD_UNIT: undefined,
            OPENCLAW_LAUNCHD_LABEL: undefined,
            OPENCLAW_WINDOWS_TASK_NAME: undefined,
            OPENCLAW_UPDATE_IN_PROGRESS: undefined,
            OPENCLAW_GATEWAY_TOKEN: undefined,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
            OPENCLAW_GATEWAY_PORT: undefined,
            OPENCLAW_WRAPPER: undefined,
            KUBERNETES_SERVICE_HOST: undefined,
            KUBERNETES_SERVICE_PORT: undefined,
          },
          async () => {
            const configPath = await writeOpenClawConfig(home, {
              gateway: { mode: "local" },
              plugins: { enabled: false },
            });
            expect(isDefaultInstallIdentity()).toBe(true);
            const ctx = await prepareDoctorContext(configPath);
            ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, port: 19090 } };
            expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
            expect(ctx.cfg.gateway?.auth?.token).toBeUndefined();
            const initialBytes = await fs.readFile(configPath, "utf8");
            const initialBackup = await fs.readFile(`${configPath}.bak`, "utf8");
            const persistedBeforeService = ctx.cfgForPersistence;

            const programArguments = [process.execPath, path.join(home, "openclaw.mjs"), "gateway"];
            service.readCommand.mockResolvedValue({
              programArguments,
              environment: { OPENCLAW_GATEWAY_TOKEN: "recovered-fixture-token" },
            });
            service.buildPlan.mockResolvedValue({ programArguments, environment: {} });
            let installedSnapshot: ConfigFileSnapshot | undefined;
            let installedBaseline: typeof ctx.cfg | undefined;
            service.install.mockImplementation(async () => {
              installedSnapshot = await readConfigFileSnapshot();
              installedBaseline = structuredClone(ctx.cfgForPersistence);
              if (outcome === "service-failure") {
                throw new Error("fixture service install failed");
              }
            });
            if (outcome === "validation-refusal") {
              // Port zero reaches the real writer's schema refusal, not an earlier service guard.
              ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, port: 0 } };
            }
            const candidateBeforeService = ctx.cfg;
            ctx.prompter.confirmRuntimeRepair = async () => true;
            await runGatewayServicesHealth(ctx);

            if (outcome === "validation-refusal") {
              expect(ctx.configWriteRefusal).toBe("validation");
              expect(ctx.cfg).toBe(candidateBeforeService);
              expect(ctx.cfgForPersistence).toBe(persistedBeforeService);
              expect(ctx.cfg.gateway?.auth?.token).toBeUndefined();
              expect(service.install).not.toHaveBeenCalled();
              expect(ctx.runtime.error).toHaveBeenCalledWith(
                expect.stringContaining(
                  "Failed to persist gateway.auth.token before service repair",
                ),
              );
              expect(await fs.readFile(configPath, "utf8")).toBe(initialBytes);
              expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(initialBackup);
            } else {
              expect(service.install).toHaveBeenCalledOnce();
              expect(installedSnapshot?.valid).toBe(true);
              expect(installedSnapshot?.sourceConfig.gateway?.auth?.token).toBe(
                "recovered-fixture-token",
              );
              expect(installedBaseline).toEqual(ctx.cfg);
              expect(ctx.configWriteRefusal).toBeUndefined();
              expect(ctx.cfg.gateway?.auth?.token).toBe("recovered-fixture-token");
              expect(ctx.cfg).toEqual(ctx.cfgForPersistence);
              if (outcome === "service-failure") {
                expect(ctx.runtime.error).toHaveBeenCalledWith(
                  "Gateway service update failed: Error: fixture service install failed",
                );
              }
            }
            expect(service.stage).not.toHaveBeenCalled();
            expect(service.restart).not.toHaveBeenCalled();
            const finalBytes = await fs.readFile(configPath, "utf8");
            const finalBackup = await fs.readFile(`${configPath}.bak`, "utf8");
            expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(
              outcome !== "validation-refusal",
            );
            expect(await fs.readFile(configPath, "utf8")).toBe(finalBytes);
            expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(finalBackup);
          },
        );
      });
    },
  );
});
