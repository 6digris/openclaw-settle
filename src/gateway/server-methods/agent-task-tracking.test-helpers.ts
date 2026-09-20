import path from "node:path";
import { vi } from "vitest";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import { setDetachedTaskLifecycleRuntime } from "../../tasks/task-runtime.test-helpers.js";
import { getAgentTestMocks } from "./agent.test-harness.js";

export function spyDetachedCreateRunningTaskRun() {
  const defaultRuntime = getDetachedTaskLifecycleRuntime();
  const createRunningTaskRunSpy = vi.fn(
    (...args: Parameters<typeof defaultRuntime.createRunningTaskRun>) =>
      defaultRuntime.createRunningTaskRun(...args),
  );
  setDetachedTaskLifecycleRuntime({
    ...defaultRuntime,
    createRunningTaskRun: createRunningTaskRunSpy,
  });
  return createRunningTaskRunSpy;
}

// Shared by every spawn control plane whose child turn reaches the gateway as a
// plain `agent` run: ACP manual spawns, plugin subagents, and native subagents.
export function mockSpawnedChildSessionEntry(childSessionKey: string, root: string) {
  const mocks = getAgentTestMocks();
  // The real transcript target reader must stay inside this fixture's state directory.
  const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
  mocks.userTurnStorePath = storePath;
  mocks.loadSessionEntry.mockReturnValue({
    cfg: {},
    storePath,
    entry: { sessionId: "spawned-child-session", updatedAt: Date.now() },
    canonicalKey: childSessionKey,
  });
  mocks.agentCommand.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { durationMs: 100 },
  });
}
