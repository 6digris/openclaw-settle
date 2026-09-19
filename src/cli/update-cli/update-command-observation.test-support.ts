import path from "node:path";
import { expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { updateCommand } from "./update-command.js";

export function registerMigratedResultSettlementTests(harness: {
  updateCommand: typeof updateCommand;
  prepare: () => void;
}) {
  it.each([false, true])(
    "observes migrated results only after executor settlement (revoked=%s)",
    async (revoked) => {
      const { createManagedHandoffLeaseStore } =
        await import("../../infra/update-managed-service-handoff-lease.js");
      const { resolveUpdateInstallRoot } = await import("../../infra/update-install-root.js");
      const migrated = await import("./update-command-migrated.js");
      const observed: Array<{ status: string; lease: string }> = [];
      vi.spyOn(migrated, "inspectActivatedUpdateState").mockResolvedValueOnce(
        "state-migrated-no-rollback",
      );
      vi.spyOn(migrated, "continueMigratedUpdateInFreshProcess").mockImplementationOnce(
        async (params) => {
          const root = resolveUpdateInstallRoot(params.root);
          const store = createManagedHandoffLeaseStore();
          const admitted = store.read(root);
          expect(admitted.kind).toBe("current");
          if (revoked && admitted.kind === "current") {
            expect(store.bind(admitted.lease, process.pid)).not.toBeNull();
          }
          return {
            result: {
              ...params.result,
              status: "ok",
              reason: undefined,
              runId: params.opts.run!.runId,
            },
            exitCode: 0,
          };
        },
      );
      harness.prepare();
      const failure = await harness
        .updateCommand({
          yes: true,
          json: true,
          onResult: (result: UpdateRunResult) =>
            observed.push({
              status: result.status,
              lease: createManagedHandoffLeaseStore().read(resolveUpdateInstallRoot(process.cwd()))
                .kind,
            }),
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ status: revoked ? "error" : "ok" });
      if (!revoked) {
        expect(failure).toBeUndefined();
        expect(observed[0]?.lease).toBe("absent");
      } else {
        expect(failure).toBeDefined();
      }
    },
  );
  it.each(["schema-migration", "protected-same-schema"] as const)(
    "does not reopen the ledger after target finalization fails (%s)",
    async (kind) => {
      const { expectDefined } = await import("@openclaw/normalization-core");
      const { ExitError } = await import("../../runtime.js");
      const migrated = await import("./update-command-migrated.js");
      const ledgerReads = vi.spyOn(
        await import("../../infra/update-run-ledger.js"),
        "getUpdateRun",
      );
      const failure = new Error("candidate finalization failed");
      let readsAtHandoff = 0;
      vi.spyOn(migrated, "inspectActivatedUpdateState").mockResolvedValueOnce(
        kind === "schema-migration" ? "state-migrated-no-rollback" : undefined,
      );
      if (kind === "protected-same-schema") {
        const execution = await import("./update-command-execution.js");
        const execute = execution.executeMutableUpdate;
        vi.spyOn(execution, "executeMutableUpdate").mockImplementationOnce(async (params) => ({
          ...expectDefined(await execute(params), "completed mutable update"),
          candidateUpdateRecovery: "parent-v1",
          updateRecoveryBackup: {
            directory: path.join(process.cwd(), "capture"),
            manifestPath: path.join(process.cwd(), "capture", "manifest.json"),
            manifestSha256: "a".repeat(64),
          },
        }));
      }
      vi.spyOn(migrated, "continueMigratedUpdateInFreshProcess").mockImplementationOnce(
        async () => {
          readsAtHandoff = ledgerReads.mock.calls.length;
          throw failure;
        },
      );
      harness.prepare();

      await expect(harness.updateCommand({ yes: true, json: true })).rejects.toEqual(
        new ExitError(1),
      );

      expect(migrated.continueMigratedUpdateInFreshProcess).toHaveBeenCalledOnce();
      expect(ledgerReads).toHaveBeenCalledTimes(readsAtHandoff);
    },
  );
}
