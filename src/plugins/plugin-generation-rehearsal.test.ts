import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveUpdateCandidatePluginSourceEntries } from "../infra/update-candidate-plugin-sources.js";
import {
  buildUpdateRehearsalPathEnv,
  resolveUpdateRehearsalRoot,
} from "../infra/update-rehearsal-paths.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { runCommandBuffered } from "../process/exec.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import {
  capturePluginGenerationRehearsalContext,
  readPluginGenerationRehearsalArtifact,
  withPluginGenerationRehearsalContext,
  withPluginGenerationRehearsalPreparation,
} from "./plugin-generation-rehearsal.js";
import { inspectPluginSourceDependencies } from "./plugin-generation-source-inspection.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const instances: PluginInstance[] = [];
const artifacts: ReturnType<typeof capturePluginGenerationArtifact>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const instance of instances.splice(0).toReversed()) {
    await instance.dispose();
  }
  for (const artifact of artifacts.splice(0)) {
    artifact.dispose();
  }
});

it("falls back to an isolated acquisition and cleans a failed borrower view", async () => {
  const f = fixture();
  await withEnvAsync(f.env, async () => {
    await f.publish();
    let abandoned: string | undefined;
    vi.spyOn(fs, "cpSync").mockImplementationOnce((_source, destination) => {
      if (typeof destination === "string") {
        abandoned = destination;
      }
      throw new Error("synthetic capture copy failure");
    });
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const artifact = capturePluginGenerationArtifact(f.plugin);
    artifacts.push(artifact);
    expect(artifact.sourceAcquisition).toBe("isolated-plugin-generation");
    expect(fs.readFileSync(artifact.resolve(path.join(f.plugin, "value.cjs")), "utf8")).toContain(
      "before",
    );
    expect(abandoned).toBeDefined();
    expect(fs.existsSync(abandoned!)).toBe(false);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("synthetic capture copy failure"));
  });
});

function fixture(standalone = false) {
  const root = fs.realpathSync(temp.make("plugin-rehearsal-generation-"));
  const plugin = path.join(root, "project", "node_modules", "fixture");
  const host = path.join(root, "host");
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(
    path.join(host, "package.json"),
    JSON.stringify({
      name: "openclaw",
      bin: { openclaw: "openclaw.mjs" },
      exports: { "./plugin-sdk/core": "./dist/plugin-sdk/core.cjs" },
    }),
  );
  write(path.join(host, "openclaw.mjs"), "export {};");
  write(path.join(host, "dist/plugin-sdk/core.cjs"), "exports.value = 'candidate SDK';");
  write(
    path.join(plugin, "package.json"),
    JSON.stringify({
      name: "fixture",
      main: "index.cjs",
      optionalDependencies: { optional: "1.0.0" },
      ...(standalone ? {} : { dependencies: { "native-wrapper": "1.0.0" } }),
    }),
  );
  const entry = path.join(plugin, "index.cjs");
  write(
    entry,
    standalone
      ? "exports.read = name => require(name).value;"
      : `
    const { Worker } = require('node:worker_threads');
    const path = require('node:path');
    let count = 0;
    exports.filename = __filename;
    exports.value = require('./value.cjs').value;
    exports.next = () => ++count;
    exports.native = () => require('native-wrapper').read();
    exports.nativeAsset = () => require('native-wrapper').asset;
    exports.optional = () => { try { return require('optional').value; } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return 'absent'; } };
    exports.worker = async () => {
      const worker = new Worker(path.join(__dirname, 'worker.cjs'));
      try { return await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }); }
      finally { await worker.terminate(); }
    };
  `,
  );
  write(path.join(plugin, "value.cjs"), "exports.value = 'before';");
  write(path.join(plugin, "setup.cjs"), "exports.value = require('./value.cjs').value;");
  write(path.join(plugin, "doctor.cjs"), "exports.value = require('./value.cjs').value;");
  write(
    path.join(plugin, "worker.cjs"),
    "require('node:worker_threads').parentPort.postMessage(require('openclaw/plugin-sdk/core').value);",
  );
  write(path.join(plugin, "unrelated.txt"), "unrelated workspace bytes");
  const native = path.join(root, "project", "node_modules", "native-wrapper");
  const asset = path.join(root, "project", "node_modules", "@native", "platform", "asset.bin");
  write(
    path.join(native, "package.json"),
    JSON.stringify({
      name: "native-wrapper",
      main: "index.cjs",
      optionalDependencies: { "@native/platform": "1.0.0" },
    }),
  );
  write(
    path.join(native, "index.cjs"),
    "exports.asset = require('node:path').join(__dirname, '../@native/platform/asset.bin'); exports.read = () => require('node:fs').readFileSync(exports.asset, 'utf8');",
  );
  write(
    path.join(path.dirname(asset), "package.json"),
    '{"name":"@native/platform","main":"index.cjs"}',
  );
  write(path.join(path.dirname(asset), "index.cjs"), "exports.native = true;");
  write(asset, "native-before");
  const env: NodeJS.ProcessEnv = {
    ...buildUpdateRehearsalPathEnv(root),
    ...buildUpdateDoctorEnv({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
      serviceRepairPolicy: "external",
    }),
    OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
  };
  const entries = (
    standalone ? [entry] : [entry, path.join(plugin, "setup.cjs"), path.join(plugin, "doctor.cjs")]
  ).map((entryFile) => ({ rootDir: plugin, entryFile, standalone }));
  const publish = async () => {
    const warnings: string[] = [];
    await withPluginGenerationRehearsalPreparation(
      { env, hostRoot: host, entries, onWarning: (warning) => warnings.push(warning) },
      async () => {
        inspectPluginSourceDependencies(entries);
      },
    );
    expect(warnings).toEqual([]);
  };
  return { root, plugin, host, entry, asset, env, entries, write, publish, standalone };
}

