#!/usr/bin/env node
import { createHash } from "node:crypto";
// Deterministic provider for the opt-in shared-progress channel lifecycle scenarios.
// The provider chooses tools; actual OpenClaw tools, workers and the selected live transport perform all work.
import http from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { readBody, writeJson, writeSse, writeRequestLogEntryOrFail } = await import(
  pathToFileURL(resolve("scripts/e2e/lib/mock-openai-http.mjs")).href
);
const port = Number(process.env.MOCK_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("An explicit MOCK_PORT is required.");
const children = ["Maple", "Cedar"];
const holds = { Maple: 60, Cedar: 85 };
const internal =
  /\[Internal task completion event\]|OpenClaw runtime context \(internal\)|\[Subagent Context\] Every subagent spawned/u;
const text = (value) =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((part) => part.text ?? "").join("\n")
      : "";
const id = (run, stage) =>
  `sprg${createHash("sha256").update(`${run}:${stage}`).digest("hex").slice(0, 20)}`;
const required = (value, needle, stage) => {
  if (!value.includes(needle)) throw new Error(`${stage}: actual tool result lacks ${needle}`);
};
function schema(body, name) {
  const value = body.tools?.find(
    (entry) => entry.type === "function" && entry.function?.name === name,
  )?.function?.parameters;
  if (!value?.properties)
    throw new Error(
      `Required tool ${name} was not advertised. Check tool policy/codeMode/toolSearch.`,
    );
  return value;
}
function reply(body, run, stage, name) {
  const call = body.messages
    .flatMap((message) => (message.role === "assistant" ? (message.tool_calls ?? []) : []))
    .find((entry) => entry.id === id(run, stage));
  if (!call) return undefined;
  if (call.function?.name !== name) throw new Error(`${stage}: tool name changed.`);
  const result = body.messages.findLast(
    (message) => message.role === "tool" && message.tool_call_id === call.id,
  );
  if (!result) throw new Error(`${stage}: no delivered result; refusing duplicate call.`);
  return text(result.content);
}
function tool(body, run, stage, name, args, commentary) {
  const params = schema(body, name);
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(params.properties, key))
      throw new Error(`${name}.${key} was not advertised.`);
  }
  for (const key of params.required ?? []) {
    if (!Object.hasOwn(args, key)) throw new Error(`${name}.${key} is required.`);
  }
  return {
    stage,
    commentary,
    call: {
      id: id(run, stage),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  };
}
function exec(body, run, stage, title, command, seconds, commentary) {
  const args = { title, command, timeoutSeconds: seconds };
  if (Object.hasOwn(schema(body, "exec").properties, "yieldMs")) args.yieldMs = 120000;
  return tool(body, run, stage, "exec", args, commentary);
}
function resultPattern(run, name) {
  return new RegExp(
    `SHARED_CHILD_RESULT run=${run} name=${name} proof=([a-f0-9]{32}) command=ok`,
    "u",
  );
}
function delivered(body, run) {
  const results = new Map();
  for (const message of body.messages) {
    if (!["user", "system", "developer"].includes(message.role)) continue;
    const content = text(message.content);
    if (!internal.test(content)) continue;
    for (const block of content.matchAll(
      /Child result[^\n]*\n<prompt-data>\n([\s\S]*?)\n<\/prompt-data>/gu,
    )) {
      for (const name of children) {
        const result = resultPattern(run, name).exec(block[1]);
        if (!result) continue;
        if (results.has(name) && results.get(name) !== result[0])
          throw new Error(`Conflicting delivered ${name} result.`);
        results.set(name, result[0]);
      }
    }
  }
  return results;
}
const execAbortReason = (output) =>
  output
    .split("\n")
    .map((line) => line.trim().replace(/^Error: /u, ""))
    .find((line) =>
      /^(?:Tool execution was aborted|Command aborted by signal (?:SIGTERM|SIGKILL)|Command aborted before exit code was captured)$/u.test(
        line,
      ),
    );
function interruptedChild(run, name, stage, reason) {
  return {
    stage: `${name}-interrupted`,
    commandFailure: { stage, reason },
    final: `SHARED_CHILD_INTERRUPTED run=${run} name=${name} reason=${reason}`,
  };
}
const missingToolResult =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
const unknownChildReport = (run, name) =>
  `SHARED_CHILD_UNKNOWN run=${run} name=${name} outcome=unknown reason=missing tool result after gateway restart`;
