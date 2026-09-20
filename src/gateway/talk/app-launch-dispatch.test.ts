import { afterEach, describe, expect, it } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { withClientVoiceAppLaunchExecution } from "../../talk/client-voice-app-launch-execution.js";
import { resetClientVoiceConfirmationStateForTest } from "../../talk/client-voice-confirmation.test-support.js";
import {
  createOrResumeClientVoiceSession,
  closeClientVoiceSession,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { prepareTalkAppLaunchDispatch } from "./app-launch-dispatch.js";
import { captureTalkVoiceOrigin } from "./client-voice-origin.js";

const app = { appId: "linux-desktop:fixture.desktop", appRevision: "a".repeat(64) };
const policy = {
  id: "fixture",
  agentId: "main",
  originatingDeviceId: "widget",
  nodeId: "node",
  ...app,
  expiresAtMs: Date.now() + 60_000,
};
const cfg = () => ({
  talk: { realtime: { appLaunchPolicies: [{ ...policy, expiresAtMs: Date.now() + 60_000 }] } },
});
afterEach(() => {
  clientVoiceSessionTesting.reset();
  resetClientVoiceConfirmationStateForTest();
  clearRuntimeConfigSnapshot();
});

async function scope(
  run: (fixture: {
    make: () => ReturnType<typeof prepareTalkAppLaunchDispatch>;
    context: object;
    voiceSessionId: string;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = cfg();
    setRuntimeConfigSnapshot(config, config);
    const context = {};
    const ingress = captureGatewayDeviceRevocation(
      context,
      { deviceId: "widget", role: "operator" },
      () => true,
    );
    const client = { ...sharingPolicyClient({ deviceId: "widget" }), isDeviceTokenAuth: true };
    const originAuthority = captureTalkVoiceOrigin({
      client,
      hasCurrentClientAuthority: ingress.isCurrent,
    });
    const sessionKey = "agent:main:launch";
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
      transcriptCapable: true,
      originAuthority,
    });
    ingress.release();
    registerClientVoiceConsultRun({
      agentId: "main",
      sessionKey,
      voiceSessionId,
      runId: "launch-run",
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "launch-run",
      toolCallId: "launch-call",
      toolName: "nodes",
      mutatingAction: true,
    });
    await waitForDiagnosticEventsDrained();
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey,
        operationalRunInstance: createOperationalRunInstanceRef("launch-run"),
      },
      () =>
        withClientVoiceAppLaunchExecution(
          {
            runId: "launch-run",
            toolCallId: "launch-call",
            nodeId: "node",
            request: app,
            voiceRun: resolveClientVoiceRunBinding("launch-run"),
          },
          () =>
            run({ make: () => prepareTalkAppLaunchDispatch("node", app), context, voiceSessionId }),
        ),
    );
  });
}

