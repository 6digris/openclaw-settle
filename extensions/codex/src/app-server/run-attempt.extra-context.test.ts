import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { describe, expect, it, vi } from "vitest";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import { isJsonObject } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createCodexRuntimePlanFixture,
  createParams,
  createStartedThreadHarness,
  fastWait,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

function developerInstructions(harness: ReturnType<typeof createStartedThreadHarness>): string {
  const request = harness.requests.findLast(
    (entry) => entry.method === "thread/start" || entry.method === "thread/resume",
  )?.params;
  assert(isJsonObject(request));
  assert(typeof request.developerInstructions === "string");
  return request.developerInstructions;
}

function originalPath(instructions: string): string {
  const quoted = instructions.match(/at ("(?:[^"\\]|\\.)*")\./u)?.[1];
  assert(quoted, "the model must receive a concrete readable source path");
  const value: unknown = JSON.parse(quoted);
  assert(typeof value === "string" && path.isAbsolute(value));
  return value;
}

describe("Codex supplemental context", () => {
  it("keeps ordinary instructions unchanged in the native developer carrier", async () => {
    const params = createParams(path.join(tempDir, "ordinary.jsonl"), tempDir);
    params.extraSystemPrompt = "Keep the supplied qualifications and answer in plain text.";
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await Promise.race([harness.waitForMethod("turn/start"), run]);

    expect(developerInstructions(harness)).toContain(params.extraSystemPrompt);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(result.systemPromptReport?.extraSystemPrompt).toEqual({
      rawChars: params.extraSystemPrompt.length,
      injectedChars: params.extraSystemPrompt.length,
      truncated: false,
    });
  });

  it("recreates the same private source after cleanup and invalidates changed omitted content", async () => {
    const firstSource = `Beginning.\n${"x".repeat(100_000)}A${"y".repeat(100_000)}\nEnd.`;
    const changedSource = firstSource.replace("A", "B");
    let threads = 0;
    let turns = 0;
    const harness = createStartedThreadHarness(
      async (method, request) => {
        if (method === "thread/start") {
          return threadStartResult(`thread-${++threads}`);
        }
        if (method === "thread/resume") {
          assert(isJsonObject(request) && typeof request.threadId === "string");
          return threadStartResult(request.threadId);
        }
        if (method === "turn/start") {
          return turnStartResult(`turn-${++turns}`);
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    const params = createParams(path.join(tempDir, "retained.jsonl"), tempDir);
    await attachSqliteSessionTarget(
      params,
      path.join(tempDir, "retained.sqlite"),
      "source-session",
    );
    // The host's dynamic-tool flag does not remove Codex-owned native readers.
    setCodexTestModelSupportsTools(params, false);
    params.contextTokenBudget = 8_000;
    const instructions: string[] = [];
    const paths: string[] = [];

    for (const [index, source] of [firstSource, firstSource, changedSource].entries()) {
      const input = { ...params, runId: `source-run-${index}`, extraSystemPrompt: source };
      const run = runCodexAppServerAttempt(input);
      await Promise.race([vi.waitFor(() => expect(turns).toBe(index + 1), fastWait), run]);
      const rendered = developerInstructions(harness);
      expect(rendered.length).toBeLessThan(source.length / 4);
      const filePath = originalPath(rendered);
      instructions.push(rendered);
      paths.push(filePath);
      expect(await fs.readFile(filePath, "utf8")).toBe(source);
      expect(input.extraSystemPrompt).toBe(source);
      await harness.completeTurn({ threadId: `thread-${threads}`, turnId: `turn-${turns}` });
      const result = await run;
      expect(result.terminal).toEqual({ kind: "ok" });
      expect(result.systemPromptReport?.extraSystemPrompt?.truncated).toBe(true);
      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    }

    expect(instructions[1]).toBe(instructions[0]);
    expect(paths[1]).toBe(paths[0]);
    expect(instructions[2]).not.toBe(instructions[0]);
    expect(paths[2]).not.toBe(paths[0]);
  });

  it("serves an omitted portion through the registered permitted read tool", async () => {
    dynamicToolBuildState.openClawCodingToolsFactory = (options) =>
      createOpenClawCodingTools(options).filter((tool) => tool.name === "read");
    const params = createParams(path.join(tempDir, "readable.jsonl"), tempDir);
    setCodexTestModelSupportsTools(params, true);
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = ["read"];
    params.contextTokenBudget = 8_000;
    params.extraSystemPrompt = Array.from(
      { length: 2_000 },
      (_, index) => `Record ${index}: ${"context data ".repeat(8)}`,
    ).join("\n");
    await bindProductionHarnessHostCapabilitiesForTest(params);
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await Promise.race([harness.waitForMethod("turn/start"), run]);
    const rendered = developerInstructions(harness);
    const filePath = originalPath(rendered);
    expect(rendered).not.toContain("Record 1000:");

    const result = await harness.handleServerRequest({
      id: "source-read",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "source-read",
        namespace: null,
        tool: "read",
        arguments: { path: filePath, offset: 1_001, limit: 1 },
      },
    });
    expect(result).toMatchObject({
      success: true,
      contentItems: [{ type: "inputText", text: expect.stringContaining("Record 1000:") }],
    });
    expect(JSON.stringify(result).length).toBeLessThan(4_000);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["disabled tools", "incognito", "workspace-only", "workspace mode"] as const)(
    "provides an inline partial representation for %s",
    async (mode) => {
      const params = createParams(path.join(tempDir, "partial.jsonl"), tempDir);
      params.disableTools = mode === "disabled tools";
      if (mode === "incognito") {
        params.sessionKey = "agent:main:internal-session-effects:incognito-extra-context";
      }
      if (mode === "workspace-only") {
        params.config = {
          ...params.config,
          tools: { ...params.config?.tools, fs: { workspaceOnly: true } },
        };
      }
      if (mode === "workspace mode") {
        params.permissionMode = "workspace";
      }
      params.extraSystemPrompt = "x".repeat(2_097_174);
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "thread/start" && mode === "incognito") {
          const response = threadStartResult();
          return { ...response, thread: { ...response.thread, ephemeral: true } };
        }
        return undefined;
      });
      const run = runCodexAppServerAttempt(params);
      await Promise.race([harness.waitForMethod("turn/start"), run]);
      const rendered = developerInstructions(harness);
      expect(rendered.length).toBeLessThan(40_000);
      expect(rendered).toContain("Partial supplemental context");
      expect(rendered).toContain("No retrievable original is available in this run");
      expect(rendered).not.toContain("extra-system-prompts/");
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      expect((await run).terminal).toEqual({ kind: "ok" });
    },
  );
});
