import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { SQLITE_CAPABILITY_PROBE } from "../../node-sqlite.mjs";

function probeSqlite(Database: unknown): unknown {
  return runInNewContext(SQLITE_CAPABILITY_PROBE, {
    require: () => ({ DatabaseSync: Database }),
    Buffer,
    Error,
    Uint8Array,
  });
}

describe("SQLite NUL capability probe", () => {
  it.each(["none", "text", "trailing", "blob", "json", "throw"] as const)(
    "detects %s corruption and closes the in-memory database",
    (corruption) => {
      const close = vi.fn();
      class FakeDatabase {
        row: Record<string, unknown> = {};
        exec() {}
        prepare(sql: string) {
          return {
            run: (
              text: string | Uint8Array,
              blob: string | Uint8Array,
              json: string | Uint8Array,
            ) => {
              this.row = { text_value: text, blob_value: blob, json_value: json };
            },
            get: () => {
              if (sql.includes("sqlite_version()")) {
                return { version: "3.51.3" };
              }
              if (corruption === "throw") {
                throw new Error("read failed");
              }
              if (corruption === "text") {
                this.row.text_value = "a";
              }
              if (corruption === "trailing") {
                this.row.text_value = "a\0b";
              }
              if (corruption === "blob") {
                this.row.blob_value = new Uint8Array([97]);
              }
              if (corruption === "json") {
                this.row.json_value = '{"value":"a"}';
              }
              return this.row;
            },
          };
        }
        close = close;
      }
      expect(probeSqlite(FakeDatabase)).toEqual({
        available: true,
        version: "3.51.3",
        text: !["text", "trailing", "throw"].includes(corruption),
        blob: !["blob", "throw"].includes(corruption),
        json: !["json", "throw"].includes(corruption),
        ...(corruption === "throw" ? { error: "read failed" } : {}),
      });
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("round-trips NULs through the real loaded SQLite binding", () => {
    expect(probeSqlite(DatabaseSync)).toMatchObject({
      available: true,
      text: true,
      blob: true,
      json: true,
    });
  });

  it("executes the serialized SQLite probe in a fresh Node process", () => {
    const output = execFileSync(
      process.execPath,
      ["-e", `process.stdout.write(JSON.stringify(${SQLITE_CAPABILITY_PROBE}))`],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output)).toMatchObject({
      available: true,
      text: true,
      blob: true,
      json: true,
    });
  });

  it.each(["supported", "nul-truncation", "unsafe-wal"] as const)(
    "probes %s SQLite without granting worker or child-process permission",
    (runtime) => {
      const moduleUrl = new URL("../../node-sqlite.mjs", import.meta.url).href;
      const output = execFileSync(
        process.execPath,
        [
          "--permission",
          "--allow-fs-read=*",
          "--input-type=module",
          "-e",
          `
            import { DatabaseSync, StatementSync } from "node:sqlite";
            const runtime = ${JSON.stringify(runtime)};
            const originalGet = StatementSync.prototype.get;
            StatementSync.prototype.get = function (...args) {
              const row = Reflect.apply(originalGet, this, args);
              if (runtime === "nul-truncation" && row?.text_value !== undefined) {
                row.text_value = "a";
              }
              if (runtime === "unsafe-wal" && row?.version !== undefined) {
                row.version = "3.51.2";
              }
              return row;
            };
            let databasesClosed = 0;
            const originalClose = DatabaseSync.prototype.close;
            DatabaseSync.prototype.close = function (...args) {
              databasesClosed++;
              return Reflect.apply(originalClose, this, args);
            };
            let workersStarted = 0;
            process.on("worker", () => workersStarted++);
            const { detectCurrentSqliteCapabilities, nodeRuntimeFailure } =
              await import(${JSON.stringify(moduleUrl)});
            const pending = detectCurrentSqliteCapabilities();
            const samePending = pending === detectCurrentSqliteCapabilities();
            const capabilities = await pending;
            process.stdout.write(JSON.stringify({
              asynchronous: pending instanceof Promise,
              samePending,
              sameResult: capabilities === await detectCurrentSqliteCapabilities(),
              capabilities,
              failure: nodeRuntimeFailure(process.versions.node, capabilities),
              databasesClosed,
              workersStarted,
              permissions: Object.fromEntries(["worker", "child", "fs.write"].map(
                (scope) => [scope, process.permission.has(scope)],
              )),
            }));
          `,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      const result = JSON.parse(output);
      expect(result).toMatchObject({
        asynchronous: true,
        samePending: true,
        sameResult: true,
        capabilities: {
          available: true,
          version: runtime === "unsafe-wal" ? "3.51.2" : expect.any(String),
          text: runtime !== "nul-truncation",
          blob: true,
          json: true,
        },
        databasesClosed: 1,
        workersStarted: 0,
        permissions: { worker: false, child: false, "fs.write": false },
      });
      if (runtime === "supported") {
        expect(result.failure).toBeNull();
      } else {
        expect(result.failure).toContain(
          runtime === "nul-truncation" ? "truncates TEXT" : "not WAL-reset-safe",
        );
      }
    },
  );

  it("shares one worker probe and joins its exit before returning capabilities", () => {
    const moduleUrl = new URL("../../node-sqlite.mjs", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import { DatabaseSync, StatementSync } from "node:sqlite";
          const counts = {};
          for (const [prototype, names] of [
            [DatabaseSync.prototype, ["prepare", "exec"]],
            [StatementSync.prototype, ["get", "all", "run", "iterate"]],
          ]) {
            for (const name of names) {
              counts[name] = 0;
              const original = prototype[name];
              prototype[name] = function (...args) {
                counts[name]++;
                return Reflect.apply(original, this, args);
              };
            }
          }
          let workersStarted = 0;
          let workersExited = 0;
          process.on("worker", (worker) => {
            workersStarted++;
            worker.once("exit", () => workersExited++);
          });
          const { detectCurrentSqliteCapabilities } = await import(${JSON.stringify(moduleUrl)});
          const pending = detectCurrentSqliteCapabilities();
          const samePending = pending === detectCurrentSqliteCapabilities();
          const capabilities = await pending;
          const sameResult = capabilities === await detectCurrentSqliteCapabilities();
          process.stdout.write(JSON.stringify({
            asynchronous: pending instanceof Promise,
            samePending, sameResult, capabilities, workersStarted, workersExited, counts,
          }));
        `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output)).toMatchObject({
      asynchronous: true,
      samePending: true,
      sameResult: true,
      capabilities: { available: true, text: true, blob: true, json: true },
      workersStarted: 1,
      workersExited: 1,
      counts: { prepare: 0, exec: 0, get: 0, all: 0, run: 0, iterate: 0 },
    });
  });
});
