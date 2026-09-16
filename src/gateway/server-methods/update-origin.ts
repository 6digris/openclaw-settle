import { formatDoctorNonInteractiveHint } from "../../infra/restart-sentinel.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";

export function buildGatewayUpdateRunOrigin({
  requester,
  sessionKey,
  deliveryContext,
  threadId,
}: {
  requester?: UpdateRunRecord["origin"]["requester"];
  sessionKey?: string;
  deliveryContext?: DeliveryContext;
  threadId?: string;
}): UpdateRunRecord["origin"] {
  return {
    doctorHint: formatDoctorNonInteractiveHint(),
    ...(requester ? { requester } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(deliveryContext
      ? {
          deliveryContext: {
            channel: deliveryContext.channel,
            to: deliveryContext.to,
            accountId: deliveryContext.accountId,
            threadId:
              threadId ??
              (deliveryContext.threadId != null ? String(deliveryContext.threadId) : undefined),
          },
        }
      : {}),
  };
}
