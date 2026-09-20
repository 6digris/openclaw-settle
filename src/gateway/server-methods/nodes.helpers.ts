// Node method helpers centralize JSON parsing and node-invoke error mapping.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
} from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import type { NodeInvokeResult } from "../node-registry.js";
import { parseGatewayPayload } from "../server-json.js";
import { emitTalkPttNodeEvent } from "./nodes.invoke-talk-events.js";
import type { RespondFn, GatewayRequestContext } from "./types.js";
export { parseGatewayPayload } from "../server-json.js";

/** Narrows successful node invoke results or responds with the node error details. */
export function respondUnavailableOnNodeInvokeError<T extends { ok: boolean; error?: unknown }>(
  respond: RespondFn,
  res: T,
): res is T & { ok: true } {
  return respondUnavailableOnNodeInvokeErrorWithProvenance(respond, res);
}

export function respondUnavailableOnNodeInvokeErrorWithProvenance<
  T extends { ok: boolean; error?: unknown },
>(
  respond: RespondFn,
  res: T,
  provenance?: { nodeCommandDispatched: boolean },
): res is T & { ok: true } {
  if (res.ok) {
    return true;
  }
  const nodeError =
    res.error && typeof res.error === "object"
      ? (res.error as { code?: unknown; message?: unknown })
      : null;
  const nodeCode = normalizeOptionalString(nodeError?.code) ?? "";
  const nodeMessage = normalizeOptionalString(nodeError?.message) ?? "node invoke failed";
  const message = nodeCode ? `${nodeCode}: ${nodeMessage}` : nodeMessage;
  const details = {
    nodeError: res.error ?? null,
    ...(provenance ? { nodeCommandDispatched: provenance.nodeCommandDispatched } : {}),
  };
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, message, {
      details,
    }),
  );
  return false;
}

export function respondNodeInvokeSuccess(params: {
  context: GatewayRequestContext;
  nodeId: string;
  command: string;
  res: NodeInvokeResult;
  respond: RespondFn;
}): void {
  const { context, nodeId, command, res, respond } = params;
  const payload = res.payloadJSON ? parseGatewayPayload(res.payloadJSON) : res.payload;
  emitTalkPttNodeEvent({
    context,
    nodeId,
    command,
    payload,
  });
  respond(
    true,
    {
      ok: true,
      nodeId,
      command,
      payload,
      payloadJSON: res.payloadJSON ?? null,
    },
    undefined,
  );
}
