import { Type } from "typebox";
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
