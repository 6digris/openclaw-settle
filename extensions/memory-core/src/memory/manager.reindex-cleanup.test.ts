import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as databaseFiles from "./manager-db.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory reindex cleanup", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps closed-shadow cleanup pending while foreground callbacks run", async () => {
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["memory"], vectorEnabled: false }),
    );
    const open = databaseFiles.openMemoryDatabaseAtPath;
    let shadow: DatabaseSync | undefined;
    let shadowPath: string | undefined;
    vi.spyOn(databaseFiles, "openMemoryDatabaseAtPath").mockImplementation((filename, ...args) => {
      shadowPath = filename;
      shadow = open(filename, ...args);
      return shadow;
    });
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const remove = fs.rm;
    let removalStarted = false;
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (args[0] === shadowPath) {
        removalStarted = true;
        entered.resolve();
        await resume.promise;
      }
      return remove(...args);
    });
    let syncSettled = false;
    const sync = manager.sync({ reason: "cli", force: true }).finally(() => {
      syncSettled = true;
    });
    void sync.catch(() => undefined);
    let close: Promise<void> | undefined;
    let closed = false;
    try {
      await Promise.race([entered.promise, sync]);
      expect(removalStarted).toBe(true);
      expect(shadow?.isOpen).toBe(false);
      expect(syncSettled).toBe(false);
      await nextTurn();
      expect(manager.status().chunks).toBeGreaterThan(0);
      expect(syncSettled).toBe(false);
      close = manager.close().then(() => {
        closed = true;
      });
      await nextTurn();
      expect(closed).toBe(false);
      resume.resolve();
      await Promise.all([sync, close]);
      expect(shadowPath).toBeDefined();
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        await expect(fs.access(`${shadowPath}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      resume.resolve();
      await Promise.allSettled([sync, close]);
    }
  });
});