function load(f: ReturnType<typeof fixture>) {
  const instance = new PluginInstance("generation-fixture");
  instances.push(instance);
  withPluginCache(createPluginCache(), () =>
    bindPluginInstanceModuleLoader({
      instance,
      origin: "config",
      rootDir: f.plugin,
      source: f.entry,
      standalone: f.standalone,
      devSourceRoot: f.host,
    }),
  );
  return { instance, value: instance.loadModule(f.entry) };
}

it.each(["relative", "absolute"])(
  "shares prepared sources with %s junctions while isolating native assets, SDK workers, and recovery",
  async (targets) => {
    if (targets === "absolute") {
      // Windows stores junction targets as absolute paths, including when given a relative target.
      const symlink = fs.symlinkSync;
      vi.spyOn(fs, "symlinkSync").mockImplementation((target, link, type) =>
        symlink(
          type === "junction" && typeof target === "string" && typeof link === "string"
            ? path.resolve(path.dirname(link), target)
            : target,
          link,
          type,
        ),
      );
    }
    const f = fixture();
    await withEnvAsync(f.env, async () => {
      await f.publish();
      const published = readPluginGenerationRehearsalArtifact(f.plugin);
      expect(published?.graphs).toHaveLength(3);
      const original = fs.readFileSync(path.join(f.plugin, "value.cjs"), "utf8");
      f.write(path.join(f.plugin, "value.cjs"), "exports.value = 'changed source';");
      f.write(f.asset, "native-after");
      f.write(
        path.join(f.plugin, "node_modules", "optional", "package.json"),
        '{"main":"index.cjs"}',
      );
      f.write(
        path.join(f.plugin, "node_modules", "optional", "index.cjs"),
        "exports.value = 'new optional';",
      );
      type Api = {
        filename: string;
        value: string;
        next(): number;
        native(): string;
        nativeAsset(): string;
        optional(): string;
        worker(): Promise<string>;
      };
      const first = load(f);
      const firstApi = first.value as Api;
      expect(firstApi.value).toBe("before");
      expect(firstApi.native()).toBe("native-before");
      expect(firstApi.optional()).toBe("absent");
      expect(firstApi.next()).toBe(1);
      await expect(firstApi.worker()).resolves.toBe("candidate SDK");
      const second = load(f);
      const secondApi = second.value as Api;
      expect(secondApi.filename).not.toBe(firstApi.filename);
      expect(secondApi.next()).toBe(1);
      expect(fs.statSync(firstApi.filename).nlink).toBe(1);
      f.write(
        path.join(path.dirname(firstApi.filename), "value.cjs"),
        "exports.value = 'changed view';",
      );
      expect(
        fs.readFileSync(path.join(path.dirname(secondApi.filename), "value.cjs"), "utf8"),
      ).toBe(original);
      f.write(firstApi.nativeAsset(), "changed view native asset");
      expect(firstApi.native()).toBe("changed view native asset");
      expect(secondApi.native()).toBe("native-before");
      const capturedAsset = published!.state.originalSources.find(
        ([, source]) => source === f.asset,
      );
      expect(capturedAsset).toBeDefined();
      expect(fs.readFileSync(path.join(published!.payload, capturedAsset![0]), "utf8")).toBe(
        "native-before",
      );
      const recovery = second.instance.captureModuleLoaderRecovery();
      await second.instance.dispose();
      fs.rmSync(f.plugin, { recursive: true });
      const restored = new PluginInstance("generation-fixture");
      instances.push(restored);
      recovery.bind(restored);
      recovery.dispose();
      const restoredApi = restored.loadModule(f.entry) as Api;
      expect(restoredApi.value).toBe("before");
      expect(restoredApi.native()).toBe("native-before");
      await expect(restoredApi.worker()).resolves.toBe("candidate SDK");
      expect(fs.existsSync(published!.payload)).toBe(true);
    });
  },
);

