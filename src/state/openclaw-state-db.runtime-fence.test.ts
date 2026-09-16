import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { OpenClawStateOwnershipError, STATE_SUPERVISION_KEY } from "./openclaw-state-ownership.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

describe("shared state runtime schema fence", () => {
  it("latches a newer schema committed under an open cached handle", () => {
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-runtime-schema-") } };
    const initial = openOpenClawStateDatabase(options);
    const external = new DatabaseSync(initial.path);
    try {
      external.exec(`
        BEGIN IMMEDIATE;
        PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};
        UPDATE schema_meta
           SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1},
               app_version = 'future-build'
         WHERE meta_key = 'primary';
        COMMIT;
      `);
    } finally {
      external.close();
    }

    let failure: unknown;
    try {
      openOpenClawStateDatabase(options);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "SqliteSchemaVersionError",
      message: expect.stringContaining(
        `uses newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
      ),
    });
    expect(initial.db.isOpen).toBe(false);
    expect(() => openOpenClawStateDatabase(options)).toThrow(failure);
  });

  it("retains the cached handle after a compatible external data commit", () => {
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-runtime-data-") } };
    const initial = openOpenClawStateDatabase(options);
    const external = new DatabaseSync(initial.path);
    try {
      external.exec(`
        UPDATE schema_meta
           SET updated_at = updated_at + 1
         WHERE meta_key = 'primary';
      `);
    } finally {
      external.close();
    }

    expect(openOpenClawStateDatabase(options)).toBe(initial);
    expect(initial.db.isOpen).toBe(true);
  });
});

describe("shared state runtime ownership admission", () => {
  it("keeps healthy cached admission defensive while observing a newly committed owner", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-state-ownership-") };
    const database = openOpenClawStateDatabase({ env });
    const claimant = new DatabaseSync(database.path);
    const exec = vi.spyOn(database.db, "exec");
    const defensive = vi.spyOn(database.db, "enableDefensive");
    try {
      expect(openOpenClawStateDatabase({ env })).toBe(database);
      expect(openOpenClawStateDatabase({ env })).toBe(database);

      claimant
        .prepare(
          "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        )
        .run(
          STATE_SUPERVISION_KEY,
          JSON.stringify({
            version: 1,
            mode: "external",
            managerId: "late-supervisor",
            claimedAt: 1,
          }),
          1,
        );

      expect(() => openOpenClawStateDatabase({ env })).toThrow(
        /externally supervised by late-supervisor/u,
      );
      const write = vi.fn();
      expect(() => runOpenClawStateWriteTransaction(write, { env })).toThrow(
        OpenClawStateOwnershipError,
      );
      expect(write).not.toHaveBeenCalled();
      expect(
        openOpenClawStateDatabase({
          env: { ...env, OPENCLAW_SUPERVISOR_MODE: "external" },
        }),
      ).toBe(database);
      expect(
        exec.mock.calls.filter(([sql]) => /\bPRAGMA\s+writable_schema\s*=/iu.test(sql)),
      ).toEqual([]);
      expect(defensive.mock.calls).toEqual([]);
    } finally {
      exec.mockRestore();
      defensive.mockRestore();
      claimant.close();
    }
  });
});
