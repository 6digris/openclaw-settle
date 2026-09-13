// Diagnostics gateway methods expose bounded stability snapshots while keeping
// malformed queries out of logging internals.
import {
  ErrorCodes,
  errorShape,
  type DiagnosticsVitalsResult,
  validateDiagnosticsVitalsParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  getDiagnosticStabilitySnapshot,
  normalizeDiagnosticStabilityQuery,
} from "../../logging/diagnostic-stability.js";
import { getCommandLaneDiagnostics } from "../../process/command-lane-diagnostics.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/** Gateway handlers for bounded, process-local diagnostics. */
export const diagnosticsHandlers: GatewayRequestHandlers = {
  "diagnostics.vitals": ({ params, context, respond }) => {
    if (
      !assertValidParams(params, validateDiagnosticsVitalsParams, "diagnostics.vitals", respond)
    ) {
      return;
    }
    // Read the sampler without resetting its window or aggregating full status.
    const eventLoop = context.getEventLoopHealth?.();
    const memory = process.memoryUsage();
    const vitals: DiagnosticsVitalsResult = {
      ...(eventLoop ? { eventLoop } : {}),
      processMemory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
      },
    };
    respond(true, vitals, undefined);
  },
  "diagnostics.lanes": ({ respond }) => {
    respond(true, { ts: Date.now(), ...getCommandLaneDiagnostics() }, undefined);
  },
  "diagnostics.stability": async ({ params, respond }) => {
    try {
      // Normalization owns parameter bounds so malformed diagnostic requests
      // return a client error instead of leaking logging internals.
      const query = normalizeDiagnosticStabilityQuery(params);
      respond(true, getDiagnosticStabilitySnapshot(query), undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          err instanceof Error ? err.message : "invalid diagnostics.stability params",
        ),
      );
    }
  },
};
