import { channel } from "node:diagnostics_channel";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawAgentReadOnlyDatabase } from "./openclaw-agent-db-readonly-open.js";
import { retainOpenClawAgentDatabaseReads } from "./openclaw-agent-db-readonly-retention.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "./openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
// Node added the public SQLite query diagnostic event in 26.8.0.
const supportsQueryDiagnostics = nodeMajor > 26 || (nodeMajor === 26 && nodeMinor >= 8);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each(["release", "read"])(
  "keeps failed native disposal owned without reviving read authority (%s)",
  async (failureAt) => {
    const options = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("retained-read-close-retry-") },
    };
    const pathname = resolveOpenClawAgentSqlitePath(options);
    openOpenClawAgentDatabase(options);
    closeOpenClawAgentDatabaseByPath(pathname);
    const reads = retainOpenClawAgentDatabaseReads({ onRevoked: vi.fn() });
    const result = reads.read(({ db }) => db, options);
    if (!result.found) {
      throw new Error(`Expected fixture database: ${result.reason}`);
    }
    const database = result.value;
    const close = vi.spyOn(database, "close").mockImplementationOnce(() => {
      throw new Error("synthetic native close failure");
    });
    try {
      if (failureAt === "read") {
        const primaryError = new Error("synthetic primary read failure");
        expect(() =>
          reads.read(() => {
            throw primaryError;
          }, options),
        ).toThrow(primaryError);
      } else {
        expect(() => reads.release()).toThrow("synthetic native close failure");
      }
      expect(database.isOpen).toBe(true);
      expect(() => reads.read(() => 1, options)).toThrow(/read retention is no longer current/);
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);

      await closeOpenClawAgentDatabaseByPathAsync(pathname);
      expect(database.isOpen).toBe(false);
      expect(close).toHaveBeenCalledTimes(2);
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
      expect(() => reads.read(() => 1, options)).toThrow(/read retention is no longer current/);
      reads.release();
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      close.mockRestore();
      await closeOpenClawAgentDatabaseByPathAsync(pathname);
      if (database.isOpen) {
        database.close();
      }
    }
  },
);

it.skipIf(!supportsQueryDiagnostics).each(["revocation", "validation"] as const)(
  "keeps failed native disposal owned after opening %s",
  async (failure) => {
    const options = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("retained-read-opening-close-") },
    };
    const pathname = resolveOpenClawAgentSqlitePath(options);
    const writer = openOpenClawAgentDatabase(options);
    if (failure === "validation") {
      writer.db.prepare("UPDATE schema_meta SET agent_id = ?").run("another-agent");
    }
    closeOpenClawAgentDatabaseByPath(pathname);
    const onRevoked = vi.fn();
    const reads = retainOpenClawAgentDatabaseReads({ onRevoked });
    const operation = vi.fn(() => 1);
    const closeFailure = new Error("synthetic native close failure during admission");
    const queryChannel = channel("sqlite.db.query");
    let database: DatabaseSync | undefined;
    let closing: Promise<void> | undefined;
    let closingError: unknown;
    let restoreClose: (() => void) | undefined;
    const closePath = () =>
      closeOpenClawAgentDatabaseByPathAsync(pathname, options.agentId).then(
        () => undefined,
        (error: unknown) => {
          closingError = error;
        },
      );
    const onQuery = (message: unknown) => {
      const event = message as { database?: DatabaseSync; sql?: string };
      if (
        database ||
        event.sql !== "PRAGMA user_version" ||
        event.database?.location() !== pathname
      ) {
        return;
      }
      database = event.database;
      const close = vi.spyOn(database, "close").mockImplementation(() => {
        throw closeFailure;
      });
      restoreClose = () => close.mockRestore();
      if (failure === "revocation") {
        closing = closePath();
      }
    };
    queryChannel.subscribe(onQuery);
    try {
      let readError: unknown;
      try {
        reads.read(operation, options);
      } catch (error) {
        readError = error;
      }
      if (failure === "validation") {
        closing = closePath();
      }
      expect(database?.isOpen).toBe(true);
      expect(closing).toBeDefined();
      await closing;
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
      expect(operation).not.toHaveBeenCalled();
      expect(readError).toMatchObject({
        message: expect.stringMatching(
          failure === "revocation"
            ? /no longer current/u
            : /belongs to agent another-agent; requested agent main/u,
        ),
      });
      expect(readError).not.toBe(closeFailure);
      expect(closingError).toMatchObject({ errors: [closeFailure] });
      expect(onRevoked).toHaveBeenCalledOnce();

      restoreClose?.();
      await closeOpenClawAgentDatabaseByPathAsync(pathname, options.agentId);
      expect(database?.isOpen).toBe(false);
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
      expect(() => reads.read(operation, options)).toThrow(/no longer current/u);
    } finally {
      queryChannel.unsubscribe(onQuery);
      restoreClose?.();
      reads.release();
      await closing;
      await closeOpenClawAgentDatabaseByPathAsync(pathname, options.agentId);
      if (database?.isOpen) {
        database.close();
      }
    }
  },
);

