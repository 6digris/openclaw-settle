import { publishSessionEntryCacheInvalidation } from "../../config/sessions/session-accessor.sqlite-entry-cache.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { withOpenClawAgentDatabaseAsync } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { movedSessionPaths } from "./relocation-session-paths.js";
import type { RelocationSessionOperations } from "./relocation-sessions.worker.js";
import type { WorktreeMovePlan } from "./relocation.types.js";

export async function relocateWorktreeSessionReferences(
  plan: WorktreeMovePlan,
  env: NodeJS.ProcessEnv,
  assertOwned: () => void,
): Promise<void> {
  for (const reference of plan.sessions) {
    const resolved = toDatabaseOptions(
      resolveSqliteScope({
        agentId: reference.agentId,
        storePath: reference.storePath,
        // The receipt names a physical store; key syntax must not redirect its writer.
        sessionKey: "",
        env,
      }),
    );
    const options = { ...resolved, path: resolveOpenClawAgentSqlitePath(resolved) };
    const identity = readDatabasePathIdentitySync(options.path);
    if (!identity.key.startsWith("file:")) {
      throw new Error("Session database disappeared during relocation");
    }
    const execution = captureOpenClawAgentDatabaseExecution(options);
    const assertCurrent = () => {
      execution.assertCurrent();
      assertExistingDatabaseIdentity(options.path, identity.key);
      assertOwned();
    };
    try {
      await runOpenClawAgentWriteAdmission(
        options,
        () =>
          withOpenClawAgentDatabaseAsync(
            options,
            async (database) => {
              assertCurrent();
              const worker = await openOpenClawAgentSqliteWorkerStore<RelocationSessionOperations>(
                options,
                database.db,
                {
                  moduleUrl: resolveRuntimeWorkerUrl(
                    runtimeProcessEntrypoints.worktreeRelocationSessions,
                  ),
                  input: { agentId: options.agentId, env },
                },
              );
              try {
                await worker.run(
                  (scope) =>
                    scope.execute({
                      type: "relocate",
                      input: { reference, paths: movedSessionPaths(plan, reference) },
                    }),
                  assertCurrent,
                );
              } finally {
                // Lost replies may follow a committed row. Invalidate canonically even
                // on failure; the durable shared intent keeps every affected path fenced.
                try {
                  publishSessionEntryCacheInvalidation(database, {
                    sessionKey: reference.sessionKey,
                  });
                } finally {
                  await worker.close();
                }
              }
            },
            assertCurrent,
          ),
        true,
      );
    } finally {
      await execution.release();
    }
  }
}
