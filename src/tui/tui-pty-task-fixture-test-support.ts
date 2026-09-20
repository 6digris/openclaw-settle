// Keeps pending task actions controllable through the real terminal input loop.
export const TUI_PTY_TASK_FIXTURE = {
  variables: `
      let observedTask: Awaited<ReturnType<TuiBackend["listTasks"]>>["tasks"][number] | null = null;
      let authoredCard: Awaited<ReturnType<TuiBackend["getProgressCard"]>>["card"] = null;
      const taskProgressPath = process.env.OPENCLAW_TUI_PTY_TASK_PROGRESS_PATH;
      function advanceTaskProgress(backend: Pick<TuiBackend, "onEvent">, stage: string) {
        if (!observedTask) return;
        const revision = (observedTask.progress?.revision ?? 0) + 1;
        observedTask = {
          ...observedTask,
          updatedAt: Number(observedTask.updatedAt) + 1,
          execution: { state: stage === "unknown" ? "unknown" : stage === "complete" || stage === "cancel" ? "finished" : "running" },
          status: stage === "complete" ? "completed" : stage === "cancel" ? "cancelled" : "running",
          progress: stage === "unknown" || stage === "complete" || stage === "cancel" ? undefined : {
            runId: "child-run",
            revision,
            items: stage === "retract" ? [] : [{
              itemId: "command", phase: "update", kind: "tool", title: "Child command", status: "running",
              progressText: "CHILD_PROGRESS_AFTER_YIELD",
            }],
          },
          ...(stage === "complete" ? { terminalSummary: "CHILD_COMPLETED" } : {}),
          ...(stage === "cancel" ? { terminalSummary: "CHILD_CANCELLED" } : {}),
        };
        backend.onEvent?.({ event: "task", payload: { action: "upserted", task: observedTask } });
      }
      let pendingTaskSuggestion: {
        id: string;
        title: string;
        prompt: string;
        tldr: string;
        cwd: string;
        sessionKey: string;
        agentId: string;
        createdAt: number;
      } | null = null;

      async function waitForTaskRelease() {
        const releasePath = process.env.OPENCLAW_TUI_PTY_TASK_RELEASE_PATH;
        if (releasePath) {
          while (!existsSync(releasePath)) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
      }
  `,
  methods: `
        async listTasks(opts: Parameters<TuiBackend["listTasks"]>[0]) {
          record("listTasks", opts);
          const statuses = Array.isArray(opts.status) ? opts.status : opts.status ? [opts.status] : undefined;
          return { tasks: observedTask && observedTask.sessionKey === opts.sessionKey && (!statuses || statuses.includes(observedTask.status)) ? [observedTask] : [] };
        }
        async getProgressCard(opts: Parameters<TuiBackend["getProgressCard"]>[0]) {
          return { card: authoredCard?.sessionKey === opts.sessionKey ? authoredCard : null };
        }
        async listTaskSuggestions() {
          record("listTaskSuggestions", { pending: Boolean(pendingTaskSuggestion) });
          return pendingTaskSuggestion ? [pendingTaskSuggestion] : [];
        }

        async acceptTaskSuggestion(taskId: string) {
          record("acceptTaskSuggestion", { taskId });
          await waitForTaskRelease();
          pendingTaskSuggestion = null;
          this.onEvent?.({
            event: "task.suggestion",
            payload: { action: "resolved", taskId, resolution: "accepted" },
          });
          return { taskId, key: "agent:main:task-pty" };
        }

        async dismissTaskSuggestion(taskId: string) {
          record("dismissTaskSuggestion", { taskId });
          await waitForTaskRelease();
          pendingTaskSuggestion = null;
          this.onEvent?.({
            event: "task.suggestion",
            payload: { action: "resolved", taskId, resolution: "dismissed" },
          });
          return { taskId, dismissed: true };
        }
  `,
  sendChat: `
          if (opts.message === "task progress proof") {
            observedTask = {
              id: "child-task", taskId: "child-task", runId: "child-run", title: "Child investigation",
              sessionKey: opts.sessionKey, status: "running", updatedAt: 1,
              execution: { state: "running" },
              progress: { runId: "child-run", revision: 1, items: [{
                itemId: "command", phase: "start", kind: "tool", title: "Child command", status: "running",
                progressText: "CHILD_STARTED",
              }] },
            };
            authoredCard = { sessionKey: opts.sessionKey, revision: 1, updatedAt: 1, steps: [{ step: "Review child result", status: "pending" }] };
            this.onEvent?.({ event: "task", payload: { action: "upserted", task: observedTask } });
            this.onEvent?.({ event: "progressCard.changed", payload: { sessionKey: opts.sessionKey, revision: 1 } });
            this.onEvent?.({ event: "chat", payload: {
              sessionKey: opts.sessionKey, runId, state: "final", yielded: true, stopReason: "end_turn",
              message: { role: "assistant", content: [{ type: "text", text: "PARENT_YIELDED" }] },
            } });
            if (taskProgressPath) {
              watchFile(taskProgressPath, { interval: 25 }, () => {
                advanceTaskProgress(this, readFileSync(taskProgressPath, "utf8").trim());
              });
            }
            return { runId };
          }
  `,
  stop: `
        stop() {
          record("stop");
          if (taskProgressPath) unwatchFile(taskProgressPath);
        }
  `,
} as const;
