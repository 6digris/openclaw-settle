import { describe, expect, it, vi } from "vitest";
import type {
  ProgressCardGetResult,
  TasksListResult,
  TaskSummary,
} from "../../packages/gateway-protocol/src/index.js";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { TuiBackend } from "./tui-backend.js";
import { createTuiTaskProgressController } from "./tui-task-progress.js";

const sessionKey = "agent:main:parent";
function child(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "child",
    taskId: "child",
    title: "Investigate",
    runId: "child-run",
    sessionKey,
    status: "running",
    updatedAt: 100,
    execution: { state: "running" },
    progress: {
      runId: "child-run",
      revision: 1,
      items: [
        {
          itemId: "command",
          phase: "start",
          kind: "tool",
          title: "Inspect source",
          status: "running",
          progressText: "Reading parser",
        },
      ],
    },
    ...overrides,
  };
}

function harness(
  opts: {
    sessionKey?: string;
    agentId?: string;
    listTasks?: TuiBackend["listTasks"];
    getProgressCard?: TuiBackend["getProgressCard"];
  } = {},
) {
  let scope = { sessionKey: opts.sessionKey ?? sessionKey, agentId: opts.agentId ?? "main" };
  const controller = createTuiTaskProgressController({
    client: {
      listTasks:
        opts.listTasks ??
        (async (query) => ({ tasks: query.sortBy === "endedAt" ? [] : [child()] })),
      getProgressCard: opts.getProgressCard ?? (async () => ({ card: null })),
    },
    getScope: () => scope,
    requestRender: () => {},
  });
  return {
    ...controller,
    render: () => stripAnsi(controller.component.render(100).join("\n")),
    switchSession: (nextSessionKey: string, agentId = "main") => {
      scope = { sessionKey: nextSessionKey, agentId };
      controller.sessionChanged();
    },
    upsert: (task: TaskSummary) => controller.handleEvent("task", { action: "upserted", task }),
  };
}

