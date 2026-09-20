import type { TaskSummary } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import { partitionTasks } from "./data.ts";

function task(overrides: Partial<TaskSummary> & Pick<TaskSummary, "id" | "status">): TaskSummary {
  return {
    taskId: overrides.id,
    updatedAt: 100,
    ...overrides,
  };
}

describe("task presentation", () => {
  it("partitions active tasks and caps recent terminal tasks at 50", () => {
    const terminals = Array.from({ length: 55 }, (_, index) =>
      task({ id: `terminal-${index}`, status: "completed", updatedAt: index }),
    );
    const result = partitionTasks([
      task({ id: "running", status: "running", updatedAt: 1000 }),
      task({ id: "queued", status: "queued", updatedAt: 999 }),
      ...terminals,
    ]);
    expect(result.active.map((entry) => entry.id)).toEqual(["queued", "running"]);
    expect(result.recent).toHaveLength(50);
    expect(result.recent[0]?.id).toBe("terminal-54");
  });

  it("keeps active tasks in creation order while their activity changes", () => {
    const oldest = task({
      id: "oldest",
      status: "running",
      createdAt: 100,
      startedAt: 110,
      updatedAt: 500,
    });
    const middle = task({
      id: "middle",
      status: "running",
      createdAt: 200,
      startedAt: 410,
      updatedAt: 600,
    });
    const newest = task({
      id: "newest",
      status: "running",
      createdAt: 300,
      startedAt: 310,
      updatedAt: 700,
    });

    expect(partitionTasks([middle, newest, oldest]).active.map((entry) => entry.id)).toEqual([
      "oldest",
      "middle",
      "newest",
    ]);
    expect(
      partitionTasks([{ ...oldest, updatedAt: 800 }, middle, newest]).active.map(
        (entry) => entry.id,
      ),
    ).toEqual(["oldest", "middle", "newest"]);
  });

  it("orders terminal tasks by completion time instead of later activity", () => {
    const finishedFirst = task({
      id: "finished-first",
      status: "completed",
      createdAt: 100,
      endedAt: 400,
      updatedAt: 900,
    });
    const finishedLast = task({
      id: "finished-last",
      status: "completed",
      createdAt: 200,
      endedAt: 500,
      updatedAt: 600,
    });

    expect(partitionTasks([finishedFirst, finishedLast]).recent.map((entry) => entry.id)).toEqual([
      "finished-last",
      "finished-first",
    ]);
  });
});
