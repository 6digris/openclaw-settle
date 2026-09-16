import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readConfigFileSnapshot } from "../config/config.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import { root as safeRoot } from "./fs-safe.js";
import { describeRunningOpenClawBuild } from "./sqlite-user-version.js";
import {
  updateRecoveryForwardResolutionSchema,
  type UpdateRecoveryBackupRef,
  type UpdateRecoveryForwardResolution,
} from "./update-recovery-backup-contract.js";
import { digest, MAX_MANIFEST_BYTES, statOrMissing } from "./update-recovery-backup-files.js";
import { withRecoveryMetadata } from "./update-recovery-backup-metadata.js";
import { fingerprintIncompleteRecoveryGeneration } from "./update-recovery-incomplete-generation.js";
import { captureUpdateRecoveryRepairRuntime } from "./update-recovery-repair-runtime.js";
import { recordUpdateRunRecoveryCapture } from "./update-run-ledger.js";
import { getUpdateRunAsync } from "./update-run-reader.js";

type Authority = { assertOwned: () => void };

/** This records repair of current state, never reverse publication or permission to delete B/C/T. */
async function readBinding(ref: UpdateRecoveryBackupRef, authority: Authority, readOnly?: true) {
  return withRecoveryMetadata(
    ref,
    authority,
    async ({ manifest, outcome, pin }) => {
      const run = await getUpdateRunAsync(manifest.runId);
      authority.assertOwned();
      const capture = run?.origin.updateRecoveryCapture;
      if (
        outcome ||
        run?.status !== "failed" ||
        run.finishedAtMs === null ||
        !capture ||
        capture.manifestSha256 !== ref.manifestSha256 ||
        capture.restored ||
        capture.retirement ||
        manifest.schemaVersion !== 2 ||
        manifest.generation?.kind !== "baseline"
      ) {
        throw new Error("Forward recovery requires the same failed run and unresolved baseline.");
      }
      const generations: { candidateSha256: string | null; preparedSha256: string | null } = {
        candidateSha256: null,
        preparedSha256: null,
      };
      const incompleteGenerations: Partial<Record<"candidate" | "prepared", string>> = {};
      for (const kind of ["candidate", "prepared"] as const) {
        const directory = path.join(ref.directory, kind);
        if (!(await statOrMissing(directory))) {
          continue;
        }
        if (!(await statOrMissing(path.join(directory, "manifest.json")))) {
          // Preparation can stop before the final seal. Retain and bind all of
          // those bytes, but never label them a verified rollback generation.
          incompleteGenerations[kind] = await fingerprintIncompleteRecoveryGeneration(
            directory,
            authority.assertOwned,
          );
          continue;
        }
        const source = await safeRoot(directory);
        const raw = (
          await source.read("manifest.json", {
            maxBytes: MAX_MANIFEST_BYTES,
            symlinks: "reject",
            hardlinks: "reject",
          })
        ).buffer;
        const { parseUpdateRecoveryBackupManifest } =
          await import("../commands/backup-verify-manifest.js");
        let generation;
        try {
          generation = parseUpdateRecoveryBackupManifest(raw.toString("utf8"));
        } catch (error) {
          if (!(error instanceof SyntaxError)) {
            throw error;
          }
          // The seal file itself is created before its write completes. A
          // truncated JSON prefix is evidence, not a published generation.
          incompleteGenerations[kind] = await fingerprintIncompleteRecoveryGeneration(
            directory,
            authority.assertOwned,
          );
          continue;
        }
        if (
          generation.runId !== manifest.runId ||
          generation.installRoot !== manifest.installRoot ||
          generation.stateDir !== manifest.stateDir ||
          generation.configPath !== manifest.configPath ||
          generation.generation?.kind !== kind ||
          generation.generation.baselineSha256 !== ref.manifestSha256 ||
          (generation.generation.kind === "prepared" &&
            generation.generation.candidateSha256 !== generations.candidateSha256)
        ) {
          throw new Error("Forward recovery generation identity changed.");
        }
        if (kind === "candidate") {
          generations.candidateSha256 = digest(raw);
        } else {
          generations.preparedSha256 = digest(raw);
        }
      }
      await pin.assertCurrent();
      authority.assertOwned();
      return {
        runId: manifest.runId,
        failedAtMs: run.finishedAtMs,
        manifestSha256: ref.manifestSha256,
        installRoot: manifest.installRoot,
        stateDir: manifest.stateDir,
        configPath: manifest.configPath,
        ...generations,
        ...(Object.keys(incompleteGenerations).length > 0 ? { incompleteGenerations } : {}),
      };
    },
    { readOnly },
  );
}

