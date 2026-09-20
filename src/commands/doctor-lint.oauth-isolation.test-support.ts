// Keep the OAuth source-lock fixture separate from the private-handle retirement matrix.
import { expect, vi } from "vitest";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { createMcpOAuthClientProvider } from "../agents/mcp-oauth-provider.js";
import { resolveMcpOAuthAccessToken } from "../agents/mcp-oauth.js";
import type { HealthCheck } from "../flows/health-checks.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { snapshotDoctorLintSqliteFamily } from "./doctor-lint.test-support.js";

export async function verifyDoctorLintOAuthStateIsolation(
  runtime: RuntimeEnv,
  installHealthChecks: (checks: HealthCheck[]) => void,
): Promise<void> {
  await withOpenClawTestState({ prefix: "doctor-lint-oauth-" }, async (state) => {
    await state.writeConfig({});
    const identity = operatorMcpOAuthIdentity("oauth-proof", "https://mcp.example.test/rpc");
    await createMcpOAuthClientProvider({ identity }).saveTokens({
      access_token: "stored-inspection-token-not-real",
      token_type: "Bearer",
      expires_in: 3600,
    });
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    const lock = openNodeSqliteDatabase(databasePath);
    try {
      // Materialize the caller's WAL sidecars before measuring Doctor's effects.
      // Windows byte-range locks prohibit raw snapshots during the transaction.
      lock.exec("BEGIN IMMEDIATE; ROLLBACK");
      const before = snapshotDoctorLintSqliteFamily(databasePath);
      lock.exec("BEGIN IMMEDIATE");
      installHealthChecks([
        {
          id: "core/doctor/runtime-tool-schemas",
          kind: "core",
          description: "checks OAuth state ownership",
          async detect() {
            const token = await resolveMcpOAuthAccessToken({
              identity,
              acceptUnknownExpiry: true,
              signal: AbortSignal.timeout(250),
            });
            expect(token).toBe("stored-inspection-token-not-real");
            return [];
          },
        },
      ]);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await expect(
          runDoctorLintCli(runtime, {
            json: true,
            onlyIds: ["core/doctor/runtime-tool-schemas"],
          }),
        ).resolves.toBe(0);
        expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
          ok: true,
          checksRun: 1,
          findings: [],
        });
        expect(lock.isOpen).toBe(true);
        expect(lock.isTransaction).toBe(true);
        lock.exec("ROLLBACK");
        expect(snapshotDoctorLintSqliteFamily(databasePath)).toEqual(before);
      } finally {
        stdout.mockRestore();
      }
    } finally {
      if (lock.isTransaction) {
        lock.exec("ROLLBACK");
      }
      lock.close();
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
    }
  });
}
