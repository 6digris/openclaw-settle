import { expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import type { UpdateCommandOptions } from "./shared.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";
import {
  deferUpdateCommandResultObservation,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";

it.each(["success", "cleanup", "pending"] as const)(
  "preserves authoritative settlement when the migrated observer throws (%s)",
  async (kind) => {
    const result: UpdateRunResult = {
      status: "ok",
      mode: "npm",
      root: "/fixture",
      steps: [],
      durationMs: 0,
    };
    const run: NonNullable<UpdateCommandOptions["run"]> = {
      runId: "observer-error-fixture",
      env: {},
    };
    const authoritative =
      kind === "cleanup"
        ? new CommandProcessCleanupError()
        : kind === "pending"
          ? new UpdateCommandPendingRecoveryFailure({ ...result, status: "error" })
          : undefined;
    const observerFailure = new Error("result observer failed");
    const onResult = vi.fn(() => {
      throw observerFailure;
    });
    const failure = await withUpdateCommandTerminalResult(
      async (register) => {
        register(run);
        deferUpdateCommandResultObservation(run, result, result.root!);
        if (authoritative) {
          throw authoritative;
        }
      },
      { onResult },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: kind === "success" ? "ok" : "error" }),
    );
    expect(failure).toBe(authoritative ?? observerFailure);
    expect(hasCommandProcessCleanupError(failure)).toBe(kind === "cleanup");
  },
);
