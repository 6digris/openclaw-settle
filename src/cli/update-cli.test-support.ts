import { EventEmitter } from "node:events";
import type fsSync from "node:fs";
import fs from "node:fs/promises";
import { expect, it, vi, type Mock } from "vitest";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import type { UpdateCommandOptions } from "./update-cli/shared.js";

export function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

export function buildUpdateCliArgs(opts: UpdateCommandOptions): string[] {
  const args = ["update"];
  for (const key of ["yes", "json", "dryRun", "acceptCapabilities"] as const) {
    if (opts[key]) {
      args.push(`--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`);
    }
  }
  if (opts.restart === false) {
    args.push("--no-restart");
  }
  for (const key of ["channel", "tag", "timeout"] as const) {
    if (opts[key] !== undefined) {
      args.push(`--${key}`, opts[key]);
    }
  }
  return args;
}

export const statfsFixture = (params: {
  bavail: number;
  bsize?: number;
  blocks?: number;
}): ReturnType<typeof fsSync.statfsSync> => ({
  type: 0,
  bsize: params.bsize ?? 1024,
  blocks: params.blocks ?? 2_000_000,
  bfree: params.bavail,
  bavail: params.bavail,
  files: 0,
  frsize: params.bsize ?? 1024,
  ffree: 0,
});

export const makeOkUpdateResult = (overrides: Partial<UpdateRunResult> = {}): UpdateRunResult => ({
  status: "ok",
  mode: "git",
  steps: [],
  durationMs: 100,
  after: { version: "1.0.0" },
  ...overrides,
});

export function reportCandidateSteps<T extends { steps: UpdateRunResult["steps"] }>(
  options: { onStep?: (step: UpdateRunResult["steps"][number]) => void },
  result: T,
): T {
  for (const step of result.steps) {
    options.onStep?.(step);
  }
  return result;
}

type PostCoreWarningReportingFixture = {
  setupUpdatedRootRefresh: () => unknown;
  spawn: Mock;
  updateCommand: typeof import("./update-cli/update-command.js").updateCommand;
  defaultRuntime: typeof import("../runtime.js").defaultRuntime;
  lastWriteJsonCall: () => unknown;
  listUpdateRuns: typeof import("../infra/update-run-ledger.js").listUpdateRuns;
  closeOpenClawStateDatabaseForTest: typeof import("../state/openclaw-state-db.js").closeOpenClawStateDatabaseForTest;
};

export function registerPostCoreWarningReportingTest({
  setupUpdatedRootRefresh,
  spawn,
  updateCommand,
  defaultRuntime,
  lastWriteJsonCall,
  listUpdateRuns,
  closeOpenClawStateDatabaseForTest,
}: PostCoreWarningReportingFixture): void {
  it("preserves fresh-process plugin warning details in parent json output", async () => {
    const advisories = [
      {
        pluginId: "demo",
        reason: "plugin-target-unavailable",
        message: "Retained demo; the requested package version is unavailable.",
        guidance: ["openclaw plugins update demo"],
      },
      {
        reason: "doctor-advisory",
        message: "Review the group allowlist after updating.",
        guidance: ["openclaw doctor"],
      },
      {
        reason: "configured-plugin-path-unavailable",
        source: "/fixture/offline-plugin",
        message: "Configured plugin path is unavailable; configuration is preserved.",
        guidance: ["Restore the path, then run openclaw doctor --fix."],
      },
      {
        reason: "configured-plugin-path-inspection-failed",
        source: "/fixture/unreadable-plugin",
        errorCode: "EACCES",
        message: "Configured plugin path is unreadable; configuration is preserved.",
        guidance: ["Fix permissions, then run openclaw doctor --fix."],
      },
    ];
    const sourceBundledMessage = "source-demo remains owned by the bundled source checkout.";
    setupUpdatedRootRefresh();
    spawn.mockImplementationOnce((_node, _argv, options) => {
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      const env = (options as { env?: NodeJS.ProcessEnv }).env;
      queueMicrotask(() => {
        void (async () => {
          const resultPath = env?.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
          if (resultPath) {
            await fs.writeFile(
              resultPath,
              JSON.stringify({
                status: "warning",
                changed: false,
                warnings: [
                  {
                    pluginId: "demo",
                    reason: "Failed to update demo: registry timeout",
                    message:
                      'Plugin "demo" could not be processed after the core update: Failed to update demo: registry timeout Run openclaw update repair to retry post-update plugin repair. Run openclaw plugins inspect demo --runtime --json for details.',
                    guidance: [
                      "Run openclaw update repair to retry post-update plugin repair.",
                      "Run openclaw plugins inspect demo --runtime --json for details.",
                    ],
                  },
                  ...advisories,
                ],
                sync: {
                  changed: false,
                  switchedToBundled: [],
                  switchedToNpm: [],
                  warnings: [],
                  errors: [],
                },
                npm: {
                  changed: false,
                  outcomes: [
                    {
                      pluginId: "demo",
                      status: "error",
                      message: "Failed to update demo: registry timeout",
                    },
                    {
                      pluginId: "source-demo",
                      status: "skipped",
                      code: "source-bundled-plugin",
                      message: sourceBundledMessage,
                    },
                  ],
                },
                integrityDrifts: [],
              }),
              "utf-8",
            );
          }
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        })();
      });
      return child;
    });
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ yes: true, json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(jsonOutput?.status).toBe("ok");
    expect(jsonOutput?.reason).toBeUndefined();
    expect(jsonOutput?.postUpdate?.plugins?.warnings?.[0]?.guidance).toContain(
      "Run openclaw update repair to retry post-update plugin repair.",
    );
    expect(jsonOutput?.postUpdate?.plugins?.npm.outcomes[0]?.message).toContain("registry timeout");
    expect(jsonOutput?.postUpdate?.plugins?.warnings?.[0]?.reason).toBe(
      "Failed to update demo: registry timeout",
    );
    expect(jsonOutput?.postUpdate?.plugins?.warnings?.slice(1)).toEqual(advisories);
    closeOpenClawStateDatabaseForTest();
    const run = listUpdateRuns({ limit: 1 })[0];
    expect(run).toMatchObject({ status: "succeeded" });
    expect(
      run?.steps
        .filter((step) => step.step.startsWith("warning:finalize:plugins:"))
        .map(({ status, detail }) => ({ status, detail })),
    ).toEqual(
      [...advisories.map((warning) => warning.message), sourceBundledMessage].map((detail) => ({
        status: "completed",
        detail,
      })),
    );
  });
}