describe("Talk installed-app final Gateway authority", () => {
  it("authorizes repeated exact launches and records only the policy reference", async () => {
    await scope(async ({ make, voiceSessionId }) => {
      expect(make().isCurrent(true)).toBe(true);
      expect(make().isCurrent(true)).toBe(true);
      const effect = clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects[0];
      expect(effect).toMatchObject({ voicePolicyId: "fixture", toolCallId: "launch-call" });
      expect(effect).not.toHaveProperty("appId");
      expect(effect).not.toHaveProperty("appRevision");
    });
  });
  it.each(["remove", "expire", "revoke-device"])(
    "rechecks %s after node policy work or readiness retry",
    async (change) => {
      await scope(async ({ make, context }) => {
        const dispatch = make();
        expect(dispatch.isCurrent()).toBe(true);
        await Promise.resolve();
        if (change === "revoke-device") {
          invalidateGatewayDeviceRevocation(context, "widget", "operator");
        } else {
          const next = cfg();
          next.talk.realtime.appLaunchPolicies =
            change === "remove" ? [] : [{ ...policy, expiresAtMs: Date.now() - 1 }];
          setRuntimeConfigSnapshot(next, next);
        }
        expect(dispatch.isCurrent(true)).toBe(false);
        expect(dispatch.reason()).toContain("VOICE_CONFIRMATION_REQUIRED");
      });
    },
  );
  it("retains admitted-run origin authority and effect recording after logical hangup", async () => {
    await scope(async ({ make, voiceSessionId }) => {
      await closeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:launch",
        voiceSessionId,
        config: {},
      });
      expect(make().isCurrent(true)).toBe(true);
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects[0]?.voicePolicyId,
      ).toBe("fixture");
    });
  });

  it("rejects a token-only resume without replacing the authenticated device owner", async () => {
    await scope(async ({ make, voiceSessionId }) => {
      expect(() =>
        createOrResumeClientVoiceSession({
          agentId: "main",
          sessionKey: "agent:main:launch",
          voiceSessionId,
          origin: "client",
        }),
      ).toThrow("originating device does not match");
      expect(make().isCurrent(true)).toBe(true);
    });
  });

  it("does not revoke an admitted run when the same device resumes its call", async () => {
    await scope(async ({ make, voiceSessionId, context }) => {
      const fresh = captureGatewayDeviceRevocation(
        context,
        { deviceId: "widget", role: "operator" },
        () => true,
      );
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:launch",
        voiceSessionId,
        origin: "client",
        originAuthority: captureTalkVoiceOrigin({
          client: { ...sharingPolicyClient({ deviceId: "widget" }), isDeviceTokenAuth: true },
          hasCurrentClientAuthority: fresh.isCurrent,
        }),
      });
      fresh.release();
      expect(make().isCurrent(true)).toBe(true);
      invalidateGatewayDeviceRevocation(context, "widget", "operator");
      expect(make().isCurrent(true)).toBe(false);
    });
  });

  it("binds fresh authenticated ingress when resuming a persisted call after runtime reset", async () => {
    await scope(async ({ voiceSessionId, context }) => {
      clientVoiceSessionTesting.reset();
      const fresh = captureGatewayDeviceRevocation(
        context,
        { deviceId: "other-widget", role: "operator" },
        () => true,
      );
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:launch",
        voiceSessionId,
        origin: "client",
        originAuthority: captureTalkVoiceOrigin({
          client: { ...sharingPolicyClient({ deviceId: "other-widget" }), isDeviceTokenAuth: true },
          hasCurrentClientAuthority: fresh.isCurrent,
        }),
      });
      fresh.release();
      registerClientVoiceConsultRun({
        agentId: "main",
        sessionKey: "agent:main:launch",
        voiceSessionId,
        runId: "resumed-run",
      });
      const voiceRun = resolveClientVoiceRunBinding("resumed-run");
      expect(voiceRun?.originAuthority?.deviceId).toBe("other-widget");
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:launch",
          operationalRunInstance: createOperationalRunInstanceRef("resumed-run"),
        },
        () =>
          withClientVoiceAppLaunchExecution(
            {
              runId: "resumed-run",
              toolCallId: "resumed-call",
              nodeId: "node",
              request: app,
              voiceRun,
            },
            async () => {
              expect(prepareTalkAppLaunchDispatch("node", app).isCurrent()).toBe(false);
            },
          ),
      );
    });
  });

  it("fails closed if the captured voice run disappears during target preparation", async () => {
    await scope(async ({ make }) => {
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        runId: "launch-run",
        durationMs: 1,
        outcome: "completed",
      });
      await waitForDiagnosticEventsDrained();
      expect(resolveClientVoiceRunBinding("launch-run")).toBeUndefined();
      const dispatch = make();
      expect(dispatch.isCurrent(true)).toBe(false);
      expect(dispatch.reason()).toContain("run binding changed");
    });
  });

  it("does not inherit a match after canonical target or descriptor substitution", async () => {
    await scope(async () => {
      expect(() => prepareTalkAppLaunchDispatch("other-node", app)).toThrow("effect binding");
      expect(() =>
        prepareTalkAppLaunchDispatch("node", { ...app, appRevision: "b".repeat(64) }),
      ).toThrow("effect binding");
      expect(() => prepareTalkAppLaunchDispatch("node", { ...app, command: "shell" })).toThrow();
    });
  });
  it("does not create origin authority from token-only or fabricated current callbacks", () => {
    const client = sharingPolicyClient({ deviceId: "widget" });
    expect(
      captureTalkVoiceOrigin({ client, hasCurrentClientAuthority: () => true }),
    ).toBeUndefined();
    expect(
      captureTalkVoiceOrigin({
        client: { ...client, isDeviceTokenAuth: true },
        hasCurrentClientAuthority: () => true,
      }),
    ).toBeUndefined();
  });
});
