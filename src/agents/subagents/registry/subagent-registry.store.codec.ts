import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Insertable, Selectable } from "kysely";
import {
  parseAgentSessionKey,
  scopeLegacySessionKeyToAgent,
} from "../../../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type SubagentRunSqliteRow = Selectable<OpenClawStateKyselyDatabase["subagent_runs"]>;
export type BoundSubagentRunRecord = Insertable<OpenClawStateKyselyDatabase["subagent_runs"]>;

type CanonicalSubagentRunRecord = SubagentRunRecord &
  Required<Pick<SubagentRunRecord, "completion" | "delivery">>;
const EXECUTION_STATUSES = new Set("queued running interrupted terminal".split(" "));
export const SUBAGENT_DELIVERY_STATUSES = new Set(
  "not_required pending in_progress delivered failed suspended discarded".split(" "),
);

function hasStateStatus(
  value: unknown,
  statuses: ReadonlySet<string>,
): value is Record<string, unknown> {
  return isRecord(value) && typeof value.status === "string" && statuses.has(value.status);
}

function isCanonicalSubagentRunRecord(value: unknown): value is CanonicalSubagentRunRecord {
  return (
    isRecord(value) &&
    hasStateStatus(value.execution, EXECUTION_STATUSES) &&
    isRecord(value.completion) &&
    typeof value.completion.required === "boolean" &&
    hasStateStatus(value.delivery, SUBAGENT_DELIVERY_STATUSES) &&
    !(
      "handoffLeaseId" in value.delivery ||
      "handoffLeasedAt" in value.delivery ||
      "handoffInjectedAt" in value.delivery
    )
  );
}

function parseSubagentRunPayload(raw: string | undefined): CanonicalSubagentRunRecord | null {
  const stored = raw ? safeParseJson(raw) : undefined;
  const payload =
    isRecord(stored) &&
    isRecord(stored.parentCompletion) &&
    stored.parentCompletion.completionTarget === "parent"
      ? stored.parentCompletion
      : stored;
  return isCanonicalSubagentRunRecord(payload) ? payload : null;
}

/** Rehydrates one sqlite row into the normalized subagent run record shape. */
export function rowToSubagentRunRecord(row: SubagentRunSqliteRow): SubagentRunRecord | null {
  const payload = parseSubagentRunPayload(row.payload_json);
  if (!payload) {
    return null;
  }
  // The store commits indexed columns with this complete payload atomically;
  // rehydrating both created competing state.
  payload.runId = row.run_id;
  payload.childSessionKey = row.child_session_key;
  payload.requesterSessionKey = row.requester_session_key;
  const controllerSessionKey = row.controller_session_key?.trim();
  if (controllerSessionKey) {
    payload.controllerSessionKey = controllerSessionKey;
  } else {
    delete payload.controllerSessionKey;
  }
  if (payload.requesterOrigin) {
    payload.requesterOrigin = normalizeDeliveryContext(payload.requesterOrigin);
  }
  if (payload.expectsCompletionMessage === false) {
    payload.delivery.status = "not_required";
  }
  const record = normalizeSubagentRunState(payload);
  return record.runId && record.childSessionKey && record.requesterSessionKey ? record : null;
}

/** Canonically serializes a run before an outer transaction acquires the write lock. */
export function bindSubagentRunRecord(entry: SubagentRunRecord): BoundSubagentRunRecord {
  const normalized = normalizeSubagentRunState(structuredClone(entry));
  if (!isCanonicalSubagentRunRecord(normalized)) {
    throw new Error("subagent run is missing canonical nested state");
  }
  return {
    run_id: normalized.runId,
    child_session_key: normalized.childSessionKey,
    controller_session_key: normalized.controllerSessionKey?.trim() || null,
    requester_session_key: normalized.requesterSessionKey,
    created_at: normalized.createdAt,
    // Released readers require root execution/completion/delivery state. Hiding
    // the whole private record also excludes it from legacy mixed/nested summaries.
    // Downgrades may discard these rows, but cannot reinterpret them as public.
    payload_json: JSON.stringify(
      normalized.completionTarget === "parent" ? { parentCompletion: normalized } : normalized,
    ),
  };
}

/** Preserve compatible reference spellings while updating the run's other facts. */
export function retainStoredSubagentRunReferences(
  row: BoundSubagentRunRecord,
  stored: SubagentRunSqliteRow | undefined,
): BoundSubagentRunRecord {
  const physical = stored && parseSubagentRunPayload(stored.payload_json);
  const next = parseSubagentRunPayload(row.payload_json);
  if (stored && physical && next) {
    const previousAgentId =
      normalizeOptionalString(physical.requesterAgentId) ??
      parseAgentSessionKey(stored.requester_session_key)?.agentId;
    const requesterAgentId =
      normalizeOptionalString(next.requesterAgentId) ??
      parseAgentSessionKey(next.requesterSessionKey)?.agentId;
    const retain = (raw: string | undefined, after: string | undefined) =>
      raw !== undefined &&
      scopeLegacySessionKeyToAgent({ sessionKey: raw, agentId: previousAgentId }) === after &&
      scopeLegacySessionKeyToAgent({ sessionKey: raw, agentId: requesterAgentId }) === after
        ? raw
        : after;
    // Bookkeeping must not migrate references: a failed startup may return to an older reader.
    // Check incoming ownership too, so retaining an alias cannot silently retarget it.
    for (const [field, raw] of [
      ["requesterSessionKey", stored.requester_session_key],
      ["controllerSessionKey", stored.controller_session_key ?? undefined],
      ["swarmRequesterSessionKey", physical.swarmRequesterSessionKey],
    ] as const) {
      const retained = retain(raw, next[field]);
      if (retained !== undefined) {
        next[field] = retained;
      }
    }
    if (next.delivery.payload) {
      next.delivery.payload.requesterSessionKey =
        retain(
          physical.delivery.payload?.requesterSessionKey,
          next.delivery.payload.requesterSessionKey,
        ) ?? next.delivery.payload.requesterSessionKey;
    }
    return {
      ...row,
      requester_session_key: next.requesterSessionKey,
      controller_session_key: next.controllerSessionKey ?? null,
      payload_json: JSON.stringify(
        next.completionTarget === "parent" ? { parentCompletion: next } : next,
      ),
    };
  }
  return row;
}
