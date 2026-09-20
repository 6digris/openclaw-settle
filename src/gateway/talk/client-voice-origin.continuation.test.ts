import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { checkClientVoiceToolConfirmationPolicy } from "../../talk/client-voice-confirmation.js";
import { resetClientVoiceConfirmationStateForTest } from "../../talk/client-voice-confirmation.test-support.js";
import {
  readVoiceSessionRecord,
  writeVoiceSessionRecordInTransaction,
} from "../../talk/client-voice-session-store.js";
import {
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
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
import { captureTalkVoiceOrigin } from "./client-voice-origin.js";
const app = {
  action: "app_launch",
  node: "node",
  appId: "linux-desktop:fixture.desktop",
  appRevision: "a".repeat(64),
};
afterEach(() => {
  clientVoiceSessionTesting.reset();
  resetClientVoiceConfirmationStateForTest();
  clearRuntimeConfigSnapshot();
});
describe("consult-local app authority and ordinary Talk continuation", () => {
  for (const policies of ["none", "nonmatching", "matching"] as const) {
    it.each([
      "same-device-token",
      "different-device-token",
      "signed-shared-token",
      "unknown",
    ] as const)(policies + " policies, %s ingress", async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const config = {
          talk: {
            realtime: {
              appLaunchPolicies:
                policies === "none"
                  ? []
                  : [
                      {
                        id: "fixture",
                        agentId: "main",
                        originatingDeviceId: policies === "nonmatching" ? "unrelated" : "widget",
                        nodeId: app.node,
                        appId: app.appId,
                        appRevision: app.appRevision,
                        expiresAtMs: Date.now() + 60_000,
                      },
                    ],
            },
          },
        };
        setRuntimeConfigSnapshot(config, config);
        const context = {};
        const capture = (deviceId: string, deviceToken: boolean) => {
          const request = captureGatewayDeviceRevocation(
            context,
            { deviceId, role: "operator" },
            () => true,
          );
          const origin = captureTalkVoiceOrigin({
            client: { ...sharingPolicyClient({ deviceId }), isDeviceTokenAuth: deviceToken },
            hasCurrentClientAuthority: request.isCurrent,
          });
          request.release();
          return origin;
        };
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:continuation",
          origin: "client" as const,
          transcriptCapable: true,
        };
        const voiceSessionId = createOrResumeClientVoiceSession(scope);
        const first = capture("widget", true);
        registerClientVoiceConsultRun({
          ...scope,
          voiceSessionId,
          runId: "old",
          originAuthority: first,
        });
        first?.release();
        expect(createOrResumeClientVoiceSession({ ...scope, voiceSessionId })).toBe(voiceSessionId);
        const next =
          mode === "unknown"
            ? undefined
            : capture(
                mode === "different-device-token" ? "other" : "widget",
                mode !== "signed-shared-token",
              );
        registerClientVoiceConsultRun({
          ...scope,
          voiceSessionId,
          runId: "new",
          originAuthority: next,
        });
        next?.release();
        const binding = resolveClientVoiceRunBinding("new")!;
        expect(binding.voiceSessionId).toBe(voiceSessionId);
        expect(binding.originAuthority?.deviceId).toBe(
          mode === "same-device-token"
            ? "widget"
            : mode === "different-device-token"
              ? "other"
              : undefined,
        );
        const decision = () =>
          checkClientVoiceToolConfirmationPolicy({
            ...scope,
            voiceSessionId,
            runId: "new",
            toolName: "nodes",
            toolCallId: "launch",
            toolParams: app,
            originAuthority: binding.originAuthority,
            isConfirmable: () => true,
          });
        expect(decision().allowed).toBe(policies === "matching" && mode === "same-device-token");
        await closeClientVoiceSession({ ...scope, voiceSessionId, config });
        expect(resolveClientVoiceRunBinding("old")?.originAuthority?.isCurrent()).toBe(true);
        invalidateGatewayDeviceRevocation(context, "widget", "operator");
        expect(decision().allowed).toBe(false);
        // Closed records are still closed; a new call cannot use their stored identity as authority.
        expect(() => createOrResumeClientVoiceSession({ ...scope, voiceSessionId })).toThrow(
          "already closed",
        );
        const reopened = createOrResumeClientVoiceSession(scope);
        registerClientVoiceConsultRun({ ...scope, voiceSessionId: reopened, runId: "reopened" });
        expect(resolveClientVoiceRunBinding("reopened")?.originAuthority).toBeUndefined();
      });
    });
  }
  it("does not restore device authority from an old persisted open record", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:old", origin: "client" as const };
      const voiceSessionId = createOrResumeClientVoiceSession(scope);
      clientVoiceSessionTesting.reset();
      expect(createOrResumeClientVoiceSession({ ...scope, voiceSessionId })).toBe(voiceSessionId);
      registerClientVoiceConsultRun({ ...scope, voiceSessionId, runId: "old-record" });
      expect(resolveClientVoiceRunBinding("old-record")?.originAuthority).toBeUndefined();
    });
  });
  it.each(["legacy-effect", "policy-metadata"] as const)(
    "reopens %s from SQLite without restoring grant authority",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const config = {
          talk: {
            realtime: {
              appLaunchPolicies: [
                {
                  id: "fixture",
                  agentId: "main",
                  originatingDeviceId: "widget",
                  nodeId: app.node,
                  appId: app.appId,
                  appRevision: app.appRevision,
                  expiresAtMs: Date.now() + 60_000,
                },
              ],
            },
          },
        };
        setRuntimeConfigSnapshot(config, config);
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:persisted",
          origin: "client" as const,
          transcriptCapable: true,
        };
        const voiceSessionId = createOrResumeClientVoiceSession(scope);
        const record = readVoiceSessionRecord(scope.agentId, voiceSessionId);
        if (!record) {
          throw new Error("Missing persisted voice record");
        }
        const effect = {
          runId: "historical",
          toolCallId: "historical-launch",
          toolName: "nodes",
          startedAt: Date.now(),
          status: "succeeded" as const,
          ...(mode === "policy-metadata" ? { voicePolicyId: "fixture" } : {}),
        };
        const before = openOpenClawAgentDatabase({ agentId: scope.agentId });
        const version = before.db.prepare("PRAGMA user_version").get();
        runOpenClawAgentWriteTransaction(
          (database) =>
            writeVoiceSessionRecordInTransaction(database, { ...record, effects: [effect] }),
          { agentId: scope.agentId },
        );
        clientVoiceSessionTesting.reset();
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        const reopened = openOpenClawAgentDatabase({ agentId: scope.agentId });
        expect(reopened).not.toBe(before);
        expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual(version);
        expect(readVoiceSessionRecord(scope.agentId, voiceSessionId)?.effects).toEqual([effect]);
        expect(createOrResumeClientVoiceSession({ ...scope, voiceSessionId })).toBe(voiceSessionId);
        registerClientVoiceConsultRun({ ...scope, voiceSessionId, runId: "after-reopen" });
        const binding = resolveClientVoiceRunBinding("after-reopen");
        expect(binding?.originAuthority).toBeUndefined();
        expect(
          checkClientVoiceToolConfirmationPolicy({
            ...scope,
            voiceSessionId,
            runId: "after-reopen",
            toolName: "nodes",
            toolCallId: "new-launch",
            toolParams: app,
            originAuthority: binding?.originAuthority,
            isConfirmable: () => true,
          }).allowed,
        ).toBe(false);
      });
    },
  );
});