it("keeps verified artifact context through nested lint state and worker-owned view placement", async () => {
  const f = fixture();
  await withEnvAsync(f.env, async () => {
    await f.publish();
    const context = capturePluginGenerationRehearsalContext();
    const workerRoot = path.join(f.root, "worker-captures");
    fs.mkdirSync(workerRoot);
    const inspectionState = path.join(f.root, "inspection-state");
    await withEnvAsync({ OPENCLAW_STATE_DIR: inspectionState }, async () => {
      expect(resolveUpdateRehearsalRoot(process.env)).toBeUndefined();
      expect(readPluginGenerationRehearsalArtifact(f.plugin)).toBeUndefined();
      await withPluginGenerationRehearsalContext(context, async () => {
        const before = fs.readdirSync(workerRoot);
        expect(inspectPluginSourceDependencies(f.entries).unresolved).toEqual([]);
        expect(fs.readdirSync(workerRoot)).toEqual(before);
        const artifact = withPluginSourceCaptureDirectory(workerRoot, () =>
          capturePluginGenerationArtifact(f.plugin),
        );
        artifacts.push(artifact);
        expect(path.dirname(artifact.boundaryRoot)).toBe(workerRoot);
        expect(
          fs.readFileSync(artifact.resolve(path.join(f.plugin, "value.cjs")), "utf8"),
        ).toContain("before");
      });
    });
  });
});

it("retains selective standalone inputs and isolates late acquisition and its failure receipts", async () => {
  const f = fixture(true);
  f.write(path.join(f.plugin, "late.cjs"), "exports.value = 'initial';");
  const dependency = path.join(f.plugin, "node_modules", "failed-dependency");
  f.write(
    path.join(dependency, "package.json"),
    JSON.stringify({ main: "index.cjs", dependencies: { "missing-required-dependency": "1.0.0" } }),
  );
  f.write(path.join(dependency, "index.cjs"), "exports.value = 42;");
  await withEnvAsync(f.env, async () => {
    await f.publish();
    const published = readPluginGenerationRehearsalArtifact(f.plugin, f.entry);
    expect(
      published?.state.originalSources.some(([, source]) => source.endsWith("unrelated.txt")),
    ).toBe(false);
    f.write(path.join(f.plugin, "late.cjs"), "exports.value = 'first demand';");
    type Api = { read(name: string): string | number };
    const first = load(f).value as Api;
    expect(first.read("./late.cjs")).toBe("first demand");
    expect(() => first.read("failed-dependency")).toThrow("missing-required-dependency");
    expect(() => first.read("failed-dependency/index.cjs")).toThrow("missing-required-dependency");
    f.write(
      path.join(dependency, "node_modules", "missing-required-dependency", "package.json"),
      '{"main":"index.cjs"}',
    );
    f.write(
      path.join(dependency, "node_modules", "missing-required-dependency", "index.cjs"),
      "exports.ready = true;",
    );
    f.write(path.join(f.plugin, "late.cjs"), "exports.value = 'second demand';");
    const second = load(f).value as Api;
    expect(second.read("./late.cjs")).toBe("second demand");
    expect(second.read("failed-dependency")).toBe(42);
    expect(() => first.read("failed-dependency/index.cjs")).toThrow("missing-required-dependency");
    expect(first.read("./late.cjs")).toBe("first demand");
    expect(published?.state.originalSources.some(([, source]) => source.endsWith("late.cjs"))).toBe(
      false,
    );
  });
});

