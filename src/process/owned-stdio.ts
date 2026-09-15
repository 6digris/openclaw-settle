import type { Writable } from "node:stream";
import { settlesWithin } from "../shared/settle-within.js";
import { createCleanupDiagnostic } from "./cleanup-diagnostic.js";
import { createChildAdapter } from "./supervisor/adapters/child.js";
import type { SpawnProcessAdapter } from "./supervisor/types.js";

export type OwnedStdioProcess = SpawnProcessAdapter<NodeJS.Signals | null> &
  Required<Pick<SpawnProcessAdapter<NodeJS.Signals | null>, "onExit" | "onError">>;

export class OwnedStdioCleanupError extends Error {}

export async function createOwnedStdioProcess(params: {
  argv: string[];
  argv0?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  exactEnv?: true;
  /** Preserve the configured Windows wrapper's shipped Node shell launch contract. */
  windowsShell?: true;
  abortSignal?: AbortSignal;
  /** Consume stderr through a native pipe instead of callback observation. */
  stderrDestination?: Writable;
}): Promise<OwnedStdioProcess> {
  let startupCleanup: Promise<boolean> | undefined;
  try {
    return await createChildAdapter({
      ...params,
      ownProcessTree: true,
      stdinMode: "pipe-open",
      onSpawnCleanup: (cleanup) => {
        startupCleanup = cleanup.then(
          () => true,
          () => false,
        );
      },
    });
  } catch (error) {
    if (
      startupCleanup &&
      (!(await settlesWithin(startupCleanup, 500)) || !(await startupCleanup))
    ) {
      throw new OwnedStdioCleanupError("stdio startup cleanup did not confirm closure", {
        cause: error,
      });
    }
    throw error;
  }
}

/** Protocol EOF requests shutdown; only the spawn owner can certify descendant extinction. */
export async function closeOwnedStdioProcess(
  process: OwnedStdioProcess,
  options: { graceMs?: number; force?: boolean } = {},
): Promise<void> {
  const trace = createCleanupDiagnostic("owned-stdio");
  let rootSettled = false;
  let extinctionSettled = false;
  trace("close-start", { force: options.force === true });
  const root = process.wait();
  const extinction =
    process.waitForExtinction?.() ??
    Promise.reject(new Error("stdio process cleanup cannot confirm descendant extinction"));
  void root.then(
    () => {
      rootSettled = true;
      trace("root-output-resolved");
    },
    () => {
      rootSettled = true;
      trace("root-output-rejected");
    },
  );
  void extinction.then(
    () => {
      extinctionSettled = true;
      trace("extinction-resolved");
    },
    () => {
      extinctionSettled = true;
      trace("extinction-rejected");
    },
  );
  const settled = Promise.allSettled([root, extinction]);
  try {
    if (!options.force) {
      try {
        trace("stdin-eof-request");
        process.stdin?.end();
      } catch {
        // Broken input cannot prevent the spawn owner from reclaiming the process tree.
        trace("broken-stdin-term");
        process.kill("SIGTERM");
      }
      const graceMs = options.graceMs ?? 2_000;
      if (!(await settlesWithin(settled, graceMs))) {
        trace("eof-grace-expired", { rootSettled, extinctionSettled });
        process.kill("SIGTERM");
        if (!(await settlesWithin(settled, graceMs))) {
          trace("term-grace-expired", { rootSettled, extinctionSettled });
          process.kill("SIGKILL");
        }
      }
    } else {
      trace("force-kill-request");
      process.kill("SIGKILL");
    }
    if (!(await settlesWithin(settled, 500))) {
      trace("final-join-expired", { rootSettled, extinctionSettled });
      throw new Error("stdio process cleanup did not confirm descendant extinction");
    }
    const failure = (await settled).find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      trace("joined-rejection");
      throw failure.reason;
    }
    trace("close-confirmed");
  } finally {
    trace("dispose", { rootSettled, extinctionSettled });
    process.dispose();
  }
}
