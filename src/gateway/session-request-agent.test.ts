import { describe, expect, it } from "vitest";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSessionEventAgentScope,
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "./session-request-agent.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

function fixedStoreConfig(owner: string): OpenClawConfig {
  return {
    session: { store: "/tmp/shared.sqlite" },
    agents: {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: owner } },
      entries: { ops: {}, research: {} },
    },
  };
}

describe("requested session agent ownership", () => {
  it.each(["!!!", " "])(
    "rejects an invalid explicit owner instead of selecting main: %s",
    (agentId) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: { default: true } } } };
      expect(() =>
        resolveSessionAgentId({ config: cfg, sessionKey: "agent:main:notes", agentId }),
      ).toThrow();
      expect(resolveRequestedSessionAgentId(cfg, "agent:main:notes", agentId).ok).toBe(false);
      expect(() =>
        resolveSessionStoreIdentity({ cfg, sessionKey: "agent:main:notes", agentId }),
      ).toThrow();
    },
  );
  it.each(["agent:---:notes", "agent::notes", "agent:ops", "agent:ops:"])(
    "does not treat malformed qualified identity as an absent owner: %s",
    (sessionKey) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: { default: true }, ops: {} } } };
      for (const agentId of [undefined, "main"]) {
        expect(resolveRequestedSessionAgentId(cfg, sessionKey, agentId).ok).toBe(false);
        expect(resolveSessionEventAgentScope(cfg, sessionKey, agentId)).toBeNull();
        expect(() => resolveSessionAgentId({ config: cfg, sessionKey, agentId })).toThrow();
        expect(() => resolveSessionStoreIdentity({ cfg, sessionKey, agentId })).toThrow();
      }
    },
  );

  it("keeps a normalized qualified key and its owner together", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { "bad-agent": {} } },
      session: { mainKey: "home", scope: "global" },
    };
    const sessionKey = "AGENT: Bad Agent :main";
    expect(resolveSessionStoreIdentity({ cfg, sessionKey })).toEqual({
      agentId: "bad-agent",
      canonicalKey: "agent:bad-agent:main",
    });
    expect(resolveSessionEventAgentScope(cfg, sessionKey)).toEqual({
      agentId: "bad-agent",
      sessionKey: "agent:bad-agent:main",
    });
  });
  it("admits aliases as distinct fully qualified conversations for each selected agent", () => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };
    for (const agentId of ["ops", "research"]) {
      for (const alias of ["global", "unknown"]) {
        expect(resolveSessionStoreIdentity({ cfg, sessionKey: alias, agentId })).toEqual({
          agentId,
          canonicalKey: `agent:${agentId}:${alias}`,
        });
      }
    }
  });

  it.each(["global", "unknown"])(
    "retains the qualified %s owner when the main key matches",
    (mainKey) => {
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { ops: {} } },
        session: { scope: "global", mainKey },
      };
      expect(resolveSessionStoreIdentity({ cfg, sessionKey: `agent:main:${mainKey}` })).toEqual({
        agentId: "main",
        canonicalKey: `agent:main:${mainKey}`,
      });
    },
  );

  it("uses the configured persisted owner for a bare key", () => {
    expect(tryResolveSessionCompatibilityOwnerAgentId(fixedStoreConfig("ops"), "global")).toBe(
      "ops",
    );
    expect(resolveRequestedSessionAgentId(fixedStoreConfig("ops"), "global")).toEqual({
      ok: true,
      agentId: "ops",
    });
  });

  it("rejects conflicting and retired persisted owners", () => {
    expect(resolveRequestedSessionAgentId(fixedStoreConfig("ops"), "global", "research").ok).toBe(
      false,
    );
    expect(resolveRequestedSessionAgentId(fixedStoreConfig("retired"), "global").ok).toBe(false);
  });

  it.each(["main", "primary"])(
    "keeps explicit %s aliases qualified without redirecting them to a fixed-store owner",
    (alias) => {
      const key = `agent:research:${alias}`;
      const cfg = fixedStoreConfig("ops");
      cfg.session = { ...cfg.session, scope: "global", mainKey: "primary" };
      for (const owner of ["ops", "retired"]) {
        cfg.agents!.defaults!.sessionStore!.agentId = owner;
        expect.soft(resolveRequestedSessionAgentId(cfg, key, "research")).toMatchObject({
          ok: true,
          agentId: "research",
        });
      }
      expect(resolveRequestedSessionAgentId(cfg, key)).toEqual({ ok: true, agentId: "research" });
      cfg.agents!.defaults!.sessionStore!.agentId = "research";
      expect(resolveRequestedSessionAgentId(cfg, key, "research")).toEqual({
        ok: true,
        agentId: "research",
      });
      cfg.session.store = "/synthetic/{agentId}/sessions.sqlite";
      cfg.agents!.defaults!.sessionStore!.agentId = "ops";
      expect(resolveRequestedSessionAgentId(cfg, key, "research")).toEqual({
        ok: true,
        agentId: "research",
      });
    },
  );

  it("uses a legacy compatibility owner for a bare key", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { ops: { default: true }, research: {} } },
    };

    expect(resolveRequestedSessionAgentId(cfg, "global")).toEqual({
      ok: true,
      agentId: "ops",
    });
  });

  it.each([undefined, "ops"])(
    "rejects an ownerless bare key with provenance %s",
    (retainedOwner) => {
      const cfg = retainLegacyDefaultAgentId(
        {
          agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
        },
        retainedOwner,
      );

      expect(tryResolveSessionCompatibilityOwnerAgentId(cfg, "global")).toBeUndefined();
      expect(resolveRequestedSessionAgentId(cfg, "global")).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: expect.stringContaining("has no explicit owner"),
        },
      });
    },
  );

  it("returns typed ownership results for arbitrary bare keys before canonicalization", () => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };

    expect(resolveRequestedSessionAgentId(cfg, "thread-1")).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("has no explicit owner") },
    });
    expect(resolveRequestedSessionAgentId(cfg, "thread-1", "research")).toEqual({
      ok: true,
      agentId: "research",
    });
  });

  it.each(["", "   ", "агент✨", "---"])(
    "rejects explicit unrepresentable agent id %j instead of selecting main",
    (agentId) => {
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      };

      expect(resolveRequestedSessionAgentId(cfg, "global", agentId)).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: `Unknown agent id "${agentId}"`,
        },
      });
    },
  );

  it("keeps retired agent-qualified history readable independently of current scope", () => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };

    expect(resolveRequestedSessionAgentId(cfg, "agent:retired:main")).toEqual({
      ok: true,
      agentId: "retired",
    });
    expect(
      resolveRequestedSessionAgentId(
        { ...cfg, session: { scope: "global" } },
        "agent:retired:main",
      ),
    ).toEqual({ ok: true, agentId: "retired" });
  });
});

