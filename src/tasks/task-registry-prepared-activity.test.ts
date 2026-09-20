import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentActivityItem } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../test-utils/task-registry-store.js";
import { createSubagentTaskBackingDetail } from "./task-backing-records.js";
import { getTaskProgressSnapshot, recordTaskActivityEvent } from "./task-registry-activity.js";
import { updateTaskStateByRunId } from "./task-registry-record-api.js";
import { getTaskById, markTaskTerminalById } from "./task-registry.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

beforeEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
  configureTaskFlowRegistryRuntime({ store: createInMemoryTaskFlowRegistryStore() });
});

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
});

describe("prepared task activity", () => {
  it("retains only prepared public item snapshots before a task yields", () => {
    const task = createTaskFixture("subagent", {
      childSessionKey: "agent:main:subagent:prepared-activity",
      runId: "run-prepared-activity",
      task: "Prepare public progress",
    });
    const prepared = {
      itemId: "tool:command-1",
      kind: "tool",
      phase: "end",
      status: "blocked",
      title: "Run focused tests",
      progressText: "Waiting for command approval",
      toolCallId: "command-1",
      name: "exec",
      meta: "pnpm test",
      commandBearing: true,
      startedAt: 100,
      endedAt: 200,
      error: "Approval required",
      summary: "Awaiting approval before command can run.",
      approvalId: "approval-1",
      approvalSlug: "test-command",
      hideFromChannelProgress: false,
      suppressChannelProgress: false,
    } satisfies AgentActivityItem;
    const data = {
      ...prepared,
      args: { command: "private command arguments" },
      result: { content: [{ type: "text", text: "private command output" }] },
      text: "private assistant buffer",
      thinking: "private reasoning buffer",
      delta: "private delta",
      privateTelemetry: { secret: "private event field" },
    };
    emitAgentEvent({ runId: task.runId!, stream: "item", data });
    emitAgentEvent({
      runId: task.runId!,
      stream: "assistant",
      data: { text: "Private assistant activity" },
    });
    emitAgentEvent({
      runId: task.runId!,
      stream: "thinking",
      data: { text: "Private reasoning activity" },
    });
    data.title = "Mutated after emission";
    expect(getTaskProgressSnapshot(task.taskId)).toEqual({
      runId: task.runId,
      revision: 1,
      items: [prepared],
    });

    const replacement = {
      itemId: prepared.itemId,
      kind: "tool",
      phase: "end",
      status: "completed",
      title: "Tests passed",
    } satisfies AgentActivityItem;
    emitAgentEvent({ runId: task.runId!, stream: "item", data: replacement });
    const preamble = {
      itemId: "commentary-1",
      kind: "preamble",
      phase: "end",
      title: "Commentary",
      progressText: "The focused tests passed.",
    } satisfies AgentActivityItem;
    emitAgentEvent({ runId: task.runId!, stream: "item", data: preamble });
    expect(getTaskProgressSnapshot(task.taskId)).toEqual({
      runId: task.runId,
      revision: 3,
      items: [replacement, preamble],
    });
  });

  it("retains anonymous public preambles only at complete host-sequenced boundaries", () => {
    const task = createTaskFixture("subagent", {
      childSessionKey: "agent:main:subagent:anonymous-preamble",
      runId: "run-anonymous-preamble",
      task: "Report prepared commentary",
    });
    for (const phase of ["start", "update"]) {
      emitAgentEvent({
        runId: task.runId!,
        stream: "item",
        data: {
          kind: "preamble",
          phase,
          title: "Preamble",
          progressText: "Checking the command",
        },
      });
    }
    expect(getTaskProgressSnapshot(task.taskId)).toBeUndefined();
    const completed = {
      kind: "preamble",
      phase: "end",
      title: "Preamble",
      progressText: "Checking the command output.",
    };
    emitAgentEvent({ runId: task.runId!, stream: "item", data: completed });
    emitAgentEvent({
      runId: task.runId!,
      stream: "item",
      data: { ...completed, progressText: "The command finished." },
    });
    expect(getTaskProgressSnapshot(task.taskId)?.items).toEqual([
      { ...completed, itemId: "preamble:3" },
      { ...completed, itemId: "preamble:4", progressText: "The command finished." },
    ]);
  });

  it("publishes identified preambles only at complete boundaries and honors retractions", () => {
    const task = createTaskFixture("subagent", {
      childSessionKey: "agent:main:subagent:identified-preamble",
      runId: "run-identified-preamble",
      task: "Report completed public commentary",
    });
    const completed = {
      itemId: "commentary-1",
      kind: "preamble",
      phase: "end",
      title: "Commentary",
      progressText: "Checking the command output.",
    } satisfies AgentActivityItem;
    const emit = (data: AgentActivityItem) =>
      emitAgentEvent({ runId: task.runId!, stream: "item", data });
    emit({ ...completed, phase: "start", progressText: "sk-proj-partial" });
    expect(getTaskProgressSnapshot(task.taskId)).toBeUndefined();
    emit(completed);
    emit({ ...completed, phase: "update", progressText: "sk-proj-partial" });
    expect(getTaskProgressSnapshot(task.taskId)?.items).toEqual([completed]);

    emit({ ...completed, phase: "update", hideFromChannelProgress: true });
    expect(getTaskProgressSnapshot(task.taskId)?.items).toEqual([]);
    emit(completed);
    emit({ ...completed, phase: "update", suppressChannelProgress: true });
    expect(getTaskProgressSnapshot(task.taskId)?.items).toEqual([]);
    emit(completed);
    emit({ ...completed, phase: "update", progressText: " " });
    expect(getTaskProgressSnapshot(task.taskId)?.items).toEqual([]);
  });

  it("bounds prepared activity while retaining the latest replacement of an item", () => {
    const task = createTaskFixture("subagent", {
      childSessionKey: "agent:main:subagent:prepared-bound",
      runId: "run-prepared-bound",
      task: "Bound public progress",
    });
    const emitItem = (index: number, phase: "start" | "end" = "start") =>
      emitAgentEvent({
        runId: task.runId!,
        stream: "item",
        data: {
          itemId: `tool:command-${index}`,
          kind: "tool",
          phase,
          title: `Command ${index}`,
          status: phase === "end" ? "completed" : "running",
        },
      });
    for (let index = 0; index < 64; index += 1) {
      emitItem(index);
    }
    emitItem(0, "end");
    emitItem(64);
    const progress = expectDefined(getTaskProgressSnapshot(task.taskId), "task progress");
    expect(progress.items).toHaveLength(64);
    expect(progress.items.some((item) => item.itemId === "tool:command-1")).toBe(false);
    expect(progress.items.find((item) => item.itemId === "tool:command-0")).toMatchObject({
      phase: "end",
      status: "completed",
    });
    expect(progress.items.at(-1)).toMatchObject({
      itemId: "tool:command-64",
      status: "running",
    });
  });

  it("bounds public text without splitting Unicode or losing the newest terminal replacement", () => {
    const task = createTaskFixture("subagent", {
      childSessionKey: "agent:main:subagent:prepared-text-budget",
      runId: "run-prepared-text-budget",
      task: "Bound the public projection",
    });
    const longText = `Public ${"\u{1D400}".repeat(2_000)}`;
    const item = {
      kind: "tool",
      phase: "start",
      status: "running",
      title: longText,
      progressText: longText,
      name: longText,
      meta: longText,
      error: longText,
      summary: longText,
    } satisfies Omit<AgentActivityItem, "itemId">;
    for (let index = 0; index < 10; index += 1) {
      emitAgentEvent({
        runId: task.runId!,
        stream: "item",
        data: { ...item, itemId: `command-${index}` },
      });
    }
    emitAgentEvent({
      runId: task.runId!,
      stream: "item",
      data: { ...item, itemId: "command-0", phase: "end", status: "failed" },
    });
    const progress = expectDefined(getTaskProgressSnapshot(task.taskId), "bounded progress");
    expect(progress.items.map((retained) => retained.itemId)).toEqual(["command-9", "command-0"]);
    expect(progress.items.at(-1)).toMatchObject({ phase: "end", status: "failed" });
    const strings = progress.items.flatMap((retained) =>
      Object.values(retained).filter((value): value is string => typeof value === "string"),
    );
    expect(
      strings.reduce((chars, value) => chars + value.length, progress.runId.length),
    ).toBeLessThanOrEqual(8_192);
    for (const text of strings) {
      expect(text.length).toBeLessThanOrEqual(512);
      expect(text).not.toMatch(/[\uD800-\uDFFF]/u);
    }
    expect(progress.items.at(-1)?.title).toContain("Public");
    expect(progress.items.at(-1)?.title).toMatch(/…$/u);

    const retraction = recordTaskActivityEvent(task, {
      runId: task.runId!,
      seq: 12,
      ts: 100,
      stream: "item",
      data: {
        ...item,
        itemId: "command-0",
        toolCallId: "oversized-identity".repeat(1_000),
      },
    });
    expect(retraction).toMatchObject({ itemId: "command-0", suppressChannelProgress: true });
    const retracted = expectDefined(getTaskProgressSnapshot(task.taskId), "retracted progress");
    expect(retracted.items.map((retained) => retained.itemId)).toEqual(["command-9"]);
    expect(retracted.revision).toBeGreaterThan(progress.revision);
  });

  it("keeps visible work through hidden polling and retracts hidden item replacements", () => {
    const task = createTaskFixture("subagent", {
      childSessionKey: "agent:main:subagent:prepared-visibility",
      runId: "run-prepared-visibility",
      task: "Keep public work visible",
    });
    const command = {
      itemId: "command-1",
      kind: "tool",
      phase: "start",
      title: "Run focused tests",
      status: "running",
    } satisfies AgentActivityItem;
    const otherCommand = { ...command, itemId: "command-2", title: "Check changed files" };
    emitAgentEvent({ runId: task.runId!, stream: "item", data: command });
    emitAgentEvent({ runId: task.runId!, stream: "item", data: otherCommand });
    for (let index = 0; index < 65; index += 1) {
      emitAgentEvent({
        runId: task.runId!,
        stream: "item",
        data: {
          itemId: `poll-${index}`,
          kind: "tool",
          name: "process",
          phase: "end",
          title: "Poll command",
          status: "completed",
          hideFromChannelProgress: index % 2 === 0,
          suppressChannelProgress: index % 2 !== 0,
        },
      });
    }
    emitAgentEvent({
      runId: task.runId!,
      stream: "item",
      data: {
        itemId: "analysis-1",
        kind: "analysis",
        phase: "end",
        title: "Private reasoning",
        progressText: "Private reasoning must not become public activity.",
      },
    });
    expect(getTaskProgressSnapshot(task.taskId)).toEqual({
      runId: task.runId,
      revision: 2,
      items: [command, otherCommand],
    });
    for (const [index, item] of [command, otherCommand].entries()) {
      const retraction = recordTaskActivityEvent(task, {
        runId: task.runId!,
        seq: 100 + index,
        ts: 400 + index,
        stream: "item",
        data: {
          ...item,
          phase: "end",
          title: "Private replacement title",
          progressText: "Private replacement progress",
          summary: "Private replacement summary",
          result: { content: [{ type: "text", text: "Private command output" }] },
          hideFromChannelProgress: index === 0,
          suppressChannelProgress: index === 1,
        },
      });
      expect(JSON.stringify(retraction ?? null)).not.toContain("Private");
    }
    expect(getTaskProgressSnapshot(task.taskId)).toEqual({
      runId: task.runId,
      revision: 4,
      items: [],
    });
  });

  it("discards replaced overlays but preserves returned public facts through terminal cleanup", () => {
    const task = createTaskFixture("subagent", {
      childSessionKey: "agent:main:subagent:prepared-generation",
      runId: "run-prepared-generation",
      task: "Resume public progress",
    });
    emitAgentEvent({
      runId: task.runId!,
      stream: "item",
      data: {
        itemId: "predecessor-command",
        kind: "tool",
        phase: "start",
        title: "Predecessor command",
      },
    });
    recordTaskActivityEvent(task, {
      runId: "run-prepared-successor",
      seq: 1,
      ts: 300,
      stream: "execution",
      data: { state: "running" },
    });
    expect(getTaskProgressSnapshot(task.taskId)).toEqual({
      runId: "run-prepared-successor",
      revision: 2,
      items: [],
    });
    const successor = {
      itemId: "successor-commentary",
      kind: "preamble",
      phase: "end",
      title: "Commentary",
      progressText: "Continuing with the replacement execution.",
    } satisfies AgentActivityItem;
    const prepared = recordTaskActivityEvent(task, {
      runId: "run-prepared-successor",
      seq: 2,
      ts: 400,
      stream: "item",
      data: {
        ...successor,
        result: { content: [{ type: "text", text: "Private final output" }] },
      },
    });
    const progress = expectDefined(getTaskProgressSnapshot(task.taskId), "task progress");
    expect(progress).toEqual({
      runId: "run-prepared-successor",
      revision: 3,
      items: [successor],
    });
    markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 500 });
    expect(getTaskProgressSnapshot(task.taskId)).toBeUndefined();
    expect(progress.items).toEqual([successor]);
    expect(prepared).toEqual(successor);
  });

  it("rejects predecessor items before a same-run generation replacement emits activity", () => {
    const task = createTaskFixture("subagent", {
      childSessionKey: "agent:main:subagent:prepared-same-run",
      runId: "run-prepared-same-run",
      task: "Replace the backing generation",
      detail: createSubagentTaskBackingDetail(1),
    });
    recordTaskActivityEvent(task, {
      runId: task.runId!,
      seq: 1,
      ts: 100,
      stream: "item",
      data: {
        itemId: "predecessor-command",
        kind: "tool",
        phase: "start",
        title: "Predecessor command",
      },
    });
    const predecessor = expectDefined(getTaskProgressSnapshot(task.taskId), "task progress");
    expect(predecessor.items[0]?.itemId).toBe("predecessor-command");
    updateTaskStateByRunId({
      taskId: task.taskId,
      runId: task.runId!,
      runtime: "subagent",
      detail: createSubagentTaskBackingDetail(2),
    });
    expect(getTaskProgressSnapshot(task.taskId)).toBeUndefined();

    const successor = {
      itemId: "successor-command",
      kind: "tool",
      phase: "start",
      title: "Replacement command",
    } satisfies AgentActivityItem;
    recordTaskActivityEvent(expectDefined(getTaskById(task.taskId), "replacement task"), {
      runId: task.runId!,
      seq: 2,
      ts: 200,
      stream: "item",
      data: successor,
    });
    expect(getTaskProgressSnapshot(task.taskId)).toEqual({
      runId: task.runId,
      revision: predecessor.revision + 2,
      items: [successor],
    });
  });

  it("does not revive progress from an earlier agent lifecycle", () => {
    const task = createTaskFixture("subagent", {
      childSessionKey: "agent:main:subagent:prepared-lifecycle",
      runId: "run-prepared-lifecycle",
      task: "Keep lifecycle ownership",
    });
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const item = {
      itemId: "command-1",
      kind: "tool",
      phase: "start",
      title: "Read current work",
    } satisfies AgentActivityItem;
    emitAgentEvent({ runId: task.runId!, lifecycleGeneration, stream: "item", data: item });
    expect(getTaskProgressSnapshot(task.taskId)?.items).toEqual([item]);

    rotateAgentEventLifecycleGeneration();
    expect(getTaskProgressSnapshot(task.taskId)).toBeUndefined();
    emitAgentEvent({
      runId: task.runId!,
      lifecycleGeneration,
      stream: "item",
      data: { ...item, title: "Stale update" },
    });
    expect(getTaskProgressSnapshot(task.taskId)).toBeUndefined();
    const replacement = { ...item, itemId: "command-2", title: "New lifecycle work" };
    emitAgentEvent({ runId: task.runId!, stream: "item", data: replacement });
    expect(getTaskProgressSnapshot(task.taskId)?.items).toEqual([replacement]);
  });
});
