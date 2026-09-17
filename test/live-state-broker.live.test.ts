// Deterministic live-pool admission proof; no model or credential is used.
import { afterEach, expect, it } from "vitest";
import { pluginStateEntriesInKeyRange } from "../src/plugin-state/plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "../src/plugin-state/plugin-state-store.test-helpers.js";
import { closeOpenClawStateDatabaseAsync } from "../src/state/openclaw-state-db-cache.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
});

it("admits plugin state range reads from the live fixture process", async () => {
  await withOpenClawTestState({ label: "live-broker-contract" }, async (state) => {
    const expected = { sessionId: "synthetic-session", binding: { threadId: "synthetic-thread" } };
    seedPluginStateEntriesForTests([
      {
        pluginId: "codex",
        namespace: "app-server-thread-bindings",
        key: "session-key:dev:synthetic",
        value: expected,
        createdAt: 1,
      },
    ]);
    expect(
      await pluginStateEntriesInKeyRange({
        env: state.env,
        pluginId: "codex",
        namespace: "app-server-thread-bindings",
        keyStartInclusive: "session-key:dev:",
        keyEndExclusive: "session-key:dev;",
        limit: 100,
      }),
    ).toEqual([{ key: "session-key:dev:synthetic", value: expected, createdAt: 1 }]);
  });
});
