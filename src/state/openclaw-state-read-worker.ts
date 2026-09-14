import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  OpenClawStateReadAuthority,
  OpenClawStateReadCommand,
  OpenClawStateReadLocation,
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "./openclaw-state-worker-error.js";

type ReadTaskOutcome = { value: OpenClawStateReadReply } | { error: unknown };

function decodeTaskReply(reply: OpenClawStateReadReply): ReadTaskOutcome {
  if (reply.ok) {
    return { value: reply };
  }
  const error = new Error(reply.message);
  retainOpenClawStateWorkerErrorPayload(error, reply.error);
  return { error: hydrateOpenClawStateWorkerError(error, { includeGenericErrors: true }) };
}

export function createOpenClawStateReadTransport(
  command: OpenClawStateReadCommand,
  onRetirementFailure: (error: unknown) => void,
) {
  const failedRetirement = createDeferredCore<never>();
  void failedRetirement.promise.catch(() => undefined);
  let pool: WorkerTaskPool<OpenClawStateReadRequest, OpenClawStateReadReply> | undefined;
  let currentTask: Promise<ReadTaskOutcome> | undefined;
  let interruptedTask: Promise<ReadTaskOutcome> | undefined;
  const run = async (
    context: OpenClawStateWorkerContext,
    location: string,
    checkFreshAdmission: boolean,
    operation: OpenClawStateReadRequest["command"],
    authority: OpenClawStateReadAuthority,
  ) => {
    authority.assertCurrent();
    pool ??= new WorkerTaskPool({
      workerUrl: resolveRuntimeProcessEntrypointUrl("stateRead"),
      maxWorkers: 1,
      onRetirementFailure(error) {
        interruptedTask ??= currentTask;
        failedRetirement.reject(error);
        onRetirementFailure(error);
      },
    });
    const task = pool
      .run(
        {
          context: {
            environment: context.environment,
            coordinatorRuntime: context.coordinatorRuntime,
          },
          databasePath: context.admission.databasePath,
          location,
          checkFreshAdmission,
          command: operation,
        },
        { signal: authority.signal },
      )
      .then(
        (reply): ReadTaskOutcome => {
          try {
            return decodeTaskReply(reply);
          } catch (error) {
            return { error };
          }
        },
        (error: unknown): ReadTaskOutcome => ({ error }),
      );
    currentTask = task;
    const outcome = await Promise.race([task, failedRetirement.promise]);
    currentTask = undefined;
    if ("error" in outcome) {
      throw outcome.error;
    }
    authority.assertCurrent();
    return outcome.value;
  };
  return {
    async validateFresh(
      context: OpenClawStateWorkerContext,
      authority: OpenClawStateReadAuthority,
    ) {
      await run(context, context.admission.databasePath, true, { type: "admit" }, authority);
    },
    read: (source: OpenClawStateReadLocation, authority: OpenClawStateReadAuthority) =>
      run(source.context, source.location, source.checkFreshAdmission, command, authority),
    async close(): Promise<{ error: unknown } | undefined> {
      await pool?.close();
      // Only acknowledged stop makes the original task's delayed rejection observable.
      const outcome = await interruptedTask;
      return outcome && "error" in outcome ? outcome : undefined;
    },
  };
}
