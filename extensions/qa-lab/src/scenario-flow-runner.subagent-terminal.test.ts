import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

function readTerminalScenarioBody() {
  const scenario = readQaScenarioById("subagent-completion-direct-fallback");
  const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
  const body = actions
    .map(asOptionalRecord)
    .map((action) => asOptionalRecord(action?.try))
    .find(Boolean);
  if (!Array.isArray(body?.actions)) {
    throw new Error("Terminal completion flow has no protected scenario body");
  }
  return { scenario, actions: body.actions };
}

function readPublicTerminalChecks() {
  const { scenario, actions } = readTerminalScenarioBody();
  const loop = actions
    .map(asOptionalRecord)
    .map((action) => asOptionalRecord(action?.forEach))
    .find((action) => action?.item === "terminalCase");
  if (!Array.isArray(loop?.actions)) {
    throw new Error("Terminal completion flow has no public case loop");
  }
  const start = loop.actions.findIndex(
    (action) => asOptionalRecord(action)?.saveAs === "terminalTask",
  );
  const end = loop.actions.findIndex(
    (action) => asOptionalRecord(action)?.set === "appendDirectFallbackProof",
  );
  if (start < 0 || end <= start) {
    throw new Error("Terminal completion flow has no public readiness and acknowledgment checks");
  }
  const cases = scenario.execution.config?.cases;
  const terminalCase = expectDefined(
    Array.isArray(cases) ? asOptionalRecord(cases[0]) : undefined,
    "visible terminal case",
  );
  return {
    actions: loop.actions.slice(start, end),
    terminalCase,
    config: scenario.execution.config ?? {},
  };
}

async function runTerminalAcknowledgment(
  initialAck: "missing" | "deleted" | "foreign" | "duplicate",
) {
  const { actions, terminalCase, config } = readPublicTerminalChecks();
  const conversationId = "terminal-parent-ack";
  const marker = String(terminalCase.marker);
  const acknowledgment = String(config.parentAcknowledgment);
  const state = createQaBusState();
  const addAck = (conversation = conversationId) =>
    state.addOutboundMessage({
      accountId: "default",
      to: `dm:${conversation}`,
      text: acknowledgment,
    });
  state.addOutboundMessage({ accountId: "default", to: `dm:${conversationId}`, text: marker });
  if (initialAck === "deleted") {
    state.deleteMessage({ accountId: "default", messageId: addAck().id });
  } else if (initialAck === "foreign") {
    addAck("another-conversation");
  } else if (initialAck === "duplicate") {
    addAck();
    addAck();
  }
  return runLoadedScenarioFlow("subagent-completion-direct-fallback", {
    state,
    flow: {
      steps: [
        {
          name: "waits for independently delivered parent acknowledgment",
          actions: [
            { set: "terminalCase", value: terminalCase },
            { set: "conversationId", value: conversationId },
            { set: "startIndex", value: 0 },
            { set: "requestCursor", value: 0 },
            { set: "activePhase", value: "public:visible" },
            ...actions,
          ],
        },
      ],
    },
    api: {
      readSettledTerminalTask: async () => ({ taskId: "completed-child" }),
      readDirectFallbackReceipts: async () => [{ content: [{ type: "text", text: marker }] }],
      publishTerminalDiagnostic: async () => undefined,
      snapshotTerminalRequests: () => [],
      waitForCondition: async <T>(check: () => Promise<T | undefined>) => {
        const beforeAcknowledgment = await check();
        if (beforeAcknowledgment !== undefined) {
          return beforeAcknowledgment;
        }
        addAck();
        return expectDefined(await check(), "readiness after parent acknowledgment");
      },
    },
  });
}

