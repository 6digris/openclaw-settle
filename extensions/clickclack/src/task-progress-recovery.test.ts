import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";
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
  it("shares one catch-up across accounts and retains later admitted scopes for account restarts", async () => {
    const f = createFixture();
    const roster = vi
      .spyOn(f.runtime.agent.session, "listSessionEntries")
      .mockReturnValue([
        { sessionKey: "global", entry: { sessionId: "global-session", updatedAt: 1 } },
      ]);
    const bound = f.runtime.tasks.async.runs.bindSession({ sessionKey: "global", agentId: "main" });
    vi.spyOn(bound, "list").mockResolvedValue([
      {
        id: "task-1",
        runtime: "subagent",
        sessionKey: "global",
        ownerKey: "global",
        scope: "session",
        status: "running",
        deliveryStatus: "pending",
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
        readClickClackTaskRecoverySessions(signal),
        readClickClackTaskRecoverySessions(signal),
      ]);
      expect(first).toEqual([{ sessionKey: "global", agentId: "main" }]);
      expect(second).toEqual(first);
      rememberClickClackTaskRecoverySession({
        sessionKey: "agent:main:new-owner",
        agentId: "main",
      });
      expect(await readClickClackTaskRecoverySessions(signal)).toEqual([
        { sessionKey: "global", agentId: "main" },
        { sessionKey: "agent:main:new-owner", agentId: "main" },
      ]);
      expect(roster).toHaveBeenCalledOnce();
    } finally {
      await f.service.stop?.(f.context);
      vi.restoreAllMocks();
    }
    expect(await readClickClackTaskRecoverySessions(new AbortController().signal)).toEqual([]);
  });

  it("does not hold account shutdown while the plugin service has not started", async () => {
    const f = createFixture();
    const abort = new AbortController();
    const waiting = readClickClackTaskRecoverySessions(abort.signal);
    const rejected = expect(waiting).rejects.toThrow("Account stopped");
    try {
      abort.abort(new Error("Account stopped"));
      await rejected;
    } finally {
      await f.service.stop?.(f.context);
    }
  });
});
