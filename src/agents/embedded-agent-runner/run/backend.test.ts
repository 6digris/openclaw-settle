import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.types.js";
import { registerAgentWorkspaceAccess, type AgentWorkspaceAccess } from "../../workspace-access.js";
import { runEmbeddedAttemptWithBackend } from "./backend.js";

const harnessMocks = vi.hoisted(() => ({
  runAttempt: vi.fn(),
}));

vi.mock("../../harness/selection.js", () => ({
  runAgentHarnessAttempt: harnessMocks.runAttempt,
  runAgentHarnessSettledTurnFinalization: vi.fn(),
}));

vi.mock("../../subagents/registry/subagent-registry.js", () => ({
  settleRequesterAfterSessionSpawns: vi.fn(),
}));

describe("embedded attempt backend", () => {
  beforeEach(() => harnessMocks.runAttempt.mockReset());
  it.each([
    {
      name: "replaces stale harness provenance",
      credentialSource: {
        kind: "direct" as const,
        evidence: "environment" as const,
        authorization: "ambient" as const,
      },
      expected: {
        provider: "groq",
        model: "openai/gpt-oss-120b",
        credentialSource: {
          kind: "direct",
          evidence: "environment",
          authorization: "ambient",
        },
      },
    },
    {
      name: "clears provenance when the runtime does not own auth selection",
      credentialSource: undefined,
      expected: undefined,
    },
  ])("$name", async ({ credentialSource, expected }) => {
    harnessMocks.runAttempt.mockResolvedValueOnce({
      agentHarnessId: "openclaw",
      modelAttempt: {
        provider: "stale-provider",
        model: "stale-model",
        credentialSource: { kind: "profile" },
      },
    });

    const result = await runEmbeddedAttemptWithBackend({
      workspaceDir: `/tmp/local-workspace-${randomUUID()}`,
      runtimePlan: {
        resolvedRef: { provider: "groq", modelId: "openai/gpt-oss-120b" },
        auth: credentialSource ? { credentialSource } : {},
      },
    } as never);

    expect(result.modelAttempt).toEqual(expected);
  });

  it.each(["codex", "openclaw"])(
    "prepares remote inputs before the %s harness without changing transcript/media facts",
    async (harness) => {
      const workspaceDir = `/tmp/remote-workspace-${randomUUID()}`;
      const media = [{ path: "media://inbound/report.pdf" }];
      const recorder = { message: { role: "user", __openclaw: { media } } };
      const prepare = vi.fn<NonNullable<AgentWorkspaceAccess["prepareTurnAttachments"]>>(
        async (_turn, assertCurrent) => {
          assertCurrent();
          expect(harnessMocks.runAttempt).not.toHaveBeenCalled();
          return "Current attachment originals are in the private input directory.";
        },
      );
      const release = registerAgentWorkspaceAccess(workspaceDir, {
        bridge: {} as SandboxFsBridge,
        prepareTurnAttachments: prepare,
      });
      harnessMocks.runAttempt.mockResolvedValueOnce({ agentHarnessId: harness });
      const params = {
        workspaceDir,
        prompt: "Inspect the attachment",
        media,
        timeoutMs: 1000,
        userTurnTranscriptRecorder: recorder,
      };
      try {
        await runEmbeddedAttemptWithBackend(params as never);
        expect(prepare.mock.calls[0]?.[0]).toMatchObject({
          media,
          userTurnTranscriptRecorder: recorder,
          timeoutMs: 1000,
        });
        expect(harnessMocks.runAttempt).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: `${params.prompt}\n\nCurrent attachment originals are in the private input directory.`,
            transcriptPrompt: params.prompt,
            media,
            userTurnTranscriptRecorder: recorder,
          }),
        );
        expect(params.prompt).toBe("Inspect the attachment");
        expect(harnessMocks.runAttempt.mock.calls[0]?.[0].media).toBe(media);
      } finally {
        release();
      }
    },
  );

  it.each(["missing", "failure", "revoked", "cancelled"])(
    "does not dispatch a remote turn when input preparation is %s",
    async (failure) => {
      const workspaceDir = `/tmp/remote-workspace-${randomUUID()}`;
      const controller = new AbortController();
      const release = registerAgentWorkspaceAccess(workspaceDir, {
        bridge: {} as SandboxFsBridge,
        ...(failure !== "missing"
          ? {
              prepareTurnAttachments: async () => {
                if (failure === "failure") {
                  throw new Error("transport offline");
                }
                if (failure === "revoked") {
                  release();
                }
                if (failure === "cancelled") {
                  controller.abort(new Error("cancelled"));
                }
                return "Do not use this obsolete result";
              },
            }
          : {}),
      });
      try {
        await expect(
          runEmbeddedAttemptWithBackend({
            workspaceDir,
            prompt: "Inspect attachment",
            timeoutMs: 1000,
            abortSignal: controller.signal,
          } as never),
        ).rejects.toThrow();
        expect(harnessMocks.runAttempt).not.toHaveBeenCalled();
      } finally {
        release();
      }
    },
  );
});
