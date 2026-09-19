import { AsyncLocalStorage } from "node:async_hooks";
import { tryResolveDefaultAgentId } from "../../agents/agent-roster.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import {
  getPublishedSystemEventStoreSelection,
  publishSystemEventStoreSelection,
  type PublishedSystemEventStoreSelection,
  type SessionEventStoreTarget,
} from "../../infra/system-event-ownership.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { listSessionStateWatcherKeysInDatabase } from "../../sessions/session-state-events.kernel.js";
import { readAgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import { createOpenClawAgentDatabasePathMatcher } from "../../state/openclaw-agent-db-registry.js";
import {
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../../state/openclaw-state-db-readonly.js";
import { getRuntimeConfig } from "../io.js";
import { getRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  resolveExplicitSessionStorePathForScope,
  resolveSessionStorePathCore,
  type SessionStorePathScope,
} from "./paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const notificationStoreLog = createSubsystemLogger("sessions/notification-store");

export function resolveSessionStorePathForScope(
  scope: SessionStorePathScope,
  config?: OpenClawConfig,
): string {
  const explicitStorePath = resolveExplicitSessionStorePathForScope(scope);
  if (explicitStorePath) {
    return explicitStorePath;
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  return resolveSessionStorePathCore((config ?? getRuntimeConfig()).session?.store, {
    agentId,
    env: scope.env,
  });
}

type SystemEventStoreCaptureTarget = SessionEventStoreTarget & {
  cfg?: OpenClawConfig;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
};

function captureSystemEventStorePath(
  target: SystemEventStoreCaptureTarget,
  cfg: OpenClawConfig,
  paths?: Map<string, string>,
): string | undefined {
  const agentId =
    target.agentId ??
    (target.sessionKey ? resolveAgentIdFromSessionKey(target.sessionKey) : undefined);
  // An unscoped scheduler wake selects its sessions at execution.
  if (!agentId) {
    return undefined;
  }
  const storePath = resolveSessionStorePathForScope(
    { agentId, sessionKey: target.sessionKey, storePath: target.storePath, env: target.env },
    cfg,
  );
  const key = JSON.stringify([agentId, storePath]);
  const cached = paths?.get(key);
  if (cached) {
    return cached;
  }
  const physicalPath = resolveIdentityPathViaExistingAncestorSync(
    resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId,
      defaultAgentId: tryResolveDefaultAgentId(cfg),
      env: target.env,
    }).path,
  );
  paths?.set(key, physicalPath);
  return physicalPath;
}

/** Capture physical provenance before the producer's admitted config can be replaced. */
export function resolveSystemEventStorePath(
  target: SystemEventStoreCaptureTarget,
): string | undefined {
  const selection = getPublishedSystemEventStoreSelection();
  const cfg = target.cfg ?? selection?.config ?? getRuntimeConfigSnapshot();
  if (!cfg) {
    return undefined;
  }
  if (selection && cfg === selection.config && !target.storePath && !target.env) {
    return selection.resolveStorePath(target);
  }
  return captureSystemEventStorePath(target, cfg);
}

/** Publish the accepted store selection before queue owners retire replaced work. */
export function publishSystemEventStoreConfig(cfg: OpenClawConfig): void {
  const env = { ...process.env };
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const paths = new Map<string, string>();
  const watcherPaths = new Map<string, string | null>();
  let samePath = createOpenClawAgentDatabasePathMatcher();
  const resolveStorePath = (target: SessionEventStoreTarget) =>
    captureSystemEventStorePath({ ...target, env }, cfg, paths);
  const refresh = () => {
    paths.clear();
    watcherPaths.clear();
    samePath = createOpenClawAgentDatabasePathMatcher();
    try {
      const watchers = withArtifactPreservingStateReads(() =>
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) => listSessionStateWatcherKeysInDatabase(db),
          { env },
        ),
      );
      let unresolved = 0;
      for (const sessionKey of watchers ?? []) {
        watcherPaths.set(sessionKey, null);
        try {
          if (
            !readAgentDatabaseAdmissionRefusal(resolveAgentIdFromSessionKey(sessionKey), { env })
          ) {
            watcherPaths.set(sessionKey, resolveStorePath({ sessionKey }) ?? null);
          }
        } catch {
          unresolved++;
        }
      }
      if (unresolved > 0) {
        notificationStoreLog.warn(`could not establish ${unresolved} notification watcher stores`);
      }
    } catch (error) {
      notificationStoreLog.warn(`failed to prepare notification watcher stores: ${String(error)}`);
    }
  };
  const selection: PublishedSystemEventStoreSelection = {
    config: cfg,
    preparedStorePaths: watcherPaths,
    resolveStorePath,
    samePath: (left, right) => samePath(left, right),
    rememberWatcher(sessionKey, storePath) {
      if (!storePath) {
        return;
      }
      inOwnerContext(() => {
        try {
          if (
            readAgentDatabaseAdmissionRefusal(resolveAgentIdFromSessionKey(sessionKey), { env })
          ) {
            return;
          }
          const current = resolveStorePath({ sessionKey });
          if (current && samePath(storePath, current)) {
            watcherPaths.set(sessionKey, storePath);
          }
        } catch (error) {
          watcherPaths.set(sessionKey, null);
          notificationStoreLog.warn(`failed to prepare registered watcher store: ${String(error)}`);
        }
      });
    },
    activate(onStoreChange) {
      inOwnerContext(refresh);
      return sessionChanges.subscribe((change) => {
        if (
          "all" in change &&
          change.scope === "stores" &&
          getPublishedSystemEventStoreSelection() === selection
        ) {
          // Database preparation may publish from a temporary admission borrow.
          inOwnerContext(() => {
            refresh();
            onStoreChange();
          });
        }
      });
    },
  };
  publishSystemEventStoreSelection(selection);
}
