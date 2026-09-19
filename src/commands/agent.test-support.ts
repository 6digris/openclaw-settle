import { withTempHome as withTempHomeBase } from "openclaw/plugin-sdk/test-env";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";

export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      try {
        return await fn(home);
      } finally {
        // Fixed session stores may live outside the SDK helper's .openclaw cleanup root.
        await closeOpenClawAgentDatabasesAsync(home);
      }
    },
    {
      prefix: "openclaw-agent-",
    },
  );
}
