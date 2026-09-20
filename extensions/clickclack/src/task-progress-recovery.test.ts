import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import {
  readClickClackTaskRecoverySessions,
  rememberClickClackTaskRecoverySession,
} from "./runtime.js";
import { registerClickClackTaskProgressRecovery } from "./task-progress-recovery.js";

function createFixture() {
  const runtime = createPluginRuntimeMock();
  const services: OpenClawPluginService[] = [];
  const api = createTestPluginApi({
    runtime,
    config: {
      channels: {
        clickclack: {
          baseUrl: "https://clickclack.example.test",
          token: "synthetic-token",
          workspace: "wsp_1",
          nativeProgress: true,
        },
      },
    },
    registerService: (service) => {
      services.push(service);
    },
  });
  const context: OpenClawPluginServiceContext = {
    config: api.config,
    stateDir: "/unused-task-progress-recovery-state",
    logger: api.logger,
  };
  registerClickClackTaskProgressRecovery(api);
  const service = services[0];
  if (!service) {
    throw new Error("Task recovery service was not registered");
  }
  return { runtime, service, context };
}

describe("ClickClack activation task recovery", () => {
  it.each([
    { status: "running", deliveryStatus: "pending" },
    { status: "succeeded", deliveryStatus: "pending" },
    { status: "succeeded", deliveryStatus: "session_queued" },
  ] as const)(
    "recovers $status/$deliveryStatus work without repeating discovery on account restart",
    async ({ status, deliveryStatus }) => {
      const f = createFixture();
      const roster = vi
        .spyOn(f.runtime.agent.session, "listSessionEntries")
        .mockReturnValue([
          { sessionKey: "global", entry: { sessionId: "global-session", updatedAt: 1 } },
        ]);
      const bound = f.runtime.tasks.async.runs.bindSession({
        sessionKey: "global",
        agentId: "main",
      });
      vi.spyOn(bound, "list").mockResolvedValue([
        {
          id: "task-1",
          runtime: "subagent",
          sessionKey: "global",
          ownerKey: "global",
          scope: "session",
          status,
          deliveryStatus,
          notifyPolicy: "state_changes",
          createdAt: 1,
          title: "Shared-session work",
        },
      ]);
      vi.spyOn(f.runtime.tasks.async.runs, "bindSession").mockReturnValue(bound);
      try {
        await f.service.start(f.context);
        const signal = new AbortController().signal;
        const [first, second] = await Promise.all([
          readClickClackTaskRecoverySessions(signal, "default"),
          readClickClackTaskRecoverySessions(signal, "default"),
        ]);
        expect(first).toEqual([{ sessionKey: "global", agentId: "main", accountId: "default" }]);
        expect(second).toEqual(first);
        rememberClickClackTaskRecoverySession({
          sessionKey: "agent:main:new-owner",
          agentId: "main",
          accountId: "default",
        });
        expect(await readClickClackTaskRecoverySessions(signal, "default")).toEqual([
          { sessionKey: "global", agentId: "main", accountId: "default" },
          { sessionKey: "agent:main:new-owner", agentId: "main", accountId: "default" },
        ]);
        expect(roster).toHaveBeenCalledOnce();
      } finally {
        await f.service.stop?.(f.context);
        vi.restoreAllMocks();
      }
      expect(
        await readClickClackTaskRecoverySessions(new AbortController().signal, "default"),
      ).toEqual([]);
    },
  );

  it("does not resurrect an idle scope when the activation catch-up finishes late", async () => {
    const f = createFixture();
    const listed = createDeferred<void>();
    const release = createDeferred<void>();
    vi.spyOn(f.runtime.agent.session, "listSessionEntries").mockReturnValue([
      { sessionKey: "global", entry: { sessionId: "global-session", updatedAt: 1 } },
    ]);
    const bound = f.runtime.tasks.async.runs.bindSession({ sessionKey: "global", agentId: "main" });
    vi.spyOn(bound, "list").mockImplementation(async () => {
      listed.resolve();
      await release.promise;
      return [
        {
          id: "task-1",
          runtime: "subagent",
          sessionKey: "global",
          ownerKey: "global",
          scope: "session",
          status: "running",
          deliveryStatus: "pending",
          notifyPolicy: "done_only",
          createdAt: 1,
          title: "Earlier snapshot",
        },
      ];
    });
    vi.spyOn(f.runtime.tasks.async.runs, "bindSession").mockReturnValue(bound);
    const starting = f.service.start(f.context);
    try {
      await listed.promise;
      const forget = rememberClickClackTaskRecoverySession({
        sessionKey: "global",
        agentId: "main",
        accountId: "default",
      });
      forget();
      release.resolve();
      await starting;
      expect(
        await readClickClackTaskRecoverySessions(new AbortController().signal, "default"),
      ).toEqual([]);
    } finally {
      release.resolve();
      await starting;
      await f.service.stop?.(f.context);
      vi.restoreAllMocks();
    }
  });

  it("does not hold account shutdown while the plugin service has not started", async () => {
    const f = createFixture();
    const abort = new AbortController();
    const waiting = readClickClackTaskRecoverySessions(abort.signal, "default");
    const rejected = expect(waiting).rejects.toThrow("Account stopped");
    try {
      abort.abort(new Error("Account stopped"));
      await rejected;
    } finally {
      await f.service.stop?.(f.context);
    }
  });
});
