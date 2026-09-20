/**
 * Runtime store for host-provided OpenClaw services used by the ClickClack
 * bundled plugin.
 */
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setClickClackRuntime, getRuntime: getClickClackRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "clickclack",
    errorMessage: "ClickClack runtime not initialized",
  });

export { getClickClackRuntime, setClickClackRuntime };

export type ClickClackTaskRecoverySession = Readonly<{
  sessionKey: string;
  agentId: string;
  accountId: string;
}>;
export type RecoverySnapshot = {
  ready: Promise<void>;
  sessions: Map<string, ClickClackTaskRecoverySession>;
  assertCurrent: () => void;
};
export const recovery = createPluginRuntimeStore<RecoverySnapshot>({
  key: "clickclack:task-progress-recovery",
  errorMessage: "ClickClack task recovery is not activated",
});

export function hasClickClackTaskRecoveryWork(task: {
  status: string;
  deliveryStatus?: string;
}): boolean {
  return (
    task.status === "queued" ||
    task.status === "running" ||
    task.deliveryStatus === "pending" ||
    task.deliveryStatus === "session_queued"
  );
}

/** The observation can forget only its own admission, never a replacement account's. */
export function rememberClickClackTaskRecoverySession(
  session: ClickClackTaskRecoverySession,
): () => void {
  const snapshot = recovery.tryGetRuntime();
  if (!snapshot) {
    return () => {};
  }
  snapshot.assertCurrent();
  const key = JSON.stringify([session.agentId, session.sessionKey, session.accountId]);
  snapshot.sessions.set(key, session);
  return () => {
    snapshot.assertCurrent();
    if (snapshot.sessions.get(key) === session) {
      snapshot.sessions.delete(key);
    }
  };
}

/** Waiting for service startup never holds account shutdown or a reconnect cycle. */
export async function readClickClackTaskRecoverySessions(
  signal: AbortSignal,
  accountId: string,
): Promise<readonly ClickClackTaskRecoverySession[]> {
  const snapshot = recovery.tryGetRuntime();
  if (!snapshot) {
    return [];
  }
  signal.throwIfAborted();
  const aborted = createDeferred<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([snapshot.ready, aborted.promise]);
    signal.throwIfAborted();
    snapshot.assertCurrent();
    return [...snapshot.sessions.values()].filter((session) => session.accountId === accountId);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
