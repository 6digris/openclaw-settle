import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import {
  createGoogleMeetToolGatewayForTest,
  invokeGoogleMeetGatewayMethodForTest,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";
import { testing } from "./test-api.js";

const runtime = vi.hoisted(() => ({
  participationContext: vi.fn(),
  participate: vi.fn(),
}));

vi.mock("./src/runtime.js", () => ({
  GoogleMeetRuntime: class {
    participationContext = runtime.participationContext;
    participate = runtime.participate;
  },
}));

function setup() {
  const harness = setupGoogleMeetPlugin(plugin);
  testing.setCallGatewayFromCliForTests(createGoogleMeetToolGatewayForTest(harness.methods));
  const tool = harness.tools[0];
  if (!tool) {
    throw new Error("Expected Google Meet tool");
  }
  return { ...harness, tool };
}

describe("Google Meet participation registration", () => {
  beforeEach(() => {
    runtime.participationContext.mockReset();
    runtime.participate.mockReset();
  });

  afterEach(() => {
    testing.setCallGatewayFromCliForTests();
  });

  it("routes participation context through the registered tool and Gateway", async () => {
    const context = {
      sessionId: "meeting-1",
      active: true,
      sourceOrder: 0,
      capabilities: [],
      sources: [],
    };
    runtime.participationContext.mockResolvedValue(context);
    const { tool } = setup();

    const result = await tool.execute("context-call", {
      action: "participation_context",
      sessionId: "meeting-1",
    });

    expect(result.details).toEqual(context);
    expect(runtime.participationContext).toHaveBeenCalledExactlyOnceWith("meeting-1");
  });

  it("passes action identity and correction references to the runtime once", async () => {
    const resultPayload = { requestId: "request-2", status: "unsupported" };
    runtime.participate.mockResolvedValue(resultPayload);
    const { tool } = setup();

    const result = await tool.execute("action-call", {
      action: "participate",
      sessionId: "meeting-1",
      requestId: "request-2",
      sourceId: "source-1",
      correctionOf: "request-1",
      participationAction: { type: "reaction.send", emoji: "👍" },
    });

    expect(result.details).toEqual(resultPayload);
    expect(runtime.participate).toHaveBeenCalledExactlyOnceWith("meeting-1", {
      requestId: "request-2",
      sourceId: "source-1",
      correctionOf: "request-1",
      action: { type: "reaction.send", emoji: "👍" },
    });
  });

  it.each([
    [{ sessionId: undefined }, "sessionId required"],
    [{ requestId: undefined }, "requestId required"],
    [{ participationAction: undefined }, "participationAction.type required"],
    [{ participationAction: [] }, "participationAction.type required"],
    [{ participationAction: { type: " " } }, "participationAction.type required"],
    [{ sourceId: 123 }, "sourceId must be a non-empty string"],
    [{ correctionOf: " " }, "correctionOf must be a non-empty string"],
    [
      { participationAction: { type: "chat", text: 123 } },
      "participationAction.text must be a string",
    ],
    [
      { participationAction: { type: "reaction.send", emoji: false } },
      "participationAction.emoji must be a string",
    ],
  ])(
    "rejects malformed Gateway participation input before runtime dispatch: %j",
    async (overrides, message) => {
      const { methods } = setup();
      const params = {
        sessionId: "meeting-1",
        requestId: "request-1",
        participationAction: { type: "chat", text: "Hello" },
        ...overrides,
      };

      await expect(
        invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.participate", params),
      ).rejects.toThrow(message);
      expect(runtime.participate).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed tool input before sending a Gateway request", async () => {
    const { tool } = setup();
    const callGateway = vi.fn(async () => ({}));
    testing.setCallGatewayFromCliForTests(callGateway);

    const result = await tool.execute("invalid-call", {
      action: "participate",
      sessionId: "meeting-1",
      requestId: "request-1",
      participationAction: "raise-hand",
    });

    expect(result.details).toEqual({ error: "participationAction.type required" });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("preserves runtime participation failures as structured tool results", async () => {
    const { tool } = setup();
    runtime.participate.mockRejectedValue(new Error("Meeting session is no longer current"));

    const result = await tool.execute("stale-call", {
      action: "participate",
      sessionId: "meeting-1",
      requestId: "request-1",
      participationAction: { type: "chat", text: "Hello" },
    });

    expect(result.details).toEqual({ error: "Meeting session is no longer current" });
  });
});
