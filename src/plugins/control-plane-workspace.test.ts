import { describe, expect, it } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginControlPlaneWorkspace } from "./control-plane-workspace.js";

describe("resolvePluginControlPlaneWorkspace", () => {
  it.each([undefined, "alpha", "beta"])(
    "omits workspace scope for an ownerless explicit fleet with retained agent %s",
    (retainedAgentId) => {
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { alpha: {}, beta: {} },
        },
      };
      retainLegacyDefaultAgentId(config, retainedAgentId);
      expect(
        resolvePluginControlPlaneWorkspace({
          config,
          env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-control-plane" },
        }),
      ).toMatchObject({
        workspaceScope: "omitted",
        diagnostic: { code: "workspace-scope-omitted" },
      });
    },
  );

  it("uses the configured system agent for control-plane workspace enrichment", () => {
    expect(
      resolvePluginControlPlaneWorkspace({
        config: {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "beta" } },
            entries: {
              alpha: { workspace: "/tmp/alpha" },
              beta: { workspace: "/tmp/beta" },
            },
          },
        },
        env: {},
      }),
    ).toEqual({
      agentId: "beta",
      workspaceDir: "/tmp/beta",
      workspaceScope: "selected",
    });
  });
});
