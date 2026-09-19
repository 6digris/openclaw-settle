// Shares SQLite row mapping helpers between task registry persistence modules.
import { safeParseJson } from "@openclaw/normalization-core";
import type { Insertable, Selectable } from "kysely";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { isRecord } from "../utils.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { normalizeTaskSessionKeys } from "./task-registry-records.js";
import { parseTaskScopeKind, type TaskExecutionOwner } from "./task-registry.types.js";

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Persisted JSON columns are typed by the receiving field.
export function parseSqliteJsonValue<T>(raw: string | null): T | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  return safeParseJson(raw) as T | undefined;
}

export function parseDeliveryContextJson(raw: string | null): DeliveryContext | undefined {
  const parsed = parseSqliteJsonValue<unknown>(raw);
  if (!isRecord(parsed)) {
    return undefined;
  }
  return normalizeDeliveryContext({
    channel: typeof parsed.channel === "string" ? parsed.channel : undefined,
    to: typeof parsed.to === "string" ? parsed.to : undefined,
    accountId: typeof parsed.accountId === "string" ? parsed.accountId : undefined,
    threadId:
      typeof parsed.threadId === "string" || typeof parsed.threadId === "number"
        ? parsed.threadId
        : undefined,
  });
}

type TaskRunsTable = DB["task_runs"];
type TaskSessionKeyRow = Pick<
  Insertable<TaskRunsTable>,
  | "requester_session_key"
  | "owner_key"
  | "child_session_key"
  | "scope_kind"
  | "agent_id"
  | "requester_agent_id"
>;

export function readTaskExecutionOwner(
  row: Partial<
    Pick<
      Selectable<TaskRunsTable>,
      "execution_owner_host" | "execution_owner_pid" | "execution_owner_start_identity"
    >
  >,
): TaskExecutionOwner | undefined {
  const host = row.execution_owner_host;
  const pid = normalizeSqliteNumber(row.execution_owner_pid ?? null);
  const startIdentity = normalizeSqliteNumber(row.execution_owner_start_identity ?? null);
  if (
    typeof host !== "string" ||
    !host.trim() ||
    pid === undefined ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    startIdentity === undefined ||
    !Number.isSafeInteger(startIdentity) ||
    startIdentity < 0
  ) {
    return undefined;
  }
  return { host, pid, startIdentity };
}

export function taskSessionKeysFromRow(row: TaskSessionKeyRow) {
  const scopeKind = parseTaskScopeKind(row.scope_kind);
  return normalizeTaskSessionKeys({
    requesterSessionKey:
      scopeKind === "system" ? "" : row.requester_session_key?.trim() || row.owner_key,
    ownerKey: row.owner_key,
    scopeKind,
    ...(row.child_session_key ? { childSessionKey: row.child_session_key } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.requester_agent_id ? { requesterAgentId: row.requester_agent_id } : {}),
  });
}

export function bindTaskRunUpdate(
  row: Insertable<TaskRunsTable>,
  previous: TaskSessionKeyRow | undefined,
) {
  let updates = { ...row, task_id: undefined };
  if (previous) {
    const retained = taskSessionKeysFromRow(previous);
    const intended = taskSessionKeysFromRow(row);
    const references = [
      ["requester_session_key", "requesterSessionKey"],
      ["owner_key", "ownerKey"],
      ["child_session_key", "childSessionKey"],
    ] as const;
    // Bookkeeping must not rename rollback-visible keys or rebind them to a changed owner.
    for (const [column, field] of references) {
      if (retained[field] !== intended[field]) {
        continue;
      }
      const candidate = { ...updates, [column]: previous[column] };
      const projected = taskSessionKeysFromRow(candidate);
      if (references.every(([, key]) => projected[key] === intended[key])) {
        updates = candidate;
      }
    }
  }
  return updates;
}
