import { once } from "node:events";
import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import {
  clearSubagentRunsReadCacheForTest,
  persistSubagentRunsToDiskOrThrow,
} from "../../agents/subagents/registry/subagent-registry-state.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { createTestPluginApi } from "../../plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createSubagentTaskBackingDetail } from "../../tasks/task-backing-records.js";
import { mapTaskRunView } from "../../tasks/task-domain-views.js";
import { listTasksForRelatedSessionKeyForOwner } from "../../tasks/task-owner-access.js";
import { getTaskProgressSnapshot } from "../../tasks/task-registry-activity.js";
import {
  createTaskFixture,
  withTaskRegistryTempDir,
} from "../../tasks/task-registry.test-support.js";
import { mapTaskSummary } from "../../tasks/task-summary.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import type { OpenClawPluginApi, OpenClawPluginService } from "../types.js";
import { observeRuntimeTaskProgress } from "./runtime-task-progress.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
  clearSubagentRunsReadCacheForTest();
});

describe("registered ClickClack task observation", () => {
  it("replays an unchanged task snapshot after unrelated real registry persistence fences queued native items", async () => {
    await withTaskRegistryTempDir(async (root) => {
      const ownerKey = "agent:main:clickclack:channel:room";
      const runId = "clickclack-acknowledgement-child";
      const unrelatedRunId = "clickclack-unrelated-persistence";
      const origin = { channel: "clickclack", accountId: "default", to: "channel:room" };
      const task = createTaskFixture("subagent", {
        ownerKey,
        requesterSessionKey: ownerKey,
        requesterAgentId: "main",
        requesterOrigin: origin,
        childSessionKey: `agent:main:subagent:${runId}`,
        runId,
        task: "Inspect progress publication",
        notifyPolicy: "state_changes",
        detail: createSubagentTaskBackingDetail(1),
      });
      subagentRuns.set(
        runId,
        createSubagentRunRecord({
          runId,
          taskRunId: runId,
          generation: 1,
          startedAt: Date.now(),
          childSessionKey: task.childSessionKey!,
          requesterSessionKey: ownerKey,
          requesterAgentId: "main",
          completionRequesterSessionId: "requester-session",
          requesterOrigin: origin,
          progressOrigin: { ...origin, messageId: "msg_original" },
        }),
      );
      const claim = expectDefined(
        claimAgentRunContext(
          runId,
          { sessionKey: task.childSessionKey },
          { trackOwner: true, ownsContext: true },
        ),
        "live child execution claim",
      );
      onTestFinished(() => releaseAgentRunContext(runId, claim));
      vi.spyOn(sessionAccessor, "loadSessionEntryReadOnly").mockReturnValue({
        sessionId: "requester-session",
        updatedAt: 1,
      });
      emitAgentEvent({
        runId,
        stream: "item",
        data: { itemId: "work", phase: "start", kind: "tool", title: "Inspecting" },
      });
      const progressRevision = getTaskProgressSnapshot(task.taskId)?.revision;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const lines = new Map<string, string>();
      const frames: Array<{ seq: number; op: string; line?: { id: string; text: string } }> = [];
      let holdFirstNativeWrite = true;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname === "/api/realtime/ephemeral") {
          if (typeof init?.body !== "string") {
            throw new Error("Expected the native JSON request body");
          }
          const frame = JSON.parse(init.body).payload as (typeof frames)[number];
          if (holdFirstNativeWrite) {
            holdFirstNativeWrite = false;
            entered.resolve();
            await release.promise;
          }
          frames.push(frame);
          if (frame.op === "clear") {
            lines.clear();
          } else if (frame.line) {
            if (frame.op === "append" || frame.op === "finalize" || lines.has(frame.line.id)) {
              if (frame.line.text) {
                lines.set(frame.line.id, frame.line.text);
              } else {
                lines.delete(frame.line.id);
              }
            }
          }
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/api/me") {
          return Response.json({ user: { id: "bot", handle: "bot" } });
        }
        if (url.pathname === "/api/realtime/events") {
          return Response.json({ events: [], tail_cursor: "startup" });
        }
        if (url.pathname === "/api/messages/msg_original") {
          return Response.json({
            message: {
              id: "msg_original",
              workspace_id: "wsp_test",
              channel_id: "room",
              author_id: "human",
              thread_root_id: "msg_original",
              body: "Inspect",
              body_format: "markdown",
              created_at: "2026-09-20T10:00:00.000Z",
            },
          });
        }
        throw new Error(`Unexpected ClickClack request: ${url.pathname}`);
      });
      const server = createServer();
      const sockets = new WebSocketServer({ server });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      onTestFinished(async () => {
        for (const socket of sockets.clients) {
          socket.terminate();
        }
        const socketsClosed = once(sockets, "close");
        const serverClosed = once(server, "close");
        sockets.close();
        server.close();
        await Promise.all([socketsClosed, serverClosed]);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an ephemeral loopback server address");
      }
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main" }] },
        channels: {
          clickclack: {
            baseUrl: `http://127.0.0.1:${address.port}`,
            token: "synthetic-token",
            workspace: "wsp_test",
            nativeProgress: true,
            commandMenu: false,
          },
        },
      };
      const runtime = createPluginRuntimeMock();
      vi.spyOn(runtime.agent.session, "listSessionEntries").mockReturnValue([
        { sessionKey: ownerKey, entry: { sessionId: "requester-session", updatedAt: 1 } },
      ]);
      const list = async () =>
        listTasksForRelatedSessionKeyForOwner({
          relatedSessionKey: ownerKey,
          callerOwnerKey: ownerKey,
          callerAgentId: "main",
        });
      const bound = runtime.tasks.async.runs.bindSession({ sessionKey: ownerKey, agentId: "main" });
      bound.list = async () => (await list()).map(mapTaskRunView);
      bound.observeProgress = (options) =>
        observeRuntimeTaskProgress({
          binding: { sessionKey: ownerKey, agentId: "main" },
          list,
          ...options,
        });
      vi.spyOn(runtime.tasks.async.runs, "bindSession").mockReturnValue(bound);
      const { clickClackPlugin, setClickClackRuntime } = await loadBundledPluginFacade<{
        clickClackPlugin: ChannelPlugin<unknown>;
        setClickClackRuntime: (runtime: OpenClawPluginApi["runtime"]) => void;
      }>({ pluginId: "clickclack", artifactBasename: "api.js" });
      const { registerClickClackTaskProgressRecovery } = await loadBundledPluginFacade<{
        registerClickClackTaskProgressRecovery: (api: OpenClawPluginApi) => void;
      }>({ pluginId: "clickclack", artifactBasename: "runtime-api.js" });
      setClickClackRuntime(runtime);
      const services: OpenClawPluginService[] = [];
      const api = createTestPluginApi({
        id: "clickclack",
        name: "ClickClack",
        runtime,
        config: cfg,
        registerService(value) {
          services.push(value);
        },
      });
      registerClickClackTaskProgressRecovery(api);
      const service = services.find((value) => value.id === "clickclack-task-progress-recovery");
      if (!service || !clickClackPlugin.gateway?.startAccount) {
        throw new Error("Expected the registered ClickClack recovery and Gateway owners");
      }
      const context = { config: cfg, stateDir: root, logger: api.logger };
      await service.start(context);
      const abort = new AbortController();
      const gatewayContext: ChannelGatewayContext = {
        cfg,
        accountId: "default",
        account: clickClackPlugin.config.resolveAccount(cfg, "default"),
        runtime: defaultRuntime,
        abortSignal: abort.signal,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        getStatus: () => ({ accountId: "default" }),
        setStatus: vi.fn(),
      };
      expect(mapTaskSummary(task).execution?.state).toBe("running");
      const running = Promise.resolve(clickClackPlugin.gateway.startAccount(gatewayContext));
      try {
        await Promise.race([
          entered.promise,
          running.then(() => {
            throw new Error("Gateway stopped before the held native publication");
          }),
        ]);
        // The held first POST lets the native owner queue the task items before
        // a real unrelated persistence publication invalidates their assertion.
        await Promise.resolve();
        persistSubagentRunsToDiskOrThrow(
          new Map([
            [
              unrelatedRunId,
              createSubagentRunRecord({
                runId: unrelatedRunId,
                childSessionKey: "agent:other:subagent:unrelated",
                requesterSessionKey: "agent:other:main",
                requesterAgentId: "other",
                completion: { required: false },
                delivery: { status: "not_required" },
              }),
            ],
          ]),
          [unrelatedRunId],
        );
        expect(getTaskProgressSnapshot(task.taskId)?.revision).toBe(progressRevision);
        release.resolve();
        await vi.waitFor(() => expect([...lines.values()]).toContain("Inspecting"));
        const itemFrame = frames.find((frame) => frame.line?.text === "Inspecting");
        expect(itemFrame?.op).toBe("append");
        expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_frame, index) => index + 1));
      } finally {
        release.resolve();
        abort.abort();
        await running;
        await service.stop?.(context);
        subagentRuns.delete(runId);
        persistSubagentRunsToDiskOrThrow(new Map(), [unrelatedRunId]);
      }
    });
  });
});
