import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pinDirectory } from "./directory-durability.js";
import { sameFileMutationFingerprint } from "./file-descriptor.js";
import { root as safeRoot } from "./fs-safe.js";
import { digest, fileDigest } from "./update-recovery-backup-files.js";

/** Bind retained crash/refusal evidence without claiming it is a sealed or restorable generation. */
export async function fingerprintIncompleteRecoveryGeneration(
  directory: string,
  assertOwned: () => void,
): Promise<string> {
  const observed = new Map<string, BigIntStats>();
  const inventory: unknown[] = [];
  const walk = async (current: string): Promise<void> => {
    const pin = await pinDirectory(current);
    try {
      if (pin.receipt.realPath !== current) {
        throw new Error("Incomplete recovery generation changed location.");
      }
      const before = await fs.lstat(current, { bigint: true });
      observed.set(current, before);
      const source = await safeRoot(current);
      const entries = (await source.list("", { withFileTypes: true })).toSorted((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        assertOwned();
        const pathname = path.join(current, entry.name);
        if (entry.isDirectory) {
          await walk(pathname);
        } else if (entry.isFile) {
          const identity = await fs.lstat(pathname, { bigint: true });
          observed.set(pathname, identity);
          inventory.push([path.relative(directory, pathname), await fileDigest(pathname)]);
        } else {
          throw new Error("Incomplete recovery generation contains an unsupported file kind.");
        }
      }
      await pin.assertCurrent();
      assertOwned();
    } finally {
      await pin.close();
    }
  };
  await walk(directory);
  for (const [pathname, before] of observed) {
    const after = await fs.lstat(pathname, { bigint: true });
    if (!sameFileMutationFingerprint(before, after) || before.mode !== after.mode) {
      throw new Error("Incomplete recovery generation changed while binding its evidence.");
    }
    inventory.push([
      path.relative(directory, pathname),
      [
        before.dev,
        before.ino,
        before.mode,
        before.size,
        before.birthtimeNs,
        before.mtimeNs,
        before.ctimeNs,
      ].map(String),
    ]);
  }
  assertOwned();
  return digest(JSON.stringify(inventory));
}
