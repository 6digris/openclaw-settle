import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { Selectable } from "kysely";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  scopeLegacySessionKeyToAgent,
} from "../routing/session-key.js";
import type { OperatorApprovals } from "../state/openclaw-state-db.generated.js";
import type {
  insertOperatorApproval,
  OperatorApprovalRecord,
  OperatorApprovalSource,
} from "./operator-approval-store.js";

type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];
type OperatorApprovalRow = Selectable<OperatorApprovals>;

export function resolveApprovalSessionKey(
  source: Partial<OperatorApprovalSource>,
  audience?: readonly string[],
): string | null {
  const sessionKey = normalizeNullableString(source.sessionKey);
  if (sessionKey === "main") {
    // The saved audience starts with the resolved source; current config cannot recover an old main alias.
    const recordedSource = audience?.[0];
    return recordedSource &&
      source.agentId &&
      parseAgentSessionKey(recordedSource)?.agentId === normalizeAgentId(source.agentId)
      ? recordedSource
      : sessionKey;
  }
  return (
    scopeLegacySessionKeyToAgent({
      agentId: source.agentId ?? undefined,
      sessionKey: sessionKey ?? undefined,
    }) ?? null
  );
}

export function normalizeApprovalAudience(
  keys: readonly string[] | undefined,
  source: Partial<OperatorApprovalSource>,
): string[] {
  const sourceKey = resolveApprovalSessionKey(source, keys);
  return normalizeUniqueTrimmedStringList(
    keys?.map((key) => (key === source.sessionKey ? (sourceKey ?? key) : key)),
  );
}

export function inputMatchesExistingRow(
  input: NewOperatorApproval,
  row: OperatorApprovalRow,
  record: OperatorApprovalRecord,
  serialized: {
    presentationJson: string;
    reviewerDeviceIdsJson: string;
    audienceSessionKeysJson: string;
  },
): boolean {
  const source = input.source ?? {};
  return (
    row.status === "pending" &&
    row.kind === input.kind &&
    row.presentation_json === serialized.presentationJson &&
    row.requested_by_device_id === normalizeNullableString(input.requester?.deviceId) &&
    row.requested_by_client_id === normalizeNullableString(input.requester?.clientId) &&
    row.requested_by_device_token_auth === (input.requester?.deviceTokenAuth === true ? 1 : 0) &&
    row.reviewer_device_ids_json === serialized.reviewerDeviceIdsJson &&
    row.source_agent_id === normalizeNullableString(source.agentId) &&
    record.source.sessionKey === resolveApprovalSessionKey(source, input.audienceSessionKeys) &&
    row.source_session_id === normalizeNullableString(source.sessionId) &&
    row.source_run_id === normalizeNullableString(source.runId) &&
    row.source_tool_call_id === normalizeNullableString(source.toolCallId) &&
    row.source_tool_name === normalizeNullableString(source.toolName) &&
    JSON.stringify(record.audienceSessionKeys) === serialized.audienceSessionKeysJson &&
    row.runtime_epoch === input.runtimeEpoch.trim() &&
    row.created_at_ms === input.createdAtMs &&
    row.expires_at_ms === input.expiresAtMs
  );
}
