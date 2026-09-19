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
import { removeTempDirectoryAsync } from "./sqlite-readonly-location-cleanup.js";
import * as worker from "./sqlite-readonly-worker.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-snapshot-source.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([true, false])(
  "retains uncertain snapshot child cleanup and staging when its caller cancels (private=%s)",
  async (privateStaging) => {
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
    let allocated: string | undefined;
    const run = vi
      .spyOn(worker, "runSqliteReadOnlyWorker")
      .mockImplementationOnce(async (_pathname, options) => {
        allocated = options?.stagingRoot;
        if (!allocated) {
          throw new Error("Expected worker-owned snapshot staging");
        }
        await fs.writeFile(path.join(allocated, "pending-copy"), "retained");
        controller.abort(cancelled);
        throw unsettled;
      });
    try {
      const failure = await prepareSqliteReadOnlyLocation(source, {
        signal: controller.signal,
        ...(privateStaging ? { stagingRoot: staging } : {}),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(run).toHaveBeenCalledOnce();
      expect(hasCommandProcessCleanupError(failure)).toBe(true);
      expect(collectNestedErrorCandidates(failure)).toContain(unsettled);
      if (!allocated) {
        throw new Error("Expected the worker staging path");
      }
      expect(await fs.readFile(path.join(allocated, "pending-copy"), "utf8")).toBe("retained");
    } finally {
      // This controlled stub launched no child; the test can retire its exact staging.
      if (allocated) {
        await removeTempDirectoryAsync(allocated);
      }
    }
  },
);
