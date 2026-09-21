import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, test } from "vitest";
import { digest, materialize } from "../../apps/linux/scripts/sea-runtime.cjs";

function payload(value: string) {
  const bytes = Buffer.from(value);
  const files = [
    { path: "bin/node", offset: 0, size: bytes.length, executable: true, digest: digest(bytes) },
  ];
  return [
    { digest: digest(JSON.stringify(files)), payloadDigest: digest(bytes), files },
    zlib.gzipSync(bytes),
  ] as const;
}

// The production materializer requires Linux uid/mode ownership and symlink semantics.
describe.skipIf(process.platform !== "linux")("Linux SEA extraction", () => {
  test("versioned extraction validates retained bytes and leaves earlier runtime available", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sea-"));
    try {
      const base = path.join(root, "runtime");
      const first = payload("first");
      const previous = materialize(base, ...first);
      assert.equal(materialize(base, ...first), previous);
      const next = materialize(base, ...payload("second"));
      assert.notEqual(next, previous);
      assert.equal(materialize(base, ...first), previous);
      fs.chmodSync(path.join(previous, "bin/node"), 0o600);
      fs.writeFileSync(path.join(previous, "bin/node"), "wrong");
      assert.throws(() => materialize(base, ...first), /changed/);
      assert.equal(materialize(base, ...payload("second")), next);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("redirected runtime directories and corrupted assets are rejected", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sea-"));
    try {
      const base = path.join(root, "runtime");
      fs.symlinkSync(root, base);
      assert.throws(() => materialize(base, ...payload("first")), /not owned/);
      fs.unlinkSync(base);
      const [manifest] = payload("first");
      assert.throws(
        () => materialize(base, manifest, zlib.gzipSync(Buffer.from("wrong"))),
        /Invalid bundled/,
      );
      assert.deepEqual(fs.readdirSync(base), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
