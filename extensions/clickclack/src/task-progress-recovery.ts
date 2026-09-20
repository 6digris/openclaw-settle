import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { listClickClackAccountIds, resolveClickClackAccount } from "./accounts.js";
import { recovery, type RecoverySnapshot } from "./runtime.js";

/** One activation catch-up shared by accounts; source ownership is checked by each observation. */
export function registerClickClackTaskProgressRecovery(api: OpenClawPluginApi): void {
  if (api.registrationMode === "tool-discovery") {
    return;
  }
  const ready = createDeferred<void>();
  const controller = new AbortController();
  const snapshot: RecoverySnapshot = {
    ready: ready.promise,
    sessions: new Map(),
    assertCurrent() {
      controller.signal.throwIfAborted();
      if (recovery.tryGetRuntime() !== snapshot) {
        throw new Error("ClickClack task recovery activation was replaced");
      }
    },
  };
  recovery.setRuntime(snapshot);
  let discovery: Promise<void> | undefined;
  const stop = async () => {
    controller.abort();
    ready.resolve();
    if (recovery.tryGetRuntime() === snapshot) {
      recovery.clearRuntime();
    }
    await discovery;
  };
  api.registerService({
    id: "clickclack-task-progress-recovery",
    start({ config: cfg }) {
      discovery = (async () => {
        const enabled = listClickClackAccountIds(cfg).some((accountId) => {
          const account = resolveClickClackAccount({ cfg, accountId });
          return account.enabled && (account.nativeProgress || account.agentActivity);
        });
        if (enabled) {
          for (const agentId of listAgentIds(cfg)) {
            snapshot.assertCurrent();
            // Shared/global owners can carry ClickClack work even when their
            // most recent foreground turn came from another channel.
            const entries = api.runtime.agent.session.listSessionEntries({
              agentId,
              readOnly: true,
            });
            for (const { sessionKey } of entries) {
              const tasks = await api.runtime.tasks.async.runs
                .bindSession({ sessionKey, agentId })
                .list();
              snapshot.assertCurrent();
              if (tasks.some((task) => task.status === "queued" || task.status === "running")) {
                snapshot.sessions.set(JSON.stringify([agentId, sessionKey]), {
                  sessionKey,
                  agentId,
                });
              }
            }
          }
        }
        ready.resolve();
      })().catch((error: unknown) => {
        ready.resolve();
        if (!controller.signal.aborted) {
          api.logger.warn(`ClickClack task progress recovery failed: ${String(error)}`);
        }
      });
      return discovery;
    },
    stop,
  });
  api.lifecycle.registerRuntimeLifecycle({
    id: "clickclack-task-progress-recovery",
    description: "Retires the one-shot task progress discovery activation.",
    cleanup: stop,
  });
}
