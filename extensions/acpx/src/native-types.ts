import type {
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpRuntime,
  AcpRuntimeStatus,
} from "acpx/runtime";
import type { AcpRuntimeHandle } from "../runtime-api.js";

export type AcpxNativeOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export type AcpxNativeTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  agent: string;
};

export type AcpxNativeSessionInput = AcpxNativeTarget & {
  transient?: boolean;
  command: readonly string[];
  cwd: string;
  model?: string;
  assertActive: () => void;
  onSessionCreated?: (sessionId: string | undefined) => void;
  onPermissionRequest: (
    request: AcpPermissionRequest,
    context: { signal: AbortSignal },
  ) => Promise<AcpPermissionDecision>;
};

export type AcpxNativeRuntime = {
  withSession<T>(
    input: AcpxNativeSessionInput,
    run: (session: {
      runtime: Pick<AcpRuntime, "startTurn">;
      handle: AcpRuntimeHandle;
      lastRequestId?: string;
      getStatus: () => Promise<AcpRuntimeStatus>;
    }) => Promise<T>,
  ): Promise<T>;
  closeSession(
    target: AcpxNativeTarget,
    assertCurrent: () => void,
    discardPersistentState?: boolean,
  ): Promise<void>;
  getStatus(handle: AcpRuntimeHandle): Promise<AcpRuntimeStatus>;
};
