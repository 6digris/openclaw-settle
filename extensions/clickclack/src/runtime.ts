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

export type ClickClackTaskRecoverySession = Readonly<{ sessionKey: string; agentId: string }>;
export type RecoverySnapshot = {
  ready: Promise<void>;
  sessions: Map<string, ClickClackTaskRecoverySession>;
  assertCurrent: () => void;
};
export const recovery = createPluginRuntimeStore<RecoverySnapshot>({
  key: "clickclack:task-progress-recovery",
  errorMessage: "ClickClack task recovery is not activated",
});

/** Keep admitted scopes discoverable after account restarts without rescanning session storage. */
export function rememberClickClackTaskRecoverySession(
  session: ClickClackTaskRecoverySession,
): void {
  const snapshot = recovery.tryGetRuntime();
  if (!snapshot) {
    return;
  }
  snapshot.assertCurrent();
  snapshot.sessions.set(JSON.stringify([session.agentId, session.sessionKey]), session);
}

/** Waiting for service startup never holds account shutdown or a reconnect cycle. */
export async function readClickClackTaskRecoverySessions(
  signal: AbortSignal,
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
    return [...snapshot.sessions.values()];
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
