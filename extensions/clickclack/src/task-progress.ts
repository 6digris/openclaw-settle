import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createClickClackActivityPublisher, type ClickClackActivityPublisher } from "./activity.js";
import { createClickClackClient } from "./http-client.js";
import {
  createClickClackAgentProgressPublisher,
  type ClickClackAgentProgressPublisher,
  type ClickClackItemEventPayload,
  type ClickClackProgressPublication,
} from "./progress.js";
import { hasClickClackTaskRecoveryWork, rememberClickClackTaskRecoverySession } from "./runtime.js";
import type { ClickClackMessage, ResolvedClickClackAccount } from "./types.js";

type BoundTasks = ReturnType<PluginRuntime["tasks"]["async"]["runs"]["bindSession"]>;
type TaskUpdate = Parameters<Parameters<BoundTasks["observeProgress"]>[0]["onChange"]>;
type TaskPublication = {
  execution: string;
  revision: number;
  items: Map<string, ClickClackItemEventPayload>;
  activity?: ClickClackActivityPublisher;
  activityRevision?: number;
  activityItems?: Set<string>;
  assertCurrent: () => void;
};
type TurnPublication = {
  message: ClickClackMessage;
  foreground: number;
  progress?: ClickClackAgentProgressPublisher;
  waitingPresentation?: boolean;
  tasks: Map<string, TaskPublication>;
};
type SessionObservation = {
  turns: Map<string, TurnPublication>;
  controller: AbortController;
  ready?: Promise<(() => Promise<void>) | undefined>;
  refresh: () => Promise<void>;
  retirement?: Promise<void>;
};

export type ClickClackTaskProgressObserver = {
  attach(input: {
    sessionKey: string;
    agentId: string;
    message: ClickClackMessage;
    progress?: ClickClackAgentProgressPublisher;
  }): Promise<{
    progress?: ClickClackAgentProgressPublisher;
    finishForeground: () => Promise<void>;
  }>;
  restore(sessions: readonly { sessionKey: string; agentId: string }[]): Promise<void>;
  close(): Promise<void>;
};

