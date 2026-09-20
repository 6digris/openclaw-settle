import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcilesInStateDir,
} from "./session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);
const observer = useReconcileWorkerObserver();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture(count = 1) {
  const stateDir = tempDirs.make("transcript-publication-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const options = { agentId: "main", env };
  const scope = { ...options, sessionId: "publication", sessionKey: "agent:main:publication" };
  await persistSessionTranscriptTurn(scope, {
    messages: Array.from({ length: count }, (_, index) => ({
      eventId: `message-${index}`,
      message: { role: "user" as const, content: `projection message ${index}` },
    })),
    touchSessionEntry: false,
  });
  await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
  const database = openOpenClawAgentDatabase(options);
  database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
  return { options: { ...options, path: database.path }, scope, database };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

it("publishes a cold multi-chunk projection without host data SQL", async () => {
  const { options } = await fixture(520);
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  const observed = observeHostDataSql(options.env);
  try {
    await expect(reconcileSessionTranscriptIndexes(options)).resolves.toEqual({
      reconciledSessions: 1,
    });
    await expect(reconcileSessionTranscriptIndexes(options)).resolves.toEqual({
      reconciledSessions: 0,
    });
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    expect(observed.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  } finally {
    observed.restore();
  }
  const { db } = openOpenClawAgentDatabase(options);
  expect(
    db
      .prepare("SELECT needs_rebuild, active_message_count FROM session_transcript_index_state")
      .get(),
  ).toEqual({ needs_rebuild: 0, active_message_count: 520 });
  expect(
    db.prepare("SELECT count(*) AS count FROM session_transcript_active_events").get(),
  ).toEqual({ count: 520 });
  expect(
    db.prepare("SELECT message_id, text FROM session_transcript_fts ORDER BY rowid").all(),
  ).toEqual(
    Array.from({ length: 520 }, (_, index) => ({
      message_id: `message-${index}`,
      text: `projection message ${index}`,
    })),
  );
}, 30_000);

it("publishes the session change only after finalization commits", async () => {
  const { options, scope, database } = await fixture();
  const changes: unknown[] = [];
  const stop = sessionChanges.subscribe((change) => {
    if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
      changes.push(
        database.db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get(),
      );
    }
  });
  try {
    observer.onTask = ({ observeMessage }) => {
      observeMessage((message) => {
        if (message.type === "plan-start") {
          database.db.exec(`CREATE TRIGGER refuse_projection BEFORE UPDATE OF needs_rebuild
            ON session_transcript_index_state WHEN NEW.needs_rebuild = 0
            BEGIN SELECT RAISE(ABORT, 'fixture finalization refused'); END;`);
        }
      });
    };
    await expect(reconcileSessionTranscriptIndexes(options)).rejects.toThrow(
      "fixture finalization refused",
    );
    observer.onTask = undefined;
    expect(changes).toEqual([]);
    expect(
      database.db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get(),
    ).toEqual({ needs_rebuild: 1 });
    database.db.exec("DROP TRIGGER refuse_projection");
    await expect(reconcileSessionTranscriptIndexes(options)).resolves.toEqual({
      reconciledSessions: 1,
    });
    expect(changes).toEqual([{ needs_rebuild: 0 }]);
  } finally {
    stop();
  }
}, 30_000);

it("refuses a retired scheduled owner and permits an explicit fresh repair", async () => {
  const { options } = await fixture();
  startSessionTranscriptIndexReconcile(options);
  await closeOpenClawAgentDatabasesAsync();
  await waitForSessionTranscriptIndexReconcile(options);
  const { db } = openOpenClawAgentDatabase(options);
  expect(db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get()).toEqual({
    needs_rebuild: 1,
  });
  await expect(reconcileSessionTranscriptIndexes(options)).resolves.toEqual({
    reconciledSessions: 1,
  });
  expect(db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get()).toEqual({
    needs_rebuild: 0,
  });
}, 30_000);

it("keeps a successor request separate from a retired scheduled owner", async () => {
  const { options, scope } = await fixture();
  const paused = createDeferred();
  let release: (() => void) | undefined;
  observer.onTask = ({ port, observeMessage }) => {
    let finishing = false;
    observeMessage((message) => {
      finishing = message.type === "plan-finish";
    });
    const post = port.postMessage.bind(port);
    port.postMessage = (message, transferList) => {
      const postOptions = Array.isArray(transferList) ? { transfer: transferList } : transferList;
      if (finishing) {
        finishing = false;
        release = () => post(message, postOptions);
        paused.resolve();
        return;
      }
      post(message, postOptions);
    };
  };
  startSessionTranscriptIndexReconcile(options);
  try {
    await paused.promise;
    await closeOpenClawAgentDatabasesAsync();
    observer.onTask = undefined;
    const successor = openOpenClawAgentDatabase(options);
    successor.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);
    startSessionTranscriptIndexReconcile(options);
    release?.();
    await waitForSessionTranscriptIndexReconcilesInStateDir(options.env.OPENCLAW_STATE_DIR!);
    expect(
      successor.db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get(),
    ).toEqual({ needs_rebuild: 0 });
  } finally {
    release?.();
    await waitForSessionTranscriptIndexReconcile(options);
  }
}, 30_000);

it("rejects a prepared projection from a replaced transcript generation", async () => {
  const { options, database, scope } = await fixture();
  const changes: unknown[] = [];
  const stop = sessionChanges.subscribe((change) => changes.push(change));
  observer.onTask = ({ observeMessage }) =>
    observeMessage((message) => {
      if (message.type === "plan-start") {
        database.db
          .prepare("UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?")
          .run("replacement-generation", scope.sessionId);
      }
    });
  try {
    await expect(reconcileSessionTranscriptIndexes(options)).resolves.toEqual({
      reconciledSessions: 0,
    });
    expect(changes).toEqual([]);
    expect(
      database.db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get(),
    ).toEqual({ needs_rebuild: 1 });
    expect(
      database.db.prepare("SELECT message_id, text FROM session_transcript_fts").all(),
    ).toEqual([{ message_id: "message-0", text: "projection message 0" }]);
  } finally {
    stop();
  }
}, 30_000);
