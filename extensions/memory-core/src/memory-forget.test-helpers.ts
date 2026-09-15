import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { withSessionTranscriptWriteLock } from "openclaw/plugin-sdk/session-transcript-runtime";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { recordMemorySessionTombstonesInDatabase } from "./memory-entry-origins.js";
import { configureMemoryCoreDreamingStateForTests } from "./test-helpers.js";

export async function holdMemoryAgentWriterForTest(beforeRelease?: () => void | Promise<void>) {
  const target = {
    agentId: "main",
    sessionId: "memory-writer-reservation",
    sessionKey: "agent:main:memory-writer-reservation",
    storePath: resolveStorePath(undefined, { agentId: "main" }),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  const entered = createDeferred<void>();
  const released = createDeferred<void>();
  const done = withSessionTranscriptWriteLock(target, async () => {
    entered.resolve();
    await released.promise;
    await beforeRelease?.();
  });
  void done.catch(() => undefined);
  await Promise.race([entered.promise, done]);
  return { release: released.resolve, done };
}

export async function createMemoryForgetFixture(prefix = "openclaw-memory-forget-") {
  const state = await createOpenClawTestState({ prefix, layout: "state-only" });
  const { stateDir, workspaceDir } = state;
  await configureMemoryCoreDreamingStateForTests();
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: workspaceDir }, list: [{ id: "main", default: true }] },
  };
  return {
    stateDir,
    workspaceDir,
    cfg,
    cleanup: async () => {
      await state.restoreEnv();
      resetPluginStateStoreForTests();
      await state.cleanup();
    },
  };
}

export async function seedMemoryForgetSession(
  sessionId: string,
  hookSource?: "gmail" | "webhook",
): Promise<void> {
  const sessionKey = `agent:main:${sessionId}`;
  await upsertSessionEntry({
    agentId: "main",
    sessionKey,
    entry: { sessionId, updatedAt: 1_000 },
  });
  if (hookSource) {
    openOpenClawAgentDatabase({ agentId: "main" })
      .db.prepare(
        "UPDATE session_windows SET hook_external_content_source = ? WHERE session_id = ?",
      )
      .run(hookSource, sessionId);
  }
}

export function seedMemoryForgetTombstones(
  params: Parameters<typeof recordMemorySessionTombstonesInDatabase>[1],
): number {
  const { db } = openOpenClawAgentDatabase({ agentId: params.agentId });
  return recordMemorySessionTombstonesInDatabase(db, params);
}
