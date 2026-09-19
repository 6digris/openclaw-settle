import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { collectNestedErrorCandidates } from "./error-graph-internal.js";
import * as worker from "./sqlite-readonly-worker.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-snapshot-source.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("retains uncertain snapshot child cleanup when its caller cancels", async () => {
  const root = dirs.make("snapshot-uncertain-cancellation-");
  const source = path.join(root, "source.sqlite");
  const db = new DatabaseSync(source);
  db.exec("CREATE TABLE payload(value TEXT)");
  db.close();
  const staging = path.join(root, "staging");
  await fs.mkdir(staging);
  const controller = new AbortController();
  const cancelled = new Error("snapshot caller cancelled");
  const unsettled = new CommandProcessCleanupError();
  const run = vi.spyOn(worker, "runSqliteReadOnlyWorker").mockImplementationOnce(async () => {
    controller.abort(cancelled);
    throw unsettled;
  });
  const failure = await prepareSqliteReadOnlyLocation(source, {
    signal: controller.signal,
    stagingRoot: staging,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(run).toHaveBeenCalledOnce();
  expect(hasCommandProcessCleanupError(failure)).toBe(true);
  expect(collectNestedErrorCandidates(failure)).toContain(unsettled);
});
