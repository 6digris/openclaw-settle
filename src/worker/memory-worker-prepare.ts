import { existsSync } from "node:fs";
import path from "node:path";

/** Run before starting the worker; ordinary memory requests never repair schemas. */
export async function prepareMemoryWorkerState(stateDir: string, agentId: string): Promise<void> {
  if (
    !path.isAbsolute(stateDir) ||
    path.normalize(stateDir) !== stateDir ||
    stateDir === path.parse(stateDir).root ||
    stateDir.includes("\0") ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)
  ) {
    throw new Error("Invalid memory worker state directory or agent");
  }
  // Native state owners must see the worker's private directory at import time.
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "memory-worker-config.json");
  const [{ resolveOpenClawAgentSqlitePath }, { withAgentDatabaseMaintenanceLease }, migration] =
    await Promise.all([
      import("../state/openclaw-agent-db.paths.js"),
      import("../state/openclaw-agent-db-maintenance-lease.js"),
      import("../state/openclaw-agent-db-maintenance.js"),
    ]);
  const pathname = resolveOpenClawAgentSqlitePath({ agentId });
  if (!existsSync(pathname)) {
    return;
  }
  await withAgentDatabaseMaintenanceLease({ env: process.env }, (maintenance) =>
    migration.migrateOpenClawAgentDatabaseForMaintenance({ agentId, pathname }, maintenance),
  );
}
