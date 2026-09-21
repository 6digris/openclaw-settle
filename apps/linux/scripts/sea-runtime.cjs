// Node 26.8.2 SEA entry. Only built-ins are available before materialization.
// The ordinary Node executable owns ESM/TLA, native addons, forks and workers.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const sea = require("node:sea");

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function directory(location) {
  try {
    fs.mkdirSync(location, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(location);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error("Runtime directory is not owned by this account: " + location);
  }
}

function materialize(base, manifest, archive) {
  directory(base);
  if (
    !/^[a-f0-9]{64}$/.test(manifest.digest) ||
    digest(JSON.stringify(manifest.files)) !== manifest.digest
  ) {
    throw new Error("Invalid runtime manifest");
  }
  const root = path.join(base, manifest.digest);
  function verify() {
    try {
      fs.lstatSync(root);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    directory(root);
    const checkedDirectories = new Set([root]);
    for (const entry of manifest.files) {
      let parent = root;
      for (const component of entry.path.split("/").slice(0, -1)) {
        parent = path.join(parent, component);
        if (!checkedDirectories.has(parent)) {
          directory(parent);
          checkedDirectories.add(parent);
        }
      }
      const file = path.join(root, entry.path);
      const stat = fs.lstatSync(file);
      const validLink =
        entry.link &&
        stat.isSymbolicLink() &&
        fs.readlinkSync(file) === entry.link &&
        fs.realpathSync(file).startsWith(root + path.sep);
      if (
        (entry.link ? !validLink : !stat.isFile() || stat.isSymbolicLink()) ||
        fs.statSync(file).size !== entry.size ||
        digest(fs.readFileSync(file)) !== entry.digest
      ) {
        throw new Error("Bundled runtime changed: " + entry.path);
      }
    }
    return true;
  }
  if (verify()) return root;
  const stage = fs.mkdtempSync(path.join(base, ".stage-"));
  try {
    const bytes = zlib.gunzipSync(archive);
    if (digest(bytes) !== manifest.payloadDigest)
      throw new Error("Invalid bundled runtime payload");
    for (const entry of manifest.files) {
      if (
        path.isAbsolute(entry.path) ||
        entry.path.split("/").some((p) => !p || p === ".." || p === ".")
      ) {
        throw new Error("Invalid runtime resource path");
      }
      const target = path.join(stage, entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const content = bytes.subarray(entry.offset, entry.offset + entry.size);
      if (digest(content) !== entry.digest)
        throw new Error("Invalid runtime resource: " + entry.path);
      if (!entry.link)
        fs.writeFileSync(target, content, { flag: "wx", mode: entry.executable ? 0o500 : 0o400 });
    }
    for (const entry of manifest.files) {
      if (entry.link) {
        const target = path.resolve(stage, path.dirname(entry.path), entry.link);
        if (path.isAbsolute(entry.link) || !target.startsWith(stage + path.sep))
          throw new Error("Runtime link escapes its payload");
        fs.symlinkSync(entry.link, path.join(stage, entry.path));
      }
    }
    try {
      fs.renameSync(stage, root);
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      verify();
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return root;
}

function main() {
  if (process.platform !== "linux") throw new Error("This bundled runtime targets Linux");
  const base = process.env.OPENCLAW_DESKTOP_RUNTIME_DIR || path.dirname(process.execPath);
  if (!base || !path.isAbsolute(base)) throw new Error("Desktop runtime directory is required");
  const manifest = JSON.parse(sea.getAsset("manifest", "utf8"));
  const root = materialize(base, manifest, Buffer.from(sea.getRawAsset("payload")));
  const node = path.join(root, "bin/node");
  const entry = path.join(root, "openclaw/openclaw.mjs");
  const env = {
    ...process.env,
    PATH: path.join(root, "bin") + path.delimiter + (process.env.PATH || ""),
    OPENCLAW_WRAPPER: path.join(base, "openclaw-runtime"),
  };
  // execve preserves PID/process group and stdio: native cancellation and service
  // supervision remain with their existing owners, without another forwarding shim.
  process.execve(node, [node, entry, ...process.argv.slice(2)], env);
}

if (sea.isSea()) {
  try {
    main();
  } catch (error) {
    console.error("OpenClaw bundled runtime: " + error.message);
    process.exitCode = 1;
  }
}
module.exports = { digest, materialize };
