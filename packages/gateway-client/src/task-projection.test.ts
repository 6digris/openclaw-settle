import { describe, expect, it } from "vitest";
import {
  TaskProjection,
  applyTaskEvent,
  mergeTaskLists,
  newestTaskSnapshot,
  normalizeTaskSummary,
  normalizeTasksCancelResult,
  normalizeTasksGetResult,
  normalizeTasksListResult,
  normalizeTasksRecoveryResult,
  type TaskSummary,
} from "./task-projection.js";

const task = (id: string, overrides: Partial<TaskSummary> = {}): TaskSummary => ({
  id,
  taskId: id,
  status: "running",
  runId: "task-run",
  updatedAt: 100,
  ...overrides,
});
const progress = (revision: number): NonNullable<TaskSummary["progress"]> => ({
  runId: "execution-run",
  revision,
  items: [
    {
      itemId: "commentary",
      kind: "preamble",
      phase: "update",
      title: "",
      progressText: "Checking the public result",
    },
  ],
});

describe("shared task projection", () => {
  it("replays pre-snapshot deletion and recreation over a stale page", () => {
    const projection = new TaskProjection();
    projection.applyEvent({ action: "deleted", taskId: "child" });
    projection.applyEvent({
      action: "upserted",
      task: task("child", { updatedAt: 5, title: "Recreated" }),
    });
    const token = projection.beginSnapshot();
    projection.applySnapshot(token, [
      task("child", { updatedAt: 500, title: "Deleted incarnation" }),
    ]);
    expect(projection.tasks?.map((row) => row.title)).toEqual(["Recreated"]);
  });

  it("keeps live completion when active and recent snapshots race", () => {
    const projection = new TaskProjection();
    const token = projection.beginSnapshot();
    projection.applyEvent({
      action: "upserted",
      task: task("child", { status: "completed", terminalSummary: "Verified output" }),
    });
    projection.applySnapshot(token, [task("child")], []);
    expect(projection.tasks).toEqual([
      task("child", { status: "completed", terminalSummary: "Verified output" }),
    ]);
  });

  it("uses prepared-progress revisions when the durable clock does not change", () => {
    const projection = new TaskProjection();
    projection.applySnapshot(projection.beginSnapshot(), [
      task("child", { progress: progress(1) }),
    ]);
    const token = projection.beginSnapshot();
    projection.applyEvent({
      action: "upserted",
      task: task("child", { progress: { ...progress(2), items: [] } }),
    });
    projection.applySnapshot(token, [task("child", { progress: progress(1) })]);
    expect(projection.tasks?.[0]?.progress).toEqual({ ...progress(2), items: [] });
    projection.applyEvent({ action: "upserted", task: task("child", { progress: progress(1) }) });
    expect(projection.tasks?.[0]?.progress?.revision).toBe(2);
  });

  it("does not restore a predecessor execution over a newer task progress revision", () => {
    const projection = new TaskProjection();
    const old = task("child", {
      execution: { state: "running", lastActivityAt: 300 },
      lastActivity: "Inspecting the predecessor execution",
      progress: progress(1),
    });
    const resumed = task("child", {
      execution: { state: "waiting", lastActivityAt: 200 },
      progress: { ...progress(2), runId: "resumed-execution", items: [] },
    });
    projection.applySnapshot(projection.beginSnapshot(), [old]);
    projection.applyEvent({ action: "upserted", task: resumed });
    projection.applyEvent({ action: "upserted", task: old });
    expect(projection.tasks?.[0]?.progress).toEqual(resumed.progress);
    expect(projection.tasks?.[0]?.execution?.state).toBe("waiting");
    expect(projection.tasks?.[0]).not.toHaveProperty("lastActivity");
    projection.invalidate();
    projection.applySnapshot(projection.beginSnapshot(), [
      task("child", { progress: { ...progress(0), runId: "restarted-host" } }),
    ]);
    expect(projection.tasks?.[0]?.progress?.runId).toBe("restarted-host");
  });

  it("does not inherit transient progress when a current snapshot omits it", () => {
    const projection = new TaskProjection();
    projection.applySnapshot(projection.beginSnapshot(), [
      task("child", { progress: progress(3), lastActivity: "Inspecting" }),
    ]);
    projection.applySnapshot(projection.beginSnapshot(), [
      task("child", { execution: { state: "unknown" } }),
    ]);
    expect(projection.tasks?.[0]).not.toHaveProperty("progress");
    expect(projection.tasks?.[0]).not.toHaveProperty("lastActivity");
    expect(projection.tasks?.[0]?.execution?.state).toBe("unknown");
  });

  it("retains real observer events when the initial read fails", () => {
    const projection = new TaskProjection();
    const token = projection.beginSnapshot();
    projection.applyEvent({ action: "upserted", task: task("live-child") });
    projection.failSnapshot(token);
    expect(projection.tasks?.map((row) => row.id)).toEqual(["live-child"]);
    expect(projection.loading).toBe(false);
  });

  it("retires reads and prior events on registry restoration", () => {
    const projection = new TaskProjection();
    const stale = projection.beginSnapshot();
    projection.applyEvent({ action: "upserted", task: task("retired-child") });
    expect(projection.applyEvent({ action: "restored" }).refetch).toBe(true);
    const current = projection.beginSnapshot();
    expect(projection.applySnapshot(stale, [task("retired-child")])).toBe(false);
    projection.applySnapshot(current, [task("current-child")]);
    expect(projection.tasks?.map((row) => row.id)).toEqual(["current-child"]);
  });

  it("cannot repopulate a disposed connection from late results or events", () => {
    const projection = new TaskProjection();
    const token = projection.beginSnapshot();
    projection.dispose();
    expect(projection.applySnapshot(token, [task("old-session")])).toBe(false);
    expect(projection.failSnapshot(token)).toBe(false);
    projection.applyEvent({ action: "upserted", task: task("old-session") });
    expect(projection.tasks).toBeNull();
    expect(() => projection.beginSnapshot()).toThrow("disposed");
  });

  it("joins a superseding read without losing events observed during the first one", () => {
    const projection = new TaskProjection();
    const first = projection.beginSnapshot();
    projection.applyEvent({ action: "upserted", task: task("child", { progress: progress(2) }) });
    const second = projection.beginSnapshot();
    expect(projection.failSnapshot(first)).toBe(false);
    projection.applySnapshot(second, [task("child", { progress: progress(1) })]);
    expect(projection.tasks?.[0]?.progress?.revision).toBe(2);
  });
});

