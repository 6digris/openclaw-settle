import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { GatewayEventLoopHealthSchema } from "./event-loop-health.js";

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
