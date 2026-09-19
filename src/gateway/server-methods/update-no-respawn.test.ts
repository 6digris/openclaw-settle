import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  captureUpdateRunPayload,
  detectRespawnSupervisorMock,
  mockGlobalInstallSurface,
  scheduleGatewaySigusr1RestartMock,
  sendGatewayLifecycleNoticeMock,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

const sessionKey = "agent:main:slack:dm:C0123ABC:thread:1234567890.123456";

it.each(["git", "global"] as const)(
  "refuses a foreground %s update before acknowledgement when process respawn is disabled",
  async (kind) => {
    if (kind === "global") {
      mockGlobalInstallSurface();
    }
    const response = await withEnvAsync({ OPENCLAW_NO_RESPAWN: "1" }, () =>
      captureUpdateRunPayload({ sessionKey }),
    );

    expect(response).toMatchObject({
      ok: false,
      ackDelivered: false,
      result: { reason: "restart-unavailable" },
      message: expect.stringContaining("OPENCLAW_NO_RESPAWN"),
    });
    const run = getUpdateRun(expectDefined(response, "update response").runId);
    expect(run).toMatchObject({
      phase: "finished",
      reason: "restart-unavailable",
      origin: { nextAction: expect.stringContaining("openclaw update") },
    });
    expect(run?.steps.map(({ step, status }) => ({ step, status }))).toEqual([
      { step: "requested", status: "failed" },
      { step: "installation-inspection", status: "completed" },
    ]);
    expect(sendGatewayLifecycleNoticeMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  },
);

it("rechecks foreground respawn after awaiting acknowledgement", async () => {
  await withEnvAsync({ OPENCLAW_NO_RESPAWN: undefined }, async () => {
    sendGatewayLifecycleNoticeMock.mockImplementationOnce(async () => {
      process.env.OPENCLAW_NO_RESPAWN = "1";
      return true;
    });

    const response = await captureUpdateRunPayload({ sessionKey });

    expect(response).toMatchObject({
      ok: false,
      ackDelivered: true,
      result: { reason: "restart-unavailable" },
      message: expect.stringContaining("OPENCLAW_NO_RESPAWN"),
    });
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });
});

it.each(["before", "during"] as const)(
  "keeps serving when respawn is disabled %s the parking notification",
  async (timing) => {
    await withEnvAsync({ OPENCLAW_NO_RESPAWN: undefined }, async () => {
      expect(await captureUpdateRunPayload({ sessionKey })).toMatchObject({ ok: true });
      const handoff = expectDefined(
        startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0],
        "prepared handoff",
      );
      if (timing === "before") {
        process.env.OPENCLAW_NO_RESPAWN = "1";
      } else {
        sendGatewayLifecycleNoticeMock.mockImplementationOnce(async () => {
          process.env.OPENCLAW_NO_RESPAWN = "1";
          return true;
        });
      }

      await expect(expectDefined(handoff.beforePark, "parking callback")()).rejects.toThrow(
        "OPENCLAW_NO_RESPAWN",
      );
      expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    });
  },
);

it.each(["launchd", "systemd"] as const)(
  "retains %s-managed updates when foreground respawn is disabled",
  async (supervisor) => {
    detectRespawnSupervisorMock.mockReturnValue(supervisor);
    const response = await withEnvAsync({ OPENCLAW_NO_RESPAWN: "1" }, () =>
      captureUpdateRunPayload(),
    );

    expect(response).toMatchObject({ ok: true, handoff: { status: "started" } });
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({ supervisor }),
    );
    expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
  },
);

it("admits foreground updates when the respawn policy is explicitly false", async () => {
  const response = await withEnvAsync({ OPENCLAW_NO_RESPAWN: "0" }, () =>
    captureUpdateRunPayload(),
  );
  expect(response).toMatchObject({ ok: true, handoff: { status: "started" } });
  expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
});
