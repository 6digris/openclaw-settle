import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { resolveRuntimeWorkerArgv } from "./runtime-worker-url.js";

const execFileAsync = promisify(execFile);
const sourceUrl = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);

describe("SQLite worker diagnostic output", () => {
  it.each([false, true])(
    "keeps migration diagnostics off stdout with parent stderr routing %s",
    async (parentRoutesToStderr) => {
      await withOpenClawTestState({ label: "sqlite-worker-stdout" }, async (state) => {
        await state.writeConfig({
          logging: { level: "info", consoleLevel: "info", file: state.path("worker.log") },
        });
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        await fs.mkdir(path.dirname(databasePath), { recursive: true });
        const db = openNodeSqliteDatabase(databasePath);
        try {
          // The first worker open must perform the real pending-schema integrity check.
          db.exec(OPENCLAW_STATE_SCHEMA_SQL);
          db.exec("PRAGMA user_version = 0");
        } finally {
          db.close();
        }
        const childScript = await state.writeText(
          "worker-stdout-child.mts",
          `
            import { loggingState } from ${sourceUrl("src/logging/state.ts")};
            import { captureOpenClawStateWorkerContext } from ${sourceUrl("src/state/openclaw-state-worker-context.ts")};
            import { executeOpenClawStateWorker } from ${sourceUrl("src/state/openclaw-state-worker-store.ts")};
            import { closeOpenClawStateDatabaseAsync } from ${sourceUrl("src/state/openclaw-state-db-cache.ts")};
            loggingState.forceConsoleToStderr = ${parentRoutesToStderr};
            try {
              const flows = await executeOpenClawStateWorker(
                captureOpenClawStateWorkerContext({ env: process.env }),
                { type: "flows.list", input: { ownerKey: "agent:main:stdout-proof" } },
              );
              process.stdout.write(JSON.stringify({ flowCount: flows.length }) + "\\n");
            } finally {
              await closeOpenClawStateDatabaseAsync();
            }
          `,
        );
        const result = await execFileAsync(
          process.execPath,
          resolveRuntimeWorkerArgv(pathToFileURL(childScript)),
          {
            env: {
              ...state.env,
              OPENCLAW_TEST_CONSOLE: "1",
              OPENCLAW_LOG_LEVEL: "info",
            },
            timeout: 30_000,
          },
        );

        expect(result.stdout).toBe(`${JSON.stringify({ flowCount: 0 })}\n`);
        expect(result.stderr).toContain(
          "state database schema migration pending; verifying integrity first",
        );
      });
    },
    60_000,
  );
});
