import { describe, expect, it } from "vitest";
import type { ResponsesInputItem } from "./mock-openai-contracts.js";
import {
  createMockServerTestHarness,
  expectNonStreamingResponsesJson,
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
const COMPACT_TOOLS = [
  "exec",
  "write",
  "sessions_yield",
  "tool_search",
  "tool_describe",
  "tool_call",
].map((name) => ({ type: "function", name }));

function catalogResult(name: string, id: string) {
  return JSON.stringify({
    results: [{ query: name, candidates: [{ id, name, source: "openclaw" }] }],
  });
}

function dispatchedResult(name: string, id: string, details: unknown) {
  return JSON.stringify({
    tool: { id, name, source: "openclaw" },
    result: { content: [{ type: "text", text: JSON.stringify(details) }], details },
  });
}

describe("mock scenario tools on a compact search surface", () => {
  it.each([
    {
      name: "fanout",
      prompt:
        "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.",
      labels: ["qa-fanout-alpha", "qa-fanout-beta"],
    },
    {
      name: "handoff",
      prompt: "Delegate one bounded QA task to a subagent and report its result.",
      labels: ["qa-sidecar"],
    },
  ])(
    "preserves $name state until discovered workers are dispatched",
    async ({ name, prompt, labels }) => {
      const server = await startMockServer();
      const input: ResponsesInputItem[] = [makeUserInput(prompt)];
      const instructions = `Runtime: embedded | sessionId=qa-discovery-${name}`;
      const request = () =>
        expectNonStreamingResponsesJson(server, { tools: COMPACT_TOOLS, instructions, input });
      const targetId = "openclaw:fixture:sessions_spawn";
      for (const [index, label] of labels.entries()) {
        const discovery = await request();
        const search = outputToolCall(discovery, "tool_search");
        expect(outputToolArgsFromItem(search)).toEqual({
          queries: [{ query: "sessions_spawn", limit: 1 }],
        });
        expect(outputItems(discovery)).toEqual([search]);
        input.push(
          search,
          makeToolOutputWithCallId(
            outputToolCallId(search, "call_mock_search"),
            catalogResult("sessions_spawn", targetId),
          ),
        );
        const dispatched = await request();
        const spawn = outputToolCall(dispatched, "tool_call");
        expect(outputToolArgsFromItem(spawn)).toMatchObject({ id: targetId, args: { label } });
        expect(outputItems(dispatched)).toEqual([spawn]);
        input.push(
          spawn,
          makeToolOutputWithCallId(
            outputToolCallId(spawn, "call_mock_spawn"),
            dispatchedResult("sessions_spawn", targetId, {
              status: "accepted",
              childSessionKey: `agent:qa:subagent:${label}`,
              note: index === 0 ? "ALPHA-OK" : "BETA-OK",
            }),
          ),
        );
      }
      const final = await request();
      if (name === "fanout") {
        expect(outputText(final)).toBe("subagent-1: ok\nsubagent-2: ok");
        expect(outputItems(final).some((item) => item.type === "function_call")).toBe(false);
      } else {
        const yielded = outputToolCall(final, "sessions_yield");
        expect(outputToolArgsFromItem(yielded)).toEqual({
          message: "Waiting for the bounded QA subagent to finish.",
        });
        expect(outputItems(final)).toEqual([yielded]);
      }
      const requests = await getJson<
        Array<{ plannedToolName?: string; plannedToolArgs?: { label?: string } }>
      >(server, "/debug/requests");
      expect(
        requests
          .filter((recordedRequest) => recordedRequest.plannedToolName === "sessions_spawn")
          .map((recordedRequest) => recordedRequest.plannedToolArgs?.label),
      ).toEqual(labels);
    },
  );

  it.each([true, false])(
    "search-only discovery dispatches only with an added direct declaration: %s",
    async (declared) => {
      const server = await startMockServer();
      const tools = [{ type: "function", name: "tool_search" }];
      const input: ResponsesInputItem[] = [
        makeUserInput(
          "Subagent terminal reply QA check: empty. Reply to the requester after spawning.",
        ),
      ];
      const discovery = await expectNonStreamingResponsesJson(server, { tools, input });
      const search = outputToolCall(discovery, "tool_search");
      expect(outputToolArgsFromItem(search)).toEqual({
        queries: [{ query: "sessions_spawn", limit: 1 }],
      });
      expect(outputItems(discovery)).toEqual([search]);
      input.push(
        search,
        makeToolOutputWithCallId(
          outputToolCallId(search, "call_mock_search"),
          catalogResult("sessions_spawn", "openclaw:fixture:sessions_spawn"),
        ),
      );
      if (!declared) {
        const rejected = await postResponses(server, { stream: false, tools, input });
        expect(rejected.status).toBe(500);
        expect(await rejected.json()).toEqual({
          error: "QA mock target tool has no declared dispatch surface: sessions_spawn",
        });
        expect(await getJson(server, "/debug/requests")).toEqual([
          expect.objectContaining({ plannedToolName: "tool_search" }),
        ]);
        return;
      }
      input.push({
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "session_tools",
            tools: [{ type: "function", name: "sessions_spawn" }],
          },
        ],
      });
      const dispatch = await expectNonStreamingResponsesJson(server, { tools, input });
      const spawn = outputToolCall(dispatch, "sessions_spawn");
      expect(spawn.namespace).toBe("session_tools");
      expect(outputToolArgsFromItem(spawn)).toEqual({
        task: "Subagent terminal reply QA worker: empty. Return no assistant output after the write.",
        label: "qa-terminal-empty",
        thread: false,
        mode: "run",
      });
      expect(outputItems(dispatch)).toEqual([spawn]);
      input.push(
        spawn,
        makeToolOutputWithCallId(
          outputToolCallId(spawn, "call_mock_spawn"),
          JSON.stringify({ status: "accepted", childSessionKey: "agent:qa:subagent:empty" }),
        ),
      );
      const acknowledged = await expectNonStreamingResponsesJson(server, { tools, input });
      expect(outputText(acknowledged)).toBe("QA-SUBAGENT-EMPTY-PARENT-ACK");
      expect(outputItems(acknowledged).some((item) => item.type === "function_call")).toBe(false);
    },
  );

  it.each([
    { name: "absent", candidates: [] },
    {
      name: "mismatched",
      candidates: [{ id: "openclaw:fixture:sessions_send", name: "sessions_send" }],
    },
  ])(
    "does not dispatch or acknowledge a spawn with a $name catalog result",
    async ({ candidates }) => {
      const server = await startMockServer();
      const input: ResponsesInputItem[] = [
        makeUserInput(
          "Subagent terminal reply QA check: empty. Reply to the requester after spawning.",
        ),
      ];
      const discovery = await expectNonStreamingResponsesJson(server, {
        tools: COMPACT_TOOLS,
        input,
      });
      const search = outputToolCall(discovery, "tool_search");
      expect(outputItems(discovery)).toEqual([search]);
      input.push(
        search,
        makeToolOutputWithCallId(
          outputToolCallId(search, "call_mock_search"),
          JSON.stringify({ results: [{ query: "sessions_spawn", candidates }] }),
        ),
      );
      const rejected = await postResponses(server, { stream: false, tools: COMPACT_TOOLS, input });
      expect(rejected.status).toBe(500);
      expect(await rejected.json()).toEqual({
        error: "QA mock target tool unavailable after search: sessions_spawn",
      });
      expect(await getJson(server, "/debug/requests")).toEqual([
        expect.objectContaining({ plannedToolName: "tool_search" }),
      ]);
    },
  );

  it.each(["visible", "empty"])(
    "discovers and spawns the %s worker before acknowledging and releasing its result",
    async (terminalCase) => {
      const server = await startMockServer();
      const instructions = `Runtime: embedded | sessionId=qa-parent-${terminalCase}`;
      const childSessionKey = `agent:qa:subagent:${terminalCase}`;
      const targetId = "openclaw:fixture:sessions_spawn";
      const input: ResponsesInputItem[] = [
        makeUserInput(
          `Subagent terminal reply QA check: ${terminalCase}. Spawn one native worker, reply to the requester after spawning, then finish without waiting. Do not use ACP.`,
        ),
      ];
      const request = () =>
        expectNonStreamingResponsesJson(server, { tools: COMPACT_TOOLS, instructions, input });

      const discovery = await request();
      const search = outputToolCall(discovery, "tool_search");
      expect(outputToolArgsFromItem(search)).toEqual({
        queries: [{ query: "sessions_spawn", limit: 1 }],
      });
      expect(outputItems(discovery)).toEqual([search]);
      input.push(
        search,
        makeToolOutputWithCallId(
          outputToolCallId(search, "call_mock_search"),
          catalogResult("sessions_spawn", targetId),
        ),
      );

      const dispatch = await request();
      const spawn = outputToolCall(dispatch, "tool_call");
      const task =
        terminalCase === "empty"
          ? "Subagent terminal reply QA worker: empty. Return no assistant output after the write."
          : "Subagent terminal reply QA worker: visible.";
      expect(outputToolArgsFromItem(spawn)).toEqual({
        id: targetId,
        args: { task, label: `qa-terminal-${terminalCase}`, thread: false, mode: "run" },
      });
      expect(outputItems(dispatch)).toEqual([spawn]);
      expect(await getJson(server, "/debug/last-request")).toMatchObject({
        plannedToolName: "sessions_spawn",
        plannedWireToolName: "tool_call",
        plannedToolArgs: { task, label: `qa-terminal-${terminalCase}` },
      });
      input.push(
        spawn,
        makeToolOutputWithCallId(
          outputToolCallId(spawn, "call_mock_spawn"),
          dispatchedResult("sessions_spawn", targetId, {
            status: "accepted",
            childSessionKey,
            runId: `run-${terminalCase}`,
          }),
        ),
      );
      const acknowledged = await request();
      expect(outputItems(acknowledged).some((item) => item.type === "function_call")).toBe(false);
      expect(outputText(acknowledged)).toBe(
        terminalCase === "empty" ? "QA-SUBAGENT-EMPTY-PARENT-ACK" : "Worker started.",
      );

      // The worker waits for its matching requester acknowledgement. An opaque
      // tool_call envelope must not lose the accepted child session identity.
      const childInput: ResponsesInputItem[] = [makeUserInput(task)];
      const childRequest = () =>
        expectNonStreamingResponsesJson(server, {
          tools: COMPACT_TOOLS,
          instructions: `Runtime: embedded | sessionId=qa-child-${terminalCase}\n- Your session: ${childSessionKey}.`,
          input: childInput,
        });
      const child = await childRequest();
      if (terminalCase === "visible") {
        expect(outputText(child)).toBe("QA-SUBAGENT-TERMINAL-VISIBLE-OK");
      } else {
        const write = outputToolCall(child, "write");
        expect(outputItems(child)).toEqual([write]);
        expect(outputToolArgsFromItem(write)).toEqual({
          path: "qa-terminal-empty-side-effect.txt",
          content: "empty terminal QA side effect completed\n",
        });
        childInput.push(
          write,
          makeToolOutputWithCallId(outputToolCallId(write, "call_mock_write"), "Wrote 40 bytes"),
        );
        const completed = await childRequest();
        expect(outputText(completed)).toBe("");
        expect(outputItems(completed).some((item) => item.type === "function_call")).toBe(false);
      }
    },
  );

  it("recognizes a dispatched terminal message as completed instead of sending it again", async () => {
    const server = await startMockServer();
    const targetId = "openclaw:fixture:message";
    const input: ResponsesInputItem[] = [
      makeUserInput("Subagent terminal reply QA check: silent."),
      makeUserInput(
        "[Internal task completion event]\nTask: qa-terminal-silent\nResult: (no output)",
      ),
    ];
    const request = () => expectNonStreamingResponsesJson(server, { tools: COMPACT_TOOLS, input });
    const discovery = await request();
    const search = outputToolCall(discovery, "tool_search");
    expect(outputItems(discovery)).toEqual([search]);
    expect(outputToolArgsFromItem(search)).toEqual({ queries: [{ query: "message", limit: 1 }] });
    input.push(
      search,
      makeToolOutputWithCallId(
        outputToolCallId(search, "call_mock_search"),
        catalogResult("message", targetId),
      ),
    );
    const dispatched = await request();
    const message = outputToolCall(dispatched, "tool_call");
    expect(outputItems(dispatched)).toEqual([message]);
    expect(outputToolArgsFromItem(message)).toEqual({
      id: targetId,
      args: { action: "send", message: "QA-SUBAGENT-TERMINAL-SILENT-REPRESENTED" },
    });
    input.push(
      message,
      makeToolOutputWithCallId(
        outputToolCallId(message, "call_mock_message"),
        dispatchedResult("message", targetId, { ok: true, messageId: "qa-terminal-message" }),
      ),
    );
    const completed = await request();
    expect(outputText(completed)).toBe("");
    expect(outputItems(completed).some((item) => item.type === "function_call")).toBe(false);
  });
});
