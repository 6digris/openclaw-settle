import type { StopReason } from "@openclaw/llm-core";

export type AgentLoopDecision = Readonly<{
  decision: "continue" | "stop";
  reason:
    | "tool_results"
    | "provider_continuation"
    | "steering"
    | "follow_up"
    | "model_terminal"
    | "tool_batch_termination"
    | "tool_loop_termination"
    | "host_stop"
    | "next_turn_stop"
    | "aborted"
    | "exception"
    | "input_cancelled";
  modelTurn?: number;
  stopReason?: StopReason;
  endTurn?: boolean;
  toolResultCount?: number;
  batchTerminate?: boolean;
  streamedContinuation?: boolean;
  pendingMessageCount?: number;
}>;

type Observer = (decision: AgentLoopDecision) => void;
const observers = new WeakMap<object, Observer>();

/** Internal host diagnostics, deliberately absent from the model and plugin tool contracts. */
export function setAgentLoopObserver(owner: object, observer: Observer | undefined): void {
  if (observer) {
    observers.set(owner, observer);
  } else {
    observers.delete(owner);
  }
}

export function copyAgentLoopObserver<T extends object>(owner: object, target: T): T {
  setAgentLoopObserver(target, observers.get(owner));
  return target;
}

export function recordAgentLoopDecision(owner: object, decision: AgentLoopDecision): void {
  const observer = observers.get(owner);
  if (!observer) {
    return;
  }
  try {
    // Observers enqueue metadata only. A rejected or pending observer must never own liveness.
    void Promise.resolve(observer(Object.freeze(decision))).catch(() => {});
  } catch {
    // Diagnostic failure cannot change tool execution, continuation, or terminal delivery.
  }
}
