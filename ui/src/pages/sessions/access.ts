import type { GatewaySessionRow } from "../../api/types.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import type { SessionsProps } from "./view.ts";

type SessionPageAccessReasons = Pick<
  SessionsProps,
  | "patchWriteDisabledReason"
  | "patchAdminDisabledReason"
  | "groupWriteDisabledReason"
  | "deleteArchivedDisabledReason"
  | "checkpointBranchDisabledReason"
  | "checkpointRestoreDisabledReason"
  | "deleteSelectedDisabledReason"
>;

export function sessionPageAccessReasons(
  snapshot: Parameters<typeof readSessionMethodAccess>[0],
  rows: readonly GatewaySessionRow[],
  selectedKeys: ReadonlySet<string>,
): SessionPageAccessReasons {
  const disabledReason = (request: {
    method: string;
    params?: unknown;
    requiredScope?: "operator.write" | "operator.admin";
  }) => {
    const access = readSessionMethodAccess(snapshot, request);
    return access.allowed ? undefined : access.reason;
  };
  const selectedDeleteDisabledReason = () => {
    const rowsByKey = new Map(rows.map((row) => [row.key, row]));
    for (const key of selectedKeys) {
      const row = rowsByKey.get(key);
      const reason = disabledReason({
        method: "sessions.delete",
        params: {
          key,
          ...(row?.archived === true ? { archivedOnly: true } : {}),
        },
      });
      if (reason) {
        return reason;
      }
    }
    return undefined;
  };
  return {
    patchWriteDisabledReason: disabledReason({
      method: "sessions.patch",
      params: { key: "", label: null },
    }),
    patchAdminDisabledReason: disabledReason({
      method: "sessions.patch",
      params: { key: "", thinkingLevel: null },
    }),
    groupWriteDisabledReason: disabledReason({
      method: "sessions.groups.put",
      requiredScope: "operator.write",
    }),
    deleteArchivedDisabledReason: disabledReason({
      method: "sessions.delete",
      params: { key: "", archivedOnly: true, deleteTranscript: true },
    }),
    checkpointBranchDisabledReason: disabledReason({
      method: "sessions.compaction.branch",
      requiredScope: "operator.write",
    }),
    checkpointRestoreDisabledReason: disabledReason({
      method: "sessions.compaction.restore",
      requiredScope: "operator.admin",
    }),
    deleteSelectedDisabledReason: selectedDeleteDisabledReason(),
  };
}
