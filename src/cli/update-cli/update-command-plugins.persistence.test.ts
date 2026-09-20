import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { seedInstalledPluginIndex } from "../../plugins/test-helpers/installed-plugin-index.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({ convergence: vi.fn() }));
vi.mock("../../commands/doctor/shared/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence: mocks.convergence,
}));
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";

afterEach(() => vi.restoreAllMocks());

describe("updater plugin commit cancellation", () => {
  it.each(["index", "config", "config-failed"] as const)(
    "fences config writes and settles tentative index custody after %s refusal",
    async (effect) => {
      await withOpenClawTestState({ label: `updater-plugin-${effect}` }, async (state) => {
        // Config-write custody uses a host control store outside the profile database.
        const control = state.path("control");
        await fs.mkdir(control, { mode: 0o700 });
        vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        const cfg = { plugins: { enabled: false } };
        await state.writeConfig(cfg);
        const originalConfig = await fs.readFile(state.configPath, "utf8");
        await seedInstalledPluginIndex({}, { config: cfg, env: state.env });
        const controller = new AbortController();
        const refusal = new Error(`updater ${effect} refusal`);
        const assertCurrent = () => controller.signal.throwIfAborted();
        mocks.convergence.mockImplementationOnce(async ({ cfg: candidate }) => {
          await Promise.resolve();
          if (effect === "index") {
            controller.abort(refusal);
          }
          return {
            config: candidate,
            configChanges: [],
            installedPluginIdRecovery: new Map(),
            changes: [],
            warnings: [],
            errored: false,
            smokeFailures: [],
            installRecords: { next: { source: "archive" } },
          };
        });
        const params = {
          root: state.root,
          channel: "stable" as const,
          configSnapshot: await readConfigFileSnapshot(),
          configWriteOptions: {
            beforeCommit: () => {
              if (effect === "config-failed") {
                throw refusal;
              }
              if (effect === "config") {
                controller.abort(refusal);
              }
            },
          },
          configChanged: true,
          pluginInstallRecords: {},
          timeoutMs: 1_000,
          json: true,
          assertCurrent,
        };
        const update = () => updatePluginsAfterCoreUpdate(params);
        await expect(
          effect === "config-failed"
            ? withPluginLifecycleLease({ assertCurrent }, update)
            : update(),
        ).rejects.toBe(refusal);
        if (effect === "config-failed") {
          expect(controller.signal.aborted).toBe(false);
        }
        expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
        // A revoked continuous owner cannot authorize compensating writes. A plain
        // commit failure still rolls back under the live owner; pre-index refusal writes nothing.
        expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(
          effect === "config" ? { next: { source: "archive" } } : {},
        );
      });
    },
  );
});

describe("updater explicit reference intent", () => {
  it.each([true, false])(
    "preserves reference activation only with explicit intent=%s",
    async (explicit) => {
      await withOpenClawTestState(
        { label: `updater-reference-${explicit}`, env: { BROWSER_BIN: "/fixture/browser" } },
        async (state) => {
          const control = state.path("control");
          await fs.mkdir(control, { mode: 0o700 });
          vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
          const cfg = {
            plugins: { enabled: false },
            browser: { executablePath: "$${BROWSER_BIN}" },
          };
          await state.writeConfig(cfg);
          await seedInstalledPluginIndex({}, { config: cfg, env: state.env });
          const snapshot = await readConfigFileSnapshot();
          expect(snapshot.valid).toBe(true);
          expect(snapshot.sourceConfig.browser?.executablePath).toBe("${BROWSER_BIN}");
          mocks.convergence.mockImplementationOnce(async ({ cfg: candidate }) => ({
            config: candidate,
            configChanges: [],
            installedPluginIdRecovery: new Map(),
            changes: [],
            warnings: [],
            errored: false,
            smokeFailures: [],
            installRecords: {},
          }));
          await updatePluginsAfterCoreUpdate({
            root: state.root,
            channel: "stable",
            configSnapshot: snapshot,
            configWriteOptions: {
              explicitSetPaths: explicit ? [["browser", "executablePath"]] : undefined,
            },
            configChanged: true,
            pluginInstallRecords: {},
            timeoutMs: 1_000,
            json: true,
          });
          const written = JSON.parse(await fs.readFile(state.configPath, "utf8"));
          expect(written.browser.executablePath).toBe(
            explicit ? "${BROWSER_BIN}" : "$${BROWSER_BIN}",
          );
          expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual({});
        },
      );
    },
  );
});
