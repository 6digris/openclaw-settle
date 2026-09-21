import { AsyncResource } from "node:async_hooks";
import { fork } from "node:child_process";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { prepareDoctorSessionTranscriptFts } from "../commands/doctor-session-transcript-fts.js";
import { withDoctorSqliteMaintenanceLock } from "../commands/doctor-sqlite-maintenance-lock.js";
import * as sqlite from "../infra/node-sqlite.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import {
  AGENT_DATABASE_MAINTENANCE_LEASE,
  assertNoOpenClawAgentDatabaseLeases,
  runWithAgentDatabaseMaintenanceAuthority,
} from "./openclaw-agent-db-lease.js";
import { getOpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  migrateOpenClawAgentDatabaseForMaintenance,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
  withAgentDatabaseMaintenanceLease,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import { clearOpenClawAgentIntegrityVerification } from "./openclaw-quarantine-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(roots);
});

function fixture() {
  const root = makeTempDir(roots, "agent-maintenance-");
  const env = { OPENCLAW_STATE_DIR: root };
  const database = openOpenClawAgentDatabase({ agentId: "worker", env });
  const options = { agentId: "worker", pathname: database.path };
  database.db.exec(`
    INSERT INTO cache_entries (scope,key,value_json,expires_at,updated_at)
      VALUES ('maintenance','retained','{"retained":true}',100,1);
  `);
  closeOpenClawAgentDatabasesForTest();
  const state = openOpenClawStateDatabase({ env });
  return { env, options, state };
}

function readIndexState(pathname: string) {
  const database = sqlite.openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return {
      index: database
        .prepare("SELECT sql FROM sqlite_schema WHERE name='idx_agent_cache_expiry'")
        .get(),
      integrity: database.prepare("PRAGMA integrity_check;").all(),
      retained: database.prepare("SELECT value_json FROM cache_entries").all(),
    };
  } finally {
    database.close();
  }
}

function installIndexDrift(pathname: string, corrupt: boolean) {
  const database = sqlite.openNodeSqliteDatabase(pathname);
  try {
    database.exec(`
      DROP INDEX idx_agent_cache_expiry;
      CREATE INDEX idx_agent_cache_expiry ON cache_entries(key);
    `);
    if (corrupt) {
      // The claimed definition disagrees with the real b-tree, exercising the
      // Worker's genuine integrity-error path before maintenance resumes.
      database.enableDefensive?.(false);
      database.exec("PRAGMA writable_schema=ON;");
      database
        .prepare("UPDATE sqlite_schema SET sql=? WHERE name='idx_agent_cache_expiry'")
        .run(
          "CREATE INDEX idx_agent_cache_expiry ON cache_entries(scope, expires_at, key) WHERE expires_at IS NOT NULL",
        );
      database.exec("PRAGMA writable_schema=OFF;");
      database.exec(
        `PRAGMA schema_version=${readSqliteNumberPragma(database, "schema_version") + 1};`,
      );
    }
  } finally {
    database.close();
  }
}

function withAbortableMaintenance<T>(
  f: ReturnType<typeof fixture>,
  signal: AbortSignal,
  run: (maintenance: OpenClawStateLeaseContext) => Promise<T>,
): Promise<T> {
  // Exercise the existing lease owner's abort signal without adding a production
  // cancellation option or replacing the closure-bound maintenance context.
  return withOpenClawStateLease(
    {
      ...AGENT_DATABASE_MAINTENANCE_LEASE,
      database: { scope: "shared", options: { env: f.env } },
      leaseMs: 60_000,
      waitMs: 5_000,
      heartbeat: "worker",
      signal,
    },
    (maintenance) => {
      assertNoOpenClawAgentDatabaseLeases(maintenance, { env: f.env });
      return runWithAgentDatabaseMaintenanceAuthority(
        maintenance,
        resolveOpenClawStateSqlitePath(f.env),
        () => run(maintenance),
      );
    },
  );
}

