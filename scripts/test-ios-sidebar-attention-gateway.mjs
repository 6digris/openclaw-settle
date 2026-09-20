// Synthetic loopback Gateway for SidebarAttentionUITests. No provider or command execution.
// Run: node scripts/test-ios-sidebar-attention-gateway.mjs
// Forward these settings through xcodebuild's TEST_RUNNER_ environment prefix:
// OPENCLAW_IOS_ATTENTION_FIXTURE_URL=http://127.0.0.1:19877
// OPENCLAW_IOS_LIVE_SETUP_CODE={"url":"ws://127.0.0.1:19877","token":"synthetic-attention-token"}
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

// Native proof owners may request an ephemeral port; the listening banner reports it.
const portArg = process.argv.indexOf("--port");
const port = Number(portArg < 0 ? 19877 : process.argv[portArg + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("--port must be an integer from 0 to 65535");
}
const mainKey = "agent:main:main";
const parentKey = "agent:main:attention-parent";
const reviewKey = "agent:main:attention-review";
const requests = [];
let questions = [];
let approvals = [];
let created;
let eventSequence = 0;
let taskScenario;
const taskId = "native-progress-child";
const childKey = "agent:worker:subagent:native-progress";
const childRunId = "native-progress-worker-run";
const taskEvents = [];
const taskRequests = [];

function resetTaskScenario() {
  reset();
  questions = [];
  approvals = [];
  taskEvents.length = 0;
  taskRequests.length = 0;
  taskScenario = { stage: "ready", revision: 0, messages: [], parentYielded: false };
}

function taskCard() {
  if (!taskScenario?.parentRunId) {
    return null;
  }
  return {
    sessionKey: mainKey,
    revision: 1,
    updatedAt: created,
    markdown: "Authored checklist; worker updates do not rewrite these steps.",
    steps: [
      { step: "Review synthetic notes", status: "in_progress" },
      { step: "Report synthetic result", status: "pending" },
    ],
  };
}

function taskSnapshot() {
  if (!taskScenario?.parentRunId) {
    return undefined;
  }
  const { stage, revision } = taskScenario;
  const terminal = stage === "failed" || stage === "completed";
  const unknown = stage === "unknown";
  const commentary =
    stage === "yielded"
      ? "Prepared worker commentary: reviewing synthetic notes."
      : "Prepared worker commentary: checking synthetic evidence.";
  return {
    id: taskId,
    taskId,
    kind: "subagent",
    runtime: "subagent",
    status: terminal ? stage : "running",
    title: "Synthetic worker",
    agentId: "worker",
    sessionKey: mainKey,
    ownerKey: mainKey,
    childSessionKey: childKey,
    runId: childRunId,
    hasTranscript: true,
    createdAt: created,
    startedAt: created,
    updatedAt: created + revision,
    execution: { state: terminal ? "finished" : unknown ? "unknown" : "running" },
    ...(terminal
      ? {
          endedAt: created + revision,
          terminalSummary: `Synthetic worker ${stage}; no command was executed.`,
          deliveryStatus: "not_applicable",
        }
      : {
          progress: {
            runId: childRunId,
            revision,
            items: [
              {
                itemId: "native-progress-commentary",
                kind: "preamble",
                phase: "end",
                title: "Worker commentary",
                progressText: commentary,
              },
              ...(stage === "yielded"
                ? []
                : [
                    {
                      itemId: "native-progress-command",
                      toolCallId: "native-progress-command",
                      kind: "tool",
                      phase: unknown ? "end" : "start",
                      name: "exec",
                      title: unknown
                        ? "printf synthetic-outcome-unavailable"
                        : "printf synthetic-progress-check",
                      ...(unknown ? {} : { status: "running" }),
                    },
                  ]),
            ],
          },
        }),
  };
}

function taskForPeer(task, ws) {
  if (ws.proofTaskProgress || !task?.progress) {
    return task;
  }
  const { progress: _progress, ...legacy } = task;
  return legacy;
}

function taskMessage(role, text, id, runId) {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: created + taskScenario.revision,
    __openclaw: { id, runId },
  };
}