function unknownChild(body, run, name, stage, output) {
  if (output !== missingToolResult) return undefined;
  const notice = `[System] Your previous turn was interrupted by a gateway restart. Your original task was:\n\nSHARED_PROGRESS_CHILD run=${run} name=${name}\n`;
  const recovered = body.messages.some(
    (message) =>
      ["user", "system", "developer"].includes(message.role) &&
      text(message.content).includes(notice),
  );
  if (!recovered) return undefined;
  return {
    stage: `${name}-unknown`,
    commandOutcome: {
      status: "unknown",
      stage,
      toolCallId: id(run, stage),
      sentinel: output,
      restartRecoveryNotice: true,
    },
    final: unknownChildReport(run, name),
  };
}
function refuseChildExec(run, name, stage, output) {
  const error = new Error(`${name}: no expected proof in actual ${stage} exec output.`);
  error.fixtureToolResult = {
    run,
    actor: name,
    stage,
    toolCallId: id(run, stage),
    text: output.slice(0, 2048),
    textLength: output.length,
    truncated: output.length > 2048,
  };
  throw error;
}
function deliveredFailures(body, run, accepted) {
  const failures = new Map();
  const save = (name, status, source, reason) => {
    const prior = failures.get(name);
    if (
      prior &&
      prior.status !== status &&
      ![prior.status, status].includes("command_interrupted")
    ) {
      throw new Error(`Conflicting delivered ${name} terminal status.`);
    }
    // A command interruption and a core task failure can describe the same child.
    if (!prior || prior.status === "command_interrupted")
      failures.set(name, { name, status, source, ...(reason ? { reason } : {}) });
  };
  const terminalStatus = (value) => /^(error|timeout|cancelled)(?:: .+)?$/u.exec(value)?.[1];
  const interruption = (value, name) => {
    if (value.split("\n").includes(unknownChildReport(run, name))) {
      save(
        name,
        "command_unknown",
        "delivered-child-unknown-result",
        "missing tool result after gateway restart",
      );
    }
    const prefix = `SHARED_CHILD_INTERRUPTED run=${run} name=${name} reason=`;
    const line = value.split("\n").find((line) => line.startsWith(prefix));
    if (!line) return;
    const reason = line.slice(prefix.length);
    if (!execAbortReason(reason)) throw new Error(`${name}: unsupported interruption report.`);
    save(name, "command_interrupted", "delivered-child-command-result", reason);
  };
  for (const message of body.messages) {
    if (!["user", "system", "developer"].includes(message.role)) continue;
    const content = text(message.content);
    if (!internal.test(content)) continue;
    const blocks = [
      ...content.matchAll(/Child result[^\n]*\n<prompt-data>\n([\s\S]*?)\n<\/prompt-data>/gu),
    ].map((match) => match[1]);
    for (const block of blocks) for (const name of children) interruption(block, name);
    // Protected internal events wrap findings once; only decode a recognized findings block.
    const findings = [
      content,
      ...blocks
        .filter((block) => block.startsWith("Child completion results:\n"))
        .map((block) =>
          block
            .replaceAll("&lt;prompt-data&gt;", "<prompt-data>")
            .replaceAll("&lt;/prompt-data&gt;", "</prompt-data>"),
        ),
    ];
    for (const fragment of findings) {
      if (!fragment.includes("Child completion results:\n")) continue;
      for (const section of fragment.matchAll(
        /(?:^|\n)\d+\. Child task[^\n]*\n<prompt-data>\n(maple|cedar|Maple|Cedar)\n<\/prompt-data>\nstatus: ([^\n]+)\nChild result[^\n]*\n<prompt-data>\n([\s\S]*?)\n<\/prompt-data>/gu,
      )) {
        const name = children.find((name) => name.toLowerCase() === section[1].toLowerCase());
        if (!accepted.has(name))
          throw new Error("Terminal findings have no accepted fixture spawn.");
        const status = terminalStatus(section[2]);
        if (status) save(name, status, "delivered-child-terminal-status");
        else if (section[2] === "ok") interruption(section[3], name);
      }
    }
    // Individual completion events are bound to the actual accepted child session.
    for (const event of content.matchAll(
      /\[Internal task completion event\]\nsource: subagent\nsession_key: ([^\n]+)\nsession_id: [^\n]+\ntype: [^\n]+\ntask: [^\n]+\nstatus: ([^\n]+)/gu,
    )) {
      const name = children.find((name) => accepted.get(name)?.childSessionKey === event[1]);
      if (!name) continue;
      const status = /^(failed|timed out|cancelled)(?:: .+)?$/u.exec(event[2])?.[1];
      if (status)
        save(
          name,
          status === "failed" ? "error" : status === "timed out" ? "timeout" : status,
          "delivered-child-terminal-status",
        );
    }
  }
  return failures;
}
function child(body, run, name) {
  const preparation = reply(body, run, `${name}-prepare`, "exec");
  const marker = `SHARED_CHILD_PREP run=${run} name=${name}`;
  if (preparation === undefined)
    return exec(
      body,
      run,
      `${name}-prepare`,
      `${name}: prepare synthetic output`,
      `sleep 20; printf '%s\\n' '${marker}'`,
      35,
      `${name} public preparation: I am running a harmless wait-and-print command. No private reasoning or external data is used.`,
    );
  const preparationUnknown = unknownChild(body, run, name, `${name}-prepare`, preparation);
  if (preparationUnknown) return preparationUnknown;
  const preparationAbort = execAbortReason(preparation);
  if (preparationAbort) return interruptedChild(run, name, `${name}-prepare`, preparationAbort);
  if (!preparation.includes(marker)) refuseChildExec(run, name, `${name}-prepare`, preparation);
  const output = reply(body, run, `${name}-hold`, "exec");
  if (output === undefined) {
    const script = `process.stdout.write('SHARED_CHILD_RESULT run=${run} name=${name} proof='+require('node:crypto').randomBytes(16).toString('hex')+' command=ok\\n')`;
    return exec(
      body,
      run,
      `${name}-hold`,
      `${name}: synthetic completion hold`,
      `sleep ${holds[name]}; node -e ${JSON.stringify(script)}`,
      holds[name] + 15,
      `${name} public command activity: preparation passed. This harmless command waits ${holds[name]} seconds, then generates a proof value from actual command output.`,
    );
  }
  const commandUnknown = unknownChild(body, run, name, `${name}-hold`, output);
  if (commandUnknown) return commandUnknown;
  const commandAbort = execAbortReason(output);
  if (commandAbort) return interruptedChild(run, name, `${name}-hold`, commandAbort);
  const result = resultPattern(run, name).exec(output);
  if (!result) refuseChildExec(run, name, `${name}-hold`, output);
  return { stage: `${name}-final`, final: result[0] };
}
const plan = (state) => [
  { step: "Run the parent command", status: state === "start" ? "in_progress" : "completed" },
  {
    step: "Wait for Maple and Cedar commands",
    status: state === "start" ? "pending" : state === "done" ? "completed" : "in_progress",
  },
  { step: "Summarize the delivered results", status: state === "done" ? "completed" : "pending" },
];
function cancel(body, run) {
  const listed = reply(body, run, "cancel-list", "subagents");
  if (listed === undefined)
    return tool(
      body,
      run,
      "cancel-list",
      "subagents",
      { action: "list" },
      "The driver requested cancellation of this synthetic work. I will find actual task IDs in my own session tree.",
    );
  const result = JSON.parse(listed);
  if (result.status !== "ok" || !Array.isArray(result.tasks))
    throw new Error("Cancellation list did not return actual tasks.");
  const targets = children.map((name) => {
    const matches = result.tasks.filter(
      (task) => task.label === name && ["running", "queued"].includes(task.status),
    );
    if (matches.length !== 1 || !matches[0].taskId)
      throw new Error(`Cancellation needs one active ${name} task, not ${matches.length}.`);
    return { name, taskId: matches[0].taskId };
  });
  for (const target of targets) {
    const stage = `cancel-${target.name}`;
    const output = reply(body, run, stage, "subagents");
    if (output === undefined)
      return tool(
        body,
        run,
        stage,
        "subagents",
        { action: "cancel", taskId: target.taskId },
        `I am cancelling ${target.name} by its observed task ID. This is a real subagents tool action, not a native channel command.`,
      );
    const receipt = JSON.parse(output);
    if (
      receipt.status !== "cancelled" ||
      receipt.cancelled !== true ||
      receipt.taskId !== target.taskId
    ) {
      throw new Error(`${target.name}: no confirmed cancellation receipt.`);
    }
  }
  const marker = `SHARED_PROGRESS_CANCELLED run=${run}`;
  return {
    stage: "cancel-final",
    cancelledTasks: targets,
    final: `${marker}\nBoth synthetic worker tasks returned confirmed cancellation receipts. No successful command result is claimed.`,
  };
}
function parent(body, run) {
  const checklist = reply(body, run, "parent-checklist", "progress_card");
  if (checklist === undefined)
    return tool(
      body,
      run,
      "parent-checklist",
      "progress_card",
      {
        markdown: `Synthetic delegation check. Run ${run}.`,
        plan: plan("start"),
      },
      `Run ${run}. I am creating a three-step checklist before starting one parent command and two real workers.`,
    );
  required(checklist, "Progress card updated", "parent-checklist");
  const output = reply(body, run, "parent-command", "exec");
  const marker = `SHARED_PARENT_COMMAND run=${run}`;
  if (output === undefined)
    return exec(
      body,
      run,
      "parent-command",
      "Check synthetic parent command",
      `sleep 20; printf '%s\\n' '${marker}'`,
      35,
      "Parent public command activity: I will run a harmless wait-and-print command, spawn Maple and Cedar, yield, then answer only from delivered results.",
    );
  required(output, marker, "parent-command");
  const accepted = new Map();
  for (const name of children) {
    const output = reply(body, run, `spawn-${name}`, "sessions_spawn");
    if (output === undefined)
      return tool(
        body,
        run,
        `spawn-${name}`,
        "sessions_spawn",
        {
          task: `SHARED_PROGRESS_CHILD run=${run} name=${name}\nRun the two synthetic exec steps provided by this fixture. Emit public commentary before each command. Return only the proof line from actual exec output. Never invent results, read credentials, contact services, or change files.`,
          taskName: name.toLowerCase(),
          label: name,
          runtime: "subagent",
          mode: "run",
          context: "isolated",
          cleanup: "keep",
          runTimeoutSeconds: 180,
          expectsCompletionMessage: true,
        },
        `The parent command passed. I am starting ${name} as a real independent worker with public commentary and bounded command activity.`,
      );
    const receipt = JSON.parse(output);
    if (receipt.status !== "accepted" || !receipt.childSessionKey || !receipt.runId)
      throw new Error(`${name}: no accepted spawn receipt.`);
    accepted.set(name, receipt);
  }
  const waiting = reply(body, run, "parent-checklist-waiting", "progress_card");
  if (waiting === undefined)
    return tool(
      body,
      run,
      "parent-checklist-waiting",
      "progress_card",
      {
        markdown: `Parent command passed; Maple and Cedar were accepted. Run ${run}.`,
        plan: plan("wait"),
      },
      "I will preserve all three checklist steps while Maple and Cedar run their commands.",
    );
  required(waiting, "Progress card updated", "parent-checklist-waiting");
  const results = delivered(body, run);
  const yielded = reply(body, run, "parent-yield", "sessions_yield");
  if (yielded === undefined) {
    if (results.size) throw new Error("A child completed before the required yield checkpoint.");
    return tool(
      body,
      run,
      "parent-yield",
      "sessions_yield",
      {
        message: `SHARED_PROGRESS_WAIT run=${run}. Resume only from actual delivered Child result blocks.`,
      },
      `SHARED_PROGRESS_WAIT run=${run}. Maple and Cedar are accepted. I yield this parent turn while their real commands continue. Keep this public explanation, checklist and command activity on the same progress card.`,
    );
  }
  if (JSON.parse(yielded).status !== "yielded") throw new Error("Parent did not actually yield.");
  const failures = deliveredFailures(body, run, accepted);
  for (const name of failures.keys()) {
    if (results.has(name))
      throw new Error(`${name}: both success proof and terminal failure were delivered.`);
  }
  if (failures.size) {
    const settled = children.filter((name) => results.has(name) || failures.has(name));
    if (settled.length === children.length) {
      const marker = `SHARED_PROGRESS_INTERRUPTED run=${run}`;
      if (
        body.messages.some(
          (message) => message.role === "assistant" && text(message.content).includes(marker),
        )
      )
        return { stage: "interrupted-already-final", final: "NO_REPLY" };
      return {
        stage: "parent-interrupted",
        delivered: settled,
        deliveredNonSuccess: [...failures.values()],
        final: `${marker}\n${children
          .map((name) =>
            failures.has(name)
              ? `${name}: ${failures.get(name).status}${failures.get(name).reason ? ` (${failures.get(name).reason})` : ""}.`
              : `${name}: command result was delivered.`,
          )
          .join(
            "\n",
          )}\nThe failed, interrupted or unconfirmed work has no successful command proof. No retry was started.`,
      };
    }
    const stage = `parent-wait-after-terminal-${settled.join("-")}`;
    if (reply(body, run, stage, "sessions_yield") !== undefined)
      throw new Error("Repeated terminal wake without another delivered child outcome.");
    return {
      ...tool(
        body,
        run,
        stage,
        "sessions_yield",
        {
          message: `SHARED_PROGRESS_WAIT run=${run}. A real child terminal outcome arrived; wait for the remaining child.`,
        },
        `${settled.join(" and ")} has a delivered terminal outcome. I will wait for the remaining worker without claiming success.`,
      ),
      delivered: settled,
      deliveredNonSuccess: [...failures.values()],
    };
  }
  if (results.size === children.length) {
    const marker = `SHARED_PROGRESS_FINAL run=${run}`;
    if (
      body.messages.some(
        (message) => message.role === "assistant" && text(message.content).includes(marker),
      )
    )
      return { stage: "already-final", final: "NO_REPLY" };
    const complete = reply(body, run, "parent-checklist-complete", "progress_card");
    if (complete === undefined)
      return {
        ...tool(
          body,
          run,
          "parent-checklist-complete",
          "progress_card",
          {
            markdown: `Both real worker results arrived after yield. Run ${run}.`,
            plan: plan("done"),
          },
          "Both command proofs arrived through real child completion context. I can now finish the checklist and report them.",
        ),
        delivered: [...results.keys()],
      };
    required(complete, "Progress card updated", "parent-checklist-complete");
    return {
      stage: "parent-final",
      delivered: [...results.keys()],
      final: `${marker}\nMaple and Cedar completed their real synthetic commands after the parent yielded.\n${children.map((name) => results.get(name)).join("\n")}\nBoth command checks passed. Final public result ends here.`,
    };
  }
  if (!results.size)
    throw new Error("Parent resumed with no actual child result; no success fallback.");
  const names = [...results.keys()].sort();
  const stage = `parent-wait-after-${names.join("-")}`;
  if (reply(body, run, stage, "sessions_yield") !== undefined)
    throw new Error("Repeated wake without another actual result.");
  return {
    ...tool(
      body,
      run,
      stage,
      "sessions_yield",
      {
        message: `SHARED_PROGRESS_WAIT run=${run}. Received ${names.join(", ")}; still waiting for the remaining result.`,
      },
      `${names.join(" and ")} returned actual command output. I will wait for the other worker without inventing a result.`,
    ),
    delivered: names,
  };
}
function secondTurn(body, run) {
  const card = reply(body, run, "second-card", "progress_card");
  if (card === undefined)
    return tool(
      body,
      run,
      "second-card",
      "progress_card",
      {
        markdown: `Second foreground turn. Run ${run}.`,
        plan: [{ step: "Check the second foreground command", status: "in_progress" }],
      },
      `SHARED_SECOND_ACTIVE run=${run}. The original workers remain independent.`,
    );
  required(card, "Progress card updated", "second-card");
  const output = reply(body, run, "second-command", "exec");
  const marker = `SHARED_SECOND_COMMAND run=${run}`;
  if (output === undefined)
    return exec(
      body,
      run,
      "second-command",
      "Second foreground command",
      `sleep 8; printf '%s\\n' '${marker}'`,
      20,
      "Running only the second foreground command; I am not claiming the old workers finished.",
    );
  required(output, marker, "second-command");
  return {
    stage: "second-final",
    final: `SHARED_SECOND_FINAL run=${run}. The second command returned its actual marker. The original workers have independent outcomes.`,
  };
}
function decide(body) {
  if (!Array.isArray(body.messages)) throw new Error("Use openai-completions messages.");
  const inputs = body.messages.filter(
    (message) => message.role === "user" && !internal.test(text(message.content)),
  );
  for (const input of inputs) {
    const match = /SHARED_PROGRESS_CHILD run=(SP-[a-z0-9-]+) name=(Maple|Cedar)\b/u.exec(
      text(input.content),
    );
    if (match) return { run: match[1], actor: match[2], ...child(body, match[1], match[2]) };
  }
  const request = inputs
    .map((input) => /SHARED_PROGRESS_PARENT run=(SP-[a-z0-9-]+)\b/u.exec(text(input.content)))
    .find(Boolean);
  if (!request) throw new Error("No synthetic scenario marker in actual request context.");
  const run = request[1];
  const secondRequested = inputs.some((input) =>
    text(input.content).includes(`SHARED_PROGRESS_SECOND run=${run}`),
  );
  const secondCompleted = body.messages.some(
    (message) =>
      message.role === "assistant" &&
      text(message.content).includes(`SHARED_SECOND_FINAL run=${run}`),
  );
  if (secondRequested && !secondCompleted)
    return { run, actor: "Second", ...secondTurn(body, run) };
  const cancelling =
    inputs.some((input) => text(input.content).includes(`SHARED_PROGRESS_CANCEL run=${run}`)) &&
    !body.messages.some(
      (message) =>
        message.role === "assistant" &&
        text(message.content).includes(`SHARED_PROGRESS_CANCELLED run=${run}`),
    );
  return { run, actor: "Parent", ...(cancelling ? cancel(body, run) : parent(body, run)) };
}
function respond(response, body, decision) {
  const content = decision.commentary ?? decision.final;
  const reason = decision.call ? "tool_calls" : "stop";
  if (!body.stream)
    return writeJson(response, 200, {
      id: "chatcmpl_shared_progress",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(decision.call ? { tool_calls: [decision.call] } : {}),
          },
          finish_reason: reason,
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
    });
  const chunk = (delta, finish_reason) => ({
    id: "chatcmpl_shared_progress",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, ...(finish_reason ? { finish_reason } : {}) }],
  });
  const middle = Math.floor(content.length / 2);
  writeSse(response, [
    chunk({ role: "assistant", content: "" }),
    chunk({ content: content.slice(0, middle) }),
    chunk({ content: content.slice(middle) }),
    ...(decision.call ? [chunk({ tool_calls: [{ index: 0, ...decision.call }] })] : []),
    chunk({}, reason),
  ]);
}
const issued = new Set();
const decisions = [];
const server = http.createServer((request, response) => {
  void (async () => {
    if (request.method === "GET" && request.url === "/health")
      return writeJson(response, 200, { ok: true, fixture: "shared-progress-v1" });
    if (request.method === "GET" && request.url === "/debug/requests")
      return writeJson(response, 200, decisions);
    if (request.method === "GET" && request.url === "/v1/models")
      return writeJson(response, 200, {
        object: "list",
        data: [{ id: "gpt-5.5", object: "model", owned_by: "shared-progress-fixture" }],
      });
    if (request.method !== "POST" || request.url !== "/v1/chat/completions")
      return writeJson(response, 404, {
        error: { message: "Use the provider API=openai-completions." },
      });
    const body = JSON.parse(await readBody(request));
    const decision = decide(body);
    decisions.push({ at: new Date().toISOString(), ...decision });
    if (decision.call) {
      if (issued.has(decision.call.id))
        throw new Error(`Repeated ${decision.stage} without observed tool result.`);
      issued.add(decision.call.id);
    }
    // Only synthetic fixture outputs and tool schemas; never log incoming prompt/history.
    if (
      writeRequestLogEntryOrFail(response, {
        requestLog: process.env.MOCK_REQUEST_LOG,
        required: true,
        entry: {
          at: new Date().toISOString(),
          method: request.method,
          path: request.url,
          ...decision,
          advertised: (body.tools ?? [])
            .filter((entry) =>
              ["exec", "sessions_spawn", "sessions_yield", "progress_card", "subagents"].includes(
                entry.function?.name,
              ),
            )
            .map((entry) => ({ name: entry.function.name, parameters: entry.function.parameters })),
        },
      })
    )
      return;
    respond(response, body, decision);
  })().catch((error) => {
    const entry = {
      at: new Date().toISOString(),
      fixtureError: error.message,
      ...(error.fixtureToolResult ? { fixtureToolResult: error.fixtureToolResult } : {}),
    };
    if (
      !writeRequestLogEntryOrFail(response, {
        requestLog: process.env.MOCK_REQUEST_LOG,
        entry,
        required: true,
      })
    ) {
      writeJson(response, 400, {
        error: { message: `Shared-progress fixture refused to advance: ${error.message}` },
      });
    }
  });
});
server.listen(port, "127.0.0.1", () => console.log(`mock-openai listening on ${port}`));