it.skipIf(!supportsQueryDiagnostics).each([
  { temperature: "cold", target: "same path" },
  { temperature: "warm", target: "missing path" },
] as const)(
  "keeps the outer native reader owned during $temperature reentry at the $target",
  async ({ temperature, target }) => {
    const options = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("retained-read-reentry-") },
    };
    const outerPath = resolveOpenClawAgentSqlitePath(options);
    openOpenClawAgentDatabase(options);
    closeOpenClawAgentDatabaseByPath(outerPath);
    const innerOptions =
      target === "same path"
        ? options
        : {
            agentId: options.agentId,
            env: { OPENCLAW_STATE_DIR: tempDirs.make("retained-read-reentry-missing-") },
          };
    const innerPath = resolveOpenClawAgentSqlitePath(innerOptions);
    const maintenance = createOpenClawDatabaseMaintenanceScope(() => undefined);
    const onRevoked = vi.fn<(reason: unknown) => void>();
    const reads = retainOpenClawAgentDatabaseReads({ onRevoked });
    const readValue = ({ db }: OpenClawAgentReadOnlyDatabase) =>
      db.prepare("SELECT 1 AS value").get()?.value;
    const connections = new Set<DatabaseSync>();
    const queryChannel = channel("sqlite.db.query");
    const reentrySql = temperature === "cold" ? "PRAGMA user_version" : "PRAGMA data_version";
    let reentered = false;
    let callbackError: unknown;
    let innerResult: ReturnType<typeof reads.read> | undefined;
    let outerOpenAfterNestedRead: boolean | undefined;
    const onQuery = (message: unknown) => {
      const event = message as { database?: DatabaseSync; sql?: string };
      const database = event.database;
      if (!database) {
        return;
      }
      const pathname = database.location();
      if (pathname !== outerPath && pathname !== innerPath) {
        return;
      }
      connections.add(database);
      if (reentered || pathname !== outerPath || event.sql !== reentrySql) {
        return;
      }
      reentered = true;
      // Subscriber exceptions become process errors; assert the nested outcome after delivery.
      try {
        innerResult = reads.read(readValue, innerOptions);
      } catch (error) {
        callbackError = error;
      }
      outerOpenAfterNestedRead = database.isOpen;
    };
    try {
      if (temperature === "warm") {
        expect(maintenance.run(() => reads.read(readValue, options))).toEqual({
          found: true,
          value: 1,
        });
      }
      queryChannel.subscribe(onQuery);
      let outerResult: ReturnType<typeof reads.read> | undefined;
      let outerError: unknown;
      try {
        outerResult = maintenance.run(() => reads.read(readValue, options));
      } catch (error) {
        outerError = error;
      }
      expect(reentered).toBe(true);
      expect(callbackError).toBeUndefined();
      expect(outerError).toBeUndefined();
      expect(innerResult).toEqual(
        target === "same path"
          ? { found: true, value: 1 }
          : { found: false, reason: "database-missing" },
      );
      expect(outerResult).toEqual({ found: true, value: 1 });
      expect(outerOpenAfterNestedRead).toBe(true);
      expect(onRevoked).not.toHaveBeenCalled();

      reads.release();
      await maintenance.close();
      expect(connections.size).toBeGreaterThan(0);
      expect([...connections].every((connection) => !connection.isOpen)).toBe(true);
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    } finally {
      queryChannel.unsubscribe(onQuery);
      try {
        reads.release();
        await maintenance.close();
      } finally {
        // Keep the original failing cases from leaking their test-owned native handles.
        for (const connection of connections) {
          if (connection.isOpen) {
            connection.close();
          }
        }
      }
    }
  },
);
