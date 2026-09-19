import { expect, it } from "vitest";
import { sessionChanges, type SessionRowChange } from "./session-row-changes.js";

it("publishes distinct canonical identities for agent-owned aliases", () => {
  const changes: SessionRowChange[] = [];
  const unsubscribe = sessionChanges.subscribe((change) => changes.push(change));
  try {
    for (const agentId of ["research", "ops"]) {
      for (const sessionKey of ["global", "unknown", `agent:${agentId}:work`]) {
        sessionChanges.emit({ agentId, sessionKey });
      }
    }
    expect(changes).toEqual([
      { agentId: "research", sessionKey: "agent:research:global" },
      { agentId: "research", sessionKey: "agent:research:unknown" },
      { agentId: "research", sessionKey: "agent:research:work" },
      { agentId: "ops", sessionKey: "agent:ops:global" },
      { agentId: "ops", sessionKey: "agent:ops:unknown" },
      { agentId: "ops", sessionKey: "agent:ops:work" },
    ]);
    sessionChanges.emit({ all: true, scope: "stores" });
    expect(changes.at(-1)).toEqual({ all: true, scope: "stores" });
  } finally {
    unsubscribe();
  }
});
