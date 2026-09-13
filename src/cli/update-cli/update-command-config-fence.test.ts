import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withConfigWriteLock } from "../../config/write-lock.js";
import {
  captureFiles,
  useConfigWriterFixture,
} from "./update-command-config-fence.test-support.js";

const withConfigWriter = useConfigWriterFixture();

it.each(
  (["explicit", "ambient"] as const).flatMap((authority) =>
    [
      { revoked: false, included: false, late: false },
      { revoked: true, included: false, late: false },
      { revoked: false, included: true, late: false },
      { revoked: true, included: true, late: true },
      { revoked: true, included: true, late: false },
    ].map(({ revoked, included, late }) => ({ authority, revoked, included, late })),
  ),
)(
  "guards config publication with its $authority source executor (revoked=$revoked, included=$included, late=$late)",
  async ({ authority, revoked, included, late }) => {
    await withConfigWriter(included, async (fixture) => {
      const beforeFiles = captureFiles(fixture.publicPaths);
      const beforeEntries = await fs.readdir(path.dirname(fixture.targetPath));
      let fsyncArmed = false;
      let fsyncBoundaryFired = false;
      if (late) {
        // The writer copies filesystem methods before preparing its backup.
        // Install now, then arm only for the candidate publication fsync.
        const fsync = syncFs.fsyncSync;
        vi.spyOn(syncFs, "fsyncSync").mockImplementation((fd) => {
          fsync(fd);
          if (fsyncArmed) {
            fsyncArmed = false;
            fsyncBoundaryFired = true;
            fixture.revoke();
          }
        });
      }
      const beforeCommit = vi.fn(async () => {
        if (revoked && !late) {
          fixture.revoke();
        }
        if (late) {
          fsyncArmed = true;
        }
      });
      const write = () =>
        fixture.write({
          beforeCommit,
          skipRuntimeSnapshotRefresh: true,
          ...(authority === "explicit" ? { assertCurrent: fixture.assertCurrent } : {}),
        });
      const mutation =
        authority === "ambient"
          ? withConfigWriteLock(fixture.configPath, write, fixture.env, fixture.assertCurrent)
          : write();
      if (revoked) {
        await expect(mutation).rejects.toThrow(/executor|ownership/i);
        expect(captureFiles(fixture.publicPaths)).toEqual(beforeFiles);
        expect(await fs.readdir(path.dirname(fixture.targetPath))).toEqual(beforeEntries);
      } else {
        await mutation;
        const persisted = JSON.parse(await fs.readFile(fixture.targetPath, "utf8"));
        expect(included ? persisted.port : persisted.gateway.port).toBe(18791);
        expect(await fs.readFile(`${fixture.targetPath}.bak`, "utf8")).toBe(
          included ? fixture.includedRaw : fixture.original,
        );
        fixture.assertCurrent();
      }
      expect(beforeCommit).toHaveBeenCalledTimes(1);
      expect(fsyncBoundaryFired).toBe(late);
      if (included) {
        expect(await fs.readFile(fixture.configPath, "utf8")).toBe(fixture.original);
        if (process.platform !== "win32") {
          expect((await fs.stat(path.dirname(fixture.includePath))).mode & 0o7777).toBe(0o3700);
        }
      }
    });
  },
);

it.each(
  (["EPERM", "EEXIST"] as const).flatMap((code) =>
    (["open", "write"] as const).flatMap((boundary) =>
      [false, true].flatMap((included) =>
        [false, true].map((revoked) => ({ code, boundary, included, revoked })),
      ),
    ),
  ),
)(
  "checks each $code copy effect after $boundary (included=$included, revoked=$revoked)",
  async ({ code, boundary, included, revoked }) => {
    await withConfigWriter(included, async (fixture) => {
      let destinationFd: number | undefined;
      let reachedBoundary = false;
      let atRevocation: ReturnType<typeof captureFiles> | undefined;
      const laterEffects: string[] = [];
      const atBoundary = () => {
        reachedBoundary = true;
        if (revoked) {
          fixture.revoke();
          atRevocation = captureFiles(fixture.publicPaths);
        }
      };
      const rename = syncFs.renameSync;
      vi.spyOn(syncFs, "renameSync").mockImplementation((source, target) => {
        if (target === fixture.targetPath) {
          throw Object.assign(new Error("forced copy fallback"), { code });
        }
        rename(source, target);
      });
      const open = syncFs.openSync;
      vi.spyOn(syncFs, "openSync").mockImplementation((filePath, flags, mode) => {
        const fd = open(filePath, flags, mode);
        if (
          filePath === fixture.targetPath &&
          typeof flags === "number" &&
          (flags & syncFs.constants.O_CREAT) !== 0
        ) {
          destinationFd = fd;
          if (boundary === "open") {
            atBoundary();
          }
        }
        return fd;
      });
      const truncate = syncFs.ftruncateSync;
      vi.spyOn(syncFs, "ftruncateSync").mockImplementation((fd, length) => {
        if (fd === destinationFd && atRevocation) {
          laterEffects.push("truncate");
        }
        truncate(fd, length);
      });
      const write = syncFs.writeSync;
      vi.spyOn(syncFs, "writeSync").mockImplementation(
        new Proxy(write, {
          apply(target, thisArg, args) {
            const isDestination = args[0] === destinationFd;
            if (isDestination && atRevocation) {
              laterEffects.push("write");
            }
            const firstWrite = isDestination && boundary === "write" && !reachedBoundary;
            const result = Reflect.apply(
              target,
              thisArg,
              firstWrite ? [args[0], args[1], args[2], Math.min(args[3], 7), args[4]] : args,
            );
            if (firstWrite) {
              atBoundary();
            }
            return result;
          },
        }),
      );
      const mutation = fixture.write({
        assertCurrent: fixture.assertCurrent,
        skipRuntimeSnapshotRefresh: true,
      });
      if (revoked) {
        await expect(mutation).rejects.toMatchObject({
          name: "ConfigWritePostCommitError",
          rollbackStatus: "unknown",
          publication: "partial",
        });
        const afterFiles = captureFiles(fixture.publicPaths);
        expect(atRevocation).toBeDefined();
        for (const [index, target] of fixture.publicPaths.entries()) {
          const before = atRevocation![index];
          if (
            process.platform === "win32" &&
            boundary === "write" &&
            target === fixture.targetPath &&
            before
          ) {
            // Windows can settle timestamps when the writing descriptor closes.
            // Content and identity remain fenced; untouched files stay exact.
            expect(afterFiles[index]).toMatchObject({
              bytes: before.bytes,
              dev: before.dev,
              ino: before.ino,
              mode: before.mode,
            });
          } else {
            expect(afterFiles[index]).toEqual(before);
          }
        }
        expect(laterEffects).toEqual([]);
      } else {
        await mutation;
        const persisted = JSON.parse(await fs.readFile(fixture.targetPath, "utf8"));
        expect(included ? persisted.port : persisted.gateway.port).toBe(18791);
      }
      expect(reachedBoundary).toBe(true);
      if (included) {
        expect(await fs.readFile(fixture.configPath, "utf8")).toBe(fixture.original);
      }
    });
  },
);

it("preserves ordinary unguarded include publication", async () => {
  await withConfigWriter(true, async (fixture) => {
    await fixture.write({ skipRuntimeSnapshotRefresh: true });
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(fixture.original);
    expect(JSON.parse(await fs.readFile(fixture.includePath, "utf8"))).toEqual({
      mode: "local",
      port: 18791,
    });
    expect(await fs.readFile(`${fixture.includePath}.bak`, "utf8")).toBe(fixture.includedRaw);
  });
});
