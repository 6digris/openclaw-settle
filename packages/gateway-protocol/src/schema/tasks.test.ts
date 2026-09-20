import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { TaskSummarySchema } from "./tasks.js";

describe("TaskSummarySchema", () => {
  it("accepts bounded live subagent progress and keeps diff stats closed", () => {
    const summary = {
      id: "task-1",
      status: "running",
      lastActivity: "Updating the gateway task ledger",
      diffStat: { files: 3, added: 12, removed: 4 },
    };

    expect(Value.Check(TaskSummarySchema, summary)).toBe(true);
    expect(Value.Check(TaskSummarySchema, { ...summary, lastActivity: "x".repeat(201) })).toBe(
      false,
    );
    expect(
      Value.Check(TaskSummarySchema, {
        ...summary,
        diffStat: { ...summary.diffStat, removed: -1 },
      }),
    ).toBe(false);
    expect(
      Value.Check(TaskSummarySchema, {
        ...summary,
        diffStat: { ...summary.diffStat, unchanged: 8 },
      }),
    ).toBe(false);
  });

  it("accepts optional prepared progress but rejects overflow and private event fields", () => {
    const item = {
      itemId: "command-1",
      kind: "tool",
      phase: "end",
      title: "Run checks",
      status: "blocked",
    };
    const progress = {
      runId: "execution-1",
      revision: 7,
      items: Array.from({ length: 64 }, (_, index) => ({ ...item, itemId: `command-${index}` })),
    };
    const summary = { id: "task-1", status: "running", progress };
    expect(Value.Check(TaskSummarySchema, summary)).toBe(true);
    expect(
      Value.Check(TaskSummarySchema, {
        ...summary,
        progress: { ...progress, items: [...progress.items, item] },
      }),
    ).toBe(false);
    expect(
      Value.Check(TaskSummarySchema, {
        ...summary,
        progress: { ...progress, revision: -1 },
      }),
    ).toBe(false);
    expect(
      Value.Check(TaskSummarySchema, {
        ...summary,
        progress: { ...progress, items: [{ ...item, result: "Private output" }] },
      }),
    ).toBe(false);
    expect(
      Value.Check(TaskSummarySchema, { ...summary, progress: { ...progress, items: [] } }),
    ).toBe(true);
  });
});
