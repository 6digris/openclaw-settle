import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { validateSessionsPreviewParams } from "../../packages/gateway-protocol/src/index.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeSessionPreviewKeys } from "./session-method-policy.js";

export function legacySessionKey(value: string, owner?: string, selectedKey?: string): string {
  if (selectedKey === value) {
    return value;
  }
  const parsed = parseAgentSessionKey(value);
  return parsed &&
    (parsed.rest === "global" || parsed.rest === "unknown") &&
    (!owner || owner === parsed.agentId)
    ? parsed.rest
    : value;
}

type SessionWireKeyProjector = (key: string, agentId?: string) => string;

function sessionFields(
  value: unknown,
  key: "key" | "sessionKey",
  project: SessionWireKeyProjector,
  inheritedOwner?: string,
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const primary = typeof value[key] === "string" ? parseAgentSessionKey(value[key]) : null;
  const owner =
    typeof value.agentId === "string" ? value.agentId : (primary?.agentId ?? inheritedOwner);
  let result = value;
  for (const field of [
    key,
    "parentSessionKey",
    "spawnedBy",
    "childSessionKey",
    "sourceKey",
  ] as const) {
    const current = value[field];
    const next =
      typeof current === "string" && (field === key || owner) ? project(current, owner) : current;
    if (next !== value[field]) {
      if (result === value) {
        result = { ...value };
      }
      result[field] = next;
    }
  }
  return result;
}

function property(
  value: unknown,
  field: string,
  project: (entry: unknown, index?: number) => unknown,
): unknown {
  if (!isRecord(value) || value[field] === undefined) {
    return value;
  }
  const current = value[field];
  const next = Array.isArray(current) ? current.map(project) : project(current);
  return next === current ? value : { ...value, [field]: next };
}

function projectors(project: SessionWireKeyProjector, owner?: string) {
  const row = (value: unknown) => sessionFields(value, "key", project, owner);
  const record = (value: unknown) => sessionFields(value, "sessionKey", project, owner);
  const approval = (value: unknown) => property(value, "request", record);
  const message = (value: unknown) => property(record(value), "session", row);
  const defaults = (value: unknown): unknown => {
    if (!isRecord(value) || typeof value.mainSessionKey !== "string") {
      return value;
    }
    const mainSessionKey = project(
      value.mainSessionKey,
      typeof value.defaultAgentId === "string" ? value.defaultAgentId : owner,
    );
    return mainSessionKey === value.mainSessionKey ? value : { ...value, mainSessionKey };
  };
  return { row, record, approval, message, defaults };
}

/** Only typed protocol envelopes change; transcript, tool and plugin data stay opaque. */
export function projectSessionWireEvent(
  event: string,
  payload: unknown,
  project: SessionWireKeyProjector,
  owner?: string,
): unknown {
  const { record, approval, message } = projectors(project, owner);
  switch (event) {
    case "chat":
    case "agent":
    case "chat.side_result":
    case "session.observer":
    case "session.tool":
    case "session.typing":
    case "session.operation":
    case "session.sharing":
    case "session.sharing.evidence":
    case "question.requested":
      return record(payload);
    case "sessions.changed":
    case "session.message":
      return message(payload);
    case "task":
      return property(payload, "task", record);
    case "session.suggestion":
    case "task.suggestion":
      return property(payload, "suggestion", record);
    case "exec.approval.requested":
    case "plugin.approval.requested":
    case "openclaw.approval.requested":
      return approval(payload);
    default:
      // Progress cards already used qualified keys in published native clients.
      return payload;
  }
}

export function projectSessionWireResponse(
  method: string,
  payload: unknown,
  project: SessionWireKeyProjector,
  owner?: string,
  requestParams?: unknown,
): unknown {
  const { row, record, approval, message, defaults } = projectors(project, owner);
  switch (method) {
    case "chat.history":
    case "chat.startup": {
      let response = property(
        property(
          property(property(record(payload), "sessionInfo", row), "defaults", defaults),
          "resolution",
          (resolution) => property(row(resolution), "candidates", row),
        ),
        "inFlightRun",
        (run) => property(run, "events", record),
      );
      if (
        isRecord(response) &&
        typeof response.sessionKey === "string" &&
        isRecord(requestParams) &&
        typeof requestParams.sessionKey === "string"
      ) {
        response = { ...response, sessionKey: requestParams.sessionKey };
      }
      return isRecord(payload) && payload.kind === "delta"
        ? property(response, "messages", message)
        : response;
    }
    case "sessions.list":
      return property(property(payload, "sessions", row), "defaults", defaults);
    case "sessions.subscribe":
      return property(payload, "list", (list) =>
        property(property(list, "sessions", row), "defaults", defaults),
      );
    case "sessions.describe":
      return property(payload, "session", row);
    case "sessions.resolve":
      return property(row(payload), "candidates", row);
    case "sessions.preview": {
      const keys = validateSessionsPreviewParams(requestParams)
        ? normalizeSessionPreviewKeys(requestParams.keys)
        : undefined;
      return property(payload, "previews", (entry, index) => {
        const key = index === undefined ? undefined : keys?.[index];
        return key !== undefined && isRecord(entry) ? { ...entry, key } : row(entry);
      });
    }
    case "sessions.search":
      return property(property(payload, "results", record), "sessions", row);
    case "sessions.create":
    case "sessions.patch":
    case "sessions.reset":
    case "sessions.delete":
    case "sessions.compact":
    case "sessions.pluginPatch":
    case "sessions.assignOwner":
    case "sessions.messages.subscribe":
    case "sessions.messages.unsubscribe":
      return property(row(payload), "session", row);
    case "sessions.patchMany":
      return property(payload, "outcomes", row);
    case "sessions.compaction.list":
      return property(row(payload), "checkpoints", record);
    case "sessions.compaction.branch":
    case "sessions.compaction.restore":
      return property(row(payload), "checkpoint", record);
    case "session.publicShare.set":
    case "session.visibility.set":
    case "session.members.list":
    case "session.members.listEvidence":
    case "session.members.add":
    case "session.members.remove":
    case "sessions.files.list":
    case "sessions.files.get":
    case "sessions.files.set":
    case "sessions.diff":
    case "sessions.fork":
      return record(payload);
    case "session.suggestions.add":
    case "session.suggestions.resolve":
      return property(payload, "suggestion", record);
    case "session.suggestions.list":
      return property(payload, "suggestions", record);
    case "question.list":
      return property(payload, "questions", record);
    case "question.get":
      return property(payload, "question", record);
    case "tasks.list":
      return property(payload, "tasks", record);
    case "tasks.get":
    case "tasks.cancel":
      return property(payload, "task", record);
    case "exec.approval.list":
    case "plugin.approval.list":
      return Array.isArray(payload) ? payload.map(approval) : payload;
    default:
      return payload;
  }
}
