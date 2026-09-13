import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../cli-runner.test-helpers.js";
import { hashCliSessionText } from "../cli-session.js";
import {
  bindExtraSystemPromptContext,
  composeExtraSystemPromptContext,
} from "../extra-system-prompt-context.js";
import { withExtraSystemPromptScope } from "../extra-system-prompt.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

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
      fixture.cleanup();
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
    expect(context.extraSystemPromptHash).toBe(hashCliSessionText(source.text));
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
      expect(changed.extraSystemPromptHash).toBe(hashCliSessionText(changedSource));
      expect(changed.extraSystemPromptHash).not.toBe(first.extraSystemPromptHash);
      expect(changed.params.extraSystemPrompt).toBe(changedSource);
    }, "cli-context-retry");
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
