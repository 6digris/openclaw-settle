import fs from "node:fs/promises";
import path from "node:path";
import { stripSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as scratchDirectories from "../../infra/tmp-openclaw-dir.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { hashCliSessionText } from "../cli-session.js";
import {
  bindExtraSystemPromptContext,
  composeExtraSystemPromptContext,
} from "../extra-system-prompt-context.js";
import { withExtraSystemPromptScope } from "../extra-system-prompt.js";
import { createReadToolDefinition } from "../sessions/tools/read.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);

describe("CLI supplemental context preparation", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  let backend: CliBackendPlugin & { pluginId: string };
  const contexts: PreparedCliRunContext[] = [];

  const prepare = async (params: Partial<RunCliAgentParams>) => {
    const context = await fixture.prepare({ modelContextTokens: 8_000, ...params });
    contexts.push(context);
    return context;
  };

  beforeEach(() => {
    supervisorSpawnMock.mockReset();
    backend = buildDefaultTestCliBackend();
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [backend],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      loadManifestModelCatalog: () => [],
    });
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(async () => {
    try {
      for (const context of contexts.splice(0).toReversed()) {
        await context.preparedBackend.cleanup?.();
      }
    } finally {
      resetCliRunnerPrepareTestDeps();
      cliBackendsTesting.resetDepsForTest();
      vi.restoreAllMocks();
      fixture.cleanup();
      supervisorSpawnMock.mockReset();
    }
  });

  it("leaves ordinary supplemental instructions and their source identity unchanged", async () => {
    const extraSystemPrompt =
      "Follow the requested output format.\nKeep the supplied qualifications.";
    const context = await prepare({ extraSystemPrompt });

    expect(context.systemPrompt).toContain(extraSystemPrompt);
    expect(context.params.extraSystemPrompt).toBe(extraSystemPrompt);
    expect(context.extraSystemPromptHash).toBe(hashCliSessionText(extraSystemPrompt));
    expect(context.systemPromptReport.extraSystemPrompt).toEqual({
      rawChars: extraSystemPrompt.length,
      injectedChars: extraSystemPrompt.length,
      truncated: false,
    });
  });

  it("reduces a large source without losing an interior runtime policy or rewriting the source", async () => {
    const runtimePolicy =
      "Runtime policy: this private reply must not be delivered to another target.";
    const source = composeExtraSystemPromptContext([
      { text: `Beginning of supplied context.\n${"x".repeat(1_048_576)}`, reducible: true },
      { text: runtimePolicy, reducible: false },
      { text: `${"y".repeat(1_048_576)}\nEnd of supplied context.`, reducible: true },
    ]);
    const input = bindExtraSystemPromptContext({ extraSystemPrompt: source.text }, source);
    const context = await withExtraSystemPromptScope(() => prepare(input), "cli-large-context");

    expect(context.systemPrompt.length).toBeLessThan(source.text.length / 20);
    expect(context.systemPrompt).toContain(runtimePolicy);
    expect(context.params.extraSystemPrompt).toBe(source.text);
    expect(context.systemPromptReport.extraSystemPrompt).toEqual({
      rawChars: source.text.length,
      injectedChars: expect.any(Number),
      truncated: true,
    });
  });

  it("reuses the prepared representation and still notices changed omitted source text", async () => {
    const head = "Beginning of supplied context.\n" + "x".repeat(100_000);
    const tail = "y".repeat(100_000) + "\nEnd of supplied context.";
    const firstSource = `${head}\nsource-value-a\n${tail}`;
    const changedSource = `${head}\nsource-value-b\n${tail}`;

    await withExtraSystemPromptScope(async () => {
      const first = await prepare({ extraSystemPrompt: firstSource });
      const retried = await prepare({ extraSystemPrompt: firstSource });
      const changed = await prepare({ extraSystemPrompt: changedSource });

      expect(first.systemPrompt.length).toBeLessThan(firstSource.length / 5);
      expect(retried.systemPrompt).toBe(first.systemPrompt);
      expect(retried.extraSystemPromptHash).toBe(first.extraSystemPromptHash);
      expect(changed.extraSystemPromptHash).not.toBe(first.extraSystemPromptHash);
      expect(changed.params.extraSystemPrompt).toBe(changedSource);
    }, "cli-context-retry");
  });

  it.each(["legacy raw binding", "smaller context budget"] as const)(
    "refreshes a retained first-only session after a %s",
    async (reason) => {
      backend = {
        ...backend,
        config: {
          ...backend.config,
          command: process.execPath,
          resumeArgs: ["--resume", "{sessionId}"],
        },
      };
      supervisorSpawnMock.mockResolvedValue(
        createManagedRun({ ...createSuccessfulProcessExit(), stdout: "finished" }),
      );
      const extraSystemPrompt = `Keep the requested format.\n${"x".repeat(64_000)}`;
      const first = await prepare({ extraSystemPrompt });
      const cliSessionBinding = {
        sessionId: "retained-cli-session",
        extraSystemPromptHash:
          reason === "legacy raw binding"
            ? hashCliSessionText(extraSystemPrompt)
            : first.extraSystemPromptHash,
        cwdHash: first.cwdHash,
      };
      const modelContextTokens = reason === "smaller context budget" ? 4_000 : 8_000;
      const refreshed = await prepare({
        extraSystemPrompt,
        modelContextTokens,
        cliSessionBinding,
      });

      expect(refreshed.systemPromptReport.extraSystemPrompt?.truncated).toBe(true);
      if (reason === "smaller context budget") {
        expect(refreshed.systemPrompt.length).toBeLessThan(first.systemPrompt.length);
      }
      await expect(
        executePreparedCliRun(refreshed, cliSessionBinding.sessionId),
      ).resolves.toMatchObject({
        text: "finished",
      });
      expect(supervisorSpawnMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          argv: [
            expect.any(String),
            "--resume",
            cliSessionBinding.sessionId,
            "--system-prompt",
            stripSystemPromptCacheBoundary(refreshed.systemPrompt.trim()),
            refreshed.params.prompt,
          ],
        }),
      );
      expect(refreshed.reusableCliSession).toEqual({
        mode: "reuse-with-drift",
        sessionId: cliSessionBinding.sessionId,
        drift: { reasons: ["system-prompt"] },
      });

      const unchanged = await prepare({
        extraSystemPrompt,
        modelContextTokens,
        cliSessionBinding: {
          ...cliSessionBinding,
          extraSystemPromptHash: refreshed.extraSystemPromptHash,
        },
      });
      expect(unchanged.reusableCliSession).toEqual({
        mode: "reuse",
        sessionId: cliSessionBinding.sessionId,
      });
      await expect(
        executePreparedCliRun(unchanged, cliSessionBinding.sessionId),
      ).resolves.toMatchObject({
        text: "finished",
      });
      expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
      expect(supervisorSpawnMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          argv: [
            expect.any(String),
            "--resume",
            cliSessionBinding.sessionId,
            unchanged.params.prompt,
          ],
        }),
      );
    },
  );

  it("keeps inline volatile context outside explicit static binding identity", async () => {
    const stable = "Keep the same conversation policy.";
    const material = "x".repeat(64_000);
    const first = await prepare({
      extraSystemPrompt: `message-a\n${material}`,
      cliSessionBindingFacts: { extraSystemPromptStatic: stable },
    });
    const next = await prepare({
      extraSystemPrompt: `message-b\n${material}`,
      cliSessionBindingFacts: { extraSystemPromptStatic: stable },
      cliSessionBinding: {
        sessionId: "retained-cli-session",
        extraSystemPromptHash: first.extraSystemPromptHash,
        cwdHash: first.cwdHash,
      },
    });

    expect(next.systemPrompt).not.toBe(first.systemPrompt);
    expect(next.systemPromptReport.extraSystemPrompt?.truncated).toBe(true);
    expect(next.reusableCliSession).toEqual({ mode: "reuse", sessionId: "retained-cli-session" });
  });

  it("refreshes retained original references after write failure, recovery, and source changes", async () => {
    backend = buildDefaultTestCliBackend({ bundleMcp: true });
    const scratchRoot = path.join(fixture.session.dir, "extra-context-scratch");
    await fs.mkdir(scratchRoot);
    vi.spyOn(scratchDirectories, "resolvePreferredOpenClawTmpDir").mockReturnValue(scratchRoot);
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime: () => ({
        port: 31783,
        ownerToken: "loopback-owner-token",
        nonOwnerToken: "loopback-non-owner-token",
      }),
      resolveMcpLoopbackScopedTools: () => ({
        agentId: "main",
        tools: [createReadToolDefinition(fixture.session.dir)],
      }),
      mintMcpLoopbackClientGrant: createTestMcpLoopbackClientGrant,
      bindMcpLoopbackClientGrantAdmission: () => true,
      createMcpLoopbackServerConfig: createTestMcpLoopbackServerConfig,
      revokeMcpLoopbackClientGrant: () => {},
    });
    const input = {
      extraSystemPrompt: `${"x".repeat(32_000)}source-a${"y".repeat(32_000)}`,
      cliSessionBindingFacts: { extraSystemPromptStatic: "Stable conversation policy." },
    };
    const retain = (context: PreparedCliRunContext) => ({
      sessionId: "retained-reader-session",
      extraSystemPromptHash: context.extraSystemPromptHash,
      messageToolPolicyHash: context.messageToolPolicyHash,
      promptToolNamesHash: context.promptToolNamesHash,
      cwdHash: context.cwdHash,
      mcpConfigHash: context.preparedBackend.mcpConfigHash,
      mcpResumeHash: context.preparedBackend.mcpResumeHash,
    });
    const first = await withExtraSystemPromptScope(() => prepare(input), "cli-original-first");
    expect(first.systemPrompt).toContain("The exact original is available only during this run");

    const originalDirectory = path.join(scratchRoot, "extra-system-prompts");
    await fs.rmdir(originalDirectory);
    await fs.writeFile(originalDirectory, "not a directory", { mode: 0o600 });
    const unavailable = await withExtraSystemPromptScope(
      () => prepare({ ...input, cliSessionBinding: retain(first) }),
      "cli-original-unavailable",
    );
    expect(unavailable.systemPrompt).toContain("No retrievable original");
    expect(unavailable.reusableCliSession).toEqual({
      mode: "reuse-with-drift",
      sessionId: "retained-reader-session",
      drift: { reasons: ["system-prompt"] },
    });

    await fs.unlink(originalDirectory);
    const recovered = await withExtraSystemPromptScope(
      () => prepare({ ...input, cliSessionBinding: retain(unavailable) }),
      "cli-original-recovered",
    );
    expect(recovered.systemPrompt).toContain(
      "The exact original is available only during this run",
    );
    expect(recovered.extraSystemPromptHash).toBe(first.extraSystemPromptHash);
    expect(recovered.reusableCliSession).toEqual(unavailable.reusableCliSession);

    const changed = await withExtraSystemPromptScope(
      () =>
        prepare({
          ...input,
          extraSystemPrompt: input.extraSystemPrompt.replace("source-a", "source-b"),
          cliSessionBinding: retain(recovered),
        }),
      "cli-original-changed",
    );
    expect(changed.extraSystemPromptHash).not.toBe(recovered.extraSystemPromptHash);
    expect(changed.reusableCliSession).toEqual(unavailable.reusableCliSession);
  });

  it.each([
    { name: "ordinary", text: "  Return only valid JSON.\n", reduced: false },
    { name: "oversized", text: "x".repeat(2_097_174), reduced: true },
  ])("prepares $name context for the isolated backend handoff", async ({ text, reduced }) => {
    const prepareExecution = vi.fn<NonNullable<CliBackendPlugin["prepareExecution"]>>(async () => ({
      isolatedCompletionEnforced: true,
      toolAvailabilityEnforced: true,
    }));
    backend = {
      ...buildDefaultTestCliBackend(),
      id: "google-gemini-cli",
      pluginId: "google",
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "prepare-execution",
      prepareExecution,
    };
    const context = await withExtraSystemPromptScope(
      () =>
        prepare({
          provider: backend.id,
          executionMode: "side-question",
          isolatedCompletion: true,
          disableTools: true,
          extraSystemPrompt: text,
          cliToolAvailability: { native: [], openClaw: [] },
        }),
      "cli-isolated-context",
    );

    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        isolatedCompletionSystemPrompt: reduced ? context.systemPrompt : text,
        toolAvailability: { native: [], openClaw: [] },
      }),
    );
    expect(context.params.extraSystemPrompt).toBe(text);
    expect(context.systemPromptReport.extraSystemPrompt?.truncated).toBe(reduced);
    if (reduced) {
      expect(context.systemPrompt.length).toBeLessThan(text.length / 20);
    } else {
      expect(context.systemPrompt).toBe(text.trim());
    }
  });
});
