import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";

/** Pending cleanup refuses a new operation before its callback starts. */
export function createOpenClawStateWorkerCleanupError(options?: {
  cause: unknown;
}): SqliteWorkerError {
  const error = new SqliteWorkerError(
    "Shared-state worker cleanup is pending; close the database before reopening",
    "unavailable",
  );
  if (options) {
    error.cause = options.cause;
  }
  return error;
}

/** Join retirement before a new callback acquires its worker. */
export async function joinOpenClawStateWorkerCleanup(
  pending: Promise<void> | undefined,
): Promise<void> {
  if (!pending) {
    throw createOpenClawStateWorkerCleanupError();
  }
  try {
    await pending;
  } catch (cause) {
    throw createOpenClawStateWorkerCleanupError({ cause });
  }
}
