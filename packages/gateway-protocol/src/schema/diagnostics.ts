import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";

/** Latest completed Gateway event-loop observation window. */
export const GatewayEventLoopHealthSchema = closedObject({
  degraded: Type.Boolean(),
  degradedSinceMs: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  reasons: Type.Array(
    Type.Union([
      Type.Literal("event_loop_delay"),
      Type.Literal("event_loop_utilization"),
      Type.Literal("cpu"),
    ]),
  ),
  intervalMs: Type.Number({ minimum: 0 }),
  delayP99Ms: Type.Number({ minimum: 0 }),
  delayMaxMs: Type.Number({ minimum: 0 }),
  utilization: Type.Number({ minimum: 0 }),
  cpuCoreRatio: Type.Number({ minimum: 0 }),
});

/** Vitals sampling does not accept status-summary or history options. */
export const DiagnosticsVitalsParamsSchema = closedObject({});

/** Process-local measurements only; no session, task, or model inventory. */
export const DiagnosticsVitalsResultSchema = closedObject({
  eventLoop: Type.Optional(GatewayEventLoopHealthSchema),
  processMemory: closedObject({
    rssBytes: Type.Integer({ minimum: 0 }),
    heapUsedBytes: Type.Integer({ minimum: 0 }),
    heapTotalBytes: Type.Integer({ minimum: 0 }),
  }),
});

export type DiagnosticsVitalsParams = Static<typeof DiagnosticsVitalsParamsSchema>;
export type DiagnosticsVitalsResult = Static<typeof DiagnosticsVitalsResultSchema>;