/** Account-lifetime projection; task state and subscription authority stay with the host. */
export function createClickClackTaskProgressObserver(params: {
  runtime: PluginRuntime;
  account: ResolvedClickClackAccount;
  signal: AbortSignal;
  onError: (error: unknown) => void;
}): ClickClackTaskProgressObserver {
  const observations = new Map<string, SessionObservation>();
  const retirements = new Set<Promise<void>>();
  let closed = false;
  const client = createClickClackClient({
    baseUrl: params.account.apiEndpoint,
    token: params.account.token,
    signal: params.signal,
  });
  const closeTurn = async (turn: TurnPublication) => {
    await turn.progress?.finalize();
    await turn.progress?.flush();
    const activityFinalizations: Promise<void>[] = [];
    for (const task of turn.tasks.values()) {
      if (task.activity) {
        activityFinalizations.push(task.activity.finalize());
      }
    }
    await Promise.all(activityFinalizations);
  };
  const retire = (key: string, state: SessionObservation) => {
    if (state.retirement) {
      return state.retirement;
    }
    if (observations.get(key) === state) {
      observations.delete(key);
    }
    state.controller.abort();
    const pending = (async () => {
      const stop = await state.ready?.catch(() => undefined);
      await stop?.();
      await Promise.all([...state.turns.values()].map(closeTurn));
    })();
    state.retirement = pending;
    retirements.add(pending);
    void pending.then(
      () => retirements.delete(pending),
      () => retirements.delete(pending),
    );
    return pending;
  };
  const observe = (sessionKey: string, agentId: string) => {
    params.signal.throwIfAborted();
    if (closed) {
      throw new Error("ClickClack task observation is closed");
    }
    const key = JSON.stringify([agentId, sessionKey]);
    const existing = observations.get(key);
    if (existing) {
      return existing;
    }
    const controller = new AbortController();
    const forgetRecovery = rememberClickClackTaskRecoverySession({
      sessionKey,
      agentId,
      accountId: params.account.accountId,
    });
    const state: SessionObservation = {
      turns: new Map(),
      controller,
      async refresh() {
        const previous = state.ready;
        state.ready = (async () => {
          const stop = await previous;
          await stop?.();
          signal.throwIfAborted();
          return subscribe();
        })();
        await state.ready;
      },
    };
    observations.set(key, state);
    const signal = AbortSignal.any([params.signal, controller.signal]);
    const update = async (
      tasks: TaskUpdate[0],
      assertOwner: TaskUpdate[1],
      sources: TaskUpdate[2],
    ) => {
      const assertCurrent = () => {
        signal.throwIfAborted();
        assertOwner();
        if (observations.get(key) !== state) {
          throw new Error("ClickClack task observer was replaced");
        }
      };
      assertCurrent();
      const hasWork = tasks.some((task) => {
        if (!hasClickClackTaskRecoveryWork(task)) {
          return false;
        }
        const source = sources.get(task.id);
        // Restoration can precede source recovery. Missing correlation is not
        // proof of idle; a known foreign account is outside this observation.
        return (
          !source ||
          (source.channel === "clickclack" &&
            (source.accountId ?? "default") === params.account.accountId)
        );
      });
      const settleNative = async (
        turn: TurnPublication,
        receipts: Array<Promise<ClickClackProgressPublication>>,
      ) => {
        await turn.progress?.flush();
        const results = await Promise.all(receipts);
        assertCurrent();
        return results.every((result) => result !== "failed");
      };
      const retractItems = async (turn: TurnPublication, publication: TaskPublication) => {
        // Any partial retraction invalidates the old native dedup cursor, even
        // if a fresh running observation resumes the same prepared revision.
        publication.revision = -1;
        const receipts: Array<Promise<ClickClackProgressPublication>> = [];
        for (const item of publication.items.values()) {
          if (turn.progress) {
            receipts.push(
              turn.progress.publishItem({ ...item, hideFromChannelProgress: true }, assertCurrent),
            );
          }
        }
        if (!(await settleNative(turn, receipts))) {
          return false;
        }
        publication.items.clear();
        return true;
      };
      const discardActivity = async (publication: TaskPublication) => {
        if (publication.activityItems) {
          for (const id of publication.activityItems) {
            publication.activity?.discardPendingItem(id);
          }
        }
        await publication.activity?.finalize();
        assertCurrent();
      };
      const active = new Map<string, string>();
      const runningTurns = new Set<string>();
      const waitingTurns = new Set<string>();
      for (const task of tasks) {
        if (task.status !== "queued" && task.status !== "running") {
          continue;
        }
        const source = sources.get(task.id);
        if (
          source?.channel !== "clickclack" ||
          (source.accountId ?? "default") !== params.account.accountId ||
          typeof source.messageId !== "string" ||
          !source.messageId
        ) {
          continue;
        }
        let turn = state.turns.get(source.messageId);
        if (!turn) {
          let message: ClickClackMessage;
          try {
            message = await client.message(source.messageId);
          } catch (error) {
            assertCurrent();
            params.onError(error);
            continue;
          }
          assertCurrent();
          if (
            message.id !== source.messageId ||
            message.workspace_id !== params.account.workspace ||
            (!message.channel_id && !message.direct_conversation_id) ||
            (source.channelId &&
              String(source.channelId) !== (message.channel_id ?? message.direct_conversation_id))
          ) {
            continue;
          }
          turn = state.turns.get(message.id) ?? {
            message,
            foreground: 0,
            tasks: new Map(),
            progress: params.account.nativeProgress
              ? createClickClackAgentProgressPublisher({
                  client,
                  target: {
                    workspaceId: message.workspace_id,
                    ...(message.channel_id
                      ? { channelId: message.channel_id }
                      : { conversationId: message.direct_conversation_id }),
                  },
                  turnId: message.id,
                  onError: params.onError,
                })
              : undefined,
          };
          state.turns.set(message.id, turn);
        }
        active.set(task.id, source.messageId);
        const isRunning = task.execution?.state === "running";
        if (isRunning) {
          runningTurns.add(source.messageId);
          if (!turn.foreground) {
            if (turn.waitingPresentation) {
              for (const current of turn.tasks.values()) {
                current.revision = -1;
              }
              await turn.progress?.finalize();
              assertCurrent();
              turn.waitingPresentation = false;
            }
            turn.progress?.start("Background work is continuing", assertCurrent);
          }
        } else if (task.execution?.state === "waiting") {
          waitingTurns.add(source.messageId);
        }
        const snapshot = task.progress;
        let publication = turn.tasks.get(task.id);
        if (publication && snapshot && publication.execution !== snapshot.runId) {
          if (!(await retractItems(turn, publication))) {
            return;
          }
          await discardActivity(publication);
          turn.tasks.delete(task.id);
          publication = undefined;
        }
        if (!publication) {
          publication = {
            execution: snapshot?.runId ?? task.runId ?? "",
            revision: -1,
            items: new Map(),
            assertCurrent,
          };
          if (params.account.agentActivity) {
            const selected = publication;
            publication.activity = createClickClackActivityPublisher({
              client: {
                async createActivityMessage(input) {
                  selected.assertCurrent();
                  return client.createActivityMessage(input);
                },
                async updateMessageBody(messageId, body) {
                  selected.assertCurrent();
                  return client.updateMessageBody(messageId, body);
                },
              },
              target: turn.message.channel_id
                ? { channelId: turn.message.channel_id }
                : { conversationId: turn.message.direct_conversation_id },
              turnId: turn.message.id,
              onError: params.onError,
            });
          }
          turn.tasks.set(task.id, publication);
        }
        publication.assertCurrent = assertCurrent;
        const publishNative = isRunning && snapshot && publication.revision !== snapshot.revision;
        const publishActivity =
          publication.activity && snapshot && publication.activityRevision !== snapshot.revision;
        const items =
          publishNative || publishActivity
            ? new Map<string, ClickClackItemEventPayload>()
            : undefined;
        if (snapshot && items) {
          for (const item of snapshot.items) {
            const prepared = {
              ...item,
              itemId: JSON.stringify([task.id, snapshot.runId, item.itemId]),
            };
            items.set(prepared.itemId, prepared);
          }
        }
        if (!isRunning || !snapshot) {
          if (!(await retractItems(turn, publication))) {
            return;
          }
        }
        const receipts: Array<Promise<ClickClackProgressPublication>> = [];
        if (publishNative && items) {
          for (const [id, prepared] of items) {
            if (turn.progress) {
              receipts.push(turn.progress.publishItem(prepared, assertCurrent));
            }
            // Retain every possibly-published identity until the native batch
            // acknowledges, including across suspension or a changed snapshot.
            publication.items.set(id, prepared);
          }
          for (const [id, item] of publication.items) {
            if (!items.has(id) && turn.progress) {
              receipts.push(
                turn.progress.publishItem(
                  { ...item, hideFromChannelProgress: true },
                  assertCurrent,
                ),
              );
            }
          }
        }
        if (publishActivity && items) {
          for (const prepared of items.values()) {
            publication.activity?.onItemEvent(prepared);
          }
          if (publication.activityItems) {
            for (const id of publication.activityItems) {
              if (!items.has(id)) {
                publication.activity?.discardPendingItem(id);
              }
            }
          }
          publication.activityItems = new Set(items.keys());
        } else if (!snapshot && publication.activityItems) {
          for (const id of publication.activityItems) {
            publication.activity?.discardPendingItem(id);
          }
        }
        await publication.activity?.finalize();
        assertCurrent();
        if (publishActivity && snapshot) {
          publication.activityRevision = snapshot.revision;
        }
        if (publishNative && snapshot && items) {
          if (!(await settleNative(turn, receipts))) {
            return;
          }
          publication.items = items;
          publication.revision = snapshot.revision;
        }
      }
      for (const [turnId, turn] of state.turns) {
        if (turn.foreground && turn.tasks.size === 0) {
          continue;
        }
        for (const [taskId, publication] of turn.tasks) {
          if (active.get(taskId) !== turnId) {
            if (!(await retractItems(turn, publication))) {
              return;
            }
            await discardActivity(publication);
            turn.tasks.delete(taskId);
          }
        }
        if (!turn.foreground) {
          if (turn.tasks.size === 0) {
            await closeTurn(turn);
            assertCurrent();
            if (!turn.foreground) {
              state.turns.delete(turnId);
              continue;
            }
          }
          if (turn.foreground) {
            turn.progress?.start(undefined, assertCurrent);
          } else if (runningTurns.has(turnId)) {
            turn.progress?.setStatus("Background work is continuing", assertCurrent, {
              running: true,
            });
          } else if (waitingTurns.has(turnId)) {
            if (!turn.waitingPresentation) {
              await turn.progress?.finalize();
              assertCurrent();
              turn.waitingPresentation = true;
            }
            // Waiting is descriptive text, not a fabricated native terminal
            // status or an assertion that an executor is currently running.
            turn.progress?.start("Background work is waiting", assertCurrent, { running: false });
            turn.progress?.setStatus("Background work is waiting", assertCurrent, {
              running: false,
            });
          } else {
            await turn.progress?.finalize();
            assertCurrent();
            turn.waitingPresentation = false;
          }
        }
        await turn.progress?.flush();
        assertCurrent();
      }
      assertCurrent();
      if (!hasWork && state.turns.size === 0) {
        forgetRecovery();
        // Unsubscribe joins this callback, so retirement must not be awaited here.
        void retire(key, state).catch(params.onError);
      }
    };
    const subscribe = async () => {
      try {
        signal.throwIfAborted();
        return await params.runtime.tasks.async.runs
          .bindSession({ sessionKey, agentId })
          .observeProgress({
            signal,
            onChange: update,
            onError(error) {
              params.onError(error);
              void retire(key, state).catch(params.onError);
            },
          });
      } catch (error) {
        // Initial idle retirement aborts and joins the host's first callback
        // before observeProgress has returned its unsubscribe function.
        if (!signal.aborted) {
          throw error;
        }
        return undefined;
      }
    };
    // Attach installs its foreground turn before the initial snapshot can prove idle.
    state.ready = Promise.resolve().then(subscribe);
    void state.ready.catch((error: unknown) => {
      params.onError(error);
      void retire(key, state).catch(params.onError);
    });
    return state;
  };
  return {
    /** Reuse the original inbound correlation; never select an activity-row ID as a receipt. */
    async attach(input) {
      params.signal.throwIfAborted();
      const state = observe(input.sessionKey, input.agentId);
      const turn: TurnPublication = state.turns.get(input.message.id) ?? {
        message: input.message,
        foreground: 0,
        progress: input.progress,
        tasks: new Map(),
      };
      turn.foreground += 1;
      state.turns.set(input.message.id, turn);
      turn.progress?.start(undefined, () => {
        params.signal.throwIfAborted();
        state.controller.signal.throwIfAborted();
      });
      let finished = false;
      return {
        progress: turn.progress,
        finishForeground: async () => {
          if (finished) {
            return;
          }
          finished = true;
          // Parent settlement is not task completion. Refresh the owner snapshot
          // in the account lifecycle, without making optional progress delay replies.
          turn.foreground -= 1;
          if (closed || state.controller.signal.aborted || params.signal.aborted) {
            return;
          }
          void state.refresh().catch((error: unknown) => {
            if (state.controller.signal.aborted || params.signal.aborted) {
              return;
            }
            params.onError(error);
            void retire(JSON.stringify([input.agentId, input.sessionKey]), state).catch(
              params.onError,
            );
          });
        },
      };
    },
    async restore(sessions: readonly { sessionKey: string; agentId: string }[]) {
      for (const session of sessions) {
        params.signal.throwIfAborted();
        await observe(session.sessionKey, session.agentId).ready;
      }
    },
    async close() {
      closed = true;
      for (const [key, state] of observations) {
        void retire(key, state);
      }
      await Promise.all(retirements);
    },
  };
}
