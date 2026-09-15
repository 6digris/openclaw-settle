// Temporary native-history probe. Node-only so measured leaves do not load the host timeline.
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { MessagePort, Worker, WorkerOptions } from "node:worker_threads";

// readonly-open/schema cover fresh handles; borrowed-schema covers reuse. Missing marks are unknown.
const phases = [
  "kernel-import",
  "history-body",
  "readonly-open",
  "readonly-schema",
  "borrowed-schema",
  "projection-snapshot",
  "reset-archive",
] as const;
type Phase = (typeof phases)[number];
export type HistoryProbeRecord =
  | {
      kind: "phase";
      ordinal: number;
      phase: Phase;
      event: "begin" | "end" | "failed" | "aggregate";
      elapsedMs: number;
      wallMs: number;
      userUs: number | null;
      systemUs: number | null;
      count: number;
      failures: number;
      maxMs: number;
    }
  | {
      kind: "startup";
      ordinal: number;
      worker: "new" | "reused";
      mode: "source" | "compiled" | "other";
      loader: "tsx" | "none" | "other";
      constructorMs: number | null;
    }
  | { kind: "online" | "handler"; ordinal: number; elapsedMs: number }
  | { kind: "invalid" | "truncated"; ordinal: number };

function numeric(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

// No workspace imports: these measurements also run inside the worker's import boundary.
function isProbeRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Explicit projection is shared by the private IPC and public receipt boundaries. */
export function projectHistoryProbeRecord(value: unknown): HistoryProbeRecord | undefined {
  if (!isProbeRecord(value)) {
    return undefined;
  }
  const { kind, ordinal } = value;
  if (!numeric(ordinal) || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > 25) {
    return undefined;
  }
  if (kind === "invalid" || kind === "truncated") {
    return { kind, ordinal };
  }
  if (kind === "online" || kind === "handler") {
    return numeric(value.elapsedMs) ? { kind, ordinal, elapsedMs: value.elapsedMs } : undefined;
  }
  if (kind === "startup") {
    const { worker, mode, loader, constructorMs } = value;
    if (
      (worker === "new" || worker === "reused") &&
      (mode === "source" || mode === "compiled" || mode === "other") &&
      (loader === "tsx" || loader === "none" || loader === "other") &&
      (constructorMs === null || numeric(constructorMs))
    ) {
      return { kind, ordinal, worker, mode, loader, constructorMs };
    }
  }
  if (kind === "phase") {
    const { phase, event, elapsedMs, wallMs, userUs, systemUs, count, failures, maxMs } = value;
    const knownPhase = phases.find((candidate) => candidate === phase);
    if (
      knownPhase &&
      (event === "begin" || event === "end" || event === "failed" || event === "aggregate") &&
      numeric(elapsedMs) &&
      numeric(wallMs) &&
      (userUs === null || numeric(userUs)) &&
      (systemUs === null || numeric(systemUs)) &&
      numeric(count) &&
      Number.isInteger(count) &&
      numeric(failures) &&
      Number.isInteger(failures) &&
      failures <= count &&
      numeric(maxMs)
    ) {
      return {
        kind,
        ordinal,
        phase: knownPhase,
        event,
        elapsedMs,
        wallMs,
        userUs,
        systemUs,
        count,
        failures,
        maxMs,
      };
    }
  }
  return undefined;
}

type Totals = {
  count: number;
  failures: number;
  repeatStarted?: boolean;
  wallMs: number;
  userUs: number | null;
  systemUs: number | null;
  maxMs: number;
};
type Probe = {
  closed: boolean;
  startedAt: number;
  totals: Map<Phase, Totals>;
  emit: (row: Omit<Extract<HistoryProbeRecord, { kind: "phase" }>, "ordinal">) => void;
};
const scope = new AsyncLocalStorage<Probe>();

function cpu(): NodeJS.CpuUsage | undefined {
  try {
    return process.threadCpuUsage?.();
  } catch {
    return undefined;
  }
}

export function createHistoryProbe(emit: (row: HistoryProbeRecord) => void) {
  let ordinal = 0;
  const probe: Probe = {
    closed: false,
    startedAt: performance.now(),
    totals: new Map(),
    emit(row) {
      if (probe.closed || ordinal > 24) {
        return;
      }
      try {
        emit(
          ordinal === 24
            ? { kind: "truncated", ordinal: ++ordinal }
            : { ...row, ordinal: ++ordinal },
        );
      } catch {
        // Optional IPC cannot change the handler's result, error or cleanup.
      }
    },
  };
  return {
    run<T>(operation: () => T): T {
      return scope.run(probe, operation);
    },
    close() {
      try {
        for (const [phase, totals] of probe.totals) {
          if (totals.count > 1) {
            probe.emit({
              kind: "phase",
              phase,
              event: "aggregate",
              elapsedMs: performance.now() - probe.startedAt,
              count: totals.count,
              failures: totals.failures,
              wallMs: totals.wallMs,
              userUs: totals.userUs,
              systemUs: totals.systemUs,
              maxMs: totals.maxMs,
            });
          }
        }
      } catch {
        // A missing summary is unknown, never a failed domain operation.
      } finally {
        probe.closed = true;
      }
    },
  };
}

/** Measures the existing sync/async boundary without wrapping it in another promise. */
export function beginHistoryProbePhase(phase: Phase): ((failed?: boolean) => void) | undefined {
  const probe = scope.getStore();
  if (!probe || probe.closed) {
    return undefined;
  }
  try {
    const startedAt = performance.now();
    const startedCpu = cpu();
    let totals = probe.totals.get(phase);
    if (!totals) {
      totals = { count: 0, failures: 0, wallMs: 0, userUs: 0, systemUs: 0, maxMs: 0 };
      probe.totals.set(phase, totals);
      probe.emit({
        kind: "phase",
        phase,
        event: "begin",
        elapsedMs: startedAt - probe.startedAt,
        wallMs: 0,
        userUs: null,
        systemUs: null,
        count: 0,
        failures: 0,
        maxMs: 0,
      });
    }
    if (totals.count > 0 && !totals.repeatStarted) {
      totals.repeatStarted = true;
      probe.emit({
        kind: "phase",
        phase,
        event: "begin",
        elapsedMs: startedAt - probe.startedAt,
        count: totals.count,
        failures: totals.failures,
        wallMs: totals.wallMs,
        userUs: totals.userUs,
        systemUs: totals.systemUs,
        maxMs: totals.maxMs,
      });
    }
    const aggregate = totals;
    let finished = false;
    return (failed = false) => {
      if (finished || probe.closed) {
        return;
      }
      finished = true;
      try {
        const wallMs = performance.now() - startedAt;
        const endedCpu = cpu();
        aggregate.count++;
        aggregate.failures += Number(failed);
        aggregate.wallMs += wallMs;
        aggregate.maxMs = Math.max(aggregate.maxMs, wallMs);
        aggregate.userUs =
          aggregate.userUs !== null && startedCpu && endedCpu
            ? aggregate.userUs + endedCpu.user - startedCpu.user
            : null;
        aggregate.systemUs =
          aggregate.systemUs !== null && startedCpu && endedCpu
            ? aggregate.systemUs + endedCpu.system - startedCpu.system
            : null;
        if (aggregate.count === 1) {
          probe.emit({
            kind: "phase",
            phase,
            event: failed ? "failed" : "end",
            elapsedMs: performance.now() - probe.startedAt,
            count: aggregate.count,
            failures: aggregate.failures,
            wallMs: aggregate.wallMs,
            userUs: aggregate.userUs,
            systemUs: aggregate.systemUs,
            maxMs: aggregate.maxMs,
          });
        }
      } catch {
        // Preserve the measured operation even if timing is unavailable.
      }
    };
  } catch {
    return undefined;
  }
}

const taskDiagnostics = channel("openclaw.worker.task");
export type HistoryWorkerFacts = {
  mode: "source" | "compiled" | "other";
  loader: "tsx" | "none" | "other";
  constructorMs: number | null;
};
type ParentTask = {
  id: number;
  done: boolean;
  preparedAt?: number;
  runInContext: ReturnType<typeof AsyncLocalStorage.snapshot>;
  slot?: { task?: unknown; worker?: Worker; retiring?: Promise<void> };
};

/** Observes the existing constructor; it never creates, replaces or warms a Worker. */
export function observeHistoryWorkerCreation(
  url: URL,
  options: WorkerOptions,
  defaults: string[],
  enabled: boolean,
) {
  let facts: HistoryWorkerFacts = { mode: "other", loader: "other", constructorMs: null };
  let started: number | undefined;
  try {
    const args = options.execArgv ?? process.execArgv;
    facts = {
      mode: options.eval
        ? "other"
        : /\.[cm]?ts$/.test(url.pathname)
          ? "source"
          : /\.[cm]?js$/.test(url.pathname)
            ? "compiled"
            : "other",
      loader:
        args.length === 0
          ? "none"
          : defaults.length === 2 &&
              args.length === 2 &&
              args.every((arg, index) => arg === defaults[index])
            ? "tsx"
            : "other",
      constructorMs: null,
    };
    if (enabled) {
      started = performance.now();
    }
  } catch {
    /* Unavailable constructor metadata remains other. */
  }
  return () => {
    try {
      if (started !== undefined) {
        facts.constructorMs = performance.now() - started;
      }
    } catch {
      /* Preserve construction. */
    }
    return facts;
  };
}

/** Private, task-owned observation only; the pool retains every execution decision. */
export class ParentHistoryProbe {
  private ordinal = 0;
  private workerOrdinal = 0;
  private invalid = false;
  private handler = false;
  private stopOnline: (() => void) | undefined;
  private readonly reused: boolean;
  constructor(private readonly task: ParentTask) {
    this.reused = Boolean(task.slot?.worker);
  }

  private live(worker: Worker) {
    return (
      !this.task.done &&
      !this.task.slot?.retiring &&
      this.task.slot?.task === this.task &&
      this.task.slot.worker === worker
    );
  }
  private emit(row: HistoryProbeRecord) {
    if (this.task.done || this.ordinal > 24) {
      return;
    }
    try {
      const record =
        this.ordinal === 24
          ? { kind: "truncated", ordinal: ++this.ordinal }
          : { ...row, ordinal: ++this.ordinal };
      this.task.runInContext(() =>
        taskDiagnostics.publish({ historyProbe: record, taskId: this.task.id }),
      );
    } catch {
      /* Passive observation never owns task settlement. */
    }
  }
  started(worker: Worker, facts: HistoryWorkerFacts | undefined) {
    try {
      if (!this.live(worker)) {
        return;
      }
      this.emit({
        kind: "startup",
        ordinal: 1,
        worker: this.reused ? "reused" : "new",
        mode: facts?.mode ?? "other",
        loader: facts?.loader ?? "other",
        constructorMs: this.reused ? 0 : (facts?.constructorMs ?? null),
      });
      const preparedAt = this.task.preparedAt;
      if (!this.reused && preparedAt !== undefined) {
        const online = () => {
          try {
            if (this.live(worker)) {
              this.emit({ kind: "online", ordinal: 1, elapsedMs: performance.now() - preparedAt });
            }
          } catch {
            /* Preserve startup. */
          }
        };
        worker.once("online", online);
        this.stopOnline = () => worker.off("online", online);
      }
    } catch {
      /* Preserve construction and dispatch. */
    }
  }
  receive(worker: Worker, message: Record<string, unknown>) {
    try {
      if (!this.live(worker) || message.taskId !== this.task.id || this.ordinal > 24) {
        return;
      }
      const row = projectHistoryProbeRecord(message.record);
      if (
        !row ||
        (row.kind !== "phase" && row.kind !== "truncated") ||
        row.ordinal !== this.workerOrdinal + 1
      ) {
        if (!this.invalid) {
          this.invalid = true;
          this.emit({ kind: "invalid", ordinal: 1 });
        }
        return;
      }
      this.workerOrdinal = row.ordinal;
      if (!this.handler && row.kind === "phase" && this.task.preparedAt !== undefined) {
        this.handler = true;
        this.emit({
          kind: "handler",
          ordinal: 1,
          elapsedMs: performance.now() - this.task.preparedAt,
        });
      }
      this.emit(row);
    } catch {
      if (!this.invalid) {
        this.invalid = true;
        this.emit({ kind: "invalid", ordinal: 1 });
      }
    }
  }
  stop() {
    try {
      this.stopOnline?.();
    } catch {
      /* Preserve cancellation and cleanup. */
    }
    this.stopOnline = undefined;
  }
}

// Same completion projection, called inside the pool's original captured context before settlement.
export function publishWorkerTaskCompletion(
  workerUrl: URL,
  task: {
    id: number;
    probe?: ParentHistoryProbe;
    enqueuedAt: number;
    startedAt?: number;
    preparedAt?: number;
    transferMs: number;
  },
  error: Error | undefined,
  pendingTasks: number,
  pendingBytes: number,
) {
  if (taskDiagnostics.hasSubscribers) {
    const now = performance.now();
    taskDiagnostics.publish({
      worker: workerUrl.pathname.split("/").at(-1),
      ...(task.probe ? { historyProbeTaskId: task.id } : {}),
      outcome: error ? "failed" : "ok",
      queueMs: (task.startedAt ?? now) - task.enqueuedAt,
      preparationMs: task.startedAt === undefined ? 0 : (task.preparedAt ?? now) - task.startedAt,
      runMs: task.preparedAt === undefined ? 0 : now - task.preparedAt,
      transferMs: task.transferMs,
      pendingTasks,
      pendingBytes,
    });
  }
}

export type WorkerEnvelope = {
  input: unknown;
  taskId: number;
  interactive?: boolean;
  responseId?: number;
  historyProbe?: number;
};
const noProbe = {
  run<T>(operation: () => T): T {
    return operation();
  },
  close() {},
};

/** Opens only diagnostic scope; the existing serve chain still owns every promise and reply. */
export function workerTaskProbe(message: WorkerEnvelope, port: Pick<MessagePort, "postMessage">) {
  if (message.historyProbe === 1) {
    try {
      return createHistoryProbe((record) =>
        port.postMessage({ status: "history-probe", taskId: message.taskId, record }),
      );
    } catch {
      /* Handler execution remains authoritative if probe setup fails. */
    }
  }
  return noProbe;
}
