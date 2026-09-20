import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

// Models an already captured ingress authority at the call-record boundary, not a live handshake.
function origin(deviceId: string) {
  return { deviceId, isCurrent: () => true, release: () => {}, retain: () => origin(deviceId) };
}
afterEach(() => {
  clientVoiceSessionTesting.reset();
  clearRuntimeConfigSnapshot();
});
describe("ordinary Talk continuation with no app policies", () => {
  it.each(["same-device", "different-device", "unknown-origin"] as const)(
    "preserves the ordinary call on %s resume",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot({}, {});
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:continuation",
          origin: "client" as const,
        };
        // Preserve the exact old call-owner input for before/after revision replay.
        const original = { ...scope, originAuthority: origin("first") };
        const voiceSessionId = createOrResumeClientVoiceSession(original);
        const resumed = {
          ...scope,
          voiceSessionId,
          originAuthority:
            mode === "unknown-origin"
              ? undefined
              : origin(mode === "same-device" ? "first" : "second"),
        };
        expect(() => createOrResumeClientVoiceSession(resumed)).not.toThrow();
        registerClientVoiceConsultRun({ ...scope, voiceSessionId, runId: "continued-run" });
        expect(resolveClientVoiceRunBinding("continued-run")?.voiceSessionId).toBe(voiceSessionId);
      });
    },
  );
});