describe("subagent terminal acknowledgment readiness", () => {
  it.each(["missing", "deleted", "foreign"] as const)(
    "waits for a live parent acknowledgment when the initial acknowledgment is %s",
    async (initialAck) => {
      await expect(runTerminalAcknowledgment(initialAck)).resolves.toMatchObject({
        status: "pass",
      });
    },
  );

  it("still rejects duplicate parent acknowledgments after readiness", async () => {
    await expect(runTerminalAcknowledgment("duplicate")).rejects.toThrow(
      "spawning parent did not acknowledge its completed turn",
    );
  });
});

async function runPrivateChronology(wireNames: string[], defect?: string) {
  const { actions } = readTerminalScenarioBody();
  const start = actions.findIndex(
    (action) => asOptionalRecord(action)?.set === "privateSpawnReceipts",
  );
  const end = actions.findIndex(
    (action) => asOptionalRecord(action)?.value === "private-outbound-settlement",
  );
  if (start < 0 || end <= start) {
    throw new Error("Terminal completion flow has no private receipt proof");
  }
  const spawns = wireNames.map((name, index) => ({
    plannedToolName: "sessions_spawn",
    ...(name !== "sessions_spawn" ? { plannedWireToolName: name } : {}),
    plannedToolCallId: `call-${index}`,
    plannedToolItemId: `item-${index}`,
  }));
  const events = wireNames.map((name, index) => ({
    name,
    ...(name === "tool_call" ? { targetName: "sessions_spawn" } : {}),
    toolCallId: `call-${index}|item-${index}`,
    timestamp: index === 0 ? 100 : 300,
  }));
  const counts: Record<string, number> = {};
  for (const name of wireNames) {
    counts[name] = (counts[name] ?? 0) + 1;
    if (name === "exec") {
      counts.sessions_spawn = (counts.sessions_spawn ?? 0) + 1;
    }
  }
  if (defect === "missing receipt") {
    events.pop();
  } else if (defect === "duplicate receipt") {
    const first = expectDefined(spawns[0], "first spawn");
    const second = expectDefined(spawns[1], "second spawn");
    second.plannedToolCallId = first.plannedToolCallId;
    second.plannedToolItemId = first.plannedToolItemId;
    expectDefined(events[0], "first receipt").timestamp = 250;
  } else if (defect === "extra call") {
    const name = expectDefined(wireNames[0], "first wire name");
    counts[name] = (counts[name] ?? 0) + 1;
  } else if (defect === "before completion") {
    expectDefined(events[1], "second receipt").timestamp = 199;
  } else if (defect === "wrong target") {
    expectDefined(events[1], "second receipt").targetName = "message";
  }
  return runLoadedScenarioFlow("subagent-completion-direct-fallback", {
    flow: {
      steps: [
        {
          name: "private completion wire chronology",
          actions: [
            { set: "privateSpawns", value: spawns },
            {
              set: "privateRequests",
              value:
                defect === "message attempt" ? [...spawns, { plannedToolName: "message" }] : spawns,
            },
            { set: "privateTasks", value: [{ endedAt: 200 }] },
            {
              set: "privateTranscript",
              value: { successfulToolCallCounts: counts, successfulToolCallEvents: events },
            },
            ...actions.slice(start, end),
          ],
        },
      ],
    },
  });
}

describe("subagent private completion wire receipts", () => {
  it.each([
    { name: "direct", wires: ["sessions_spawn", "sessions_spawn"] },
    { name: "structured Tool Search", wires: ["tool_call", "tool_call"] },
    { name: "Code Mode", wires: ["exec", "exec"] },
    { name: "mixed declarations", wires: ["sessions_spawn", "tool_call"] },
  ])("checks the two committed spawns over $name", async ({ wires }) => {
    await expect(runPrivateChronology(wires)).resolves.toMatchObject({ status: "pass" });
  });

  it.each([
    "missing receipt",
    "duplicate receipt",
    "extra call",
    "before completion",
    "message attempt",
    "wrong target",
  ])("rejects private completion proof with %s", async (defect) => {
    await expect(runPrivateChronology(["tool_call", "tool_call"], defect)).rejects.toThrow(
      "private continuation lacks committed tool chronology or tried external messaging",
    );
  });
});
