import { existsSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { GATEWAY_RUN_CHUNK_METADATA_VERSION } from "./gateway-run-chunk-metadata.mts";
import { importToolingTypeScript } from "./import-tooling-typescript.mts";

/** Frozen targets own their worker artifacts and Gateway locator contract. */
export async function readReleaseTargetRuntimeContract(targetRoot: string) {
  const workerProducerPath = resolve(targetRoot, "src/worker/worker-deploy-entry.ts");
  const workerBundlePath = resolve(targetRoot, "src/shared/worker-bundle-hash.ts");
  // Frozen targets can have shared hash helpers without a deploy entrypoint.
  const hasWorkerProducer = existsSync(workerProducerPath);
  let workerArtifactDeclarations: Array<[string, unknown]> = [];
  if (hasWorkerProducer) {
    const target = await importToolingTypeScript(
      pathToFileURL(workerBundlePath).href,
      import.meta.url,
    );
    if (Object.hasOwn(target, "WORKER_BUNDLE_ARTIFACT_PATHS")) {
      const paths = target.WORKER_BUNDLE_ARTIFACT_PATHS;
      if (!Array.isArray(paths) || paths.length === 0) {
        throw new Error(
          "release-check: target WORKER_BUNDLE_ARTIFACT_PATHS must be a non-empty array.",
        );
      }
      workerArtifactDeclarations = paths.map((value, index): [string, unknown] => [
        `WORKER_BUNDLE_ARTIFACT_PATHS[${index}]`,
        value,
      ]);
    } else {
      // v2026.9.4 deploy targets expose individual paths. Remove this fallback once
      // every supported frozen release target declares the canonical array.
      workerArtifactDeclarations = Object.entries(target).filter(([name]) =>
        /^WORKER_BUNDLE_.*_PATH$/u.test(name),
      );
    }
  }
  const workerDeployEntrypoints = workerArtifactDeclarations.map(([name, value]) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(
        `release-check: target worker artifact ${name} must be a non-empty path string.`,
      );
    }
    const normalizedPath = posix.normalize(value);
    const workerPath = posix.join("dist/worker", normalizedPath);
    if (
      value !== value.trim() ||
      value !== normalizedPath ||
      value.includes("\\") ||
      normalizedPath.split("/").includes("..") ||
      win32.isAbsolute(value) ||
      !workerPath.startsWith("dist/worker/")
    ) {
      throw new Error(
        `release-check: target worker artifact ${name} must be a normalized relative path within dist/worker.`,
      );
    }
    return workerPath;
  });
  if (hasWorkerProducer && workerDeployEntrypoints.length === 0) {
    throw new Error(
      "release-check: target worker producer is missing WORKER_BUNDLE_*_PATH declarations.",
    );
  }
  // New tooling may qualify a frozen target without the build-owned locator generator.
  // Never infer legacy mode from missing output: current targets must rebuild missing metadata.
  const locatorModulePath = resolve(targetRoot, "scripts/lib/gateway-run-chunk-metadata.mts");
  const locatorModule = existsSync(locatorModulePath)
    ? await importToolingTypeScript(pathToFileURL(locatorModulePath).href, import.meta.url)
    : undefined;
  if (
    locatorModule &&
    locatorModule.GATEWAY_RUN_CHUNK_METADATA_VERSION !== GATEWAY_RUN_CHUNK_METADATA_VERSION
  ) {
    throw new Error("release-check: unsupported target gateway run chunk metadata version.");
  }
  return { workerDeployEntrypoints, legacyGatewayChunkDiscovery: locatorModule === undefined };
}
