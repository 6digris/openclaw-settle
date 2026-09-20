import { Type, type TProperties } from "typebox";
import { Compile } from "typebox/compile";

// Frozen v2026.9.5 output contracts, not today's schemas minus selected fields.
// Source: openclaw/openclaw@ec9c1a13db8938e5a3eaa51fca2e981cde2395a9
// packages/gateway-protocol/src/schema/{tasks,closed-object,primitives,since}.ts.
// withSince's non-validating x-openclaw-since metadata and hidden nominal identity
// are omitted; every output property, bound and additionalProperties rule is retained.
function closedObject<Properties extends TProperties>(properties: Properties) {
  return Type.Object(properties, { additionalProperties: false });
}
const nonEmptyString = Type.String({ minLength: 1 });
const timestamp = Type.Union([Type.String(), Type.Integer({ minimum: 0 })]);
const execution = closedObject({
  state: Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("waiting"),
    Type.Literal("finished"),
    Type.Literal("unknown"),
  ]),
  currentTool: Type.Optional(closedObject({ name: Type.String(), startedAt: timestamp })),
  lastActivityAt: Type.Optional(timestamp),
  wait: Type.Optional(
    closedObject({
      kind: Type.Union([
        Type.Literal("children"),
        Type.Literal("external"),
        Type.Literal("agent_messages"),
        Type.Literal("approval"),
        Type.Literal("user_input"),
      ]),
      dependencies: Type.Optional(
        Type.Array(
          closedObject({
            runId: nonEmptyString,
            sessionKey: Type.Optional(Type.String()),
            taskId: Type.Optional(Type.String()),
            label: Type.Optional(Type.String()),
          }),
          { maxItems: 100 },
        ),
      ),
      pendingCount: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
  ),
});
const summary = closedObject({
  id: nonEmptyString,
  kind: Type.Optional(Type.String()),
  runtime: Type.Optional(Type.String()),
  status: Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
    Type.Literal("timed_out"),
  ]),
  title: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  sessionKey: Type.Optional(Type.String()),
  childSessionKey: Type.Optional(Type.String()),
  hasTranscript: Type.Optional(Type.Boolean()),
  ownerKey: Type.Optional(Type.String()),
  runId: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
  flowId: Type.Optional(Type.String()),
  parentTaskId: Type.Optional(Type.String()),
  sourceId: Type.Optional(Type.String()),
  createdAt: Type.Optional(timestamp),
  updatedAt: Type.Optional(timestamp),
  startedAt: Type.Optional(timestamp),
  endedAt: Type.Optional(timestamp),
  toolUseCount: Type.Optional(Type.Integer({ minimum: 0 })),
  lastToolName: Type.Optional(Type.String()),
  execution: Type.Optional(execution),
  lastActivity: Type.Optional(Type.String({ maxLength: 200 })),
  diffStat: Type.Optional(
    closedObject({
      files: Type.Integer({ minimum: 0 }),
      added: Type.Integer({ minimum: 0 }),
      removed: Type.Integer({ minimum: 0 }),
    }),
  ),
  progressSummary: Type.Optional(Type.String()),
  terminalSummary: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  deliveryStatus: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("delivered"),
      Type.Literal("session_queued"),
      Type.Literal("failed"),
      Type.Literal("dismissed"),
      Type.Literal("parent_missing"),
      Type.Literal("not_applicable"),
    ]),
  ),
  terminalOutcome: Type.Optional(Type.Union([Type.Literal("succeeded"), Type.Literal("blocked")])),
  result: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
});

export const releasedTaskValidators = {
  summary: Compile(summary),
  list: Compile(
    closedObject({
      tasks: Type.Array(summary),
      nextCursor: Type.Optional(Type.String({ maxLength: 512 })),
    }),
  ),
  get: Compile(closedObject({ task: summary })),
  cancel: Compile(
    closedObject({
      found: Type.Boolean(),
      cancelled: Type.Boolean(),
      reason: Type.Optional(Type.String()),
      task: Type.Optional(summary),
    }),
  ),
  recovery: Compile(
    closedObject({
      results: Type.Array(
        closedObject({
          taskId: nonEmptyString,
          ok: Type.Boolean(),
          reason: Type.Optional(Type.String()),
          duplicateRisk: Type.Optional(Type.Boolean()),
          task: Type.Optional(summary),
        }),
        { maxItems: 10 },
      ),
    }),
  ),
  history: Compile(
    closedObject({
      messages: Type.Array(Type.Unknown()),
      nextCursor: Type.Optional(Type.String({ maxLength: 8192 })),
    }),
  ),
};
