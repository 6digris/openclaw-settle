import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import * as recoveryConfigWrites from "../../infra/update-recovery-config-writes.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { completePostCorePluginUpdate } from "./update-command-fresh-doctor.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";

export function registerUpdateReceiptRevocationTest(params: {
  makeDirectory: () => string;
  successfulPluginUpdate: PostCorePluginUpdateResult;
  validConfigSnapshot: ConfigFileSnapshot;
}) {
  it("does not launch Doctor when finalization is revoked during config receipt flush", async () => {
    const directory = params.makeDirectory();
    const entered = createDeferred();
    const release = createDeferred();
    const revoked = new Error("Finalization authority was revoked");
    let active = true;
    const doctorLaunch = vi.fn();
    const flush = vi
      .spyOn(recoveryConfigWrites, "persistUpdateRecoveryConfigWrites")
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
    vi.mocked(completePostCorePluginUpdate).mockImplementationOnce(async (doctorParams) => {
      await doctorParams.beforeDoctor?.();
      doctorLaunch();
      return {
        pluginUpdate: params.successfulPluginUpdate,
        configSnapshot: params.validConfigSnapshot,
      };
    });
    const convergence = convergeUpdatePlugins(
      {
        coreAlreadyCurrent: true,
        updateRecoveryBackup: {
          directory,
          manifestPath: path.join(directory, "manifest.json"),
          manifestSha256: "a".repeat(64),
        },
        result: {
          status: "skipped",
          mode: "npm",
          root: "/tmp/openclaw",
          reason: "already-current",
          before: { version: "2026.9.3" },
          after: { version: "2026.9.3" },
          steps: [],
          durationMs: 1,
        },
        root: "/tmp/openclaw",
        installKindChanged: false,
        configSnapshot: params.validConfigSnapshot,
        requestedChannel: null,
        storedChannel: null,
        channel: "stable",
        downgradeRisk: false,
        opts: {},
        preUpdatePluginInstallRecords: {},
        startedAt: 1,
        updateStepTimeoutMs: 1_000,
      },
      () => {
        if (!active) {
          throw revoked;
        }
      },
    );
    const settled = convergence.then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    try {
      await Promise.race([entered.promise, settled]);
      expect(flush).toHaveBeenCalledOnce();
      expect(doctorLaunch).not.toHaveBeenCalled();
      active = false;
      release.resolve();
      const outcome = await settled;
      expect(doctorLaunch).not.toHaveBeenCalled();
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toBe(revoked);
      }
    } finally {
      release.resolve();
      await settled;
      flush.mockRestore();
    }
  });
}
