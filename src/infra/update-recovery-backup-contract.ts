import path from "node:path";
import { z } from "zod";
export const updateRecoveryBackupRefSchema = z
  .object({
    directory: z.string().min(1),
    manifestPath: z.string().min(1),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type UpdateRecoveryBackupRef = z.infer<typeof updateRecoveryBackupRefSchema>;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const updateRecoveryConfigWriteSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0") && path.resolve(value) === value),
    beforeHash: sha256.nullable(),
    afterHash: sha256.nullable(),
    contiguous: z.boolean(),
  })
  .strict();
export type UpdateRecoveryConfigWrite = z.infer<typeof updateRecoveryConfigWriteSchema>;
export function mergeUpdateRecoveryConfigWrites(
  previous: readonly UpdateRecoveryConfigWrite[],
  next: readonly UpdateRecoveryConfigWrite[],
): UpdateRecoveryConfigWrite[] {
  const merged = new Map(previous.map((entry) => [entry.path, entry]));
  for (const entry of next) {
    const before = merged.get(entry.path);
    merged.set(
      entry.path,
      before
        ? {
            path: entry.path,
            beforeHash: before.beforeHash,
            afterHash: entry.afterHash,
            contiguous:
              before.contiguous && entry.contiguous && before.afterHash === entry.beforeHash,
          }
        : entry,
    );
  }
  return [...merged.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

export const updateRecoveryTerminalOutcomeSchema = z
  .object({
    status: z.enum(["restored", "committed"]),
    error: z.string().max(4096).optional(),
    manifestSha256: sha256,
  })
  .strict();

const updateRecoveryRetirementSchema = z
  .object({
    directory: z.string().min(1).max(4096),
    installRoot: z.string().min(1).max(4096),
    stateDir: z.string().min(1).max(4096),
    configPath: z.string().min(1).max(4096),
    identity: z.object({ dev: z.number(), ino: z.number(), birthtimeMs: z.number() }).strict(),
    outcome: z.enum(["committed", "restored"]),
    // Present only after every retained generation has passed terminal verification.
    generations: z
      .array(
        z
          .object({
            kind: z.enum(["candidate", "prepared"]),
            manifestSha256: sha256,
            identity: z
              .object({ dev: z.number(), ino: z.number(), birthtimeMs: z.number() })
              .strict(),
          })
          .strict(),
      )
      .max(2)
      .optional(),
  })
  .strict();
export type UpdateRecoveryRetirement = z.infer<typeof updateRecoveryRetirementSchema>;

export const updateRecoveryForwardResolutionSchema = z
  .object({
    kind: z.literal("forward-resolved"),
    binding: z
      .object({
        runId: z.string().min(1),
        failedAtMs: z.number().int().nonnegative(),
        manifestSha256: sha256,
        candidateSha256: sha256.nullable(),
        preparedSha256: sha256.nullable(),
        incompleteGenerations: z
          .object({
            candidate: sha256.optional(),
            prepared: sha256.optional(),
          })
          .strict()
          .optional(),
        installRoot: z.string().min(1),
        stateDir: z.string().min(1),
        configPath: z.string().min(1),
      })
      .strict(),
    repair: z
      .object({
        root: z.string().min(1),
        packageSha256: sha256,
        node: z.string().min(1),
        nodeVersion: z.string().min(1),
        build: z.string().min(1),
        artifact: z
          .object({
            rootIdentity: z.string().min(1),
            module: z.string().min(1),
            entry: z.string().min(1),
            inventorySha256: sha256,
            executableIdentity: z.string().min(1),
            executableSha256: sha256,
          })
          .strict(),
      })
      .strict(),
    completedAtMs: z.number().int().nonnegative(),
  })
  .strict();
export type UpdateRecoveryForwardResolution = z.infer<typeof updateRecoveryForwardResolutionSchema>;

export const updateRecoveryCaptureStateSchema = z
  .object({
    manifestSha256: sha256,
    configWrites: z.array(updateRecoveryConfigWriteSchema).max(512),
    status: z.enum(["pending", "restore-failed"]),
    error: z.string().max(4096).optional(),
    doctorCompleted: z.boolean().optional(),
    restored: z.literal(true).optional(),
    retirement: updateRecoveryRetirementSchema.optional(),
    forwardResolution: updateRecoveryForwardResolutionSchema.optional(),
  })
  .strict();
export type UpdateRecoveryCaptureState = z.infer<typeof updateRecoveryCaptureStateSchema>;

function mergeUpdateRecoveryCaptureState(
  previous: UpdateRecoveryCaptureState | undefined,
  patch: Pick<UpdateRecoveryCaptureState, "manifestSha256"> & Partial<UpdateRecoveryCaptureState>,
): UpdateRecoveryCaptureState {
  if (previous && previous.manifestSha256 !== patch.manifestSha256) {
    throw new Error("Update recovery receipts belong to another capture.");
  }
  return updateRecoveryCaptureStateSchema.parse({
    status: "pending",
    ...previous,
    ...patch,
    ...(previous?.restored ? { restored: true } : {}),
    configWrites: mergeUpdateRecoveryConfigWrites(
      previous?.configWrites ?? [],
      patch.configWrites ?? [],
    ),
  });
}

/** Recheck the failed-run identity inside its existing synchronous ledger transaction. */
export function mergeUpdateRunRecoveryCaptureState(
  record: {
    runId: string;
    status: string;
    finishedAtMs: number | null;
    origin: { updateRecoveryCapture?: UpdateRecoveryCaptureState };
  },
  patch: Pick<UpdateRecoveryCaptureState, "manifestSha256"> & Partial<UpdateRecoveryCaptureState>,
): UpdateRecoveryCaptureState {
  const capture = record.origin.updateRecoveryCapture;
  const resolution = patch.forwardResolution;
  if (resolution) {
    if (
      record.status !== "failed" ||
      record.finishedAtMs !== resolution.binding.failedAtMs ||
      resolution.binding.runId !== record.runId ||
      resolution.binding.manifestSha256 !== patch.manifestSha256 ||
      resolution.completedAtMs < resolution.binding.failedAtMs ||
      !capture ||
      capture.manifestSha256 !== patch.manifestSha256 ||
      capture.restored ||
      capture.retirement ||
      capture.forwardResolution
    ) {
      throw new Error("Forward resolution cannot replace a changed or resolved recovery run.");
    }
  }
  return mergeUpdateRecoveryCaptureState(capture, patch);
}
