import { describe, expect, it } from "vitest";
import {
  createMockServerTestHarness,
  expectNonStreamingResponsesJson,
  getJson,
  makeUserInput,
  makeToolOutputWithCallId,
  outputItems,
  outputText,
  outputToolArgsFromItem,
  outputToolCall,
  outputToolCallId,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();
const SESSIONS_YIELD_TOOL = { type: "function", name: "sessions_yield" } as const;
const MESSAGE_TOOL = { type: "function", name: "message" } as const;
const TEST_RUNTIME_CONTEXT_CARRIER = [
  "OpenClaw runtime context for the immediately preceding user message.",
  "This context is runtime-generated, not user-authored. Keep internal details private.",
  "",
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
  "runtime metadata",
  "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
].join("\n");

describe("qa mock structured tool transport", () => {
  it.each([false, true])(
    "delivers silent terminal representation once (deferred=%s)",
    async (deferred) => {
      const server = await startMockServer();
      const tools = deferred ? [{ type: "function", name: "tool_call" }] : [MESSAGE_TOOL];
      const completionInput = [
        makeUserInput("Subagent terminal reply QA check: silent."),
        makeUserInput(
          TEST_RUNTIME_CONTEXT_CARRIER.replace(
            "runtime metadata",
            "[Internal task completion event]\nTask: qa-terminal-silent\nResult: (no output)",
          ),
        ),
      ];
      const delivery = await expectNonStreamingResponsesJson(server, {
        tools,
        instructions:
          "Visible source replies are not automatically delivered for this run. Use `message(action=send)` for user-visible source-channel output. When the message is the completed reply to the current source conversation, set `final=true`.",
        input: completionInput,
      });
      const messageCall = outputToolCall(delivery, deferred ? "tool_call" : "message");
      const args = outputToolArgsFromItem(messageCall);
      if (deferred) {
        expect(args.id).toBe("message");
      }
      expect(deferred ? args.args : args).toEqual({
        action: "send",
        message: "QA-SUBAGENT-TERMINAL-SILENT-REPRESENTED",
        final: true,
      });

      const settled = await expectNonStreamingResponsesJson(server, {
        tools,
        input: [
          ...completionInput,
          messageCall,
          makeToolOutputWithCallId(
            outputToolCallId(messageCall, "call_mock_message_silent_terminal"),
            JSON.stringify(
              deferred
                ? {
                    tool: { id: "openclaw:message", name: "message", source: "openclaw" },
                    result: {
                      content: [
                        { type: "text", text: '{"ok":true,"messageId":"qa-silent-terminal"}' },
                      ],
                    },
                  }
                : { ok: true, messageId: "qa-silent-terminal" },
            ),
          ),
        ],
      });
      expect(outputItems(settled).some((item) => item.type === "function_call")).toBe(false);
      expect(outputText(settled)).toBe("");
    },
  );

  it.each(["visible", "empty"])(
    "starts and settles the %s worker through structured Tool Search",
    async (terminalCase) => {
      const server = await startMockServer();
      const tools = [
        { type: "function", name: "tool_search" },
        { type: "function", name: "tool_describe" },
        { type: "function", name: "tool_call" },
        SESSIONS_YIELD_TOOL,
      ];
      const prompt = `Subagent terminal reply QA check: ${terminalCase}. Reply to the requester after spawning.`;
      const instructions = "Runtime: embedded | sessionId=qa-deferred-parent";
      const input = [makeUserInput(prompt)];
      const kickoff = await expectNonStreamingResponsesJson(server, { tools, instructions, input });
      const spawn = outputToolCall(kickoff, "tool_call");
      expect(outputToolArgsFromItem(spawn)).toMatchObject({
        id: "sessions_spawn",
        args: { label: `qa-terminal-${terminalCase}`, mode: "run", thread: false },
      });
      expect(await getJson(server, "/debug/last-request")).toMatchObject({
        plannedToolName: "sessions_spawn",
        plannedWireToolName: "tool_call",
        plannedToolArgs: { label: `qa-terminal-${terminalCase}` },
      });
      const childSessionKey = `agent:qa:subagent:deferred-${terminalCase}`;
      const acknowledgment = await expectNonStreamingResponsesJson(server, {
        tools,
        instructions,
        input: [
          ...input,
          spawn,
          makeToolOutputWithCallId(
            outputToolCallId(spawn, "spawn"),
            JSON.stringify({
              tool: { id: "openclaw:sessions_spawn", name: "sessions_spawn", source: "openclaw" },
              result: {
                content: [
                  { type: "text", text: JSON.stringify({ status: "accepted", childSessionKey }) },
                ],
              },
            }),
          ),
        ],
      });
      expect(outputText(acknowledgment)).toBe(
        terminalCase === "empty" ? "QA-SUBAGENT-EMPTY-PARENT-ACK" : "Worker started.",
      );
      const child = await expectNonStreamingResponsesJson(server, {
        instructions: `- Your session: ${childSessionKey}.`,
        input: [makeUserInput(`Subagent terminal reply QA worker: ${terminalCase}.`)],
      });
      expect(outputText(child)).toContain(
        terminalCase === "empty"
          ? "QA-SUBAGENT-TERMINAL-INTERNAL-MUST-NOT-LEAK"
          : "QA-SUBAGENT-TERMINAL-VISIBLE-OK",
      );
    },
  );

  it("reports a structured Tool Search spawn failure instead of yielding", async () => {
    const server = await startMockServer();
    const response = await expectNonStreamingResponsesJson(server, {
      tools: [{ type: "function", name: "tool_call" }, SESSIONS_YIELD_TOOL],
      input: [
        makeUserInput("Delegate one bounded QA task."),
        {
          type: "function_call",
          call_id: "spawn",
          name: "tool_call",
          arguments: JSON.stringify({ id: "sessions_spawn", args: {} }),
        },
        makeToolOutputWithCallId(
          "spawn",
          JSON.stringify({
            tool: { id: "openclaw:sessions_spawn", name: "sessions_spawn", source: "openclaw" },
            result: {
              content: [
                { type: "text", text: '{"status":"forbidden","error":"child admission denied"}' },
              ],
            },
          }),
        ),
      ],
    });
    expect(outputText(response)).toBe("Failed to delegate: child admission denied");
    expect(outputItems(response).some((item) => item.type === "function_call")).toBe(false);
  });
});
