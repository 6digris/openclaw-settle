import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  onInternalDiagnosticEvent,
  onTrustedToolExecutionEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type TrustedToolExecutionEvent,
} from "../infra/diagnostic-events.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { getInternalToolExecutionPreparer } from "./runtime/internal-hooks.js";
import type { AnyAgentTool } from "./tools/common.js";

afterEach(() => {
  resetGlobalHookRunner();
  resetDiagnosticEventsForTest();
});

it.each([false, true])(
  "retains finalized operational facts without delegated diagnostics (enabled=%s)",
  async (enabled) => {
    resetDiagnosticEventsForTest();
    setDiagnosticsEnabledForProcess(enabled);
    const operational: TrustedToolExecutionEvent[] = [];
    const optional: string[] = [];
    const stop = onTrustedToolExecutionEvent((event) => operational.push(event));
    const stopOptional = onInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("tool.execution.")) {
        optional.push(event.type);
      }
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () => ({ params: { action: "app_launch" } }),
        },
      ]),
    );
    try {
      for (const finalAction of ["status", "app_launch"] as const) {
        operational.length = 0;
        const body = vi.fn(async (_id: string, args: unknown) => {
          expect(args).toEqual({ action: finalAction });
          expect(operational).toMatchObject([
            {
              type: "tool.execution.started",
              runId: "operational-run",
              toolCallId: finalAction,
              mutatingAction: finalAction === "app_launch",
            },
          ]);
          return { content: [], details: { ok: true } };
        });
        const source: AnyAgentTool = {
          name: "nodes",
          label: "Nodes",
          description: "Fixture",
          parameters: Type.Object({ action: Type.String() }),
          finalizeBeforeToolCallParams: () => ({ action: finalAction }),
          execute: body,
        };
        const wrapped = wrapToolWithBeforeToolCallHook(
          source,
          { agentId: "main", runId: "operational-run" },
          { emitDiagnostics: false },
        );
        await wrapped.execute(finalAction, { action: "status", privateValue: "not retained" });
        expect(body).toHaveBeenCalledOnce();
        expect(operational.map((event) => event.type)).toEqual([
          "tool.execution.started",
          "tool.execution.completed",
        ]);
        expect(JSON.stringify(operational)).not.toContain("not retained");
      }
      await waitForDiagnosticEventsDrained();
      expect(optional).toEqual([]);
    } finally {
      stop();
      stopOptional();
    }
  },
);

it.each(["veto", "disposed", "cancel-before", "failure", "cancel-during"] as const)(
  "keeps the actual source boundary authoritative: %s",
  async (mode) => {
    resetDiagnosticEventsForTest();
    const events: TrustedToolExecutionEvent[] = [];
    const stop = onTrustedToolExecutionEvent((event) => events.push(event));
    const controller = new AbortController();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () =>
            mode === "veto" ? { block: true, blockReason: "fixture veto" } : undefined,
        },
      ]),
    );
    const body = vi.fn(async () => {
      expect(events[0]?.type).toBe("tool.execution.started");
      if (mode === "cancel-during") {
        controller.abort(new Error("cancelled"));
        controller.signal.throwIfAborted();
      }
      throw new Error("fixture execution failure");
    });
    const source: AnyAgentTool = {
      name: "nodes",
      label: "Nodes",
      description: "Fixture",
      parameters: Type.Object({ action: Type.String() }),
      execute: body,
    };
    const wrapped = wrapToolWithBeforeToolCallHook(
      source,
      { runId: "operational-run" },
      { emitDiagnostics: false },
    );
    try {
      if (mode === "disposed") {
        const prepare = getInternalToolExecutionPreparer(wrapped);
        if (!prepare) {
          throw new Error("Missing canonical execution preparer");
        }
        const prepared = await prepare({ toolCallId: "disposed", args: { action: "app_launch" } });
        expect(prepared.kind).toBe("ready");
        expect(events).toEqual([]);
        prepared.dispose();
        if (prepared.kind === "ready") {
          await prepared.execute();
        }
      } else {
        if (mode === "cancel-before") {
          controller.abort(new Error("cancelled"));
        }
        const execution = wrapped.execute(mode, { action: "app_launch" }, controller.signal);
        if (mode === "veto") {
          await expect(execution).resolves.toMatchObject({ details: { status: "blocked" } });
        } else {
          await expect(execution).rejects.toThrow();
        }
      }
      if (mode === "failure" || mode === "cancel-during") {
        expect(body).toHaveBeenCalledOnce();
        expect(events.map((event) => event.type)).toEqual([
          "tool.execution.started",
          "tool.execution.error",
        ]);
        expect(events[1]).toMatchObject({
          terminalReason: mode === "failure" ? "failed" : "cancelled",
        });
      } else {
        expect(body).not.toHaveBeenCalled();
        expect(events).toEqual([]);
      }
    } finally {
      stop();
    }
  },
);

it("does not admit operational facts from the untrusted public diagnostic producer", () => {
  const events: TrustedToolExecutionEvent[] = [];
  const stop = onTrustedToolExecutionEvent((event) => events.push(event));
  try {
    emitDiagnosticEvent({
      type: "tool.execution.started",
      runId: "forged",
      toolCallId: "forged",
      toolName: "nodes",
      mutatingAction: true,
    });
    expect(events).toEqual([]);
  } finally {
    stop();
  }
});
