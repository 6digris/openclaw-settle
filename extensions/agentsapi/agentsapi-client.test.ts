import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsApiClient } from "./agentsapi-client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Agents API session creation", () => {
  it.each(["gpt-6-astra", "future-model"])(
    "sends the selected model %s to the backend",
    async (model) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json({ id: "session-fixture" }));
      const client = new AgentsApiClient("fixture-not-a-real-api-key", vi.fn());

      await expect(
        client.create(new AbortController().signal, "Fixture instructions", model),
      ).resolves.toBe("session-fixture");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0];
      if (!call) {
        throw new Error("Expected a session creation request");
      }
      const request = new Request(call[0], call[1]);
      const body: unknown = await request.json();
      expect(request.url).toBe("https://api.openai.com/v1/agents/sessions");
      expect(request.method).toBe("POST");
      expect(body).toMatchObject({ agent: { model } });
    },
  );

  it("preserves the backend's unsupported-model error", async () => {
    const backendMessage = "Model 'future-model' is not supported by the Agents API.";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ error: { message: backendMessage } }, { status: 400 }));
    const client = new AgentsApiClient("fixture-not-a-real-api-key", vi.fn());

    await expect(
      client.create(new AbortController().signal, "Fixture instructions", "future-model"),
    ).rejects.toThrow(backendMessage);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
