import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";

export async function withTempSessionStore<T>(
  run: (params: { dir: string; storePath: string }) => Promise<T>,
): Promise<T> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-")),
  );
  try {
    return await run({ dir, storePath: path.join(dir, "sessions.json") });
  } finally {
    await closeOpenClawAgentDatabasesAsync(dir);
    await fs.rm(dir, { recursive: true, force: true });
  }
}
