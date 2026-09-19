/** Owns each admitted turn from actor admission through final settlement. */
import { resolveSystemEventStorePath } from "../../config/sessions/session-store-path.js";
import { logVerbose } from "../../globals.js";
import { captureSystemEventStorePaths } from "../../infra/system-event-ownership.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type {
  AcpRunTurnInput,
  AcpSessionManagerDeps,
  ActiveTurnState,
  WithManagerSessionActor,
} from "./manager.types.js";
import { acpSessionActorKey } from "./manager.utils.js";

export type AcceptedTurnState = Pick<
  ActiveTurnState,
  "requestId" | "instanceId" | "abortController"
> & {
  activeTurn?: ActiveTurnState;
  readonly watcherStorePaths: Readonly<Record<string, string | null>>;
  settled: Promise<void>;
  cancelReason?: string;
  revalidateCancel?: () => void;
};

export type AcceptedTurns = Map<string, Set<AcceptedTurnState>>;

export async function runAcceptedManagerTurn(params: {
  input: AcpRunTurnInput;
  sessionKey: string;
  agentId: string;
  stopping: boolean;
  turns: AcceptedTurns;
  loadSessionEntry: AcpSessionManagerDeps["loadSessionEntry"];
  withSessionActor: WithManagerSessionActor;
  run: (
    input: AcpRunTurnInput,
    acceptedTurn: AcceptedTurnState,
    isCurrentActor: () => boolean,
  ) => Promise<void>;
  onQueuedCancellation: (startedAt: number) => Promise<void>;
}): Promise<void> {
  const { input } = params;
  const startedAt = Date.now();
  const instance = input.admittedRunContext.operationalRunInstance;
  if (instance.runId !== input.requestId) {
    throw new Error("ACP operational run instance disagrees with the admitted request");
  }
  const watcherStorePaths: Record<string, string | null> =
    input.provenance === "human" ? { ...captureSystemEventStorePaths(input.cfg) } : {};
  if (input.provenance === "human") {
    try {
      const entry = params.loadSessionEntry({
        cfg: input.cfg,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        clone: false,
      })?.entry;
      const watcher = entry?.spawnedBy ?? entry?.parentSessionKey;
      if (watcher) {
        // The actor queue may outlive this store selection; never re-resolve its parent later.
        watcherStorePaths[watcher] = null;
        watcherStorePaths[watcher] =
          resolveSystemEventStorePath({ cfg: input.cfg, sessionKey: watcher }) ?? null;
      }
    } catch (error) {
      logVerbose(`acp-manager: could not capture notification parent store: ${String(error)}`);
    }
  }
  const completion = createDeferredCore();
  // Only cancellation joins this promise. Ordinary failed turns may have no joiner.
  void completion.promise.catch(() => {});
  const turn: AcceptedTurnState = {
    requestId: input.requestId,
    instanceId: instance.instanceId,
    abortController: new AbortController(),
    watcherStorePaths: Object.freeze(watcherStorePaths),
    settled: completion.promise,
  };
  const actorKey = acpSessionActorKey(params);
  const turns = params.turns.get(actorKey) ?? new Set<AcceptedTurnState>();
  turns.add(turn);
  params.turns.set(actorKey, turns);
  if (params.stopping) {
    turn.abortController.abort();
  }
  const signal = input.signal
    ? AbortSignal.any([input.signal, turn.abortController.signal])
    : turn.abortController.signal;
  let started = false;
  try {
    try {
      await params.withSessionActor(
        params,
        async (isCurrentActor) => {
          started = true;
          await params.run({ ...input, signal }, turn, isCurrentActor);
        },
        signal,
      );
    } catch (error) {
      if (started || !signal.aborted) {
        throw error;
      }
      // The actor still owns its queued callback, which will observe the abort.
      // Finish only this accepted instance; never write idle over its predecessor.
      turn.revalidateCancel?.();
      await params.onQueuedCancellation(startedAt);
    }
    completion.resolve();
  } catch (error) {
    completion.reject(error);
    throw error;
  } finally {
    turns.delete(turn);
    if (turns.size === 0 && params.turns.get(actorKey) === turns) {
      params.turns.delete(actorKey);
    }
  }
}
