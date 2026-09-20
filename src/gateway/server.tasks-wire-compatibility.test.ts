import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expect, test, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import type {
  TasksCancelResult,
  TasksGetResult,
  TasksHistoryResult,
  TasksListResult,
  TasksRecoveryResult,
} from "../../packages/gateway-protocol/src/schema/tasks.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { settleSubagentCompletionDelivery } from "../agents/subagents/completion/subagent-completion-admission.store.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import type * as SubagentRegistry from "../agents/subagents/registry/subagent-registry.js";
import { writeConfigFile } from "../config/config.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { getTaskById, prepareTaskRegistryRead } from "../tasks/runtime-internal.js";
import { getTaskRegistryObservers } from "../tasks/task-registry.store.js";
import {
  createTaskFixture,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.test-support.js";
import type { TaskEventPayload } from "../tasks/task-summary.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  onceMessage,
  openWs,
  rpcReq,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import { releasedTaskValidators } from "./task-wire-v2026-9-5.test-support.js";

// Exercise the real recovery transaction/RPC, without starting asynchronous
// completion delivery after the explicit operator retry under test.
vi.mock("../agents/subagents/registry/subagent-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SubagentRegistry>()),
  resumeSubagentRun: vi.fn(),
}));

installGatewayTestHooks({ scope: "suite" });

type TaskFrame = { type: "event"; event: "task"; payload: TaskEventPayload; seq: number };

