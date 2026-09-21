import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { resolveReleaseTagPackageIdentity } from "../../../scripts/lib/release-version.mjs";
import { digest } from "./sea-runtime.cjs";

// Input is a private canonical install-cli.sh Node prefix, not a source checkout
// or the Mac worker closure. Preserve the full CLI and its installed dependencies.
export function packRuntime(source, output) {
  source = fs.realpathSync(source);
  const files = [];
  const chunks = [];
  let offset = 0;
  function walk(relative, ancestors = new Set(), outputRelative = relative) {
    const location = path.join(source, relative);
    const real = fs.realpathSync(location);
    if (real !== source && !real.startsWith(source + path.sep)) {
      throw new Error("Runtime link escapes the installed package: " + relative);
    }
    const stat = fs.statSync(location);
    if (stat.isDirectory()) {
      if (ancestors.has(real)) throw new Error("Cyclic runtime directory: " + relative);
      const next = new Set([...ancestors, real]);
      for (const name of fs.readdirSync(location).sort())
        walk(path.join(relative, name), next, path.join(outputRelative, name));
    } else if (stat.isFile()) {
      const bytes = fs.readFileSync(location);
      const link = fs.lstatSync(location).isSymbolicLink() ? fs.readlinkSync(location) : undefined;
      if (link && path.isAbsolute(link))
        throw new Error("Runtime link is not relocatable: " + relative);
      files.push({
        path: outputRelative.split(path.sep).join("/"),
        ...(link ? { link } : {}),
        offset,
        size: bytes.length,
        executable: Boolean(stat.mode & 0o111),
        digest: digest(bytes),
      });
      chunks.push(bytes);
      offset += bytes.length;
    } else throw new Error("Unsupported runtime file: " + relative);
  }
  walk("bin/node");
  // A private distribution must not look like npm's global prefix. A host npm
  // launched by our Node otherwise claims this package as its update target.
  walk("lib/node_modules/openclaw", new Set(), "openclaw");
  const bytes = Buffer.concat(chunks);
  const manifest = { digest: digest(JSON.stringify(files)), payloadDigest: digest(bytes), files };
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest));
  const compressed = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(path.join(output, "payload.gz"), compressed);
  return {
    digest: manifest.digest,
    files: files.length,
    unpackedBytes: bytes.length,
    compressedBytes: compressed.length,
    nodeBytes: files[0].size,
  };
}

function runtimeIdentity(packageVersion, { releaseTag, sourceSha, sourceDirectory }) {
  if (!releaseTag && !sourceSha) return { version: packageVersion, packageVersion };
  if (!releaseTag || !/^[a-f0-9]{40}$/.test(sourceSha || "")) {
    throw new Error("Desktop release packaging requires an exact release tag and source SHA");
  }
  const root = JSON.parse(fs.readFileSync(path.join(sourceDirectory, "package.json"), "utf8"));
  if (root.version !== packageVersion) {
    throw new Error("Installed package version does not match the release source checkout");
  }
  const { baseTag } = resolveReleaseTagPackageIdentity(releaseTag, packageVersion);
  const commit = (ref) => execFileSync(
    "git", ["-C", sourceDirectory, "rev-parse", "--verify", ref],
    { encoding: "utf8", timeout: 10_000 },
  ).trim();
  if (commit("HEAD") !== sourceSha) {
    throw new Error("Desktop release source SHA does not match the packaging checkout");
  }
  if (commit(`refs/tags/${releaseTag}^{commit}`) !== sourceSha) {
    throw new Error("Desktop release tag does not match its selected source SHA");
  }
  // Shared release policy permits base-package bytes for a correction only at
  // the exact base tag's source commit, never by removing a numeric suffix.
  if (baseTag && commit(`refs/tags/${baseTag}^{commit}`) !== sourceSha) {
    throw new Error("Desktop base release tag does not match the correction source SHA");
  }
  return { version: releaseTag.slice(1), packageVersion, sourceSha };
}

/** @param {{releaseTag?: string, sourceSha?: string, sourceDirectory?: string}} [release] */
export function buildSea(source, destination, release = {}) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(source, "lib/node_modules/openclaw/package.json"), "utf8"),
  );
  const identity = runtimeIdentity(packageJson.version, {
    ...release,
    sourceDirectory: release.sourceDirectory || fileURLToPath(new URL("../../../", import.meta.url)),
  });
  const node = path.resolve(source, "bin/node");
  const version = spawnSync(node, ["--version"], { encoding: "utf8" });
  if (version.status !== 0 || version.stdout.trim() !== "v26.8.2") {
    throw new Error("Desktop SEA packaging requires the selected Node 26.8.2 runtime");
  }
  const output = fs.mkdtempSync(path.join(path.dirname(destination), ".sea-build-"));
  try {
    const metrics = packRuntime(source, output);
    const config = {
      main: fileURLToPath(new URL("./sea-runtime.cjs", import.meta.url)),
      output: destination,
      mainFormat: "commonjs",
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgvExtension: "none",
      assets: {
        manifest: path.join(output, "manifest.json"),
        payload: path.join(output, "payload.gz"),
      },
    };
    const configPath = path.join(output, "sea.json");
    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = spawnSync(node, ["--build-sea", configPath], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Node SEA build failed");
    fs.chmodSync(destination, 0o755);
    fs.writeFileSync(
      path.join(path.dirname(destination), "manifest.json"),
      JSON.stringify({
        ...identity,
        sha256: digest(fs.readFileSync(destination)),
      }),
    );
    return { ...metrics, executableBytes: fs.statSync(destination).size };
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 && process.argv.length !== 6)
    throw new Error("Usage: build-sea-runtime.mjs <installed-node-prefix> <output> [release-tag source-sha]");
  console.log(
    JSON.stringify(buildSea(path.resolve(process.argv[2]), path.resolve(process.argv[3]), {
      releaseTag: process.argv[4], sourceSha: process.argv[5],
    })),
  );
}
