import type { DiagnosticEventPayload } from "./diagnostic-events.js";

const ASYNC_DIAGNOSTIC_EVENT_TYPES = new Set<DiagnosticEventPayload["type"]>([
  "diagnostic.gc",
  "gateway.event_loop.sample",
  "gateway.rpc",
  "gateway.admission",
  "gateway.run.owner",
  "tool.execution.started",
  "tool.execution.completed",
  "tool.execution.error",
  "tool.execution.blocked",
  "skill.used",
  "exec.process.completed",
  "exec.approval.followup_suppressed",
  "message.delivery.started",
  "message.delivery.completed",
  "message.delivery.error",
  "talk.event",
  "model.call.started",
  "model.call.completed",
  "model.call.error",
  "run.progress",
  "run.execution_phase",
  "harness.run.completed",
  "harness.run.error",
  "context.assembled",
  "log.record",
]);
const PRIORITY_ASYNC_DIAGNOSTIC_EVENT_TYPES = new Set<DiagnosticEventPayload["type"]>([
  // Trusted lifecycle terminals must displace best-effort diagnostics; dropping one
  // can strand the recorder's active span after its producer already finished.
  "tool.execution.completed",
  "tool.execution.error",
  "tool.execution.blocked",
  "model.call.completed",
  "model.call.error",
  "harness.run.completed",
  "harness.run.error",
]);

export const isAsyncDiagnosticEventType = (type: DiagnosticEventPayload["type"]) =>
  ASYNC_DIAGNOSTIC_EVENT_TYPES.has(type);
export const isPriorityDiagnosticEventType = (type: DiagnosticEventPayload["type"]) =>
  PRIORITY_ASYNC_DIAGNOSTIC_EVENT_TYPES.has(type);
