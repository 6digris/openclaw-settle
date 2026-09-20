import { createHash } from "node:crypto";
import { Type } from "typebox";
import {
  SessionsMentionableParamsSchema,
  SessionsMentionParamsSchema,
} from "../../../packages/gateway-protocol/src/index.js";
import { jsonResult, readToolStringParam, ToolAuthorizationError } from "./common.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";

export const sessionsMentionToolProperties = {
  query: Type.Optional({
    ...SessionsMentionableParamsSchema.properties.query,
    description: "mentionable: bounded eligible-person search in the current session.",
  }),
  recipientProfileIds: Type.Optional({
    ...SessionsMentionParamsSchema.properties.recipientProfileIds,
    description: "mention: verified profile IDs returned by mentionable; never guess handles.",
  }),
  message: Type.Optional({
    ...SessionsMentionParamsSchema.properties.message,
    description:
      "mention: assistant note to persist in the current session and request these people’s attention. Does not start another run or grant access.",
  }),
};

export async function runSessionsMentionTool(
  action: "mentionable" | "mention",
  params: Record<string, unknown>,
  toolCallId: string,
  gatewayRequest: AgentToolGatewayRequestCaller,
) {
  const caller = getGatewayToolCallerIdentity();
  const assertCurrent = captureGatewayToolCallerAssertion();
  if (!caller || !assertCurrent) {
    throw new ToolAuthorizationError("Mentions require an active Gateway-hosted agent run.");
  }
  const requested = readToolStringParam(params, "sessionKey");
  if (requested && requested !== "current" && requested !== caller.sessionKey) {
    throw new ToolAuthorizationError("Mentions can only originate in the current session.");
  }
  assertCurrent();
  const target = { sessionKey: caller.sessionKey, agentId: caller.agentId };
  return jsonResult(
    await gatewayRequest({
      method: action === "mentionable" ? "sessions.mentionable" : "sessions.mention",
      params:
        action === "mentionable"
          ? { ...target, ...(params.query !== undefined ? { query: params.query } : {}) }
          : {
              ...target,
              message: readToolStringParam(params, "message", { required: true }),
              recipientProfileIds: params.recipientProfileIds,
              idempotencyKey: createHash("sha256")
                .update(JSON.stringify([caller.operationalRunInstance?.runId, toolCallId]))
                .digest("hex"),
            },
      agentToolCaller: {
        agentId: caller.agentId,
        sessionKey: caller.sessionKey,
        assertCurrent,
      },
    }),
  );
}