function emitTask() {
  broadcast("task", { action: "upserted", task: taskSnapshot() });
}

function advanceTaskScenario(stage) {
  if (!taskScenario?.parentYielded || ["failed", "completed"].includes(taskScenario.stage)) {
    throw new Error("Send the synthetic parent prompt before advancing an active task");
  }
  const expected = { yielded: ["working"], working: ["unknown"], unknown: ["failed", "completed"] };
  if (!expected[taskScenario.stage]?.includes(stage)) {
    throw new Error("Expected working, unknown, then failed or completed");
  }
  taskScenario.stage = stage;
  taskScenario.revision += 1;
  emitTask();
  if (stage === "failed" || stage === "completed") {
    const message = taskMessage(
      "assistant",
      `Synthetic final: ${stage} fixture result; no command was executed.`,
      "native-progress-final",
      "native-progress-delivery",
    );
    taskScenario.messages.push(message);
    broadcast("chat", {
      runId: "native-progress-delivery",
      sessionKey: mainKey,
      agentId: "main",
      state: "final",
      message,
    });
  }
}

function taskEvidence() {
  return {
    scenario: taskScenario ? "task-progress" : null,
    stage: taskScenario?.stage ?? null,
    sessionKey: mainKey,
    taskId,
    parentYielded: taskScenario?.parentYielded ?? false,
    requests: taskRequests,
    connections: [...wss.clients]
      .filter((ws) => ws.proofRole)
      .map((ws) => ({
        role: ws.proofRole,
        taskProgress: ws.proofTaskProgress,
        protocol: ws.proofProtocol,
      })),
    events: taskEvents,
    task: taskSnapshot() ?? null,
    card: taskCard(),
    assistantMessages: (taskScenario?.messages ?? [])
      .filter((message) => message.role === "assistant")
      .map((message) => ({ id: message["__openclaw"].id, text: message.content[0].text })),
  };
}

function reset() {
  taskScenario = undefined;
  created = Date.now();
  questions = ["Which draft should we review first?", "Should the summary include a timeline?"].map(
    (question, index) => ({
      id: `attention-question-${index + 1}`,
      questions: [
        {
          questionId: "choice",
          header: "Review",
          question,
          options: [{ label: "Draft A" }, { label: "Draft B" }],
        },
        ...(index === 0
          ? [
              {
                questionId: "reviewer",
                header: "Reviewer",
                question: "Who should review the appendix?",
                options: [{ label: "Research team" }, { label: "Editor" }],
              },
            ]
          : []),
      ],
      agentId: "main",
      sessionKey: reviewKey,
      createdAtMs: created + index,
      expiresAtMs: created + 3_600_000,
      status: "pending",
    }),
  );
  approvals = ["exec", "exec", "plugin", "plugin", "system-agent", "system-agent"].map(
    (kind, index) => {
      const presentation =
        kind === "exec"
          ? {
              kind,
              commandText: "echo synthetic-review",
              commandPreview:
                index === 0
                  ? "Inspect the synthetic review folder"
                  : "Summarize the synthetic notes",
              allowedDecisions: ["allow-once", "deny"],
              agentId: "main",
              host: "gateway",
            }
          : kind === "plugin"
            ? {
                kind,
                title: `Review synthetic plugin action ${index - 1}`,
                description: "A synthetic plugin request. No external action runs.",
                severity: "info",
                pluginId: "synthetic",
                toolName: "review",
                allowedDecisions: ["allow-once", "deny"],
                agentId: "main",
              }
            : {
                kind,
                title: `Review synthetic proposal ${index - 3}`,
                description: "A synthetic proposal. No state outside the fixture changes.",
                proposalHash: `synthetic-proposal-${index}`,
                allowedDecisions: [],
                agentId: "main",
              };
      return {
        id: `attention-approval-${index + 1}`,
        urlPath: `/approval/attention-approval-${index + 1}`,
        createdAtMs: created + 100 + index,
        expiresAtMs: created + 3_600_000,
        status: "pending",
        sourceSessionKey: reviewKey,
        presentation,
      };
    },
  );
  requests.length = 0;
}
reset();