function legacyFtsFixture(rowCount = 600) {
  const f = fixture();
  const database = sqlite.openNodeSqliteDatabase(f.options.pathname);
  database.exec("BEGIN");
  for (const session of ["legacy", "complete"]) {
    database
      .prepare(
        "INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at) VALUES (?,?,'{}',1)",
      )
      .run(session, session);
    database
      .prepare(
        "INSERT INTO session_windows (session_id,session_key,created_at,updated_at) VALUES (?,?,1,1)",
      )
      .run(session, session);
    database
      .prepare(
        "INSERT INTO session_transcript_index_state (session_id,indexed_seq,needs_rebuild,fts_row_count,updated_at) VALUES (?,600,?,?,?)",
      )
      .run(session, session === "legacy" ? 1 : 0, session === "legacy" ? null : 1, -17);
  }
  for (let seq = 0; seq < rowCount; seq++) {
    const event = JSON.stringify({
      type: "message",
      id: `m${seq}`,
      parentId: seq ? `m${seq - 1}` : null,
      message: { role: "user", content: "retained needle" },
    });
    database.prepare("INSERT INTO transcript_events VALUES (?,?,?,1)").run("legacy", seq, event);
    database
      .prepare(
        "INSERT INTO session_transcript_fts (rowid,session_id,message_id,text) VALUES (?,?,?,?)",
      )
      .run(seq - 3, "legacy", `m${seq}`, "retained needle");
  }
  database.exec(
    "INSERT INTO session_transcript_fts (session_id,message_id,text) VALUES ('complete','sibling','untouched'); INSERT INTO session_transcript_fts_rows SELECT session_id,rowid FROM session_transcript_fts WHERE session_id='complete'; COMMIT",
  );
  const before = {
    events: database.prepare("SELECT * FROM transcript_events ORDER BY seq").all(),
    fts: database.prepare("SELECT rowid,* FROM session_transcript_fts ORDER BY rowid").all(),
    state: database
      .prepare(
        "SELECT session_id,indexed_seq,needs_rebuild,updated_at FROM session_transcript_index_state ORDER BY session_id",
      )
      .all(),
  };
  database.close();
  return { ...f, before };
}

