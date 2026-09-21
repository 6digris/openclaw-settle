import { describe, expect, it } from "vitest";
import {
  type MockServer,
  createMockServerTestHarness,
  expectNonStreamingResponsesJson,
  expectOk,
  getJson,
  makeToolOutputWithCallId,
  makeUserInput,
  outputItems,
  outputText,
  outputToolArgsFromItem,
  outputToolCall,
  outputToolCallId,
  postResponses,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();
const SESSIONS_SPAWN_TOOL = { type: "function", name: "sessions_spawn" } as const;
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

function makeDeveloperInput(text: string) {
  return { role: "developer" as const, content: [{ type: "input_text" as const, text }] };
}

function postNonStreamingResponses(server: MockServer, body: Record<string, unknown>) {
  return postResponses(server, { stream: false, ...body });
}

const TOOL_CALL_TOOL = { type: "function", name: "tool_call" } as const;
const DEFERRED_SUBAGENT_TOOLS = [
  "Available deferred-schema tools:",
  "- message (core): Send messages.",
  "- sessions_spawn (core): Spawn a child session.",
  "",
  "Call tool_call with the tool name in id and its parameters in args.",
].join("\n");

function deferredToolResult(name: string, details: Record<string, unknown>) {
  return JSON.stringify({
    tool: { id: name, name, source: "openclaw" },
    result: { content: [{ type: "text", text: JSON.stringify(details) }], details },
  });
}

describe("qa mock openai tool dispatch", () => {
  it.each(["visible", "empty"])(
    "starts the %s terminal worker through the declared Tool Search dispatcher",
    async (terminalCase) => {
      const server = await startMockServer();
      const kickoff = makeUserInput(`Subagent terminal reply QA check: ${terminalCase}.`);
      const input = [makeDeveloperInput(DEFERRED_SUBAGENT_TOOLS), kickoff];
      const payload = await expectNonStreamingResponsesJson(server, {
        tools: [TOOL_CALL_TOOL],
        input,
      });
      const call = outputToolCall(payload, "tool_call");
      const args = outputToolArgsFromItem(call);
      expect(args).toEqual({
        id: "sessions_spawn",
        args: {
          task: `Subagent terminal reply QA worker: ${terminalCase}.`,
          label: `qa-terminal-${terminalCase}`,
          thread: false,
          mode: "run",
        },
      });
      expect(await getJson(server, "/debug/last-request")).toMatchObject({
        plannedToolName: "sessions_spawn",
        plannedWireToolName: "tool_call",
        plannedToolArgs: args.args,
      });

      const settled = await expectNonStreamingResponsesJson(server, {
        tools: [TOOL_CALL_TOOL],
        input: [
          ...input,
          call,
          makeToolOutputWithCallId(
            String(call.call_id),
            deferredToolResult("sessions_spawn", { status: "accepted", runId: "run-child" }),
          ),
        ],
      });
      expect(outputText(settled)).toBe("Worker started.");
      expect(outputItems(settled).some((item) => item.type === "function_call")).toBe(false);
    },
  );

  it.each(["missing", "user-only"])(
    "does not infer deferred spawn access from a %s directory",
    async (directory) => {
      const server = await startMockServer();
      const payload = await expectNonStreamingResponsesJson(server, {
        tools: [TOOL_CALL_TOOL],
        input: [
          makeUserInput(
            `${directory === "user-only" ? `${DEFERRED_SUBAGENT_TOOLS}\n` : ""}Subagent terminal reply QA check: visible.`,
          ),
        ],
      });
      expect(outputItems(payload).some((item) => item.type === "function_call")).toBe(false);
    },
  );

  it.each([false, true])(
    "binds crossed parent responses to matching workers (deferred=%s)",
    async (deferred) => {
      const server = await startMockServer();
      const firstChildSessionKey = "agent:qa:subagent:child-1";
      const secondChildSessionKey = "agent:qa:subagent:child-2";
      const startChild = (runtimeSessionId: string, childSessionKey: string) =>
        postNonStreamingResponses(server, {
          model: "gpt-5.6-luna",
          instructions: [
            `Runtime: embedded | sessionId=${runtimeSessionId}`,
            `- Your session: ${childSessionKey}.`,
          ].join("\n"),
          input: [makeUserInput("Subagent terminal reply QA worker: visible.")],
        });
      const settleParent = async (
        runtimeSessionId: string,
        childSessionKey: string,
        callId: string,
      ) => {
        const parent = await expectNonStreamingResponsesJson(server, {
          model: "gpt-5.6-luna",
          instructions: `Runtime: embedded | sessionId=${runtimeSessionId}`,
          tools: deferred ? [TOOL_CALL_TOOL] : [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
          input: [
            makeUserInput("Subagent terminal reply QA check: visible."),
            ...(deferred
              ? [
                  {
                    type: "function_call",
                    call_id: callId,
                    name: "tool_call",
                    arguments: JSON.stringify({ id: "sessions_spawn", args: {} }),
                  },
                ]
              : []),
            makeToolOutputWithCallId(
              callId,
              deferred
                ? deferredToolResult("sessions_spawn", {
                    status: "accepted",
                    childSessionKey,
                    runId: `run-${callId}`,
                  })
                : JSON.stringify({ status: "accepted", childSessionKey, runId: `run-${callId}` }),
            ),
          ],
        });
        expect(outputText(parent)).toBe("Worker started.");
      };

      const firstChildResponse = startChild("qa-terminal-child-1", firstChildSessionKey);
      const secondChildResponse = startChild("qa-terminal-child-2", secondChildSessionKey);
      let firstChildSettled = false;
      let secondChildSettled = false;
      void firstChildResponse.then(() => {
        firstChildSettled = true;
      });
      void secondChildResponse.then(() => {
        secondChildSettled = true;
      });

      await expect
        .poll(async () => {
          const inflight = await getJson<unknown[]>(server, "/debug/inflight-requests");
          return inflight.length;
        })
        .toBe(2);

      await settleParent("qa-terminal-parent-2", secondChildSessionKey, "call_spawn_2");
      const secondChild = await (await expectOk(secondChildResponse)).json();
      expect(outputText(secondChild)).toBe("QA-SUBAGENT-TERMINAL-VISIBLE-OK");
      expect(secondChildSettled).toBe(true);
      expect(firstChildSettled).toBe(false);

      await settleParent("qa-terminal-parent-1", firstChildSessionKey, "call_spawn_1");
      const firstChild = await (await expectOk(firstChildResponse)).json();
      expect(outputText(firstChild)).toBe("QA-SUBAGENT-TERMINAL-VISIBLE-OK");
    },
  );

  it.each([false, true])(
    "delivers silent terminal representation once (deferred=%s)",
    async (deferred) => {
      const server = await startMockServer();
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
        tools: deferred ? [TOOL_CALL_TOOL] : [MESSAGE_TOOL],
        instructions: `${deferred ? `${DEFERRED_SUBAGENT_TOOLS}\n` : ""}Visible source replies are not automatically delivered for this run. Use \`message(action=send)\` for user-visible source-channel output. When the message is the completed reply to the current source conversation, set \`final=true\`.`,
        input: completionInput,
      });
      const messageCall = outputToolCall(delivery, deferred ? "tool_call" : "message");
      const args = outputToolArgsFromItem(messageCall);
      expect(deferred ? args.args : args).toEqual({
        action: "send",
        message: "QA-SUBAGENT-TERMINAL-SILENT-REPRESENTED",
        final: true,
      });

      const settled = await expectNonStreamingResponsesJson(server, {
        tools: deferred ? [TOOL_CALL_TOOL] : [MESSAGE_TOOL],
        ...(deferred ? { instructions: DEFERRED_SUBAGENT_TOOLS } : {}),
        input: [
          ...completionInput,
          messageCall,
          makeToolOutputWithCallId(
            outputToolCallId(messageCall, "call_mock_message_silent_terminal"),
            deferred
              ? deferredToolResult("message", { ok: true, messageId: "qa-silent-terminal" })
              : '{"ok":true,"messageId":"qa-silent-terminal"}',
          ),
        ],
      });
      expect(outputItems(settled).some((item) => item.type === "function_call")).toBe(false);
      expect(outputText(settled)).toBe("");
    },
  );
});
