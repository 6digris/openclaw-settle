import { describe, expect, it, vi } from "vitest";
import { buildQaGatewayConfig } from "../../qa-gateway-config.js";
import type { SlackQaWriteTrace } from "./slack-live.capture.js";
import { buildSlackQaConfig } from "./slack-live.config.js";
import {
  readSlackTerminalSendResult,
  verifySlackDeliveryObservations,
} from "./slack-live.delivery-proof.js";
import { readSlackDeliveryProviderMessages } from "./slack-live.provider-capture.js";

function fixture(): Parameters<typeof verifySlackDeliveryObservations>[0] {
  const first = {
    type: "tool_use" as const,
    id: "call-1",
    name: "exec",
    input: { command: "first-command" },
  };
  const second = {
    type: "tool_use" as const,
    id: "call-2",
    name: "exec",
    input: { command: "second-command" },
  };
  const firstResult = { id: "call-1", isError: false, text: "FIRST" };
  const secondResult = { id: "call-2", isError: false, text: "SECOND" };
  const base = { model: "claude-opus-4-8", outputTokens: 32, maxTokens: 2048 };
  return {
    mode: "final-only" as const,
    preamble: "PREAMBLE",
    final: "FINAL",
    privateFinal: "PRIVATE",
    channelId: "C123",
    finalMessageId: "2.000000",
    commands: ["first-command", "second-command"] as [string, string],
    outputs: ["FIRST", "SECOND"] as [string, string],
    retainedMessages: [{ ts: "2.000000", text: "FINAL" }],
    messages: [
      {
        ...base,
        text: "PREAMBLE",
        blocks: [{ type: "text" as const, text: "PREAMBLE" }, first],
        toolResults: [],
        stopReason: "tool_use",
      },
      { ...base, text: "", blocks: [second], toolResults: [firstResult], stopReason: "tool_use" },
      {
        ...base,
        text: "FINAL",
        blocks: [{ type: "text" as const, text: "FINAL" }],
        toolResults: [firstResult, secondResult],
        stopReason: "end_turn",
      },
    ],
    trace: {
      order: "response-observation",
      complete: true,
      issues: [],
      writes: [
        {
          eventId: 1,
          method: "chat.postMessage",
          classification: "reply",
          status: "acknowledged",
          content: ["FINAL"],
          message: { channelId: "C123", ts: "2.000000", text: "FINAL" },
        },
      ],
    } as SlackQaWriteTrace,
  };
}

function messageToolFixture(): Parameters<typeof verifySlackDeliveryObservations>[0] {
  const observed = fixture();
  observed.mode = "message-tool";
  observed.messages[2] = {
    ...observed.messages[2]!,
    text: "",
    blocks: [
      {
        type: "tool_use",
        id: "call-3",
        name: "message",
        input: {
          action: "send",
          channel: "slack",
          target: "channel:C123",
          message: "FINAL",
          final: true,
        },
      },
    ],
    stopReason: "tool_use",
  };
  observed.terminalSendResult = {
    id: "call-3",
    isError: false,
    text: JSON.stringify({ ok: true, result: { channelId: "C123", messageId: "2.000000" } }),
  };
  return observed;
}

