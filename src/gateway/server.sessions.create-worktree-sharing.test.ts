import fs from "node:fs/promises";
import { expect, test } from "vitest";
import { getRegistryWorktree } from "../agents/worktrees/registry.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { testState } from "./test-helpers.js";
import { directSessionReq } from "./test/server-sessions.test-helpers.js";
import { setupGatewaySessionsWorktreeTestHarness } from "./test/server-sessions.worktree-fixture.js";

const { createSessionStoreDir, initializeRemoteBackedGitWorkspace } =
  setupGatewaySessionsWorktreeTestHarness();

test("named session worktrees are shared resources with independent session lifecycle", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-shared-session-worktree-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(state.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  const client = { connect: { scopes: ["operator.admin"] } } as never;
  let worktreeId: string | undefined;
  try {
    const first = await directSessionReq<{
      key: string;
      worktree: { id: string; path: string };
    }>(
      "sessions.create",
      { agentId: "main", worktree: true, worktreeName: "shared-task" },
      { client },
    );
    const second = await directSessionReq<{
      key: string;
      worktree: { id: string; path: string };
    }>(
      "sessions.create",
      { agentId: "main", worktree: true, worktreeName: "shared-task" },
      { client },
    );

    expect(first.ok, JSON.stringify(first.error)).toBe(true);
    expect(second.ok, JSON.stringify(second.error)).toBe(true);
    expect(second.payload!.worktree).toEqual(first.payload!.worktree);
    worktreeId = first.payload!.worktree.id;
    expect(getRegistryWorktree(process.env, worktreeId)?.ownerId).toBeUndefined();

    const deleted = await directSessionReq("sessions.delete", { key: first.payload!.key });

    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(getRegistryWorktree(process.env, worktreeId)?.removedAt).toBeUndefined();
    await expect(fs.access(first.payload!.worktree.path)).resolves.toBeUndefined();
  } finally {
    if (worktreeId && getRegistryWorktree(process.env, worktreeId)?.removedAt === undefined) {
      await managedWorktrees.remove({
        id: worktreeId,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await state.cleanup();
  }
});
