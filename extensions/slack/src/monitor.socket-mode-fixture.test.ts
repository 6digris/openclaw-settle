import "./monitor.test-helpers.js";
import { SocketModeReceiver } from "@slack/bolt";
import { expect, it, vi } from "vitest";
import { installSlackSocketModeEnvelopeGuard } from "./monitor/socket-mode-envelope.js";

it("preserves SDK dispatch and acknowledgements in the shared Socket Mode fixture", async () => {
  const receiver = new SocketModeReceiver({ appToken: "xapp-fixture" });
  const warn = vi.fn();
  installSlackSocketModeEnvelopeGuard(receiver, { warn });

  const send = Reflect.get(receiver.client, "send");
  expect(vi.isMockFunction(send)).toBe(true);
  const delivered = vi.fn();
  const acknowledgements: Promise<void>[] = [];
  receiver.client.on("slack_event", (event: { body: unknown; ack: () => Promise<void> }) => {
    delivered(event.body);
    acknowledgements.push(event.ack());
  });

  const message = {
    type: "event_callback",
    event: { type: "message", text: "still receiving" },
  };
  receiver.client.emit(
    "ws_message",
    JSON.stringify({
      type: "events_api",
      envelope_id: "control",
      payload: { type: "app_rate_limited", team_id: "T_FIXTURE" },
    }),
    false,
  );
  receiver.client.emit(
    "ws_message",
    JSON.stringify({ type: "events_api", envelope_id: "message", payload: message }),
    false,
  );
  await Promise.all(acknowledgements);

  expect(delivered).toHaveBeenCalledExactlyOnceWith(message);
  expect(send).toHaveBeenNthCalledWith(1, "control");
  expect(send).toHaveBeenNthCalledWith(2, "message", undefined);
  expect(send).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "Slack Events API delivery is rate limited; acknowledging the control notification.",
  );
});
