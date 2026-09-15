import path from "node:path";
import {
  gatewayDatabaseWorkerTestFiles,
  gatewayPluginTestFiles,
} from "./vitest.gateway-server-paths.mjs";
import { collectVitestExcludePatterns, matchesVitestGlob } from "./vitest.pattern-file.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayDatabaseWorkersVitestConfig(env?: Record<string, string | undefined>) {
  const dir = "src/gateway";
  const config = createScopedVitestConfig(gatewayDatabaseWorkerTestFiles, {
    dir,
    env,
    fileParallelism: false,
    intersectIncludeFile: true,
    isolate: false,
    name: "gateway-database-workers",
    passWithNoTests: true,
    pool: "forks",
    useNonIsolatedRunner: true,
  });
  const cliExcludes = collectVitestExcludePatterns(process.argv.slice(2));
  // Keep Gateway-relative CLI filters; resolve cross-root files only after selection.
  return {
    ...config,
    test: {
      ...config.test,
      include: config.test?.include?.flatMap((pattern) => {
        if (!gatewayPluginTestFiles.includes(pattern)) {
          return [pattern];
        }
        if (cliExcludes.some((exclude) => matchesVitestGlob(pattern, exclude))) {
          return [];
        }
        return [path.posix.relative(dir, pattern)];
      }),
    },
  };
}

export default createGatewayDatabaseWorkersVitestConfig();