describe("asynchronous agent database maintenance admission", () => {
  it("prepares legacy FTS ownership without publishing transcript freshness", async () => {
    const f = legacyFtsFixture();
    const { before } = f;
    for (let attempt = 0; attempt < 2; attempt++) {
      const prepared = await withDoctorSqliteMaintenanceLock({
        env: f.env,
        operation: "synthetic transcript preparation",
        protectedPaths: [f.options.pathname],
        run: (authority) =>
          prepareDoctorSessionTranscriptFts({
            env: f.env,
            authority,
            targets: [
              { agentId: "worker", storePath: f.options.pathname, sqlitePath: f.options.pathname },
            ],
          }),
      });
      expect(prepared).toBe(attempt ? 0 : 1);
      const after = sqlite.openNodeSqliteDatabase(f.options.pathname, { readOnly: true });
      try {
        expect(
          after
            .prepare(
              "SELECT session_id,fts_row_count FROM session_transcript_index_state ORDER BY session_id",
            )
            .all(),
        ).toEqual([
          { session_id: "complete", fts_row_count: 1 },
          { session_id: "legacy", fts_row_count: 600 },
        ]);
        expect(after.prepare("SELECT count(*) n FROM session_transcript_fts_rows").get()).toEqual({
          n: 601,
        });
        expect(after.prepare("SELECT * FROM transcript_events ORDER BY seq").all()).toEqual(
          before.events,
        );
        expect(
          after.prepare("SELECT rowid,* FROM session_transcript_fts ORDER BY rowid").all(),
        ).toEqual(before.fts);
        expect(
          after
            .prepare(
              "SELECT session_id,indexed_seq,needs_rebuild,updated_at FROM session_transcript_index_state ORDER BY session_id",
            )
            .all(),
        ).toEqual(before.state);
      } finally {
        after.close();
      }
    }
  });

  it.each(["into-complete", "from-complete"])(
    "refuses conflicting FTS ownership %s without certifying a dirty projection",
    async (direction) => {
      const f = legacyFtsFixture();
      const database = sqlite.openNodeSqliteDatabase(f.options.pathname);
      if (direction === "into-complete") {
        database.exec("UPDATE session_transcript_fts_rows SET session_id='legacy'");
      } else {
        database.exec(
          "INSERT INTO session_transcript_fts_rows SELECT 'complete',min(rowid) FROM session_transcript_fts WHERE session_id='legacy'",
        );
      }
      database.close();
      await expect(
        withAgentDatabaseMaintenanceLease({ env: f.env }, (maintenance) =>
          migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance),
        ),
      ).rejects.toThrow("conflicting session ownership");
      const after = sqlite.openNodeSqliteDatabase(f.options.pathname, { readOnly: true });
      try {
        expect(
          after
            .prepare(
              "SELECT fts_row_count,needs_rebuild,updated_at FROM session_transcript_index_state WHERE session_id='legacy'",
            )
            .get(),
        ).toEqual({ fts_row_count: null, needs_rebuild: 1, updated_at: -17 });
        expect(
          after.prepare("SELECT rowid,* FROM session_transcript_fts ORDER BY rowid").all(),
        ).toEqual(f.before.fts);
        expect(after.prepare("SELECT * FROM transcript_events ORDER BY seq").all()).toEqual(
          f.before.events,
        );
      } finally {
        after.close();
      }
    },
  );

  it.each(["mappings", "counts"])(
    "retains resumable FTS %s batches when the maintenance owner is aborted",
    async (phase) => {
      const f = legacyFtsFixture();
      if (phase === "counts") {
        const database = sqlite.openNodeSqliteDatabase(f.options.pathname);
        database.exec("BEGIN");
        for (let index = 0; index < 600; index++) {
          const id = `empty-${index}`;
          database
            .prepare(
              "INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at) VALUES (?,?,'{}',1)",
            )
            .run(id, id);
          database
            .prepare(
              "INSERT INTO session_windows (session_id,session_key,created_at,updated_at) VALUES (?,?,1,1)",
            )
            .run(id, id);
          database
            .prepare(
              "INSERT INTO session_transcript_index_state (session_id,indexed_seq,needs_rebuild,fts_row_count,updated_at) VALUES (?,-1,1,NULL,-17)",
            )
            .run(id);
        }
        database.exec("COMMIT");
        database.close();
      }
      const abort = new AbortController();
      let observation: { n: number } | undefined;
      let tick: NodeJS.Immediate | undefined;
      let stopped = false;
      const observe = () => {
        if (stopped) {
          return;
        }
        const database = sqlite.openNodeSqliteDatabase(f.options.pathname, { readOnly: true });
        try {
          const row = database
            .prepare(
              phase === "mappings"
                ? "SELECT count(*) n FROM session_transcript_fts_rows WHERE session_id='legacy'"
                : "SELECT count(*) n FROM session_transcript_index_state WHERE session_id LIKE 'empty-%' AND fts_row_count IS NOT NULL",
            )
            .get() as { n: number };
          if (row.n > 0 && row.n < 600) {
            observation = row;
            abort.abort(new Error("synthetic FTS preparation abort"));
            return;
          }
        } finally {
          database.close();
        }
        tick = setImmediate(observe);
      };
      tick = setImmediate(observe);
      try {
        await expect(
          withAbortableMaintenance(f, abort.signal, (maintenance) =>
            migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance),
          ),
        ).rejects.toThrow(/abort/);
        expect(observation).toBeDefined();
      } finally {
        stopped = true;
        if (tick) {
          clearImmediate(tick);
        }
      }
      const interrupted = sqlite.openNodeSqliteDatabase(f.options.pathname, { readOnly: true });
      try {
        expect(
          interrupted
            .prepare(
              "SELECT fts_row_count,needs_rebuild,updated_at FROM session_transcript_index_state WHERE session_id='legacy'",
            )
            .get(),
        ).toEqual({ fts_row_count: null, needs_rebuild: 1, updated_at: -17 });
      } finally {
        interrupted.close();
      }
      await withAgentDatabaseMaintenanceLease({ env: f.env }, (maintenance) =>
        migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance),
      );
      const resumed = sqlite.openNodeSqliteDatabase(f.options.pathname, { readOnly: true });
      try {
        expect(
          resumed
            .prepare("SELECT count(*) n FROM session_transcript_fts_rows WHERE session_id='legacy'")
            .get(),
        ).toEqual({ n: 600 });
        expect(
          resumed
            .prepare(
              "SELECT fts_row_count,needs_rebuild,updated_at FROM session_transcript_index_state WHERE session_id='legacy'",
            )
            .get(),
        ).toEqual({ fts_row_count: 600, needs_rebuild: 1, updated_at: -17 });
        expect(resumed.prepare("SELECT * FROM transcript_events ORDER BY seq").all()).toEqual(
          f.before.events,
        );
        expect(
          resumed.prepare("SELECT rowid,* FROM session_transcript_fts ORDER BY rowid").all(),
        ).toEqual(f.before.fts);
        if (phase === "counts") {
          expect(
            resumed
              .prepare(
                "SELECT count(*) n FROM session_transcript_index_state WHERE session_id LIKE 'empty-%' AND fts_row_count=0 AND needs_rebuild=1 AND updated_at=-17",
              )
              .get(),
          ).toEqual({ n: 600 });
        }
      } finally {
        resumed.close();
      }
    },
  );

  it("cancels a large session count before certifying partial ownership", async () => {
    const rowCount = 4096;
    const f = legacyFtsFixture(rowCount);
    const abort = new AbortController();
    let tick: NodeJS.Immediate | undefined;
    let stopped = false;
    const observe = () => {
      if (stopped) {
        return;
      }
      const database = sqlite.openNodeSqliteDatabase(f.options.pathname, { readOnly: true });
      let mapped: number;
      try {
        mapped = (
          database
            .prepare("SELECT count(*) n FROM session_transcript_fts_rows WHERE session_id='legacy'")
            .get() as { n: number }
        ).n;
      } finally {
        database.close();
      }
      // Let preparation enter its count work after mapping coverage completes,
      // then cancel through the real lease signal before it can certify the count.
      tick = setImmediate(
        mapped === rowCount
          ? () => {
              tick = setImmediate(() =>
                abort.abort(new Error("synthetic count preparation abort")),
              );
            }
          : observe,
      );
    };
    tick = setImmediate(observe);
    try {
      await expect(
        withAbortableMaintenance(f, abort.signal, (maintenance) =>
          migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance),
        ),
      ).rejects.toThrow(/abort/);
    } finally {
      stopped = true;
      if (tick) {
        clearImmediate(tick);
      }
    }
    const interrupted = sqlite.openNodeSqliteDatabase(f.options.pathname, { readOnly: true });
    try {
      expect(
        interrupted
          .prepare(
            "SELECT fts_row_count,needs_rebuild,updated_at FROM session_transcript_index_state WHERE session_id='legacy'",
          )
          .get(),
      ).toEqual({ fts_row_count: null, needs_rebuild: 1, updated_at: -17 });
    } finally {
      interrupted.close();
    }
    await withAgentDatabaseMaintenanceLease({ env: f.env }, (maintenance) =>
      migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance),
    );
    const resumed = sqlite.openNodeSqliteDatabase(f.options.pathname, { readOnly: true });
    try {
      expect(
        resumed
          .prepare(
            "SELECT fts_row_count,needs_rebuild,updated_at FROM session_transcript_index_state WHERE session_id='legacy'",
          )
          .get(),
      ).toEqual({ fts_row_count: rowCount, needs_rebuild: 1, updated_at: -17 });
      expect(resumed.prepare("SELECT * FROM transcript_events ORDER BY seq").all()).toEqual(
        f.before.events,
      );
      expect(
        resumed.prepare("SELECT rowid,* FROM session_transcript_fts ORDER BY rowid").all(),
      ).toEqual(f.before.fts);
    } finally {
      resumed.close();
    }
  });

  it("reuses one integrity process across agent maintenance while checking each file afresh", async () => {
    const f = fixture();
    const createTarget = (agentId: string) => {
      const database = openOpenClawAgentDatabase({ agentId, env: f.env });
      const validation = expectDefined(
        getOpenClawAgentDatabaseValidation(database),
        "verified maintenance target",
      );
      return { agentId, pathname: database.path, validation };
    };
    const second = createTarget("second");
    const third = createTarget("third");
    await closeOpenClawAgentDatabasesAsync();
    expect(Atomics.load(new Int32Array(second.validation.valid), 0)).toBe(1);
    expect(Atomics.load(new Int32Array(third.validation.valid), 0)).toBe(1);
    vi.mocked(fork).mockClear();
    const entry = resolveRuntimeProcessEntrypointUrl("sqliteIntegrity").href;
    const children = () =>
      vi.mocked(fork).mock.calls.flatMap((args, index) => {
        if (String(args[0]) !== entry) {
          return [];
        }
        const result = expectDefined(vi.mocked(fork).mock.results[index], "integrity fork result");
        if (result.type !== "return") {
          throw new Error("Integrity worker did not start");
        }
        return [result.value];
      });
    await withAgentDatabaseMaintenanceLease({ env: f.env }, async (maintenance) => {
      expect(Atomics.load(new Int32Array(second.validation.valid), 0)).toBe(0);
      expect(Atomics.load(new Int32Array(third.validation.valid), 0)).toBe(0);
      await migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance);
      await withAgentDatabaseMaintenanceLease({ env: f.env }, async (nested) => {
        await migrateOpenClawAgentDatabaseForMaintenance(second, nested);
      });
      await migrateOpenClawAgentDatabaseForMaintenance(third, maintenance);
      expect(children()).toHaveLength(1);
      const child = expectDefined(children()[0], "reused integrity child");
      expect(child.exitCode).toBeNull();

      installIndexDrift(f.options.pathname, true);
      await expect(
        integrityWorker.assertSqliteIntegrityInWorker(f.options.pathname, 250, maintenance.signal),
      ).rejects.toMatchObject({ name: "SqliteIntegrityError" });
      expect(child.exitCode).toBe(0);
      await migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance);
      expect(readIndexState(f.options.pathname).integrity).toEqual([{ integrity_check: "ok" }]);
      maintenance.assertOwned();
    });
    expect(children().every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
      true,
    );
    expect(f.state.db.prepare("SELECT owner FROM state_leases").all()).toEqual([]);
  });

  it("yields during real integrity admission while retaining the maintenance fence", async () => {
    const f = fixture();
    const before = readIndexState(f.options.pathname);
    await withAgentDatabaseMaintenanceLease({ env: f.env }, async (maintenance) => {
      let progressed = false;
      const tick = setImmediate(() => {
        progressed = true;
      });
      try {
        await migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance);
        expect(progressed).toBe(true);
        maintenance.assertOwned();
        expect(() => openOpenClawAgentDatabase({ agentId: "worker", env: f.env })).toThrow(
          /maintenance is in progress/,
        );
      } finally {
        clearImmediate(tick);
      }
    });
    expect(readIndexState(f.options.pathname)).toEqual(before);
  });

  it.each([false, true])(
    "admits only the live mutation owner and revokes inherited callbacks (cached=%s)",
    async (cached) => {
      const f = fixture();
      const before = readIndexState(f.options.pathname);
      const ready = createDeferred();
      const release = createDeferred();
      const open = () => openOpenClawAgentDatabase({ agentId: "worker", env: f.env });
      let late: (() => ReturnType<typeof open>) | undefined;
      const running = withAgentDatabaseMaintenanceLease({ env: f.env }, async (maintenance) => {
        const mutation = maintenance.withDatabaseFileMutation;
        if (!mutation) {
          throw new Error("Missing live mutation owner");
        }
        await mutation({
          assertCurrent: () => maintenance.assertOwned(),
          async mutate() {
            late = AsyncResource.bind(open);
            try {
              expect(open().db.prepare("SELECT value_json FROM cache_entries").all()).toEqual(
                before.retained,
              );
              if (!cached) {
                await closeOpenClawAgentDatabasesAsync();
              }
              ready.resolve();
              await release.promise;
            } finally {
              await closeOpenClawAgentDatabasesAsync();
            }
          },
          async capture() {
            expect(() => late?.()).toThrow(/scope is (closed|no longer current)/);
          },
          bind() {
            return undefined;
          },
        });
      });
      void running.catch((error: unknown) => ready.reject(error));
      try {
        await ready.promise;
        expect(open).toThrow(
          cached
            ? /another maintenance mutation scope/
            : /another OpenClaw process owns state-handles/,
        );
      } finally {
        release.resolve();
        await running;
      }
      expect(() => late?.()).toThrow(/scope is (closed|no longer current)/);
      expect(readIndexState(f.options.pathname)).toEqual(before);
    },
  );

  it("refuses a foreign caller coalesced onto the mutation owner's real async admission", async () => {
    const f = fixture();
    clearOpenClawAgentIntegrityVerification(f.options.pathname, f.env);
    const ready = createDeferred();
    const release = createDeferred();
    const inspect = integrityWorker.assertSqliteIntegrityInWorker;
    vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
      async (...args) => {
        ready.resolve();
        await release.promise;
        return inspect(...args);
      },
    );
    const ownerOperation = vi.fn();
    const foreignOperation = vi.fn();
    const options = { agentId: "worker", env: f.env };
    const running = withAgentDatabaseMaintenanceLease({ env: f.env }, async (maintenance) => {
      const mutation = maintenance.withDatabaseFileMutation;
      if (!mutation) {
        throw new Error("Missing live mutation owner");
      }
      await mutation({
        assertCurrent: () => maintenance.assertOwned(),
        async mutate() {
          try {
            await withOpenClawAgentDatabaseAsync(options, ownerOperation);
          } finally {
            await closeOpenClawAgentDatabasesAsync();
          }
        },
        async capture() {},
        bind() {
          return undefined;
        },
      });
    });
    void running.catch((error: unknown) => ready.reject(error));
    try {
      await ready.promise;
      const foreign = withOpenClawAgentDatabaseAsync(options, foreignOperation);
      const refused = expect(foreign).rejects.toThrow(/another maintenance mutation scope/);
      release.resolve();
      await refused;
      await running;
      expect(ownerOperation).toHaveBeenCalledOnce();
      expect(foreignOperation).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await running;
    }
  });

  it.each(["expiry", "replacement"] as const)(
    "refuses ordinary agent admission after the mutation owner's %s",
    async (loss) => {
      const f = fixture();
      const before = readIndexState(f.options.pathname);
      await expect(
        withAgentDatabaseMaintenanceLease({ env: f.env }, async (maintenance) => {
          const mutation = maintenance.withDatabaseFileMutation;
          if (!mutation) {
            throw new Error("Missing live mutation owner");
          }
          await mutation({
            assertCurrent: () => maintenance.assertOwned(),
            async mutate() {
              runOpenClawStateWriteTransaction(
                (database) => {
                  database.db
                    .prepare(
                      `UPDATE state_leases SET ${loss === "expiry" ? "expires_at=0" : "owner='successor'"}
                    WHERE scope=? AND lease_key=?`,
                    )
                    .run(
                      AGENT_DATABASE_MAINTENANCE_LEASE.scope,
                      AGENT_DATABASE_MAINTENANCE_LEASE.key,
                    );
                },
                { env: f.env },
              );
              expect(() => openOpenClawAgentDatabase({ agentId: "worker", env: f.env })).toThrow(
                /lost/i,
              );
            },
            async capture() {
              throw new Error("Capture must not run after ownership loss");
            },
            bind() {
              return undefined;
            },
          });
        }),
      ).rejects.toThrow(/lost/i);
      expect(readIndexState(f.options.pathname)).toEqual(before);
    },
  );

  it.each(
    [false, true].flatMap((corrupt) =>
      (["expiry", "replacement", "abort"] as const).map((loss) => ({ corrupt, loss })),
    ),
  )("fences Worker resume after $loss (integrity failure=$corrupt)", async ({ corrupt, loss }) => {
    const f = fixture();
    installIndexDrift(f.options.pathname, corrupt);
    const before = readIndexState(f.options.pathname);
    const abort = new AbortController();
    const check = integrityWorker.assertSqliteIntegrityInWorker;
    const spy = vi
      .spyOn(integrityWorker, "assertSqliteIntegrityInWorker")
      .mockImplementation(async (...args) => {
        let failed = false;
        let failure: unknown;
        try {
          await check(...args);
        } catch (error) {
          failed = true;
          failure = error;
        }
        expect(failed).toBe(corrupt);
        if (loss === "abort") {
          abort.abort(new Error("synthetic maintenance abort"));
        } else {
          f.state.db
            .prepare(
              `UPDATE state_leases SET ${loss === "expiry" ? "expires_at=0" : "owner='successor'"}
                WHERE scope=? AND lease_key=?`,
            )
            .run(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key);
        }
        if (failed) {
          throw failure;
        }
      });
    try {
      await expect(
        withAbortableMaintenance(f, abort.signal, (maintenance) =>
          migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance),
        ),
      ).rejects.toThrow(/lost|abort/i);
      expect(spy).toHaveBeenCalledOnce();
      expect(readIndexState(f.options.pathname)).toEqual(before);
      if (loss === "replacement") {
        expect(f.state.db.prepare("SELECT owner FROM state_leases").all()).toEqual([
          { owner: "successor" },
        ]);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it.each(
    [false, true].flatMap((corrupt) =>
      (["owner", "version"] as const).map((changed) => ({ corrupt, changed })),
    ),
  )(
    "refuses changed database $changed before Worker resume repairs indexes (integrity failure=$corrupt)",
    async ({ corrupt, changed }) => {
      const f = fixture();
      installIndexDrift(f.options.pathname, corrupt);
      const before = readIndexState(f.options.pathname);
      const check = integrityWorker.assertSqliteIntegrityInWorker;
      const spy = vi
        .spyOn(integrityWorker, "assertSqliteIntegrityInWorker")
        .mockImplementationOnce(async (...args) => {
          let failed = false;
          let failure: unknown;
          try {
            await check(...args);
          } catch (error) {
            failed = true;
            failure = error;
          }
          expect(failed).toBe(corrupt);
          // Change the same file after the real scan, before its result is consumed.
          const database = sqlite.openNodeSqliteDatabase(f.options.pathname);
          try {
            if (changed === "owner") {
              database
                .prepare("UPDATE schema_meta SET agent_id=? WHERE meta_key='primary'")
                .run("other-agent");
            } else {
              database.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
            }
          } finally {
            database.close();
          }
          if (failed) {
            throw failure;
          }
        });
      try {
        await expect(
          withAgentDatabaseMaintenanceLease({ env: f.env }, (maintenance) =>
            migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance),
          ),
        ).rejects.toThrow(changed === "owner" ? /belongs to agent other-agent/ : /newer schema/);
        expect(spy).toHaveBeenCalledOnce();
        expect(readIndexState(f.options.pathname)).toEqual(before);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("joins a cancelled real Worker before closing its database or releasing the fence", async () => {
    const f = fixture();
    const abort = new AbortController();
    const check = integrityWorker.assertSqliteIntegrityInWorker;
    const open = sqlite.openNodeSqliteDatabase;
    let completed = false;
    let native: Promise<void> | undefined;
    vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
      const database = open(pathname, options);
      if (pathname === f.options.pathname && options?.readOnly !== true) {
        const close = database.close.bind(database);
        database.close = () => {
          try {
            expect(completed).toBe(true);
          } finally {
            close();
          }
        };
      }
      return database;
    });
    vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation((...args) => {
      native = check(...args).finally(() => {
        completed = true;
      });
      abort.abort(new Error("synthetic maintenance abort"));
      expect(completed).toBe(false);
      expect(f.state.db.prepare("SELECT owner FROM state_leases").all()).toHaveLength(1);
      return native;
    });
    try {
      await expect(
        withAbortableMaintenance(f, abort.signal, (maintenance) =>
          migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance),
        ),
      ).rejects.toThrow(/abort/i);
      expect(completed).toBe(true);
      expect(f.state.db.prepare("SELECT owner FROM state_leases").all()).toEqual([]);
    } finally {
      await native?.catch(() => {});
    }
  });

  it("rejects a retained closed maintenance context before opening or scanning", async () => {
    const f = fixture();
    let retained: OpenClawStateLeaseContext | undefined;
    await withAgentDatabaseMaintenanceLease({ env: f.env }, async (maintenance) => {
      retained = maintenance;
    });
    expect(retained).toBeDefined();
    const open = vi.spyOn(sqlite, "openNodeSqliteDatabase");
    const scan = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    await expect(migrateOpenClawAgentDatabaseForMaintenance(f.options, retained!)).rejects.toThrow(
      /stopped-writer maintenance/,
    );
    expect(open).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  it.each(["outside", "copied"] as const)(
    "requires the exact active maintenance scope when its context is %s",
    async (scope) => {
      const f = fixture();
      const ready = createDeferred<OpenClawStateLeaseContext>();
      const release = createDeferred();
      const scan = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
      const running = withAgentDatabaseMaintenanceLease({ env: f.env }, async (maintenance) => {
        if (scope === "copied") {
          await expect(
            migrateOpenClawAgentDatabaseForMaintenance(f.options, { ...maintenance }),
          ).rejects.toThrow(/stopped-writer maintenance/);
          return;
        }
        ready.resolve(maintenance);
        await release.promise;
      });
      try {
        if (scope === "outside") {
          const maintenance = await ready.promise;
          maintenance.assertOwned();
          await expect(
            migrateOpenClawAgentDatabaseForMaintenance(f.options, maintenance),
          ).rejects.toThrow(/stopped-writer maintenance/);
        }
      } finally {
        release.resolve();
        await running;
      }
      expect(scan).not.toHaveBeenCalled();
    },
  );
});