describe("Slack Anthropic delivery proof", () => {
  it("qualifies only the realized sequence and the observed final identity", () => {
    expect(JSON.parse(verifySlackDeliveryObservations(fixture())).providerShapeExercised).toBe(
      true,
    );
    const wrongIdentity = fixture();
    wrongIdentity.finalMessageId = "3.000000";
    expect(() => verifySlackDeliveryObservations(wrongIdentity)).toThrow(
      "inconclusive: capture incomplete",
    );
    const unexercised = fixture();
    unexercised.messages[1]!.text = "extra narration";
    expect(() => verifySlackDeliveryObservations(unexercised)).toThrow(
      "inconclusive: provider sequence unexercised",
    );
  });

  it.each(["reversed-blocks", "wrong-command", "wrong-result-id", "failed-result", "wrong-output"])(
    "does not qualify %s as the requested provider sequence",
    (fault) => {
      const observed = fixture();
      if (fault === "reversed-blocks") {
        observed.messages[0]!.blocks.reverse();
      }
      if (fault === "wrong-command") {
        const tool = observed.messages[0]!.blocks[1]!;
        if (tool.type === "tool_use") {
          tool.input.command = "different-command";
        }
      }
      if (fault === "wrong-result-id") {
        observed.messages[1]!.toolResults[0]!.id = "unknown";
      }
      if (fault === "failed-result") {
        observed.messages[1]!.toolResults[0]!.isError = true;
      }
      if (fault === "wrong-output") {
        observed.messages[1]!.toolResults[0]!.text = "failure";
      }
      expect(() => verifySlackDeliveryObservations(observed)).toThrow(
        "provider sequence unexercised",
      );
    },
  );

  it("rejects a final that was deleted after the initial reply observation", () => {
    const observed = fixture();
    observed.retainedMessages = [];
    expect(() => verifySlackDeliveryObservations(observed)).toThrow("failed: visible final policy");
  });

  it("rejects transient native text even when the final ledger is correct", () => {
    const observed = fixture();
    observed.trace.writes.unshift({
      eventId: 0,
      method: "chat.stopStream",
      classification: "reply",
      status: "acknowledged",
      content: ["PREAMBLE"],
      message: { channelId: "C123", ts: "1.000000", text: "PREAMBLE" },
    });
    expect(() => verifySlackDeliveryObservations(observed)).toThrow(
      "failed: intermediate reply content",
    );
    observed.trace.writes[0]!.method = "chat.startStream";
    observed.trace.writes[1]!.method = "chat.stopStream";
    expect(
      JSON.parse(verifySlackDeliveryObservations({ ...observed, mode: "progress" })).mode,
    ).toBe("progress");
  });

  it("cannot prove absence from incomplete capture or an unexpected write surface", () => {
    const incomplete = fixture();
    incomplete.trace.complete = false;
    expect(() => verifySlackDeliveryObservations(incomplete)).toThrow(
      "inconclusive: capture incomplete",
    );
    const unexpected = fixture();
    unexpected.trace.writes.push({
      eventId: 2,
      method: "chat.postEphemeral",
      classification: "other",
      status: "acknowledged",
      content: ["PREAMBLE"],
      message: { channelId: "C123", ts: "3.000000", text: "PREAMBLE" },
    });
    expect(() => verifySlackDeliveryObservations(unexpected)).toThrow(
      "inconclusive: capture incomplete",
    );
  });

  it("keeps observed negative-ACK metadata separate from reply qualification without private content", () => {
    const observed = fixture();
    observed.trace.writes.push({
      eventId: 2,
      method: "agents.sessions.setStatus",
      classification: "metadata",
      status: "rejected",
      responseStatus: 200,
      responseOk: false,
      errorCode: "feature_disabled",
      content: ["PRIVATE_TITLE"],
    });
    const details = verifySlackDeliveryObservations(observed);
    expect(details).not.toContain("PRIVATE_TITLE");
    expect(JSON.parse(details).nonAcknowledgedWrites).toEqual([
      {
        eventId: 2,
        method: "agents.sessions.setStatus",
        classification: "metadata",
        status: "rejected",
        responseStatus: 200,
        responseOk: false,
        errorCode: "feature_disabled",
      },
    ]);
    observed.trace.writes[1]!.classification = "reply";
    observed.trace.writes[1]!.method = "chat.postMessage";
    expect(() => verifySlackDeliveryObservations(observed)).toThrow("capture incomplete");
    observed.trace.writes[1]!.classification = "other";
    observed.trace.writes[1]!.method = "PRIVATE_METHOD";
    expect(() => verifySlackDeliveryObservations(observed)).toThrow("unexpected-method");
    expect(() => verifySlackDeliveryObservations(observed)).not.toThrow("PRIVATE_METHOD");
  });

  it("joins only one native message's markdown and rejects split private output", () => {
    const observed = fixture();
    observed.retainedMessages[0]!.text = "PREAMBLE\nFINAL";
    observed.trace.writes = ["PRE", "AMBLE\nFI", "NAL"].map((text, index) => ({
      eventId: index + 1,
      method: ["chat.startStream", "chat.appendStream", "chat.stopStream"][index]!,
      classification: "reply",
      status: "acknowledged",
      content: [text],
      nativeMarkdown: text,
      message: { channelId: "C123", ts: "2.000000", text: "" },
    }));
    const verify = () => verifySlackDeliveryObservations({ ...observed, mode: "progress" });
    expect(JSON.parse(verify()).nativeMessages).toEqual([
      { preamble: true, final: true, privateFinal: false, textChars: 14 },
    ]);
    const last = observed.trace.writes[2]!;
    last.message!.ts = "3.000000";
    expect(verify).toThrow("inconclusive: capture incomplete");
    last.message!.ts = "2.000000";
    last.message!.channelId = "OTHER";
    expect(verify).toThrow("inconclusive: capture incomplete");
    last.message!.channelId = "C123";
    last.nativeMarkdown = "";
    expect(verify).toThrow("inconclusive: capture incomplete");
    last.nativeMarkdown = "NAL";
    last.method = "chat.update";
    expect(verify).toThrow("inconclusive: capture incomplete");
    last.method = "chat.stopStream";
    observed.trace.writes[1]!.nativeMarkdown = "AMBLE\nFINAL\nPRI";
    last.nativeMarkdown = "VATE";
    expect(verify).toThrow("failed: visible final policy");
  });

  it("requires a completed explicit send and its correlated terminal receipt", () => {
    const observed = messageToolFixture();
    expect(
      JSON.parse(verifySlackDeliveryObservations({ ...observed, mode: "message-tool" }))
        .providerShapeExercised,
    ).toBe(true);
    const send = observed.messages[2]!.blocks[0]!;
    if (send.type !== "tool_use") {
      throw new Error("missing fixture send");
    }
    for (const final of [undefined, false]) {
      send.input.final = final;
      expect(() => verifySlackDeliveryObservations({ ...observed, mode: "message-tool" })).toThrow(
        "provider sequence unexercised",
      );
    }
    send.input.final = true;
    send.input.target = "channel:OTHER";
    expect(() => verifySlackDeliveryObservations({ ...observed, mode: "message-tool" })).toThrow(
      "provider sequence unexercised",
    );
    send.input.target = "channel:C123";
    const toolResult = observed.terminalSendResult!;
    observed.terminalSendResult = undefined;
    expect(() => verifySlackDeliveryObservations(observed)).toThrow(
      "provider sequence unexercised",
    );
    observed.terminalSendResult = toolResult;
    toolResult.id = "unrelated-call";
    expect(() => verifySlackDeliveryObservations(observed)).toThrow(
      "provider sequence unexercised",
    );
    toolResult.id = "call-3";
    toolResult.isError = true;
    expect(() => verifySlackDeliveryObservations(observed)).toThrow(
      "provider sequence unexercised",
    );
    toolResult.isError = false;
    for (const text of [
      "not-json",
      JSON.stringify({ ok: false, result: { channelId: "C123", messageId: "2.000000" } }),
      JSON.stringify({ result: { channelId: "C123", messageId: "2.000000" } }),
    ]) {
      toolResult.text = text;
      expect(() => verifySlackDeliveryObservations(observed)).toThrow(
        "provider sequence unexercised",
      );
    }
    const coreResult = {
      channel: "slack",
      to: "channel:C123",
      via: "direct",
      deliveryStatus: "sent",
      mediaUrl: null,
      result: { channel: "slack", target: { kind: "channel", id: "C123" }, messageId: "2.000000" },
    };
    toolResult.text = JSON.stringify(coreResult);
    expect(
      JSON.parse(verifySlackDeliveryObservations(observed)).explicitSendDiagnostics.coreSuccess,
    ).toBe(true);
    for (const deliveryStatus of [undefined, "failed", "partial_failed", "suppressed", "queued"]) {
      toolResult.text = JSON.stringify({ ...coreResult, deliveryStatus });
      expect(() => verifySlackDeliveryObservations(observed)).toThrow(
        "provider sequence unexercised",
      );
    }
    for (const result of [
      null,
      {},
      { ...coreResult.result, target: { kind: "channel", id: "OTHER" } },
      { ...coreResult.result, messageId: "OTHER" },
    ]) {
      toolResult.text = JSON.stringify({ ...coreResult, result });
      expect(() => verifySlackDeliveryObservations(observed)).toThrow(
        "provider sequence unexercised",
      );
    }
    toolResult.text = JSON.stringify(coreResult);
    observed.trace.writes[0]!.content.push("PRIVATE");
    expect(() => verifySlackDeliveryObservations({ ...observed, mode: "message-tool" })).toThrow(
      "failed: visible final policy",
    );
  });

  it("reads the completed tool receipt from the exact owned thread without another provider call", async () => {
    const session = { key: "agent:qa:slack:channel:c123:thread:1.000000", sessionId: "session-1" };
    const receipt = {
      role: "toolResult",
      toolCallId: "call-3",
      toolName: "message",
      isError: false,
      content: [{ type: "text", text: messageToolFixture().terminalSendResult!.text }],
    };
    const listing = { hasMore: false, sessions: [session] };
    const history = {
      sessionKey: session.key,
      sessionId: session.sessionId,
      hasMore: false,
      messages: [receipt],
    };
    const call = vi.fn().mockResolvedValueOnce(listing).mockResolvedValueOnce(history);
    await expect(
      readSlackTerminalSendResult({
        gateway: { call },
        channelId: "C123",
        sentTs: "1.000000",
        toolCallId: "call-3",
      }),
    ).resolves.toEqual({ ...messageToolFixture().terminalSendResult, textParts: 1 });
    expect(call.mock.calls).toEqual([
      ["sessions.list", { agentId: "qa", search: ":channel:c123:thread:1.000000", limit: 2 }],
      ["chat.history", { agentId: "qa", sessionKey: session.key, limit: 24 }],
    ]);
  });

  it("rejects ambiguous ownership and missing, truncated, duplicate or mismatched terminal receipts", async () => {
    const session = { key: "agent:qa:slack:channel:c123:thread:1.000000", sessionId: "session-1" };
    const receipt = {
      role: "toolResult",
      toolCallId: "call-3",
      toolName: "message",
      isError: false,
      content: [{ type: "text", text: "{}" }],
    };
    const listing = { hasMore: false, sessions: [session] };
    const history = {
      sessionKey: session.key,
      sessionId: session.sessionId,
      hasMore: false,
      messages: [receipt],
    };
    for (const [list, transcript] of [
      [{ ...listing, hasMore: true }, history],
      [{ ...listing, sessions: [] }, history],
      [{ ...listing, sessions: [session, session] }, history],
      [
        {
          ...listing,
          sessions: [{ ...session, key: "agent:other:slack:channel:c123:thread:1.000000" }],
        },
        history,
      ],
      [
        {
          ...listing,
          sessions: [{ ...session, key: "agent:qa:slack:channel:other:thread:1.000000" }],
        },
        history,
      ],
      [
        { ...listing, sessions: [{ ...session, key: "agent:qa:slack:channel:c123:thread:other" }] },
        history,
      ],
      [listing, { ...history, sessionId: "other" }],
      [listing, { ...history, sessionKey: "other" }],
      [listing, { ...history, hasMore: true }],
      [listing, { ...history, nextOffset: 24 }],
      [listing, { ...history, messages: Array.from({ length: 24 }, () => ({ ...receipt })) }],
      [listing, { ...history, messages: [] }],
      [listing, { ...history, messages: [receipt, receipt] }],
      [listing, { ...history, messages: [{ ...receipt, toolCallId: "other" }] }],
      [listing, { ...history, messages: [{ ...receipt, toolName: "exec" }] }],
      [listing, { ...history, messages: [{ ...receipt, isError: undefined }] }],
      [listing, { ...history, messages: [{ ...receipt, __openclaw: { truncated: true } }] }],
      [listing, { ...history, messages: [{ ...receipt, content: [{ type: "omitted" }] }] }],
    ]) {
      const call = vi.fn().mockResolvedValueOnce(list).mockResolvedValueOnce(transcript);
      await expect(
        readSlackTerminalSendResult({
          gateway: { call },
          channelId: "C123",
          sentTs: "1.000000",
          toolCallId: "call-3",
        }),
      ).rejects.toThrow(
        /Slack delivery proof terminal (session identity|transcript|tool result) is incomplete/,
      );
    }
  });

  it("retains fifth-response provenance without qualifying an extra provider turn", () => {
    const observed = messageToolFixture();
    observed.messages.push({
      ...observed.messages[0]!,
      text: "PRIVATE",
      blocks: [{ type: "text", text: "PRIVATE" }],
      toolResults: [...observed.messages[2]!.toolResults, observed.terminalSendResult!],
      stopReason: "end_turn",
    });
    expect(() => verifySlackDeliveryObservations(observed)).toThrow(
      "provider sequence unexercised",
    );
    observed.messages.push({
      ...observed.messages[3]!,
      text: "DIFFERENT",
      blocks: [{ type: "text", text: "DIFFERENT" }],
      request: {
        eventId: 20,
        messageCount: 9,
        toolCount: 0,
        lastRole: "user",
        lastUserText: "PRIVATE_CONTINUATION_INPUT",
      },
    });
    observed.ownerEvents = [
      "settled post-tool turn lacked a final answer: runId=PRIVATE_RUN — running isolated finalization",
    ];
    try {
      verifySlackDeliveryObservations(observed);
      expect.fail("a fifth response must remain unqualified");
    } catch (error) {
      expect(String(error)).toContain("provider sequence unexercised");
      const facts = JSON.parse(String(error).split("; ")[1]!);
      expect(facts.provider[3].privateFinal).toBe(true);
      expect(facts.provider[4].privateFinal).toBe(false);
      expect(facts.explicitSendDiagnostics).toMatchObject({
        envelopeObject: true,
        receiptObject: true,
        pluginSuccess: true,
        messageMatches: true,
      });
      expect(facts.ownerEventKinds).toEqual(["settled post-tool turn"]);
      expect(facts.privateDiagnostics).toEqual({
        finalUserInput: "PRIVATE_CONTINUATION_INPUT",
        ownerEvents: observed.ownerEvents,
      });
      expect(
        JSON.stringify({
          provider: facts.provider,
          send: facts.explicitSendDiagnostics,
          owner: facts.ownerEventKinds,
        }),
      ).not.toContain("PRIVATE_");
    }
    const secret = "synthetic-secret-".repeat(20);
    observed.messages[4]!.request!.lastUserText =
      "prefix ".repeat(290) + ` Bearer ${secret} ` + "suffix ".repeat(500);
    try {
      verifySlackDeliveryObservations(observed);
      expect.fail("a fifth response must remain unqualified");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      const facts = JSON.parse(String(error).split("; ")[1]!);
      expect(facts.privateDiagnostics.finalUserInput.length).toBeLessThanOrEqual(2_048);
      expect(facts.privateDiagnostics.finalUserInput).toContain("output omitted");
    }
  });

  it.each(["final-only", "progress", "message-tool"] as const)(
    "pins the %s delivery contract without product defaults changes",
    (mode) => {
      const config = buildSlackQaConfig(
        buildQaGatewayConfig({
          bind: "loopback",
          gatewayPort: 18789,
          gatewayToken: "test-token",
          workspaceDir: "/tmp/qa-workspace",
          providerMode: "live-frontier",
          primaryModel: "anthropic/claude-opus-4-8",
          alternateModel: "anthropic/claude-opus-4-8",
        }),
        {
          channelId: "C123",
          driverBotUserId: "U123",
          sutAccountId: "sut",
          sutAppToken: "test-app",
          sutBotToken: "test-bot",
          overrides: { delivery: mode },
        },
      );
      expect(config.channels?.slack?.accounts?.sut?.streaming).toEqual({
        mode: mode === "progress" ? "progress" : "off",
        nativeTransport: mode === "progress",
        block: { enabled: false },
      });
      expect(config.agents?.defaults).toMatchObject({
        blockStreamingDefault: "off",
        verboseDefault: "off",
        reasoningDefault: "off",
        params: { maxTokens: 2048 },
      });
      expect(config.messages?.groupChat?.visibleReplies).toBe(
        mode === "message-tool" ? "message_tool" : "automatic",
      );
      expect(config.logging?.level).toBe("debug");
      expect(config.agents?.entries?.qa?.identity).toBeUndefined();
      expect(config.agents?.entries?.qa?.model).toEqual({ primary: "anthropic/claude-opus-4-8" });
    },
  );

  it("requires a completed authenticated-model response within the token bound", () => {
    const data = [
      { type: "message_start", message: { id: "provider-message-1", model: "claude-opus-4-8" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "FINAL" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ]
      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
      .join("");
    const request = {
      id: 1,
      flowId: "f",
      host: "api.anthropic.com",
      path: "/v1/messages",
      kind: "request",
      dataText: JSON.stringify({ model: "claude-opus-4-8", max_tokens: 2048, messages: [] }),
    };
    const response = {
      id: 2,
      flowId: "f",
      host: "api.anthropic.com",
      path: "/v1/messages",
      kind: "response",
      status: 200,
      dataText: data,
    };
    const store = { getSessionEvents: () => [response, request], readBlob: () => null };
    expect(
      readSlackDeliveryProviderMessages({
        store,
        sessionId: "qa",
        cursor: 0,
        fixtureMarker: "FIXTURE",
      })[0],
    ).toMatchObject({
      text: "FINAL",
      model: "claude-opus-4-8",
      stopReason: "end_turn",
      maxTokens: 2048,
    });
    const duplicateRequest = { ...request, id: 3, flowId: "duplicate" };
    const duplicateResponse = { ...response, id: 4, flowId: "duplicate" };
    const repeated = {
      ...store,
      getSessionEvents: () => [duplicateResponse, duplicateRequest, response, request],
    };
    expect(
      readSlackDeliveryProviderMessages({
        store: repeated,
        sessionId: "qa",
        cursor: 0,
        fixtureMarker: "FIXTURE",
      })[1],
    ).toMatchObject({
      request: { sameRequestAsPrevious: true, sameResponseIdAsPrevious: true },
    });
    duplicateRequest.dataText = request.dataText.replace(
      '"messages":[]',
      '"messages":[{"role":"user","content":"continuation"}]',
    );
    duplicateResponse.dataText = data.replace("provider-message-1", "provider-message-2");
    expect(
      readSlackDeliveryProviderMessages({
        store: repeated,
        sessionId: "qa",
        cursor: 0,
        fixtureMarker: "FIXTURE",
      })[1],
    ).toMatchObject({
      request: { sameRequestAsPrevious: false, sameResponseIdAsPrevious: false },
    });
    const toolFrames = [
      { type: "message_start", message: { id: "provider-message-1", model: "claude-opus-4-8" } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call-2", name: "exec", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"second-command"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ]
      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
      .join("");
    request.dataText = JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              is_error: false,
              content: [{ type: "text", text: "FIRST" }],
            },
          ],
        },
      ],
    });
    response.dataText = toolFrames;
    expect(
      readSlackDeliveryProviderMessages({
        store,
        sessionId: "qa",
        cursor: 0,
        fixtureMarker: "FIXTURE",
      })[0],
    ).toMatchObject({
      blocks: [
        { type: "tool_use", id: "call-2", name: "exec", input: { command: "second-command" } },
      ],
      toolResults: [{ id: "call-1", isError: false, text: "FIRST" }],
    });
    const privateMessages = [{ role: "user", content: "PRIVATE_INPUT FIXTURE" }];
    for (const { overrides, expected } of [
      { overrides: { model: "PRIVATE_MODEL" }, expected: { modelMatches: false } },
      {
        overrides: { messages: "PRIVATE_MESSAGES" },
        expected: { messagesArray: false, fixtureUserTextMatches: false },
      },
      {
        overrides: { max_tokens: "PRIVATE_VALUE" },
        expected: { maxTokensType: "string", maxTokensValue: null, maxTokensWithinBound: false },
      },
      {
        overrides: { max_tokens: 2049 },
        expected: { maxTokensValue: 2049, maxTokensWithinBound: false },
      },
      {
        overrides: { max_tokens: null },
        expected: { maxTokensType: "object", maxTokensValue: null, maxTokensWithinBound: false },
      },
      {
        overrides: {
          model: "PRIVATE_MODEL",
          messages: [{ role: "user", content: [{ type: "text", text: "PRIVATE_INPUT FIXTURE" }] }],
        },
        expected: { modelMatches: false },
      },
      {
        overrides: {
          model: "PRIVATE_MODEL",
          messages: [
            { role: "assistant", content: "PRIVATE_INPUT FIXTURE" },
            { role: "user", content: [{ type: "tool_result", content: "FIXTURE" }] },
          ],
        },
        expected: { modelMatches: false, fixtureUserTextMatches: false },
      },
    ]) {
      duplicateRequest.dataText = JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 2048,
        messages: privateMessages,
        system: "PRIVATE_SYSTEM".repeat(2048),
        ...overrides,
      });
      duplicateRequest.flowId = "PRIVATE_FLOW_ID";
      duplicateResponse.flowId = "PRIVATE_FLOW_ID";
      let failure: unknown;
      try {
        readSlackDeliveryProviderMessages({
          store: repeated,
          sessionId: "PRIVATE_SESSION_ID",
          cursor: 0,
          fixtureMarker: "FIXTURE",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("provider identity or token bound differs");
      expect(String(failure)).not.toContain("PRIVATE_");
      expect(String(failure).length).toBeLessThan(1024);
      expect(JSON.parse(String(failure).split("providerRequest=")[1]!)).toEqual({
        requestOrdinal: 2,
        capturedRequests: 2,
        responseCorrelated: true,
        responseStatus: 200,
        modelMatches: true,
        modelType: "string",
        messagesArray: true,
        maxTokensType: "number",
        maxTokensValue: 2048,
        maxTokensWithinBound: true,
        maxTokensLimit: 2048,
        fixtureUserTextMatches: true,
        ...expected,
      });
    }
    response.dataText = data.replace('data: {"type":"message_stop"}\n\n', "");
    expect(() =>
      readSlackDeliveryProviderMessages({
        store,
        sessionId: "qa",
        cursor: 0,
        fixtureMarker: "FIXTURE",
      }),
    ).toThrow("did not complete");
  });
});