describe("session event agent scope", () => {
  it("qualifies retained aliases using configured, retired, legacy, and explicit owners", () => {
    for (const owner of ["ops", "retired"]) {
      expect(resolveSessionEventAgentScope(fixedStoreConfig(owner), "global")).toEqual({
        agentId: owner,
        sessionKey: `agent:${owner}:global`,
      });
    }
    expect(
      resolveSessionEventAgentScope({ agents: { entries: { main: { default: true } } } }, "global"),
    ).toEqual({ agentId: "main", sessionKey: "agent:main:global" });
    expect(resolveSessionEventAgentScope(fixedStoreConfig("ops"), "global", "research")).toEqual({
      agentId: "research",
      sessionKey: "agent:research:global",
    });
  });

  it("rejects conflicting qualified event identity without consulting fallbacks", () => {
    expect(
      resolveSessionEventAgentScope(fixedStoreConfig("ops"), "agent:research:main", "ops"),
    ).toBeNull();
    for (const agentId of ["research", "retired"]) {
      const sessionKey = `agent:${agentId}:main`;
      const cfg = fixedStoreConfig("ops");
      expect(resolveSessionEventAgentScope(cfg, sessionKey)).toEqual({
        agentId,
        sessionKey,
      });
      expect(
        resolveSessionEventAgentScope(
          { ...cfg, session: { ...cfg.session, scope: "global" } },
          sessionKey,
        ),
      ).toEqual({
        agentId,
        sessionKey,
      });
    }
  });
});
