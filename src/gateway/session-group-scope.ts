import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import {
  AgentSelectionRequiredError,
  listAgentIds,
  tryResolveSoleAgentId,
} from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";

/** A catalog request has no session key from which an old caller's agent can be recovered. */
export function resolveRequestedSessionGroupAgentId(
  cfg: OpenClawConfig,
  explicitAgentId?: string,
): ReturnType<typeof resolveRequestedSessionAgentId> {
  if (explicitAgentId !== undefined) {
    return resolveRequestedSessionAgentId(cfg, undefined, explicitAgentId);
  }
  const sole = tryResolveSoleAgentId(cfg);
  if (sole) {
    return resolveRequestedSessionAgentId(cfg, undefined, sole);
  }
  const error = new AgentSelectionRequiredError(listAgentIds(cfg), {
    surface: "session groups",
    hint: "Pass agentId; group catalogs belong to one agent.",
  });
  return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, error.message) };
}