describe("task snapshot precedence", () => {
  it("keeps same-title tasks distinct and orders tied rows deterministically", () => {
    const rows = mergeTaskLists(
      [
        task("b", { title: "Worker", updatedAt: 200 }),
        task("a", { title: "Worker", updatedAt: 200 }),
      ],
      [task("b", { title: "Worker", status: "completed", updatedAt: 300 })],
    );
    expect(rows.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "b", status: "completed" },
      { id: "a", status: "running" },
    ]);
  });

  it("advances queued work despite an equal-clock older running observation", () => {
    const queued = task("child", {
      status: "queued",
      execution: { state: "queued", lastActivityAt: 400 },
    });
    const running = task("child", { execution: { state: "running", lastActivityAt: 300 } });
    expect(mergeTaskLists([queued], [running])).toEqual([running]);
    expect(mergeTaskLists([running], [queued])).toEqual([running]);
  });

  it("normalizes numeric and ISO activity clocks before choosing current work", () => {
    const fresh = task("child", {
      execution: { state: "waiting", lastActivityAt: "1970-01-01T00:00:00.400Z" },
    });
    const stale = task("child", { execution: { state: "running", lastActivityAt: 300 } });
    expect(newestTaskSnapshot(fresh, stale, "event")).toEqual(fresh);
    expect(newestTaskSnapshot(stale, fresh, "snapshot")).toEqual(fresh);
  });

  it("keeps tool progress while taking an authorized prompt from stale details", () => {
    const current = task("child", {
      toolUseCount: 2,
      lastToolName: "write",
      progressSummary: "Finishing",
    });
    const stale = task("child", {
      toolUseCount: 1,
      lastToolName: "read",
      prompt: "Authorized task input",
    });
    expect(newestTaskSnapshot(current, stale, "detail")).toEqual({
      ...current,
      prompt: stale.prompt,
    });
    expect(
      applyTaskEvent([current], { action: "upserted", task: stale }).tasks[0]?.lastToolName,
    ).toBe("write");
  });

  it("does not revive terminal work from an equal-clock active snapshot", () => {
    const completed = task("child", { status: "completed" });
    expect(newestTaskSnapshot(completed, task("child"), "snapshot").status).toBe("completed");
    expect(mergeTaskLists([task("child")], [completed])[0]?.status).toBe("completed");
  });

  it("accepts authoritative equal-clock terminal corrections but not stale details", () => {
    const completed = task("child", {
      status: "completed",
      terminalSummary: "Old result",
      prompt: "Authorized task input",
      result: "Canonical completion output",
    });
    const corrected = task("child", { status: "failed", terminalSummary: "Delivery failed" });
    expect(newestTaskSnapshot(completed, corrected, "event")).toEqual({
      ...corrected,
      prompt: completed.prompt,
      result: completed.result,
    });
    expect(newestTaskSnapshot(completed, corrected, "detail").terminalSummary).toBe("Old result");
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "hydrates %s details without replacing terminal facts or reviving live activity",
    (status) => {
      const current = task("child", {
        status,
        terminalSummary: "Current terminal facts",
        execution: { state: "finished" },
      });
      const detail = task("child", {
        status,
        terminalSummary: "Older terminal facts",
        prompt: "Authorized task input",
        result: "Canonical completion output",
        execution: { state: "running", lastActivityAt: 200 },
        lastActivity: "Still running",
        progress: progress(1),
      });
      expect(newestTaskSnapshot(current, detail, "detail")).toEqual({
        ...current,
        prompt: detail.prompt,
        result: detail.result,
      });
    },
  );

  it.each([
    { runId: "replacement-task-run" },
    { progress: { ...progress(2), runId: "replacement-execution" } },
  ])("does not transfer detail fields across a known execution replacement: %j", (replacement) => {
    const previous = task("child", {
      status: "completed",
      prompt: "Previous task input",
      result: "Previous completion output",
      progress: progress(1),
    });
    const current = task("child", { status: "completed", ...replacement });
    expect(newestTaskSnapshot(current, previous, "detail")).toEqual(current);
    expect(newestTaskSnapshot(previous, current, "event")).toEqual(current);
  });

  it("does not hydrate terminal details from an older durable snapshot", () => {
    const current = task("child", { status: "failed", updatedAt: 200 });
    const stale = task("child", {
      status: "completed",
      prompt: "Previous task input",
      result: "Previous completion output",
    });
    expect(newestTaskSnapshot(current, stale, "detail")).toEqual(current);
  });

  it("keeps detail-only prompts while replacing live task facts", () => {
    const current = task("child", { prompt: "Authorized task input", progress: progress(1) });
    const next = newestTaskSnapshot(
      current,
      task("child", { updatedAt: 101, progress: progress(2) }),
      "event",
    );
    expect(next.prompt).toBe("Authorized task input");
    expect(next.progress?.revision).toBe(2);
  });

  it("retains legacy display facts without carrying active activity into terminal work", () => {
    const current = task("child", {
      lastActivity: "Inspecting",
      diffStat: { files: 1, added: 2, removed: 0 },
    });
    const active = newestTaskSnapshot(current, task("child", { updatedAt: 101 }), "snapshot");
    expect(active.lastActivity).toBe("Inspecting");
    const terminal = newestTaskSnapshot(
      active,
      task("child", { updatedAt: 102, status: "completed" }),
      "event",
    );
    expect(terminal).not.toHaveProperty("lastActivity");
    expect(terminal.diffStat).toEqual(current.diffStat);
  });

  it("retains task execution observations when older details return later", () => {
    const current = task("child", { execution: { state: "waiting", lastActivityAt: 200 } });
    const old = task("child", { execution: { state: "running", lastActivityAt: 150 } });
    expect(newestTaskSnapshot(current, old, "detail").execution?.state).toBe("waiting");
  });

  it("deletes only the identified task and invalidates on unknown registry events", () => {
    const rows = [task("one"), task("two")];
    expect(
      applyTaskEvent(rows, { action: "deleted", taskId: "one" }).tasks.map((row) => row.id),
    ).toEqual(["two"]);
    expect(applyTaskEvent(rows, { action: "unexpected" }).refetch).toBe(true);
  });
});