it("keeps standalone setup and Doctor surface preparation out of the surrounding workspace", async () => {
  const f = fixture(true);
  f.write(
    path.join(f.plugin, "doctor-contract-api.cjs"),
    "exports.value = require('./value.cjs').value;",
  );
  f.write(
    path.join(f.plugin, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object", properties: {} },
      doctorContract: { configRepair: true },
    }),
  );
  const entries = resolveUpdateCandidatePluginSourceEntries(
    [
      {
        idHint: "fixture",
        source: f.entry,
        rootDir: f.plugin,
        setupSource: path.join(f.plugin, "setup.cjs"),
        origin: "config",
      },
    ],
    { plugins: { entries: { fixture: { enabled: true } } } },
  );
  expect(entries).toHaveLength(3);
  await withEnvAsync(f.env, async () => {
    const warnings: string[] = [];
    await withPluginGenerationRehearsalPreparation(
      {
        env: f.env,
        hostRoot: f.host,
        entries,
        onWarning: (warning) => warnings.push(warning),
      },
      async () => {
        inspectPluginSourceDependencies(entries);
      },
    );
    expect(warnings).toEqual([]);
    for (const entry of entries) {
      const artifact = capturePluginGenerationArtifact(entry.rootDir, entry.entryFile, (run) =>
        run(),
      );
      artifacts.push(artifact);
      expect(artifact.hasSource(path.join(f.plugin, "unrelated.txt"))).toBe(false);
      expect(artifact.sourceAcquisition).toBe("prepared-candidate-plugin-generation");
      expect(fs.readFileSync(artifact.resolve(entry.entryFile), "utf8")).toBe(
        fs.readFileSync(entry.entryFile, "utf8"),
      );
    }
  });
});

it("reopens a prepared generation in another process and never publishes an interrupted producer", async () => {
  const prepared = fixture();
  const interrupted = fixture();
  await withEnvAsync(prepared.env, async () => {
    await prepared.publish();
    prepared.write(path.join(prepared.plugin, "value.cjs"), "exports.value = 'changed source';");
    const moduleUrl = (name: string) => new URL(name, import.meta.url).href;
    const script = `
      import fs from 'node:fs';
      import { createRequire } from 'node:module';
      import { capturePluginGenerationArtifact } from ${JSON.stringify(moduleUrl("./plugin-generation-artifact.ts"))};
      import { withPluginGenerationRehearsalPreparation } from ${JSON.stringify(moduleUrl("./plugin-generation-rehearsal.ts"))};
      import { inspectPluginSourceDependencies } from ${JSON.stringify(moduleUrl("./plugin-generation-source-inspection.ts"))};
      const view = capturePluginGenerationArtifact(${JSON.stringify(prepared.plugin)});
      try { fs.writeSync(1, createRequire(import.meta.url)(view.resolve(${JSON.stringify(path.join(prepared.plugin, "value.cjs"))})).value + '\\n'); }
      finally { view.dispose(); }
      await withPluginGenerationRehearsalPreparation(${JSON.stringify({ env: interrupted.env, hostRoot: interrupted.host, entries: interrupted.entries })}, async () => {
        inspectPluginSourceDependencies(${JSON.stringify(interrupted.entries)});
        process.exit(73);
      });
    `;
    const child = await runCommandBuffered(
      [
        process.execPath,
        "--import",
        moduleUrl("../../scripts/tsx.mjs"),
        "--input-type=module",
        "-e",
        script,
      ],
      { timeoutMs: 15_000 },
    );
    expect(child.code, child.stderr.toString()).toBe(73);
    expect(child.stdout.toString().trim()).toBe("before");
  });
  await withEnvAsync(interrupted.env, async () => {
    expect(readPluginGenerationRehearsalArtifact(interrupted.plugin)).toBeUndefined();
    expect(fs.readFileSync(path.join(interrupted.plugin, "value.cjs"), "utf8")).toContain("before");
  });
});
