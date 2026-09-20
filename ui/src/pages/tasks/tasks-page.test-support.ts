import type { TaskStatus, TaskSummary } from "@openclaw/gateway-client/browser";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";

export type TasksPageTestElement = HTMLElement & {
  context: ApplicationContext;
  tasks: TaskSummary[];
  error: string | null;
  copyResultError: string | null;
  cancellingTaskIds: Set<string>;
  cancelTask: (taskId: string) => Promise<void>;
  copyTaskResult: (taskId: string) => Promise<void>;
  recoverTask: (taskId: string, action: "retry" | "dismiss") => Promise<void>;
  refreshTasks: () => Promise<void>;
};

export function staleCursorError() {
  return new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: "invalid or expired tasks.list cursor; restart pagination without a cursor",
  });
}

export function createGateway(
  client: GatewayBrowserClient,
  hello: ApplicationGatewaySnapshot["hello"] = null,
) {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const source = createApplicationGateway(snapshot);
  return {
    emitConnected(connected: boolean) {
      snapshot.phase = connected ? "connected" : "stopped";
      source.publish(snapshot);
    },
    emitTask(payload: unknown) {
      source.publishEvent({ event: "task", payload, type: "event" });
    },
    gateway: source.gateway,
  };
}

export function createTask(
  id: string,
  status: TaskStatus = "running",
  overrides: Partial<TaskSummary> = {},
): TaskSummary {
  return { id, taskId: id, status, agentId: "main", updatedAt: 100, ...overrides };
}
