import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import {
  adoptUpdateCampaignMock,
  cancelManagedServiceUpdateHandoffMock,
  initializeGatewayUpdateStatusMock,
  invokeUpdateRun,
  scheduleGatewaySigusr1RestartMock,
  sentinelState,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

describe("update.run unexpected-error diagnostics", () => {
  it.each(["discovery", "campaign adoption"])(
    "retains the requested target and redacted failure facts when %s throws",
    async (source) => {
      const error = Object.assign(
        new Error(
          "EACCES: permission denied, open '/Users/example/private-file' token=synthetic-secret\nprivate second line",
        ),
        { code: "EACCES" },
      );
      const root = "/tmp/openclaw-source";
      if (source === "discovery") {
        initializeGatewayUpdateStatusMock.mockRejectedValueOnce(error);
      } else {
        initializeGatewayUpdateStatusMock.mockResolvedValueOnce({
          root,
          status: {
            root,
            installKind: "git",
            packageManager: "pnpm",
            git: {
              root,
              sha: "b".repeat(40),
              tag: null,
              branch: "main",
              upstream: "origin/main",
              dirty: false,
              ahead: 0,
              behind: 1,
              fetchOk: true,
            },
          },
          installReceipt: null,
        });
        adoptUpdateCampaignMock.mockImplementationOnce(() => {
          throw error;
        });
      }
      const logGateway = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
      let payload:
        | { runId: string; ok: boolean; ackDelivered: boolean; result: UpdateRunResult }
        | undefined;
      await invokeUpdateRun(
        { target: { kind: "git", upstreamRef: "origin/main", upstreamSha: "a".repeat(40) } },
        (_ok, response) => {
          payload = response as typeof payload;
        },
        undefined,
        { logGateway },
      );

      const response = expectDefined(payload, "update response");
      const recordedRun = expectDefined(getUpdateRun(response.runId), "recorded update run");
      expect(response).toMatchObject({ ok: false, ackDelivered: false });
      expect(recordedRun).toMatchObject({
        status: "failed",
        phase: "finished",
        reason: "unexpected-error",
      });
      expect(recordedRun.target).toMatchObject({
        kind: "git",
        sha: "a".repeat(40),
      });
      const failureFacts = [
        {
          check: "requested",
          code: "EACCES",
          message: expect.stringContaining("EACCES: permission denied, open [redacted-path]"),
        },
      ];
      expect(recordedRun.steps).toContainEqual(
        expect.objectContaining({
          step: "requested",
          status: "failed",
          failureFacts,
        }),
      );
      expect(response.result).toMatchObject({
        status: "error",
        mode: source === "discovery" ? "unknown" : "git",
        reason: "unexpected-error",
        before: { version: "1.0.0" },
        steps: [expect.objectContaining({ name: "requested", exitCode: 1, failureFacts })],
      });
      expect(response.result.root).toBe(source === "discovery" ? undefined : root);
      expect(adoptUpdateCampaignMock).toHaveBeenCalledTimes(source === "discovery" ? 0 : 1);
      expect(response.result.recovery).toBeUndefined();
      expect(sentinelState.capturedPayload).toBeUndefined();
      expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(cancelManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
      const report = await prepareUpdateFailureReport({
        attemptId: response.runId,
        result: response.result,
        recordedRun,
      });
      expect(report.body).toContain(`Update target: ${"a".repeat(40)}`);
      expect(report.body).toContain("Update mode: git");
      expect(report.body).toContain("Failed phase requested:");
      expect(report.body).toContain("EACCES; Permission denied");
      expect(report.body).toContain("Recovery outcome: not recorded");
      for (const privateText of [
        "/Users/example",
        "private-file",
        "synthetic-secret",
        "private second line",
      ]) {
        expect(JSON.stringify(response.result)).not.toContain(privateText);
        expect(JSON.stringify(recordedRun)).not.toContain(privateText);
        expect(report.body).not.toContain(privateText);
      }
      expect(logGateway.warn).toHaveBeenCalledOnce();
      expect(logGateway.warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    },
  );
});
