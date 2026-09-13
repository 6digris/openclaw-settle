// Coverage for assembling provider-transformed embedded attempt system prompts.
import fs from "node:fs/promises";
import { streamOpenAIResponses } from "@openclaw/ai/internal/openai";
import {
  prependSystemPromptAdditionAfterCacheBoundary,
  splitSystemPromptRelocatableBoundary,
  stripSystemPromptCacheBoundary,
} from "@openclaw/ai/internal/shared";
import { Type } from "typebox";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import * as scratchDirectories from "../../../infra/tmp-openclaw-dir.js";
import { addSession, deleteSession } from "../../bash-process-registry.js";
import { createProcessSessionFixture } from "../../bash-process-registry.test-helpers.js";
import { buildBootstrapBudgetState } from "../../bootstrap-budget.js";
import { withExtraSystemPromptScope } from "../../extra-system-prompt.js";
import { buildModelToolsUnavailablePrompt } from "../../model-tool-support.js";
import type { AgentTool } from "../../runtime/index.js";
import { createSandboxTestContext } from "../../sandbox/test-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import type { EmbeddedAttemptSetup } from "./attempt-setup.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

// Prompt assembly consumes a prepared provider handle; discovery belongs to attempt setup.
const providerRegistryMocks = vi.hoisted(() => {
  const rejectProviderDiscovery = () => {
    throw new Error("Prompt fixture unexpectedly discovered provider runtime");
  };
  return {
    isPluginProvidersLoadInFlight: vi.fn(rejectProviderDiscovery),
    resolvePluginProvidersCore: vi.fn(rejectProviderDiscovery),
  };
});

vi.mock("../../../plugins/providers.runtime-core.js", () => ({
  createProviderRegistryResolver: () => providerRegistryMocks,
}));

let buildAttemptSystemPrompt: typeof import("./attempt-system-prompt.js").buildAttemptSystemPrompt;
let prepareEmbeddedAttemptSystemPrompt: typeof import("./attempt-system-prompt-prepare.js").prepareEmbeddedAttemptSystemPrompt;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeAll(async () => {
  ({ buildAttemptSystemPrompt } = await import("./attempt-system-prompt.js"));
  ({ prepareEmbeddedAttemptSystemPrompt } = await import("./attempt-system-prompt-prepare.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  providerRegistryMocks.isPluginProvidersLoadInFlight.mockClear();
  providerRegistryMocks.resolvePluginProvidersCore.mockClear();
});

const baseProviderTransform = {
  provider: "openai",
  workspaceDir: "/tmp/openclaw",
  context: {
    provider: "openai",
    modelId: "gpt-5.5",
    promptMode: "full" as const,
  },
};

const transformProviderSystemPrompt: Parameters<
  typeof buildAttemptSystemPrompt
>[0]["transformProviderSystemPrompt"] = ({ context }) => context.systemPrompt;

async function preparePermissionPrompt(
  isRawModelRun = false,
  thinkLevel?: EmbeddedRunAttemptParams["thinkLevel"],
  requireExplicitMessageTarget?: boolean,
  session?: Pick<EmbeddedRunAttemptParams, "sessionKey" | "sandboxSessionKey">,
  options: {
    attempt?: Partial<EmbeddedRunAttemptParams>;
    setup?: Partial<EmbeddedAttemptSetup>;
    modelToolsEnabled?: boolean;
  } = {},
) {
  const tool = (name: string): AgentTool => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  });
  const read = tool("read");
  const write = tool("write");
  const exec = tool("exec");
  const modelToolsEnabled = options.modelToolsEnabled ?? true;
  const tools = modelToolsEnabled
    ? [
        read,
        write,
        exec,
        ...(session ? [tool("process")] : []),
        ...(requireExplicitMessageTarget === undefined ? [] : [tool("message")]),
      ]
    : [];
  const attempt = {
    provider: "openai",
    modelId: "gpt-5.6-luna",
    model: makeProviderModelFixture({
      id: "gpt-5.6-luna",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    }),
    permissionMode: "full",
    promptMode: "full",
    sessionId: "permission-prompt",
    sessionFile: "/tmp/openclaw/permission-prompt.sqlite",
    sessionKey: "agent:main:permission-prompt",
    ...session,
    workspaceDir: "/tmp/openclaw",
    config: {},
    thinkLevel,
    sourceReplyDeliveryMode:
      requireExplicitMessageTarget === undefined ? undefined : "message_tool_only",
    ...options.attempt,
  } as EmbeddedRunAttemptParams;
  const capabilityToolNames = new Set(tools.map(({ name }) => name));
  const prepared = await prepareEmbeddedAttemptSystemPrompt({
    agentDir: "/tmp/openclaw/test-agent",
    attempt,
    activeContextEngine: undefined,
    bootstrap: {
      ...buildBootstrapBudgetState({ files: [] }),
      bootstrapMode: "full",
      contextFiles: [],
      bootstrapInjectionStats: [],
      shouldRecordCompletedBootstrapTurn: false,
      workspaceNotes: [],
    },
    capabilityToolNames,
    requireExplicitMessageTarget,
    effectiveTools: tools,
    setup: createAttemptSetupFixture({
      effectiveCwd: "/tmp/openclaw",
      effectiveWorkspace: "/tmp/openclaw",
      getProviderRuntimeHandle: () => ({
        provider: attempt.provider,
        modelId: attempt.modelId,
        prepared: true,
      }),
      sandboxSessionKey: attempt.sandboxSessionKey ?? attempt.sessionKey ?? attempt.sessionId,
      ...options.setup,
    }),
    isRawModelRun,
    modelToolsEnabled,
    skillsPrompt: "",
    toolSearchDirectoryEnabled: false,
    toolSearchRuntimeConfig: attempt.config,
  });
  if (!prepared.preparePermissionPrompt) {
    throw new Error("Expected a refreshable attempt prompt");
  }
  return {
    attempt,
    capabilityToolNames,
    prepared,
    read,
    refreshSystemPrompt: async (prompt: string, refreshedTools: AgentTool[]) =>
      (await prepared.preparePermissionPrompt!(refreshedTools))(prompt),
    write,
  };
}