describe("task wire normalization", () => {
  it("accepts older payloads and bounded public progress through the same decoder", () => {
    expect(normalizeTaskSummary({ id: " child ", status: "running" })?.taskId).toBe("child");
    const withProgress = task("child", { progress: progress(1) });
    expect(normalizeTasksGetResult({ task: withProgress })?.progress).toEqual(
      withProgress.progress,
    );
    expect(normalizeTasksListResult({ tasks: [withProgress] })?.tasks[0]?.progress).toEqual(
      withProgress.progress,
    );
  });

  it("rejects malformed or private progress rather than publishing it to consumers", () => {
    expect(normalizeTaskSummary({ id: " ", status: "running" })).toBeNull();
    expect(
      normalizeTasksListResult({
        tasks: [task("child", { progress: { ...progress(1), revision: -1 } })],
      }),
    ).toBeNull();
    expect(
      normalizeTasksGetResult({
        task: { ...task("child"), progress: { ...progress(1), privatePrompt: "not public" } },
      }),
    ).toBeNull();
  });

  it("distinguishes refused cancellation from a failed transport and keeps recovery outcomes", () => {
    expect(
      normalizeTasksCancelResult({
        found: true,
        cancelled: false,
        reason: "already-terminal",
        task: task("child", { status: "completed" }),
      }),
    ).toMatchObject({ cancelled: false, reason: "already-terminal" });
    expect(
      normalizeTasksRecoveryResult({
        results: [
          {
            taskId: "child",
            ok: false,
            reason: "already-terminal",
            task: task("child", { status: "completed" }),
          },
        ],
      })?.results[0],
    ).toMatchObject({ ok: false, reason: "already-terminal" });
  });
});
