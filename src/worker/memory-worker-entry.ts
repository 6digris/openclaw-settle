import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { OpenKeyedStoreOptions } from "../plugin-state/plugin-state-store.js";

// Describe the consumed public artifact without pulling plugin source into core's type graph.
type MemoryWorkerApi = {
  serveMemoryWorker: (options: {
    workspace: string;
    stateDir: string;
    agentId: string;
    input: Readable;
    output: Writable;
    loadHost: typeof loadHost;
  }) => Promise<{ close: () => void }>;
};

async function loadHost() {
  // The worker establishes its state directory before loading host state owners.
  const [{ registerEmbeddingProvider }, { createPluginStateKeyedStore }] = await Promise.all([
    import("../plugins/embedding-providers.js"),
    import("../plugin-state/plugin-state-store.js"),
  ]);
  return {
    registerEmbeddingProvider,
    openShortTermLocks: <T>(options: Omit<OpenKeyedStoreOptions, "namespace">) =>
      createPluginStateKeyedStore<T>("memory-core", { ...options, namespace: "short-term-locks" }),
  };
}

try {
  const args = process.argv.slice(2);
  const prepare = args[0] === "--prepare";
  if (prepare) {
    args.shift();
  }
  const [workspace, stateDir, agentId, ...extra] = args;
  if (!workspace || !stateDir || !agentId || extra.length) {
    throw new Error("Memory worker requires workspace, state directory, and agent ID");
  }
  // Stdout belongs to the duplex protocol, including during native initialization.
  console.log = console.info = (...values: unknown[]) => console.error(...values);
  if (prepare) {
    const { prepareMemoryWorkerState } = await import("./memory-worker-prepare.js");
    await prepareMemoryWorkerState(stateDir, agentId);
  } else {
    // The public artifact loader can import host modules that capture state paths.
    // Establish this process's private state before loading it; the worker validates paths.
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "memory-worker-config.json");
    const { loadBundledPluginPublicArtifactModuleSync } =
      await import("../plugins/public-surface-loader.js");
    const { serveMemoryWorker } = loadBundledPluginPublicArtifactModuleSync<MemoryWorkerApi>({
      dirName: "memory-core",
      artifactBasename: "worker-api.js",
    });
    const server = await serveMemoryWorker({
      workspace,
      stateDir,
      agentId,
      input: process.stdin,
      output: process.stdout,
      loadHost,
    });
    process.once("SIGTERM", () => {
      server.close();
      process.stdin.destroy();
    });
  }
} catch (error) {
  process.stderr.write(`Memory worker startup failed: ${String(error)}\n`);
  process.exitCode = 1;
}
