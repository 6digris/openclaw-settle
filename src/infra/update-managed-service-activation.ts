import { readControlPlaneUpdateSentinelMeta } from "./update-control-plane-sentinel.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

/** Prepare the existing helper transport without granting a direct ancestor stop. */
export async function prepareManagedServiceUpdateHandoffActivation(params: {
  root: string;
  runId: string;
  assertCurrent: () => void;
}): Promise<((onStopped: () => void) => Promise<void>) | undefined> {
  if (process.env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1") {
    return undefined;
  }
  params.assertCurrent();
  const meta = await readControlPlaneUpdateSentinelMeta();
  params.assertCurrent();
  const root = resolveUpdateInstallRoot(params.root);
  if (
    meta?.runId !== params.runId ||
    !meta.handoffId ||
    !meta.root ||
    resolveUpdateInstallRoot(meta.root) !== root
  ) {
    return undefined;
  }
  const store = createManagedHandoffLeaseStore();
  const found = store.read(root);
  if (found.kind !== "current") {
    return undefined;
  }
  const lease = found.lease;
  if (
    lease.owner !== meta.handoffId ||
    lease.action.kind !== "update" ||
    lease.helper.pid === lease.executor.pid ||
    !store.owns(lease, "executor")
  ) {
    return undefined;
  }
  const assertCurrent = () => {
    params.assertCurrent();
    if (!store.owns(lease, "executor")) {
      throw new Error("Managed update activation lost its original helper assignment.");
    }
  };
  const input = process.stdin;
  const output = process.stdout;
  let consumed = false;
  return async (onStopped) => {
    assertCurrent();
    if (consumed) {
      throw new Error("Managed update activation has already been requested.");
    }
    consumed = true;
    if (input.destroyed || input.readableEnded || output.destroyed) {
      throw new Error("Managed update activation control is unavailable.");
    }
    // The helper owns the stop deadline and joins native teardown before replying.
    // Do not race it with a caller timeout that would release the lifecycle lock.
    await new Promise<void>((resolve, reject) => {
      let buffered = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        input.off("data", onData).off("end", onEnd).off("error", finish);
        // Writable invokes a failed write callback before its paired error event.
        setImmediate(() => output.off("error", finish));
        input.pause();
        if (error) {
          reject(error);
          return;
        }
        try {
          // Preserve the observed stop even if authority was revoked during teardown.
          onStopped();
          assertCurrent();
          resolve();
        } catch (cause) {
          reject(
            cause instanceof Error
              ? cause
              : new Error("Managed update activation failed", { cause }),
          );
        }
      };
      const onEnd = () =>
        finish(new Error("Managed update activation control closed before acknowledgement."));
      const onData = (chunk: Buffer | string) => {
        buffered += chunk.toString();
        if (!buffered.includes("\n") && buffered.length < 64) {
          return;
        }
        finish(
          buffered === "parked\n"
            ? undefined
            : new Error("Managed update activation was not confirmed."),
        );
      };
      input.on("data", onData).once("end", onEnd).once("error", finish);
      output.once("error", finish);
      input.resume();
      try {
        assertCurrent();
        output.write("park\n", (error) => {
          if (error) {
            finish(error);
          }
        });
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  };
}
