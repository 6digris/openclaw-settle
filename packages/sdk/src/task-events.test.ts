import { expect, it } from "vitest";
import { EventHub, OpenClaw } from "./index.js";
import type { GatewayEvent, OpenClawTransport, TaskSummary } from "./types.js";

it("delivers canonical task actions with nested identity and prepared progress", async () => {
  const events = new EventHub<GatewayEvent>({ replayLimit: 3 });
  const transport: OpenClawTransport = {
    request: async () => {
      throw new Error("Task event subscription must not issue an RPC");
    },
    events: (filter) => events.stream(filter, { replay: true }),
    close: () => events.close(),
  };
  const oc = new OpenClaw({ transport });
  const observe = async (seq: number) => {
    for await (const event of oc.events((eventLocal) => eventLocal.raw?.seq === seq)) {
      return event;
    }
    throw new Error(`event stream ended before sequence ${seq}`);
  };
  const task: TaskSummary = {
    id: "task-background",
    taskId: "runtime-task-id",
    runId: "child-run",
    sessionKey: "agent:main:main",
    agentId: "worker",
    status: "running",
    execution: { state: "waiting", wait: { kind: "children" } },
    progress: {
      runId: "child-run",
      revision: 2,
      items: [
        { itemId: "item-1", phase: "update", kind: "tool", title: "Reading", status: "running" },
      ],
    },
  };
  try {
    await oc.connect();
    const actions = [
      { action: "upserted", task },
      { action: "deleted", taskId: task.id },
      { action: "restored" },
    ];
    for (const [seq, payload] of actions.entries()) {
      const observed = observe(seq);
      events.publish({ event: "task", seq, payload });
      const event = await observed;
      expect(event.type).toBe("task.updated");
      expect(event.data).toEqual(payload);
      if (payload.action === "upserted") {
        expect(event).toMatchObject({
          taskId: task.id,
          runId: task.runId,
          sessionKey: task.sessionKey,
          agentId: task.agentId,
        });
      } else {
        expect(event.taskId).toBe(payload.action === "deleted" ? task.id : undefined);
        expect(event.runId).toBeUndefined();
      }
    }
  } finally {
    await oc.close();
  }
});
