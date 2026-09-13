import { describe, expect, it } from "vitest";
import {
  getSlackQaMessageWriteCursor,
  readSlackQaMessageWrites,
  readSlackQaWriteTrace,
} from "./slack-live.capture.js";

function buildMessageRequest(params: {
  channel?: string;
  flowId: string;
  method?: string;
  text: string;
  threadTs?: string;
  ts?: string;
}): Record<string, unknown> {
  return {
    dataText: new URLSearchParams({
      channel: params.channel ?? "C123",
      text: params.text,
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
      ...(params.ts ? { ts: params.ts } : {}),
    }).toString(),
    flowId: params.flowId,
    host: "slack.com",
    kind: "request",
    method: "POST",
    path: `/api/${params.method ?? "chat.postMessage"}`,
  };
}

function buildResponse(
  flowId: string,
  ok: boolean,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    dataText: JSON.stringify({ channel: "C123", ok, ts: "2.000000", ...overrides }),
    flowId,
    kind: "response",
    status: 200,
  };
}

describe("Slack QA debug capture", () => {
  it("preserves only successful Slack post and update snapshots", async () => {
    const postRequest = buildMessageRequest({
      flowId: "post",
      text: "fallback",
      threadTs: "1.000000",
    });
    postRequest.dataText = new URLSearchParams({
      channel: "C123",
      text: "fallback",
      blocks: JSON.stringify([
        { type: "header", text: { type: "plain_text", text: "Update" } },
        { type: "section", text: { type: "mrkdwn", text: "COMMENTARY" } },
      ]),
      thread_ts: "1.000000",
    }).toString();
    const events = [
      buildResponse("update", true),
      {
        id: 4,
        ...buildMessageRequest({
          flowId: "update",
          method: "chat.update",
          text: "receipt",
          ts: "2.000000",
        }),
      },
      buildResponse("post", true),
      { id: 3, ...postRequest },
      buildResponse("rejected", false),
      { id: 2, ...buildMessageRequest({ flowId: "rejected", text: "REJECTED" }) },
      buildResponse("non-write", true),
      {
        id: 1,
        ...buildMessageRequest({ flowId: "non-write", method: "auth.test", text: "IGNORED" }),
      },
    ];
    const store = {
      getSessionEvents: () => events,
      readBlob: () => null,
    };

    await expect(
      readSlackQaMessageWrites({
        afterRequestEventId: 0,
        sessionId: "qa-slack",
        store,
      }),
    ).resolves.toEqual([
      {
        blockText: ["Update", "COMMENTARY"],
        channelId: "C123",
        text: "fallback",
        threadTs: "1.000000",
        ts: "2.000000",
      },
      { channelId: "C123", text: "receipt", ts: "2.000000" },
    ]);
  });

  it("reads captured request and response blobs when previews are unavailable", async () => {
    const request = buildMessageRequest({ flowId: "blob", text: "BLOB-COMMENTARY" });
    const response = buildResponse("blob", true);
    const blobs = new Map([
      ["request", String(request.dataText)],
      ["response", String(response.dataText)],
    ]);
    delete request.dataText;
    delete response.dataText;
    request.id = 1;
    request.dataBlobId = "request";
    response.dataBlobId = "response";
    const store = {
      getSessionEvents: () => [response, request],
      readBlob: (blobId: string) => blobs.get(blobId) ?? null,
    };

    await expect(
      readSlackQaMessageWrites({
        afterRequestEventId: 0,
        sessionId: "qa-slack",
        store,
      }),
    ).resolves.toEqual([expect.objectContaining({ text: "BLOB-COMMENTARY" })]);
  });

  it("uses request ids as cursors and waits for late response capture", async () => {
    const oldRequest = { id: 4, ...buildMessageRequest({ flowId: "old", text: "OLD" }) };
    const nextRequest = { id: 5, ...buildMessageRequest({ flowId: "next", text: "NEXT" }) };
    let reads = 0;
    const store = {
      getSessionEvents: () => {
        reads += 1;
        return reads < 3 ? [nextRequest, oldRequest] : [buildResponse("next", true), nextRequest];
      },
      readBlob: () => null,
    };

    expect(getSlackQaMessageWriteCursor({ sessionId: "qa-slack", store })).toBe(5);
    await expect(
      readSlackQaMessageWrites({
        afterRequestEventId: 4,
        sessionId: "qa-slack",
        store,
      }),
    ).resolves.toEqual([expect.objectContaining({ text: "NEXT" })]);
  });
});

