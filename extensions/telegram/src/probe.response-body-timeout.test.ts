// Telegram tests cover stalled diagnostic response body handling.
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { probeTelegram } from "./probe.js";

const resolveTelegramTransport = vi.hoisted(() => vi.fn());
const makeProxyFetch = vi.hoisted(() => vi.fn());

vi.mock("./fetch.js", () => ({
  resolveTelegramTransport,
  resolveTelegramApiBase: (apiRoot?: string) =>
    apiRoot?.trim()?.replace(/\/+$/, "") || "https://api.telegram.org",
}));

vi.mock("./proxy.js", () => ({
  makeProxyFetch,
}));

function installFetchMock(): Mock {
  const fetchMock = vi.fn();
  resolveTelegramTransport.mockImplementation((proxyFetch?: typeof fetch) => ({
    fetch: proxyFetch ?? (fetchMock as unknown as typeof fetch),
    sourceFetch: proxyFetch ?? (fetchMock as unknown as typeof fetch),
    forceFallback: vi.fn().mockReturnValue(true),
    close: async () => {},
  }));
  makeProxyFetch.mockImplementation(() => fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function makeJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeStallingJsonResponse(payload: unknown, cancel: (reason?: unknown) => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
      },
      cancel,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("probeTelegram response body timeouts", () => {
  let tokenIndex = 0;
  const nextToken = () => `response-body-${++tokenIndex}`;

  afterEach(() => {
    resolveTelegramTransport.mockReset();
    makeProxyFetch.mockReset();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps webhook diagnostics best-effort when webhookInfo response body stalls", async () => {
    const fetchMock = installFetchMock();
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        ok: true,
        result: { id: 123, is_bot: true, first_name: "Test", username: "bot" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      makeStallingJsonResponse({ ok: true, result: { url: "https://example.test/hook" } }, cancel),
    );

    vi.useFakeTimers();
    const probePromise = probeTelegram(nextToken(), 50);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60);

    const result = await probePromise;
    expect(result.ok).toBe(true);
    expect(result.webhook).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