describe("TUI task progress", () => {
  it("keeps retractions and terminal truth over stale snapshots and prepared events", async () => {
    const page = createDeferred<TasksListResult>();
    const view = harness({
      listTasks: async (query) => (query.sortBy === "endedAt" ? { tasks: [] } : page.promise),
    });
    const connected = view.connect();
    view.upsert(child({ progress: { runId: "child-run", revision: 3, items: [] } }));
    page.resolve({ tasks: [child()] });
    await connected;
    expect(view.render()).toContain("Investigate [running]");
    expect(view.render()).not.toContain("Inspect source");
    view.upsert(
      child({
        progress: {
          runId: "resumed-execution",
          revision: 4,
          items: [
            {
              itemId: "resumed-command",
              phase: "start",
              kind: "tool",
              title: "Verify repair",
              progressText: "Testing resumed execution",
              status: "running",
            },
          ],
        },
      }),
    );
    expect(view.render()).toContain("Testing resumed execution");
    view.upsert(
      child({
        progress: {
          runId: "resumed-execution",
          revision: 5,
          items: [
            {
              itemId: "resumed-command",
              phase: "end",
              kind: "tool",
              title: "Verify repair",
              progressText: "No outcome was reported",
            },
          ],
        },
      }),
    );
    expect(view.render()).toContain("Verify repair [unknown]");
    expect(view.render()).not.toContain("[completed]");
    view.upsert(
      child({
        execution: { state: "finished" },
        progress: {
          runId: "resumed-execution",
          revision: 6,
          items: [
            {
              itemId: "resumed-command",
              phase: "end",
              kind: "tool",
              title: "Verify repair",
              status: "completed",
              progressText: "Regression passed; parent delivery is pending",
            },
          ],
        },
      }),
    );
    expect(view.render()).toContain("Investigate [finished]");
    expect(view.render()).toContain("Verify repair [completed]");
    expect(view.render()).toContain("Regression passed; parent delivery is pending");
    expect(view.render()).not.toContain("Investigate [completed]");
    view.upsert(
      child({
        status: "completed",
        execution: { state: "finished" },
        progress: undefined,
        terminalSummary: "Parser repaired",
      }),
    );
    view.upsert(child());
    expect(view.render()).toContain("Investigate [completed]");
    expect(view.render()).toContain("Parser repaired");
    expect(view.render()).not.toContain("[running]");
    view.dispose();
    await view.settled();
  });

  it("replays a scoped ownership move before admitting a held initial snapshot", async () => {
    const page = createDeferred<TasksListResult>();
    const view = harness({
      listTasks: async (query) => (query.sortBy === "endedAt" ? { tasks: [] } : page.promise),
    });
    const connected = view.connect();
    view.upsert(
      child({
        sessionKey: "agent:work:moved-parent",
        ownerKey: "agent:work:moved-parent",
        childSessionKey: "agent:work:subagent:child",
        agentId: "main",
        updatedAt: 200,
      }),
    );
    page.resolve({
      tasks: [
        child(),
        child({
          id: "retained",
          taskId: "retained",
          title: "Still authorized",
          progress: undefined,
        }),
      ],
    });
    try {
      await connected;
      const rendered = view.render();
      expect(rendered).toContain("Still authorized [running]");
      expect(rendered).not.toContain("Investigate");
      expect(rendered).not.toContain("Reading parser");
    } finally {
      view.dispose();
      await view.settled();
    }
  });

  it("rejects stale task and authored-card reads across a session change", async () => {
    const oldPage = createDeferred<TasksListResult>();
    const oldCard = createDeferred<ProgressCardGetResult>();
    const other = "agent:main:other";
    const view = harness({
      listTasks: async (query) =>
        query.sessionKey === sessionKey
          ? oldPage.promise
          : {
              tasks:
                query.sortBy === "endedAt"
                  ? []
                  : [
                      child({
                        id: "other",
                        taskId: "other",
                        sessionKey: other,
                        title: "Other session",
                      }),
                    ],
            },
      getProgressCard: async (query) =>
        query.sessionKey === sessionKey
          ? oldCard.promise
          : {
              card: {
                sessionKey: other,
                revision: 1,
                updatedAt: 1,
                steps: [{ step: "Other checklist", status: "pending" }],
              },
            },
    });
    const connected = view.connect();
    view.switchSession(other);
    await vi.waitFor(() => expect(view.render()).toContain("Other checklist"));
    oldPage.resolve({ tasks: [child({ title: "Stale private task" })] });
    oldCard.resolve({
      card: { sessionKey, revision: 99, updatedAt: 99, markdown: "Stale private checklist" },
    });
    await connected;
    await view.settled();
    expect(view.render()).toContain("Other session");
    expect(view.render()).not.toContain("Stale private");
    view.dispose();
  });

  it("removes old running activity on disconnect and shows authoritative unknown after reconnect", async () => {
    let restarted = false;
    const view = harness({
      listTasks: async (query) => ({
        tasks:
          query.sortBy === "endedAt"
            ? []
            : [
                restarted
                  ? child({ execution: { state: "unknown" }, progress: undefined })
                  : child(),
              ],
      }),
    });
    await view.connect();
    expect(view.render()).toContain("Reading parser");
    view.disconnect();
    expect(view.render()).toContain("Task activity unavailable");
    expect(view.render()).not.toContain("[running]");
    restarted = true;
    await view.connect();
    expect(view.render()).toContain("Investigate [unknown]");
    expect(view.render()).not.toContain("Reading parser");
    view.dispose();
  });

  it("uses the authoritative agent-scoped query for ambiguous requester aliases", async () => {
    const view = harness({
      sessionKey: "global",
      agentId: "work",
      listTasks: async () => ({ tasks: [] }),
    });
    await view.connect();
    view.upsert(child({ sessionKey: "global", agentId: "main", title: "Foreign private task" }));
    await view.settled();
    expect(view.render()).not.toContain("Foreign private task");
    view.dispose();
  });
});