test("negotiates released task replies and events without changing task authority", async () => {
  const owner = ensureProfileForEmail("task-owner@example.test");
  const stranger = ensureProfileForEmail("task-stranger@example.test");
  const reader = ensureProfileForEmail("task-reader@example.test");
  setUserProfileRole(owner.id, "task-operator");
  setUserProfileRole(reader.id, "task-reader");
  const origin = "https://tasks.example.test";
  const auth: GatewayAuthConfig = {
    mode: "trusted-proxy",
    identityScopes: {
      "task-owner@example.test": ["operator.read", "operator.write"],
      "task-reader@example.test": ["operator.read"],
    },
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [origin] };
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      controlUi: { allowedOrigins: [origin] },
      roles: {
        default: "task-operator",
        definitions: {
          "task-operator": {
            sessions: { others: "none" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
          "task-reader": {
            sessions: { others: "none" },
            agents: "*",
            scopes: ["operator.read"],
          },
        },
      },
    },
  });
  resetTaskRegistryForTests({ persist: false });
  const sockets: WebSocket[] = [];
  const completionRuns: string[] = [];
  try {
    await withGatewayServer(async ({ port }) => {
      try {
        const ownedKey = "agent:main:task-wire-owned";
        const hiddenKey = "agent:main:task-wire-hidden";
        for (const [sessionKey, profileId] of [
          [ownedKey, owner.id],
          [hiddenKey, stranger.id],
        ] as const) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            {
              sessionId: `${sessionKey}-id`,
              lifecycleRevision: `${sessionKey}-generation`,
              updatedAt: Date.now(),
              createdActor: { type: "human", source: "profile", id: profileId },
              visibility: "draft",
            },
          );
        }
        const scope = { agentId: "main", sessionKey: ownedKey, sessionId: `${ownedKey}-id` };
        await appendTranscriptMessage(scope, {
          message: { role: "assistant", content: "Earlier task output" },
        });
        await appendTranscriptMessage(scope, {
          message: {
            role: "toolResult",
            toolCallId: "poll",
            toolName: "process",
            isError: false,
            content: "Command completed",
            details: { status: "completed", sessionId: "job", aggregated: "done", exitCode: 0 },
          },
        });
        const connect = async (mode: "omitted" | "legacy" | "modern", readOnly = false) => {
          const ws = await openWs(port, {
            origin,
            "x-forwarded-for": "203.0.113.50",
            "x-forwarded-proto": "https",
            "x-forwarded-user": readOnly ? "task-reader@example.test" : "task-owner@example.test",
          });
          sockets.push(ws);
          // connectReq normally supplies caps: []; this peer represents an actual
          // released client omitting the field, not a different version/client ID.
          const send = ws.send.bind(ws);
          const omitCaps =
            mode === "omitted"
              ? vi.spyOn(ws, "send").mockImplementationOnce((data) => {
                  if (typeof data !== "string") {
                    throw new Error("Expected a text connect frame");
                  }
                  const frame = JSON.parse(data);
                  delete frame.params.caps;
                  send(JSON.stringify(frame));
                })
              : undefined;
          try {
            const connected = await connectReq(ws, {
              skipDefaultAuth: true,
              prePairDevice: true,
              scopes: readOnly ? ["operator.read"] : ["operator.read", "operator.write"],
              caps: mode === "modern" ? ["task-progress"] : [],
              client: CONTROL_UI_CLIENT,
              deviceIdentityPath: path.join(
                process.env.OPENCLAW_STATE_DIR!,
                `task-wire-${mode}-${readOnly}.sqlite`,
              ),
              browserOrigin: origin,
            });
            expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
            if (readOnly) {
              expect(connected.payload).toMatchObject({ auth: { scopes: ["operator.read"] } });
            }
          } finally {
            omitCaps?.mockRestore();
          }
          return { ws, modern: mode === "modern" };
        };
        const peers = [await connect("omitted"), await connect("legacy"), await connect("modern")];
        await vi.waitFor(() => expect(getTaskRegistryObservers()).not.toBeNull());
        await prepareTaskRegistryRead();
        const events = new Map<WebSocket, TaskFrame[]>();
        for (const { ws } of peers) {
          const received: TaskFrame[] = [];
          events.set(ws, received);
          ws.on("message", (data: RawData) => {
            const frame = JSON.parse(rawDataToString(data));
            if (frame.type === "event" && frame.event === "task") {
              received.push(frame);
            }
          });
        }
        const hidden = createTaskFixture("cli", {
          runId: "wire-hidden-run",
          requesterSessionKey: hiddenKey,
          requesterAgentId: "main",
          ownerKey: hiddenKey,
          task: "Private task",
          notifyPolicy: "silent",
        });
        const visible = createTaskFixture("cli", {
          runId: "wire-visible-run",
          requesterSessionKey: ownedKey,
          requesterAgentId: "main",
          ownerKey: ownedKey,
          task: "Inspect visible files",
          notifyPolicy: "silent",
          progressSummary: "Retained legacy progress text",
        });
        // Bound initial event delivery before listening for the progress-only update.
        for (const { ws } of peers) {
          expect((await rpcReq(ws, "tasks.get", { taskId: visible.taskId })).ok).toBe(true);
        }
        const updated = peers.map(({ ws }) =>
          onceMessage<TaskFrame>(
            ws,
            (frame) =>
              frame.type === "event" &&
              frame.event === "task" &&
              frame.payload.action === "upserted" &&
              frame.payload.task.id === visible.taskId,
          ),
        );
        const item = {
          itemId: "wire-command",
          kind: "tool",
          phase: "start",
          title: "Inspect files",
          name: "exec",
          status: "running",
        };
        emitAgentEvent({
          runId: hidden.runId!,
          stream: "item",
          data: { ...item, title: "Private command" },
        });
        emitAgentEvent({ runId: visible.runId!, stream: "item", data: item });
        const publications = await Promise.all(updated);
        for (const [index, peer] of peers.entries()) {
          const publication = publications[index]!;
          expect(publication.payload.action).toBe("upserted");
          if (publication.payload.action !== "upserted") {
            throw new Error("Expected task upsert");
          }
          const summary = publication.payload.task;
          if (peer.modern) {
            expect(summary.progress).toMatchObject({
              runId: visible.runId,
              revision: 1,
              items: [item],
            });
            // Independent negative control: a released validator must reject the
            // actual rich summary, not merely accept a synthetic legacy fixture.
            expect(releasedTaskValidators.summary.Check(summary)).toBe(false);
          } else {
            expect(releasedTaskValidators.summary.Check(summary)).toBe(true);
            expect(summary).not.toHaveProperty("progress");
          }
          const listed = await rpcReq<TasksListResult>(peer.ws, "tasks.list", {});
          expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
          expect(listed.payload?.tasks.map((task) => task.id)).toEqual([visible.taskId]);
          const detail = await rpcReq<TasksGetResult>(peer.ws, "tasks.get", {
            taskId: visible.taskId,
          });
          const cancel = await rpcReq<TasksCancelResult>(peer.ws, "tasks.cancel", {
            taskId: visible.taskId,
          });
          expect(detail.ok, JSON.stringify(detail.error)).toBe(true);
          expect(cancel).toMatchObject({
            ok: true,
            payload: {
              found: true,
              cancelled: false,
              task: { id: visible.taskId, status: "running" },
            },
          });
          for (const task of [
            listed.payload?.tasks[0],
            detail.payload?.task,
            cancel.payload?.task,
          ]) {
            expect(task?.progressSummary).toBe("Retained legacy progress text");
            expect(task?.execution).toBeDefined();
            if (peer.modern) {
              expect(task?.progress).toEqual(summary.progress);
            } else {
              expect(task).not.toHaveProperty("progress");
            }
          }
          if (!peer.modern) {
            expect(releasedTaskValidators.list.Check(listed.payload)).toBe(true);
            expect(releasedTaskValidators.get.Check(detail.payload)).toBe(true);
            expect(releasedTaskValidators.cancel.Check(cancel.payload)).toBe(true);
          }
          const history = await rpcReq<TasksHistoryResult>(peer.ws, "tasks.history", {
            taskId: visible.taskId,
            limit: 1,
          });
          expect(history.ok, JSON.stringify(history.error)).toBe(true);
          expect(history.payload?.messages).toMatchObject([{ content: "Command completed" }]);
          expect(history.payload?.nextCursor).toEqual(expect.any(String));
          if (peer.modern) {
            expect(history.payload?.activity).toEqual([
              { messageId: expect.any(String), items: [] },
            ]);
            expect(releasedTaskValidators.history.Check(history.payload)).toBe(false);
          } else {
            expect(releasedTaskValidators.history.Check(history.payload)).toBe(true);
            expect(history.payload).not.toHaveProperty("activity");
          }
          const older = await rpcReq<TasksHistoryResult>(peer.ws, "tasks.history", {
            taskId: visible.taskId,
            cursor: history.payload?.nextCursor,
            limit: 1,
          });
          expect(older).toMatchObject({
            ok: true,
            payload: { messages: [{ content: "Earlier task output" }] },
          });
          for (const method of ["tasks.get", "tasks.history"]) {
            expect(await rpcReq(peer.ws, method, { taskId: hidden.taskId })).toMatchObject({
              ok: false,
              error: { code: "INVALID_REQUEST" },
            });
          }
          expect(await rpcReq(peer.ws, "tasks.cancel", { taskId: hidden.taskId })).toMatchObject({
            ok: true,
            payload: { found: false, cancelled: false },
          });
          for (const method of ["tasks.retry", "tasks.dismiss"]) {
            expect(await rpcReq(peer.ws, method, { taskIds: [hidden.taskId] })).toMatchObject({
              ok: true,
              payload: {
                results: [{ taskId: hidden.taskId, ok: false, reason: "task not found" }],
              },
            });
          }
          expect(
            events
              .get(peer.ws)
              ?.some(
                (frame) =>
                  frame.payload.action === "upserted" && frame.payload.task.id === hidden.taskId,
              ),
          ).toBe(false);
        }
        expect(getTaskById(hidden.taskId)?.status).toBe("running");
        expect(getTaskById(visible.taskId)?.status).toBe("running");

        for (const [index, peer] of peers.entries()) {
          for (const method of ["tasks.retry", "tasks.dismiss"] as const) {
            const now = Date.now();
            const runId = `${method}-${index}`;
            const task = createTaskFixture("subagent", {
              runId,
              childSessionKey: `agent:main:subagent:${runId}`,
              requesterSessionKey: ownedKey,
              requesterAgentId: "main",
              ownerKey: ownedKey,
              task: "Recover the retained completion",
              status: "succeeded",
              deliveryStatus: "failed",
              terminalOutcome: "blocked",
              progressSummary: "Retained completion result",
              notifyPolicy: "silent",
            });
            const subagent = createSubagentRunRecord({
              runId,
              childSessionKey: task.childSessionKey,
              requesterSessionKey: ownedKey,
              createdAt: task.createdAt,
              endedAt: now,
              outcome: { status: "ok" },
              expectsCompletionMessage: true,
              retainAttachmentsOnKeep: true,
              completion: {
                required: true,
                resultText: "Retained completion result",
                capturedAt: now,
              },
              delivery: {
                status: "suspended",
                disposition: "permanent_failure",
                generation: 1,
                suspendedAt: now,
                suspendedReason: "expiry",
                lastError: "requester unavailable",
              },
            });
            settleSubagentCompletionDelivery({ subagent, task });
            subagentRuns.set(runId, subagent);
            completionRuns.push(runId);
            const recovered = await rpcReq<TasksRecoveryResult>(peer.ws, method, {
              taskIds: [task.taskId, "missing-task"],
            });
            expect(recovered).toMatchObject({
              ok: true,
              payload: {
                results: [
                  {
                    taskId: task.taskId,
                    ok: true,
                    task: {
                      id: task.taskId,
                      status: "completed",
                      result: "Retained completion result",
                      deliveryStatus: method === "tasks.retry" ? "pending" : "dismissed",
                    },
                  },
                  { taskId: "missing-task", ok: false },
                ],
              },
            });
            expect(releasedTaskValidators.recovery.Check(recovered.payload)).toBe(true);
          }
        }
        for (const mode of ["legacy", "modern"] as const) {
          const readOnlyPeer = await connect(mode, true);
          for (const method of ["tasks.cancel", "tasks.retry", "tasks.dismiss"]) {
            const result = await rpcReq(
              readOnlyPeer.ws,
              method,
              method === "tasks.cancel"
                ? { taskId: visible.taskId }
                : { taskIds: [visible.taskId] },
            );
            expect(result).toMatchObject({
              ok: false,
              error: { message: expect.stringContaining("operator.write") },
            });
          }
        }
      } finally {
        for (const ws of sockets) {
          ws.close();
        }
      }
    });
  } finally {
    for (const runId of completionRuns) {
      subagentRuns.delete(runId);
    }
    resetTaskRegistryForTests({ persist: false });
    invalidateOperatorRolePolicy(owner.id);
    invalidateOperatorRolePolicy(reader.id);
  }
}, 60_000);
