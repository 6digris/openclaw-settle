import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsTool } from "./sessions-tool.js";

const config: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "alpha" } },
    entries: { alpha: {}, beta: {} },
  },
};

describe("session tool group owner", () => {
  it.each([
    { action: "group_list", method: "sessions.groups.list", params: {} },
    { action: "group_set", method: "sessions.groups.put", params: { names: ["Shared"] } },
    {
      action: "group_rename",
      method: "sessions.groups.rename",
      params: { name: "Shared", to: "Beta" },
    },
    { action: "group_delete", method: "sessions.groups.delete", params: { name: "Shared" } },
  ])(
    "binds $action to the requester, not the default agent or a model-supplied target",
    async ({ action, method, params }) => {
      const callGateway: AgentToolGatewayRequestCaller = vi.fn(async () => {
        throw new Error("request captured");
      });
      const tool = createSessionsTool({
        agentSessionKey: "agent:beta:task",
        config,
        callGateway,
        hasInProcessGatewayContext: () => true,
      });
      await expect(
        tool.execute("group-scope", {
          action,
          ...params,
          agentId: "alpha",
          sessionKey: "agent:alpha:task",
        }),
      ).rejects.toThrow("request captured");
      expect(callGateway).toHaveBeenCalledExactlyOnceWith({
        method,
        params: { ...params, agentId: "beta" },
        agentToolCaller: { agentId: "beta", sessionKey: "agent:beta:task" },
      });
    },
  );

  it("retains an explicit requester owner for an unqualified session key", async () => {
    const callGateway: AgentToolGatewayRequestCaller = vi.fn(async () => {
      throw new Error("request captured");
    });
    const tool = createSessionsTool({
      agentSessionKey: "task",
      requesterAgentIdOverride: "beta",
      config,
      callGateway,
      hasInProcessGatewayContext: () => true,
    });
    await expect(tool.execute("group-list", { action: "group_list" })).rejects.toThrow(
      "request captured",
    );
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { agentId: "beta" },
        agentToolCaller: expect.objectContaining({ agentId: "beta" }),
      }),
    );
  });
});