const methods = [
  "health",
  "config.get",
  "agents.list",
  "sessions.list",
  "chat.history",
  "voicewake.get",
  "question.list",
  "question.get",
  "question.resolve",
  "exec.approval.list",
  "plugin.approval.list",
  "openclaw.approval.list",
  "approval.get",
  "approval.resolve",
  "cron.list",
  "cron.status",
  "system-presence",
  "node.list",
  "sessions.subscribe",
  "sessions.unsubscribe",
  "session.status",
  "models.list",
  "sessions.preview",
  "sessions.groups.list",
];
const events = [
  "question.requested",
  "question.resolved",
  "exec.approval.requested",
  "exec.approval.resolved",
  "plugin.approval.resolved",
  "openclaw.approval.resolved",
  "tick",
];
function broadcast(event, payload) {
  const seq = ++eventSequence;
  let recipients = 0;
  let taskProgressRecipients = 0;
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN && ws.proofRole === "operator") {
      const projected =
        event === "task" && payload.task
          ? { ...payload, task: taskForPeer(payload.task, ws) }
          : payload;
      ws.send(JSON.stringify({ type: "event", event, payload: projected, seq }));
      recipients += 1;
      if (ws.proofTaskProgress) {
        taskProgressRecipients += 1;
      }
    }
  }
  if (taskScenario && event !== "tick") {
    taskEvents.push({
      seq,
      event,
      stage: taskScenario.stage,
      ...(payload.action ? { action: payload.action } : {}),
      ...(payload.state ? { state: payload.state } : {}),
      ...(payload.yielded !== undefined ? { yielded: payload.yielded } : {}),
      ...(payload.task ? { status: payload.task.status } : {}),
      recipients,
      taskProgressRecipients,
    });
  }
}
function settleQuestions(status, id) {
  for (const question of questions.filter(
    (entry) => entry.status === "pending" && (id === undefined || entry.id === id),
  )) {
    question.status = status;
    if (status === "answered") {
      question.answers = {
        answers: Object.fromEntries(
          question.questions.map((item) => [item.questionId, [item.options[0].label]]),
        ),
      };
    }
    broadcast("question.resolved", {
      id: question.id,
      status,
      ...(question.answers ? { answers: question.answers } : {}),
    });
  }
}
function addParentQuestion() {
  const question = {
    id: "attention-question-parent",
    questions: [
      {
        questionId: "page",
        header: "Website",
        question: "Which page should we refresh first?",
        options: [{ label: "Home page" }, { label: "About page" }],
      },
    ],
    agentId: "main",
    sessionKey: parentKey,
    createdAtMs: created - 100,
    expiresAtMs: created + 3_600_000,
    status: "pending",
  };
  questions.push(question);
  broadcast("question.requested", question);
}
function settleApprovals(status, id) {
  for (const approval of approvals.filter(
    (entry) => entry.status === "pending" && (id === undefined || entry.id === id),
  )) {
    approval.status = status;
    approval.resolvedAtMs = Date.now();
    approval.reason = status === "expired" ? "timeout" : "run-aborted";
    const family =
      approval.presentation.kind === "system-agent" ? "openclaw" : approval.presentation.kind;
    broadcast(`${family}.approval.resolved`, {
      id: approval.id,
      decision: "deny",
      resolvedAtMs: approval.resolvedAtMs,
    });
  }
}
async function handleHttpRequest(req, res) {
  res.setHeader("content-type", "application/json");
  const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  if (path.startsWith("/task-progress/")) {
    try {
      if (req.method === "POST" && path === "/task-progress/reset") {
        resetTaskScenario();
        res.end(JSON.stringify({ sessionKey: mainKey }));
      } else if (req.method === "POST" && path === "/task-progress/advance") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) {
            throw new Error("Task scenario request is too large");
          }
        }
        advanceTaskScenario(JSON.parse(body).stage);
        res.end(JSON.stringify(taskEvidence()));
      } else if (req.method === "GET" && path === "/task-progress/evidence") {
        res.end(JSON.stringify(taskEvidence()));
      } else {
        res.writeHead(404);
        res.end("{}");
      }
    } catch (error) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (req.method === "POST") {
    if (path === "/reset") {
      reset();
    } else if (path === "/questions/answer") {
      settleQuestions("answered");
    } else if (path === "/questions/answer-oldest") {
      settleQuestions("answered", questions[0].id);
    } else if (path === "/questions/add-parent") {
      addParentQuestion();
    } else if (path === "/questions/cancel-parent") {
      settleQuestions("cancelled", "attention-question-parent");
    } else if (path === "/questions/expire-newer") {
      settleQuestions("expired", questions[1].id);
    } else if (path === "/questions/cancel") {
      settleQuestions("cancelled");
    } else if (path === "/questions/expire") {
      settleQuestions("expired");
    } else if (path === "/approvals/cancel") {
      settleApprovals("cancelled");
    } else if (path === "/approvals/expire") {
      settleApprovals("expired");
    } else if (path === "/approvals/expire-last") {
      settleApprovals("expired", approvals.at(-1).id);
    } else {
      res.writeHead(404);
      res.end("{}");
      return;
    }
  }
  res.end(
    JSON.stringify({
      requests,
      questions: questions.map(({ id, status }) => ({ id, status })),
      approvals: approvals.map(({ id, status }) => ({ id, status })),
      connections: wss.clients.size,
    }),
  );
}
const server = createServer((req, res) => {
  void handleHttpRequest(req, res).catch((/** @type {unknown} */ error) => {
    res.destroy(error instanceof Error ? error : undefined);
  });
});
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "synthetic-attention-nonce", ts: Date.now() },
    }),
  );
  ws.on("message", (raw) => {
    const req = JSON.parse(Buffer.from(raw).toString("utf8"));
    if (req.type !== "req") {
      return;
    }
    const params = req.params ?? {};
    if (taskScenario) {
      taskRequests.push({
        method: req.method,
        ...([mainKey, childKey].includes(params.sessionKey)
          ? { sessionKey: params.sessionKey }
          : {}),
        ...(["main", "worker"].includes(params.agentId) ? { agentId: params.agentId } : {}),
        ...(params.taskId === taskId ? { taskId } : {}),
        stage: taskScenario.stage,
      });
    }
    requests.push({ method: req.method, sessionKey: params.sessionKey, id: params.id });
    console.log(JSON.stringify(requests.at(-1)));
    const reply = (payload) =>
      ws.send(JSON.stringify({ type: "res", id: req.id, ok: true, payload }));
    const fail = (message) =>
      ws.send(
        JSON.stringify({
          type: "res",
          id: req.id,
          ok: false,
          error: { code: "INVALID_REQUEST", message },
        }),
      );
    if (req.method.endsWith(".approval.list")) {
      const kind = req.method.startsWith("openclaw") ? "system-agent" : req.method.split(".")[0];
      reply(
        approvals
          .filter((entry) => entry.status === "pending" && entry.presentation.kind === kind)
          .map((entry) => ({
            id: entry.id,
            approvalKind: kind,
            createdAtMs: entry.createdAtMs,
            expiresAtMs: entry.expiresAtMs,
            request: { sessionKey: entry.sourceSessionKey, agentId: "main" },
          })),
      );
      return;
    }
    switch (req.method) {
      case "connect":
        ws.proofProtocol = taskScenario
          ? [4, 3].find((version) => params.minProtocol <= version && params.maxProtocol >= version)
          : 3;
        if (ws.proofProtocol === undefined) {
          fail("Unsupported synthetic Gateway protocol range");
          break;
        }
        ws.proofRole = params.role;
        ws.proofTaskProgress = Array.isArray(params.caps) && params.caps.includes("task-progress");
        ws.proofNodeId = params.role === "node" ? params.device?.id : undefined;
        reply({
          type: "hello-ok",
          protocol: ws.proofProtocol,
          server: { version: "synthetic-attention", connId: "synthetic" },
          features: taskScenario
            ? {
                methods: [
                  ...methods,
                  "chat.send",
                  "agent.wait",
                  "tasks.list",
                  "tasks.get",
                  "progressCard.get",
                ],
                events: [...events, "chat", "task", "progressCard.changed"],
                capabilities: ["progress-card-agent-scope-v1"],
              }
            : { methods, events },
          snapshot: {
            presence: [],
            health: { ok: true },
            stateVersion: { presence: 1, health: 1 },
            uptimeMs: 1000,
            sessionDefaults: {
              defaultAgentId: "main",
              mainKey: "main",
              mainSessionKey: mainKey,
              scope: "per-sender",
            },
          },
          auth: {
            role: params.role,
            scopes: params.scopes ?? [],
            deviceToken: `synthetic-${params.role}`,
          },
          policy: { maxPayload: 1048576, maxBufferedBytes: 1048576, tickIntervalMs: 30000 },
        });
        break;
      case "health":
        reply({
          ok: true,
          ts: Date.now(),
          durationMs: 1,
          channels: {},
          agents: [],
          sessions: { count: 3 },
        });
        break;
      case "config.get":
        reply({
          config: { agents: { defaults: {} }, gateway: { mode: "local" } },
          hash: "synthetic",
          valid: true,
        });
        break;
      case "agents.list":
        reply({
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "main", name: "Research assistant" },
            ...(taskScenario ? [{ id: "worker", name: "Synthetic worker" }] : []),
          ],
        });
        break;
      case "sessions.list":
        reply({
          ts: Date.now(),
          count: 3,
          totalCount: 3,
          offset: 0,
          nextOffset: 3,
          hasMore: false,
          defaults: {},
          sessions: [
            {
              key: mainKey,
              displayName: "Home",
              label: "Home",
              kind: "direct",
              updatedAt: created,
              totalTokens: 120,
            },
            {
              key: parentKey,
              displayName: "Website refresh",
              label: "Website refresh",
              category: "Research",
              kind: "direct",
              childSessions: [reviewKey],
              updatedAt: created - 30000,
              totalTokens: 60,
            },
            {
              key: reviewKey,
              displayName: "Pending review",
              label: "Pending review",
              category: "Research",
              kind: "direct",
              updatedAt: created - 60000,
              totalTokens: 84,
            },
          ],
        });
        break;
      case "chat.history":
        if (taskScenario) {
          reply({
            sessionKey: params.sessionKey ?? mainKey,
            sessionId: "synthetic-session",
            sessionInfo: { key: mainKey, agentId: "main", hasActiveRun: false, activeRunIds: [] },
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Your research workspace is ready." }],
                timestamp: created,
              },
              ...taskScenario.messages,
            ],
          });
          break;
        }
        reply({
          sessionKey: params.sessionKey ?? mainKey,
          sessionId: "synthetic-session",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Your research workspace is ready." }],
              timestamp: created,
            },
          ],
        });
        break;
      case "chat.send": {
        if (!taskScenario || taskScenario.stage !== "ready" || params.sessionKey !== mainKey) {
          fail("Reset the task-progress scenario and send to its parent session");
          break;
        }
        taskScenario.parentRunId = params.idempotencyKey;
        taskScenario.stage = "yielded";
        taskScenario.revision = 1;
        taskScenario.messages.push(
          taskMessage("user", params.message, "native-progress-prompt", params.idempotencyKey),
        );
        reply({ runId: params.idempotencyKey, status: "started" });
        emitTask();
        broadcast("progressCard.changed", { sessionKey: mainKey, revision: 1 });
        const message = taskMessage(
          "assistant",
          "Parent yielded; synthetic worker continues.",
          "native-progress-yield",
          params.idempotencyKey,
        );
        taskScenario.messages.push(message);
        taskScenario.parentYielded = true;
        broadcast("chat", {
          runId: params.idempotencyKey,
          sessionKey: mainKey,
          agentId: "main",
          state: "final",
          yielded: true,
          message,
        });
        break;
      }
      case "agent.wait":
        if (taskScenario?.parentYielded && params.runId === taskScenario.parentRunId) {
          reply({ runId: params.runId, status: "ok", yielded: true });
        } else {
          fail("Unknown synthetic parent run");
        }
        break;
      case "tasks.list": {
        const task = taskSnapshot();
        // With sessionKey, agentId scopes the requester, not the child executor.
        const matchesSession =
          params.sessionKey === undefined ||
          (params.sessionKey === mainKey &&
            (params.agentId === undefined || params.agentId === "main"));
        const matchesAgent =
          params.sessionKey !== undefined ||
          params.agentId === undefined ||
          params.agentId === "worker";
        const statuses = params.status === undefined ? undefined : [params.status].flat();
        reply({
          tasks:
            task && matchesSession && matchesAgent && (!statuses || statuses.includes(task.status))
              ? [taskForPeer(task, ws)]
              : [],
        });
        break;
      }
      case "tasks.get": {
        const task = taskSnapshot();
        if (!task || params.taskId !== taskId) {
          fail("Unknown synthetic task");
        } else {
          reply({
            task: {
              ...taskForPeer(task, ws),
              prompt: "Review synthetic notes without executing a command.",
              ...(["failed", "completed"].includes(task.status)
                ? { result: task.terminalSummary }
                : {}),
            },
          });
        }
        break;
      }
      case "progressCard.get":
        reply({ card: params.sessionKey === mainKey ? taskCard() : null });
        break;
      case "question.list":
        reply({ questions: questions.filter((entry) => entry.status === "pending") });
        break;
      case "question.get":
        reply({ question: questions.find((entry) => entry.id === params.id) });
        break;
      case "question.resolve": {
        const question = questions.find((entry) => entry.id === params.id);
        if (!question) {
          fail("Unknown synthetic question");
          break;
        }
        question.status = params.cancel === true ? "cancelled" : "answered";
        if (question.status === "answered") {
          question.answers = params.answers;
        }
        const result = {
          id: question.id,
          status: question.status,
          ...(question.answers ? { answers: question.answers } : {}),
        };
        reply(result);
        broadcast("question.resolved", result);
        break;
      }
      case "approval.get":
        reply({ approval: approvals.find((entry) => entry.id === params.id) });
        break;
      case "approval.resolve":
        fail("Use the fixture lifecycle endpoints; no approval actions execute");
        break;
      case "voicewake.get":
        reply({ triggers: [] });
        break;
      case "cron.list":
        reply({ jobs: [] });
        break;
      case "cron.status":
        reply({ enabled: true, jobs: 0 });
        break;
      case "system-presence":
        reply([]);
        break;
      case "node.list":
        reply({
          nodes: taskScenario
            ? [...wss.clients]
                .filter((peer) => peer.readyState === WebSocket.OPEN && peer.proofNodeId)
                .map((peer) => ({
                  nodeId: peer.proofNodeId,
                  displayName: "Synthetic native node",
                  paired: true,
                  connected: true,
                  approvalState: "approved",
                  caps: [],
                  commands: [],
                }))
            : [],
        });
        break;
      case "sessions.subscribe":
      case "sessions.unsubscribe":
        reply({ ok: true });
        break;
      case "models.list":
        reply({ models: [] });
        break;
      case "sessions.groups.list":
        reply({ groups: [{ name: "Research", position: 0 }] });
        break;
      case "sessions.preview":
        reply({ ts: Date.now(), previews: [] });
        break;
      default:
        fail(`Unsupported synthetic method: ${req.method}`);
    }
  });
});
const tick = setInterval(() => broadcast("tick", { ts: Date.now() }), 10_000);
server.listen(port, "127.0.0.1", () =>
  console.log(`Synthetic attention Gateway listening on loopback:${server.address().port}`),
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(tick);
    for (const ws of wss.clients) {
      ws.terminate();
    }
    wss.close();
    server.close();
  });
}