describe("buildAttemptSystemPrompt", () => {
  it.each([undefined, "agent:main:execution"])(
    "keeps the system prompt identical when execution-owned processes change: %s",
    async (sessionKey) => {
      const owned = createProcessSessionFixture({ id: "execution-owned", backgrounded: true });
      owned.scopeKey = sessionKey ?? "permission-prompt";
      const other = createProcessSessionFixture({ id: "policy-owned", backgrounded: true });
      other.scopeKey = "agent:main:policy";
      const idle = await preparePermissionPrompt(false, undefined, undefined, {
        sessionKey,
        sandboxSessionKey: other.scopeKey,
      });
      addSession(owned);
      addSession(other);
      try {
        const { prepared } = await preparePermissionPrompt(false, undefined, undefined, {
          sessionKey,
          sandboxSessionKey: other.scopeKey,
        });
        expect(prepared.systemPromptText).toBe(idle.prepared.systemPromptText);
        expect(prepared.systemPromptText).not.toContain(owned.id);
        expect(prepared.systemPromptText).not.toContain(other.id);
      } finally {
        deleteSession(owned.id);
        deleteSession(other.id);
      }
    },
  );

  it("keeps model instructions identical when only reasoning effort changes", async () => {
    const prompts = [];
    for (const effort of ["low", "high", "medium"] as const) {
      prompts.push((await preparePermissionPrompt(false, effort)).prepared.systemPromptText);
    }
    expect(prompts[0]).not.toBe("");
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[2]).toBe(prompts[0]);
  });

  it.each([
    { sandboxSessionKey: "global", mode: "off", sandboxed: false },
    { sandboxSessionKey: "agent:main:policy", mode: "all", sandboxed: true },
  ])(
    "reports the selected sandbox policy for a global attempt ($sandboxSessionKey)",
    async (testCase) => {
      const workspaceDir = tempDirs.make("openclaw-global-system-prompt-");
      const config = {
        agents: {
          ownership: "explicit" as const,
          list: [
            { id: "main", sandbox: { mode: "all" as const } },
            { id: "marketing", sandbox: { mode: "off" as const } },
          ],
        },
      };
      const attempt = {
        config,
        agentId: "marketing",
        sessionId: "global-system-prompt",
        sessionFile: `${workspaceDir}/global-system-prompt.sqlite`,
        sessionKey: "global",
        provider: "openai",
        modelId: "gpt-5.5",
        model: { id: "gpt-5.5", provider: "openai", api: "openai-responses" },
        workspaceDir,
      };
      const result = await prepareEmbeddedAttemptSystemPrompt({
        agentDir: "/tmp/openclaw/test-agent",
        attempt: attempt as never,
        bootstrap: {
          ...buildBootstrapBudgetState({ config, agentId: "marketing", files: [] }),
          workspaceNotes: [],
          contextFiles: [],
          bootstrapInjectionStats: [],
        } as never,
        activeContextEngine: undefined,
        capabilityToolNames: new Set(),
        effectiveTools: [],
        setup: createAttemptSetupFixture({
          effectiveCwd: workspaceDir,
          effectiveWorkspace: workspaceDir,
          // Preserve the prepared model binding instead of discovering provider plugins.
          getProviderRuntimeHandle: () => ({
            provider: attempt.provider,
            modelId: attempt.modelId,
            prepared: true,
          }),
          sandboxSessionKey: testCase.sandboxSessionKey,
          sessionAgentId: "marketing",
        }),
        isRawModelRun: true,
        modelToolsEnabled: false,
        skillsPrompt: "",
        toolSearchDirectoryEnabled: false,
        toolSearchRuntimeConfig: config,
      });

      expect(result.systemPromptReport?.sandbox).toEqual({
        mode: testCase.mode,
        sandboxed: testCase.sandboxed,
      });
      expect(providerRegistryMocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
    },
  );
  it("replaces an intermediate permission prompt after later changes", async () => {
    const fixture = await preparePermissionPrompt();
    const { attempt, capabilityToolNames, prepared, read, refreshSystemPrompt, write } = fixture;
    const initialPrompt = prepared.systemPromptText;
    expect(initialPrompt).toContain("- exec:");
    expect(initialPrompt).toContain("exec approval-pending:");

    attempt.permissionMode = "workspace";
    capabilityToolNames.delete("exec");
    const currentTools = [read, write];
    const preparation = prepared.preparePermissionPrompt!(currentTools);
    expect(prepared.preparePermissionPrompt!(currentTools)).toBe(preparation);
    const intermediatePrompt = (await preparation)(initialPrompt);
    expect(intermediatePrompt).toContain("- write:");
    expect(intermediatePrompt).not.toContain("- exec:");

    attempt.permissionMode = "read-only";
    capabilityToolNames.delete("write");
    await refreshSystemPrompt(intermediatePrompt, [read]);
    // The delayed hook retained B while the live owner already advanced to C.
    const delayedHookPrompt = prependSystemPromptAdditionAfterCacheBoundary({
      systemPrompt: `Hook prefix\n\n${intermediatePrompt}\n\nHook suffix`,
      systemPromptAddition: "Current runtime addition",
    });
    const refreshed = await refreshSystemPrompt(delayedHookPrompt, [read]);
    expect(refreshed).toContain("- read:");
    expect(refreshed).not.toContain("- write:");
    expect(refreshed).not.toContain("- exec:");
    expect(refreshed).not.toContain("exec approval-pending:");
    expect(refreshed).toContain("Hook prefix");
    expect(refreshed).toContain("Hook suffix");
    expect(refreshed).toContain("Current runtime addition");
    expect(refreshed).toContain("permissions to read-only");
    expect(refreshed).not.toContain("permissions to workspace");
    expect(refreshed.match(/## Permission change/g)).toHaveLength(1);
    expect(await refreshSystemPrompt(refreshed, [read])).toBe(refreshed);
  });

  it("preserves explicit hook overrides while replacing their stale permission notice", async () => {
    const { attempt, read, refreshSystemPrompt } = await preparePermissionPrompt();
    attempt.permissionMode = "workspace";
    const overridden = await refreshSystemPrompt("Use the deliberate hook override.", [read]);
    attempt.permissionMode = "guarded";
    await refreshSystemPrompt(overridden, [read]);
    attempt.permissionMode = "read-only";
    const refreshed = await refreshSystemPrompt(overridden, [read]);

    expect(refreshed).toContain("Use the deliberate hook override.");
    expect(refreshed).not.toContain("## Tooling");
    expect(refreshed).toContain("permissions to read-only");
    expect(refreshed).not.toContain("permissions to workspace");
    expect(refreshed.match(/## Permission change/g)).toHaveLength(1);
  });

  it("keeps an appended permission notice out of the relocatable region", async () => {
    // `refreshSystemPrompt` appends its PERMISSION section after the built
    // prompt. The relocatable region is closed before that, so a transport that
    // carries the region onto a user turn cannot demote the notice with it.
    const { prepared, read, refreshSystemPrompt } = await preparePermissionPrompt();
    const refreshed = await refreshSystemPrompt(prepared.systemPromptText, [read]);
    expect(refreshed).toContain("<!-- openclaw:attempt:PERMISSION -->");

    const split = splitSystemPromptRelocatableBoundary(refreshed);

    expect(split?.relocatable).toContain("Runtime:");
    expect(split?.relocatable).not.toContain("PERMISSION");
    expect(split?.remainingPrompt).toContain("<!-- openclaw:attempt:PERMISSION -->");
    expect(stripSystemPromptCacheBoundary(refreshed)).not.toContain(
      "OPENCLAW-RELOCATABLE-BOUNDARY",
    );
  });

  it("does not inject permission guidance into raw model prompts", async () => {
    const { attempt, prepared, read, refreshSystemPrompt } = await preparePermissionPrompt(true);
    attempt.permissionMode = "read-only";
    expect(prepared.systemPromptText).toBe("");
    expect(await refreshSystemPrompt("", [read])).toBe("");
  });

  it("does not invoke ambient contributors during settled finalization", async () => {
    const getProviderRuntimeHandle = vi.fn();
    const markStage = vi.fn();
    const setup = createAttemptSetupFixture({ getProviderRuntimeHandle });
    setup.prepStages.mark = markStage;
    const result = await prepareEmbeddedAttemptSystemPrompt({
      agentDir: "/tmp/openclaw/test-agent",
      attempt: { operation: "settled-tool-finalization" },
      setup,
    } as never);

    expect(result.systemPromptText).toBe("");
    expect(result.runtimeChannel).toBeUndefined();
    expect(getProviderRuntimeHandle).not.toHaveBeenCalled();
    expect(markStage).toHaveBeenCalledWith("system-prompt");
  });

  it.each(["/tmp/openclaw", "/tmp/open\u202eclaw\n"])(
    "injects workspace identity context from %j",
    (workspaceDir) => {
      // Workspace identity files are part of the base system prompt and must
      // survive provider transformation.
      const result = buildAttemptSystemPrompt({
        isRawModelRun: false,
        transformProviderSystemPrompt,
        embeddedSystemPrompt: {
          workspaceDir,
          reasoningTagHint: false,
          runtimeInfo: {
            host: "test-host",
            os: "Darwin",
            arch: "arm64",
            node: "v22.0.0",
            model: "openai/gpt-5.5",
          },
          tools: [],
          modelAliasLines: [],
          userTimezone: "UTC",
          userDate: "2026-01-05",
          contextFiles: [
            { path: "/tmp/openclaw/SOUL.md", content: "SOUL_CONTEXT_MARKER" },
            { path: "/tmp/openclaw/IDENTITY.md", content: "IDENTITY_CONTEXT_MARKER" },
            { path: "/tmp/openclaw/USER.md", content: "USER_CONTEXT_MARKER" },
          ],
        },
        providerTransform: { ...baseProviderTransform, workspaceDir },
      });

      expect(result.systemPrompt).toContain("\nWorking directory: /tmp/openclaw\n");
      expect(result.systemPrompt).not.toContain("\u202e");
      expect(result.systemPrompt).toContain("# Project Context");
      expect(result.systemPrompt).toContain("## /tmp/openclaw/SOUL.md");
      expect(result.systemPrompt).toContain("SOUL_CONTEXT_MARKER");
      expect(result.systemPrompt).toContain("## /tmp/openclaw/IDENTITY.md");
      expect(result.systemPrompt).toContain("IDENTITY_CONTEXT_MARKER");
      expect(result.systemPrompt).toContain("## /tmp/openclaw/USER.md");
      expect(result.systemPrompt).toContain("USER_CONTEXT_MARKER");
    },
  );

  it("filters first-turn curated context to global and active-project entries", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        userDate: "2026-01-05",
        activeProjectKeys: ["github.com/acme/Alpha"],
        contextFiles: [
          {
            path: "/tmp/openclaw/MEMORY.md",
            content: [
              "# Durable memory",
              "- Alpha fact. <!-- project: github.com/acme/Alpha -->",
              "- Beta fact. <!-- project: github.com/acme/Beta -->",
              "- Global fact.",
            ].join("\n"),
          },
        ],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("Alpha fact");
    expect(result.systemPrompt).toContain("Global fact");
    expect(result.systemPrompt).not.toContain("Beta fact");
  });

  it("preserves bootstrap Project Context", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        userDate: "2026-01-05",
        bootstrapMode: "full",
        bootstrapTruncationNotice: "Bootstrap context was truncated.",
        contextFiles: [
          {
            path: "/tmp/openclaw/BOOTSTRAP.md",
            content: "Reply with BOOTSTRAP_OK.",
          },
          {
            path: "/tmp/openclaw/SOUL.md",
            content: "SOUL_CONTEXT_MARKER",
          },
          {
            path: "/tmp/openclaw/IDENTITY.md",
            content: "IDENTITY_CONTEXT_MARKER",
          },
          {
            path: "/tmp/openclaw/USER.md",
            content: "USER_CONTEXT_MARKER",
          },
        ],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("Current model identity: openai/gpt-5.5.");
    expect(result.systemPrompt).toContain("## Bootstrap Pending");
    expect(result.systemPrompt).toContain("BOOTSTRAP.md below; follow before normal reply.");
    expect(result.systemPrompt).toContain("## Bootstrap Context Notice");
    expect(result.systemPrompt).toContain("Bootstrap context was truncated.");
    expect(result.systemPrompt).toContain("# Project Context");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/SOUL.md");
    expect(result.systemPrompt).toContain("SOUL_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/IDENTITY.md");
    expect(result.systemPrompt).toContain("IDENTITY_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/USER.md");
    expect(result.systemPrompt).toContain("USER_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/BOOTSTRAP.md");
    expect(result.systemPrompt).toContain("Reply with BOOTSTRAP_OK.");
  });

  it("preserves runtime extra system prompt context", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        userDate: "2026-01-05",
        promptMode: "minimal",
        extraSystemPrompt:
          "# Subagent Context\n\n## Your Role\n- You were created to handle: RUN_MODE_TASK_77950",
        bootstrapMode: "full",
        contextFiles: [],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("Current model identity: openai/gpt-5.5.");
    expect(result.systemPrompt).toContain("## Subagent Context");
    expect(result.systemPrompt).toContain("RUN_MODE_TASK_77950");
  });

  it("omits system prompts for raw model probes", () => {
    // Raw model probes still build a base prompt for diagnostics, but the final
    // provider prompt must be empty.
    const result = buildAttemptSystemPrompt({
      isRawModelRun: true,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        userDate: "2026-01-05",
        bootstrapMode: "full",
        contextFiles: [
          {
            path: "/tmp/openclaw/BOOTSTRAP.md",
            content: "Reply with BOOTSTRAP_OK.",
          },
        ],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.baseSystemPrompt).toContain("BOOTSTRAP.md below; follow before normal reply.");
    expect(result.systemPrompt).toBe("");
  });
});

describe("embedded prepared message-target guidance", () => {
  it.each([false, true])(
    "carries the prepared target requirement (%s) through prompt assembly",
    async (required) => {
      const { prepared } = await preparePermissionPrompt(false, undefined, required);
      expect(prepared.systemPromptText).toContain(
        required ? "target required this turn" : "current source is default target",
      );
    },
  );
});

describe("embedded supplemental context preparation", () => {
  const sentinel = "EXTRA_CONTEXT_129206";
  const oversized = `${sentinel}\n${"x".repeat(2_097_174 - sentinel.length - 1)}`;

  beforeEach(() => {
    vi.spyOn(scratchDirectories, "resolvePreferredOpenClawTmpDir").mockReturnValue(
      tempDirs.make("openclaw-attempt-extra-context-"),
    );
  });

  async function captureProviderPayload(
    fixture: Awaited<ReturnType<typeof preparePermissionPrompt>>,
  ): Promise<string> {
    let serialized: string | undefined;
    const stream = streamOpenAIResponses(
      { ...fixture.attempt.model, api: "openai-responses" },
      {
        systemPrompt: fixture.prepared.systemPromptText,
        messages: [{ role: "user", content: "Answer from the supplied context.", timestamp: 1 }],
      },
      {
        apiKey: ["fixture", "transport", "value"].join("-"),
        cacheRetention: "none",
        onPayload(payload) {
          serialized = JSON.stringify(payload);
          throw new Error("stop after payload capture");
        },
      },
    );
    expect((await stream.result()).stopReason).toBe("error");
    if (serialized === undefined) {
      throw new Error("Expected provider payload capture before transport");
    }
    return serialized;
  }

  it.each([
    { name: "ordinary", text: `${sentinel}: keep this qualification exactly.`, reduced: false },
    { name: "2 MiB", text: oversized, reduced: true },
  ])(
    "submits $name supplemental context through the real prepared provider payload",
    async ({ text, reduced }) => {
      await withExtraSystemPromptScope(async () => {
        const fixture = await preparePermissionPrompt(false, undefined, true, undefined, {
          attempt: { extraSystemPrompt: text, contextTokenBudget: 4_096 },
        });
        const payload = await captureProviderPayload(fixture);
        expect(payload).toContain(sentinel);
        expect(payload).toContain("target required this turn");
        expect(fixture.attempt.extraSystemPrompt).toBe(text);
        expect(fixture.prepared.systemPromptReport?.extraSystemPrompt).toMatchObject({
          rawChars: text.length,
          truncated: reduced,
        });
        expect(JSON.stringify(fixture.prepared.systemPromptReport)).not.toContain(sentinel);
        if (reduced) {
          expect(payload).toContain("Partial supplemental context");
          expect(payload).not.toContain(text);
          expect(payload.length).toBeLessThan(text.length / 20);
          expect(
            fixture.prepared.systemPromptReport?.extraSystemPrompt?.injectedChars,
          ).toBeLessThanOrEqual(4_096);
        } else {
          expect(payload).toContain(text);
          expect(payload).not.toContain("Partial supplemental context");
        }
        const retry = await preparePermissionPrompt(false, undefined, true, undefined, {
          attempt: { extraSystemPrompt: text, contextTokenBudget: 4_096 },
        });
        expect(retry.prepared.systemPromptText).toBe(fixture.prepared.systemPromptText);
      }, "embedded-payload");
    },
  );

  it.each([
    { name: "tools disabled", modelToolsEnabled: false },
    { name: "schema-only reader", toolExecutionAllow: ["skill_workshop"] },
    { name: "sandboxed", setup: { sandbox: createSandboxTestContext() } },
    { name: "workspace-only reads", setup: { effectiveFsWorkspaceOnly: true } },
    { name: "incognito", sessionKey: "agent:main:dashboard:incognito-extra" },
  ])(
    "keeps a compact inline view without advertising a private source when $name",
    async (variant) => {
      await withExtraSystemPromptScope(async () => {
        const fixture = await preparePermissionPrompt(false, undefined, undefined, undefined, {
          attempt: {
            extraSystemPrompt: oversized,
            contextTokenBudget: 4_096,
            ...(variant.sessionKey ? { sessionKey: variant.sessionKey } : {}),
            ...(variant.toolExecutionAllow
              ? { toolExecutionAllow: variant.toolExecutionAllow }
              : {}),
          },
          setup: variant.setup,
          modelToolsEnabled: variant.modelToolsEnabled,
        });
        const prompt = fixture.prepared.systemPromptText;
        expect(prompt).toContain("Partial supplemental context");
        expect(prompt).toContain("No retrievable original");
        expect(prompt).not.toContain("available only during this run");
        expect(prompt.length).toBeLessThan(oversized.length / 20);
        if (variant.modelToolsEnabled === false) {
          expect(prompt).toContain(buildModelToolsUnavailablePrompt(false));
          expect(fixture.capabilityToolNames.size).toBe(0);
        }
      }, "restricted-extra-context");
    },
  );

  it("refreshes partial-context guidance when permission changes remove read access", async () => {
    await withExtraSystemPromptScope(async () => {
      const fixture = await preparePermissionPrompt(false, undefined, undefined, undefined, {
        attempt: { extraSystemPrompt: oversized, contextTokenBudget: 4_096 },
      });
      expect(fixture.prepared.systemPromptText).toContain("available only during this run");
      fixture.attempt.permissionMode = "read-only";
      fixture.capabilityToolNames.clear();
      const refreshed = await fixture.refreshSystemPrompt(fixture.prepared.systemPromptText, []);

      expect(refreshed).toContain("No retrievable original");
      expect(refreshed).not.toContain("available only during this run");
      expect(refreshed).toContain("Partial supplemental context");
      expect(refreshed.length).toBeLessThan(oversized.length / 20);
      expect(fixture.attempt.extraSystemPrompt).toBe(oversized);
    }, "permission-changed-context");
  });

  it("does not retain or report injected supplemental context for raw model probes", async () => {
    await withExtraSystemPromptScope(async () => {
      const fixture = await preparePermissionPrompt(true, undefined, undefined, undefined, {
        attempt: { extraSystemPrompt: oversized, contextTokenBudget: 4_096 },
      });
      expect(fixture.prepared.systemPromptText).toBe("");
      expect(fixture.prepared.systemPromptReport?.extraSystemPrompt).toBeUndefined();
      expect(await fs.readdir(scratchDirectories.resolvePreferredOpenClawTmpDir())).toEqual([]);
    }, "raw-model-context");
  });
});