describe("Slack QA complete write trace", () => {
  function trace(events: Array<Record<string, unknown>>) {
    return readSlackQaWriteTrace({
      afterRequestEventId: 0,
      sessionId: "qa-slack",
      settleTimeoutMs: 0,
      store: { getSessionEvents: () => events, readBlob: () => null },
    });
  }

  it("captures buffered stop content and every native chunk text surface", async () => {
    const events = ["chat.startStream", "chat.appendStream", "chat.stopStream"]
      .flatMap((method, index) => {
        const flowId = String(index);
        return [
          buildResponse(flowId, true),
          {
            id: index + 1,
            ...buildMessageRequest({ flowId, method, text: "" }),
            dataText: JSON.stringify({
              channel: "C123",
              ts: "2.000000",
              ...(index === 0 ? { markdown_text: "PREAMBLE" } : {}),
              ...(index === 1
                ? {
                    chunks: [
                      { type: "plan_update", title: "PLAN" },
                      {
                        type: "task_update",
                        title: "TASK",
                        details: "DETAIL",
                        output: "OUTPUT",
                        sources: [{ text: "SOURCE" }],
                      },
                    ],
                  }
                : {}),
              ...(index === 2
                ? {
                    chunks: [
                      { type: "markdown_text", text: "BUFFERED-FINAL" },
                      {
                        type: "blocks",
                        blocks: [
                          { type: "section", text: { type: "mrkdwn", text: "CHUNK-BLOCK" } },
                        ],
                      },
                    ],
                    blocks: [{ type: "section", text: { type: "mrkdwn", text: "STOP-BLOCK" } }],
                  }
                : {}),
            }),
          },
        ];
      })
      .toReversed();
    const result = await trace(events);
    expect(result.complete).toBe(true);
    expect(result.order).toBe("response-observation");
    expect(result.writes.map((write) => write.method)).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.stopStream",
    ]);
    expect(result.writes.map((write) => write.content)).toEqual([
      ["PREAMBLE"],
      ["PLAN", "TASK", "DETAIL", "OUTPUT", "SOURCE"],
      ["BUFFERED-FINAL", "CHUNK-BLOCK", "STOP-BLOCK"],
    ]);
    expect(result.writes.map((write) => write.nativeMarkdown)).toEqual([
      "PREAMBLE",
      "",
      "BUFFERED-FINAL",
    ]);
  });

  it("classifies pre-turn titles separately and retains unknown method inventory", async () => {
    const events = [
      "agents.sessions.setStatus",
      "agents.sessions.rename",
      "chat.postEphemeral",
    ].flatMap((method, index) => [
      buildResponse(String(index), true),
      { id: index + 1, ...buildMessageRequest({ flowId: String(index), method, text: "TITLE" }) },
    ]);
    const result = await trace(events);
    expect(result.writes.map((write) => write.classification)).toEqual([
      "metadata",
      "metadata",
      "other",
    ]);
    expect(result.writes.every((write) => write.content.includes("TITLE"))).toBe(true);
  });

  it("does not convert transport errors without request rows into absence", async () => {
    const event = {
      id: 7,
      kind: "error",
      method: "POST",
      host: "slack.com",
      path: "/api/chat.postMessage",
    };
    const result = await trace([event]);
    expect(result.complete).toBe(false);
    expect(result.issues).toContain("7:transport-error");
    expect(result.writes).toEqual([expect.objectContaining({ eventId: 7, status: "unconfirmed" })]);
    expect(
      getSlackQaMessageWriteCursor({
        sessionId: "qa-slack",
        store: { getSessionEvents: () => [event], readBlob: () => null },
      }),
    ).toBe(7);
  });

  it.each<Array<{ name: string; response?: Record<string, unknown>; metaJson?: string }>[number]>([
    { name: "missing acknowledgement", response: undefined },
    { name: "rejected write", response: buildResponse("f", false) },
    {
      name: "unavailable body",
      response: buildResponse("f", true, {}),
      metaJson: JSON.stringify({ bodyCapture: "unavailable" }),
    },
    {
      name: "truncated capture",
      response: buildResponse("f", true, {}),
      metaJson: JSON.stringify({ captureTruncated: true }),
    },
    {
      name: "missing response blob",
      response: { ...buildResponse("f", true), dataBlobId: "absent" },
    },
  ])("marks $name inconclusive", async ({ response, metaJson }) => {
    const request = { id: 1, ...buildMessageRequest({ flowId: "f", text: "CONTENT" }) };
    const result = await trace(
      response ? [{ ...response, ...(metaJson ? { metaJson } : {}) }, request] : [request],
    );
    expect(result.complete).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("retains full text and refuses a full event window or malformed content", async () => {
    const text = "a".repeat(2048) + "TAIL-LEAK";
    const request = { id: 1, ...buildMessageRequest({ flowId: "f", text }) };
    expect((await trace([buildResponse("f", true), request])).writes[0]?.content).toEqual([text]);
    expect((await trace(Array.from({ length: 5000 }, () => request))).issues).toContain(
      "capture-window-limit",
    );
    const malformed = {
      ...request,
      dataText: new URLSearchParams({ channel: "C123", chunks: "[broken" }).toString(),
    };
    expect((await trace([buildResponse("f", true), malformed])).issues).toContain(
      "1:invalid-chunks",
    );
  });
});

it("reads native chunks from the SDK URL-encoded request body", async () => {
  const request = {
    id: 1,
    ...buildMessageRequest({ flowId: "f", method: "chat.stopStream", text: "" }),
    dataText: new URLSearchParams({
      channel: "C123",
      ts: "2.000000",
      chunks: JSON.stringify([
        { type: "markdown_text", text: "BUF" },
        { type: "task_update", title: "STATUS" },
        { type: "markdown_text", text: "FERED" },
      ]),
    }).toString(),
  };
  const result = await readSlackQaWriteTrace({
    afterRequestEventId: 0,
    sessionId: "qa-slack",
    settleTimeoutMs: 0,
    store: {
      getSessionEvents: () => [buildResponse("f", true), request],
      readBlob: () => null,
    },
  });
  expect(result.complete).toBe(true);
  expect(result.writes[0]?.content).toEqual(["BUF", "STATUS", "FERED"]);
  expect(result.writes[0]?.nativeMarkdown).toBe("BUFFERED");
});