/** Missing receipt keeps admission closed. Malformed or contradictory receipts fail closed. */
export async function hasUpdateRecoveryForwardResolution(
  ref: UpdateRecoveryBackupRef,
  authority: Authority = { assertOwned() {} },
): Promise<boolean> {
  return withRecoveryMetadata(
    ref,
    authority,
    async ({ manifest, outcome }) => {
      const run = await getUpdateRunAsync(manifest.runId);
      authority.assertOwned();
      const value = run?.origin.updateRecoveryCapture?.forwardResolution;
      if (!value) {
        return false;
      }
      const receipt = updateRecoveryForwardResolutionSchema.parse(value);
      if (outcome || !isDeepStrictEqual(receipt.binding, await readBinding(ref, authority, true))) {
        throw new Error("Forward recovery receipt is stale or contradicts its failed capture.");
      }
      authority.assertOwned();
      return true;
    },
    { readOnly: true },
  );
}

/** Only the Doctor scope that held maintenance through the repair may settle this closure. */
export async function prepareUpdateRecoveryForwardResolution(
  ref: UpdateRecoveryBackupRef,
  repairRoot: string,
  authority: Authority,
  actualEntryUrl: string = import.meta.url,
): Promise<() => Promise<void>> {
  const binding = await readBinding(ref, authority);
  authority.assertOwned();
  const runtime = captureUpdateRecoveryRepairRuntime(repairRoot, import.meta.url, actualEntryUrl);
  authority.assertOwned();
  const repair = {
    ...runtime,
    nodeVersion: process.version,
    build: describeRunningOpenClawBuild(),
  };
  const assertRepairCurrent = () => {
    authority.assertOwned();
    if (
      !isDeepStrictEqual(
        captureUpdateRecoveryRepairRuntime(repairRoot, import.meta.url, actualEntryUrl),
        runtime,
      )
    ) {
      throw new Error("Forward recovery repair runtime changed before settlement.");
    }
    authority.assertOwned();
  };
  return async () => {
    authority.assertOwned();
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      throw new Error("Forward recovery cannot certify invalid configuration.");
    }
    // The normal Doctor readiness owner checks all registered/configured current stores,
    // including same-version drift; no baseline database is copied over newer state.
    await assertOpenClawDatabasesReady({
      operation: "gateway-startup",
      env: process.env,
      config: snapshot.config,
    });
    const receipt: UpdateRecoveryForwardResolution = {
      kind: "forward-resolved",
      binding,
      repair,
      completedAtMs: Date.now(),
    };
    await withRecoveryMetadata(ref, authority, async ({ manifest, outcome, pin }) => {
      if (outcome || !isDeepStrictEqual(binding, await readBinding(ref, authority))) {
        throw new Error("Forward recovery binding changed during repair.");
      }
      await pin.assertCurrent();
      authority.assertOwned();
      // Synchronous ledger transaction revalidates the failed run immediately before
      // storing its separate receipt. The original status/error and B/C/T remain intact.
      recordUpdateRunRecoveryCapture(
        manifest.runId,
        {
          manifestSha256: ref.manifestSha256,
          forwardResolution: receipt,
        },
        // Synchronous runtime validation inside the owning ledger transaction,
        // after every readiness/metadata await and before receipt publication.
        assertRepairCurrent,
      );
    });
  };
}
