import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { publishSystemEventStoreConfig } from "../config/sessions/session-store-path.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "../infra/heartbeat-events.js";
import { setHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";
import { captureSystemEventStorePaths } from "../infra/system-event-ownership.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  listSessionStateEventsSince,
  recordSessionGoalChanged,
  recordSessionHumanDirectMessage,
  recordSessionStateEvent,
  sweepSessionStateWatchNotices,
} from "./session-state-events.js";
import {
  listAmbientGroupWatchTargets,
  registerMainSessionGroupWatch,
  registerSessionStateWatch,
} from "./session-state-watches.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const watcher = "agent:main:main";
const group = "agent:main:telegram:group:room-1";
let disposeHeartbeatWakeHandler: (() => void) | undefined;

function createDatabaseOptions() {
  const stateDir = tempDirs.make("openclaw-session-watches-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  publishSystemEventStoreConfig({});
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

afterEach(async () => {
  disposeHeartbeatWakeHandler?.();
  disposeHeartbeatWakeHandler = undefined;
  vi.useRealTimers();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  resetSystemEventsForTest();
  publishSystemEventStoreConfig({});
  resetHeartbeatEventsForTest();
  vi.unstubAllEnvs();
});

describe("session watch registration", () => {
  it.each(["sync", "goal-worker"] as const)(
    "does not advance discovered watchers across store replacement (%s)",
    async (mode) => {
      const database = createDatabaseOptions();
      const oldStore = path.join(database.env.OPENCLAW_STATE_DIR, "original", "sessions.json");
      const newStore = path.join(database.env.OPENCLAW_STATE_DIR, "replacement", "sessions.json");
      publishSystemEventStoreConfig({ session: { store: oldStore } });
      await upsertSessionEntryCore(
        { sessionKey: watcher, storePath: oldStore, env: database.env },
        { sessionId: "original-watcher", updatedAt: Date.now() },
      );
      expect(
        registerSessionStateWatch(
          { watcherSessionKey: watcher, targetSessionKey: group },
          database,
        ),
      ).toBe(true);
      const { db } = openOpenClawStateDatabase(database);
      const readWatch = () =>
        db
          .prepare(
            "SELECT * FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?",
          )
          .get(watcher, group);
      const originalWatch = readWatch();
      const recordChange = async (summary: string) => {
        if (mode === "goal-worker") {
          await recordSessionGoalChanged({
            watcherStorePaths: captureSystemEventStorePaths(),
            sessionKey: group,
            entry: { sessionId: "watched-session", updatedAt: Date.now() },
            agentId: "main",
            summary,
          });
        } else {
          recordSessionStateEvent(
            {
              sessionKey: group,
              agentId: "main",
              kind: "goal_changed",
              actorType: "system",
              summary,
            },
            database,
          );
        }
      };

      publishSystemEventStoreConfig({ session: { store: newStore } });
      await recordChange("replacement-store change");

      expect(peekSystemEventEntries(watcher)).toEqual([]);
      expect(listSessionStateEventsSince(group, "main", 0, 200, database).events).toMatchObject([
        { summary: "replacement-store change" },
      ]);
      expect.soft(readWatch()).toEqual(originalWatch);
      publishSystemEventStoreConfig({ session: { store: oldStore } });
      sweepSessionStateWatchNotices(database);
      expect(peekSystemEventEntries(watcher)).toEqual([]);

      await recordChange("same-store change");
      expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    },
  );

  it("promotes an ambient main-to-group watch to explicit immediate delivery", async () => {
    vi.useFakeTimers();
    const wakes = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(wakes);
    await vi.runAllTimersAsync();
    wakes.mockClear();
    const database = createDatabaseOptions();
    registerMainSessionGroupWatch({ sessionKey: group, agentId: "main" }, database);
    expect(listAmbientGroupWatchTargets(watcher, database)).toEqual(new Set([group]));

    registerSessionStateWatch({ watcherSessionKey: watcher, targetSessionKey: group }, database);
    expect(listAmbientGroupWatchTargets(watcher, database)).toEqual(new Set());
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare(
          `SELECT provenance FROM session_watch_cursors
           WHERE watcher_session_key = ? AND target_session_key = ?`,
        )
        .get(watcher, group),
    ).toEqual({ provenance: "explicit" });
    // Later inbound group registration must not downgrade the explicit watch.
    registerMainSessionGroupWatch({ sessionKey: group, agentId: "main" }, database);

    recordSessionHumanDirectMessage(
      {
        watcherStorePaths: captureSystemEventStorePaths(),
        sessionKey: group,
        entry: { sessionId: "session-group", updatedAt: Date.now(), chatType: "group" },
        agentId: "main",
        actor: { actorType: "human", actorId: "human-1" },
        channel: "telegram",
      },
      database,
    );
    const { db } = openOpenClawStateDatabase(database);
    const readWatch = () =>
      db
        .prepare(
          "SELECT * FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?",
        )
        .get(watcher, group);
    const currentWatch = readWatch();
    expect(
      registerMainSessionGroupWatch(
        {
          sessionKey: group,
          agentId: "main",
          watcherStorePath: path.join(
            database.env.OPENCLAW_STATE_DIR,
            "retired",
            "openclaw-agent.sqlite",
          ),
        },
        database,
      ),
    ).toBe(false);
    expect(readWatch()).toEqual(currentWatch);
    expect(getLastHeartbeatEvent()).toMatchObject({ status: "skipped", reason: "store-replaced" });
    await vi.advanceTimersByTimeAsync(21_000);

    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(wakes).toHaveBeenCalledTimes(1);
  });
});
