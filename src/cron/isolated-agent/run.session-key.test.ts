// Session key tests cover deterministic keys for isolated cron run sessions.
import { describe, expect, it } from "vitest";
import { resolveCronAgentSessionKey } from "./session-key.js";

describe("resolveCronAgentSessionKey", () => {
  it("builds an agent-scoped key for legacy aliases", () => {
    expect(resolveCronAgentSessionKey({ sessionKey: "main", agentId: "main" })).toBe(
      "agent:main:main",
    );
  });

  it("preserves canonical agent keys instead of prefixing twice", () => {
    expect(resolveCronAgentSessionKey({ sessionKey: "agent:main:main", agentId: "main" })).toBe(
      "agent:main:main",
    );
  });

  it("normalizes canonical keys to lowercase before reuse", () => {
    expect(
      resolveCronAgentSessionKey({ sessionKey: "AGENT:Main:Hook:Webhook:42", agentId: "x" }),
    ).toBe("agent:main:hook:webhook:42");
  });

  it("keeps hook keys scoped under the target agent", () => {
    expect(resolveCronAgentSessionKey({ sessionKey: "hook:webhook:42", agentId: "main" })).toBe(
      "agent:main:hook:webhook:42",
    );
  });

  it("canonicalizes main alias when cfg.session.mainKey differs from default (#29683)", () => {
    const cfg = { session: { mainKey: "work" } };
    expect(
      resolveCronAgentSessionKey({ sessionKey: "main", agentId: "ops", mainKey: "work", cfg }),
    ).toBe("agent:ops:work");
  });

  it("keeps qualified main identity when the configured mainKey changes", () => {
    const cfg = { session: { mainKey: "work" } };
    expect(
      resolveCronAgentSessionKey({
        sessionKey: "agent:ops:main",
        agentId: "ops",
        mainKey: "work",
        cfg,
      }),
    ).toBe("agent:ops:main");
  });

  it("resolves bare main in global scope without moving an existing qualified session", () => {
    const cfg = { session: { scope: "global" as const, mainKey: "work" } };
    expect(resolveCronAgentSessionKey({ sessionKey: "main", agentId: "ops", cfg })).toBe(
      "agent:ops:global",
    );
    expect(resolveCronAgentSessionKey({ sessionKey: "agent:ops:main", agentId: "ops", cfg })).toBe(
      "agent:ops:main",
    );
  });

  it("does not change non-alias keys when cfg is provided", () => {
    const cfg = { session: { mainKey: "work" } };
    expect(
      resolveCronAgentSessionKey({
        sessionKey: "hook:webhook:42",
        agentId: "ops",
        mainKey: "work",
        cfg,
      }),
    ).toBe("agent:ops:hook:webhook:42");
  });
});
