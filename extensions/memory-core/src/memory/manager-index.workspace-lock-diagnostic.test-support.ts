import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { onTestFailed, onTestFinished, vi } from "vitest";
import * as dreamingState from "../dreaming-state.js";

type Phase =
  | "manager-creation"
  | "baseline"
  | "seeding"
  | "sql-lock"
  | "initial-syncs"
  | "rollback"
  | "recovery"
  | "close";
type Operation = "registerIfAbsent" | "observe" | "compareAndApply" | "lookup";
type Outcome =
  | "started"
  | "acquired"
  | "contended"
  | "observed"
  | "applied"
  | "unchanged"
  | "conflict"
  | "present"
  | "missing"
  | "rejected";
type Fact = { sequence: number; elapsedMs: number; phase: Phase; details: unknown };
type Summary = { count: number; first: Fact; last: Fact };
const limits = {
  objectIdentities: 128,
  scalarIdentities: 128,
  scalarCharacters: 512,
  summaryGroups: 32,
  importantGroups: 32,
  phaseMarkers: 16,
  outputBytes: 24_576,
} as const;

/** Temporary failure-only observation; every store call and promise stays owned by the real store. */
export function installMemoryWorkspaceLockDiagnostic(workspaceDir: string) {
  const workspaceKey = dreamingState.memoryCoreWorkspaceStateKey(workspaceDir);
  const startedAt = performance.now();
  const objectIdentities = new WeakMap<object, string>();
  const scalarIdentities = new Map<unknown, string>();
  const summaries = new Map<string, Summary>();
  const important = new Map<string, Summary>();
  const totals = new Map<string, number>();
  const firstErrors = new Map<Operation, Fact>();
  const observers = new Set<Promise<void>>();
  const phases: Array<Omit<Fact, "details">> = [];
  const settlements: Record<string, unknown> = {};
  const dropped = {
    objectLabelRequests: 0,
    scalarLabelRequests: 0,
    summaryFacts: 0,
    importantFacts: 0,
    phaseMarkers: 0,
    outputGroups: 0,
    outputFacts: 0,
  };
  let phase: Phase = "manager-creation";
  let sequence = 0;
  let objectLabels = 0;
  let observerFailure: { error: unknown } | undefined;

  const identity = (value: unknown): string => {
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      const existing = objectIdentities.get(value);
      if (existing) {
        return existing;
      }
      if (objectLabels === limits.objectIdentities) {
        dropped.objectLabelRequests += 1;
        return "object-overflow";
      }
      const label = `object-${++objectLabels}`;
      objectIdentities.set(value, label);
      return label;
    }
    const existing = scalarIdentities.get(value);
    if (existing) {
      return existing;
    }
    if (
      scalarIdentities.size === limits.scalarIdentities ||
      (typeof value === "string" && value.length > limits.scalarCharacters)
    ) {
      dropped.scalarLabelRequests += 1;
      return "scalar-overflow";
    }
    const label = `scalar-${scalarIdentities.size + 1}`;
    scalarIdentities.set(value, label);
    return label;
  };
  const point = () => ({
    sequence: ++sequence,
    elapsedMs: Math.round(performance.now() - startedAt),
    phase,
  });
  const row = (value: unknown) => {
    const record = asOptionalRecord(value);
    return record
      ? {
          owner: identity(record.owner),
          ownerIsCurrentProcess:
            typeof record.owner === "string" && record.owner.startsWith(`${process.pid}:`),
          acquiredAt: identity(record.acquiredAt),
          ageMs: typeof record.acquiredAt === "number" ? Date.now() - record.acquiredAt : undefined,
          ownerStartTime:
            record.ownerStartTime === undefined ? undefined : identity(record.ownerStartTime),
        }
      : { missing: true };
  };
  const rowIdentity = (value: unknown) => {
    const record = asOptionalRecord(value);
    return record
      ? [record.owner, record.acquiredAt, record.ownerStartTime].map(identity).join("/")
      : "missing";
  };
  const errorFacts = (value: unknown, depth = 0): unknown => {
    const record = asOptionalRecord(value);
    const message = typeof record?.message === "string" ? record.message : "";
    const safeCode = (code: unknown) =>
      code === undefined
        ? undefined
        : typeof code === "string" &&
            code.length <= 80 &&
            /^(?:ERR_SQLITE_|SQLITE_|PLUGIN_STATE_)[A-Z_]+$/.test(code)
          ? code
          : identity(code);
    return {
      error: identity(value),
      kind: value instanceof Error ? "Error" : typeof value,
      code: safeCode(record?.code),
      errcode: typeof record?.errcode === "number" ? record.errcode : undefined,
      message: identity(message),
      category: message.includes("Timed out waiting for memory workspace lock")
        ? "workspace-lock-timeout"
        : /SQLITE_(?:BUSY|LOCKED)|database is (?:busy|locked)/i.test(message)
          ? "sqlite-contention"
          : message.includes("observation belongs to another database, namespace or key")
            ? "comparison-scope-mismatch"
            : /closed|revoked|retired|no longer active/i.test(message)
              ? "owner-unavailable"
              : "other",
      ...(record?.cause !== undefined && depth < 2
        ? { cause: errorFacts(record.cause, depth + 1) }
        : {}),
    };
  };
  const record = (
    startPhase: Phase,
    operation: Operation,
    outcome: Outcome,
    details: unknown,
    distinction = "",
  ) => {
    const key = `${startPhase}:${operation}:${outcome}:${distinction}`;
    const fact = { ...point(), details };
    const totalKey = `${operation}:${outcome}`;
    totals.set(totalKey, (totals.get(totalKey) ?? 0) + 1);
    if (outcome === "rejected" && !firstErrors.has(operation)) {
      firstErrors.set(operation, fact);
    }
    const significant = ["acquired", "applied", "unchanged", "rejected"].includes(outcome);
    const target = significant ? important : summaries;
    const existing = target.get(key);
    if (existing) {
      existing.count += 1;
      existing.last = fact;
    } else if (target.size < (significant ? limits.importantGroups : limits.summaryGroups)) {
      target.set(key, { count: 1, first: fact, last: fact });
    } else if (significant) {
      dropped.importantFacts += 1;
    } else {
      dropped.summaryFacts += 1;
    }
  };
  const tap = <T>(
    key: string,
    operation: Operation,
    input: () => unknown,
    invoke: () => Promise<T>,
    result: (value: T) => { outcome: Outcome; details: unknown; distinction?: string },
  ): Promise<T> => {
    if (key !== workspaceKey) {
      return invoke();
    }
    const startPhase = phase;
    const inputFacts = input();
    record(startPhase, operation, "started", inputFacts);
    let actual: Promise<T>;
    try {
      actual = invoke();
    } catch (error) {
      record(startPhase, operation, "rejected", { input: inputFacts, error: errorFacts(error) });
      throw error;
    }
    const observer = actual.then(
      (value) => {
        const observed = result(value);
        record(startPhase, operation, observed.outcome, observed.details, observed.distinction);
      },
      (error: unknown) =>
        record(startPhase, operation, "rejected", { input: inputFacts, error: errorFacts(error) }),
    );
    const joined = observer.then(
      () => {
        observers.delete(joined);
      },
      (error: unknown) => {
        observerFailure ??= { error };
        observers.delete(joined);
      },
    );
    observers.add(joined);
    // Return the original operation promise; tracing must not replace its result or rejection.
    return actual;
  };

  const open = dreamingState.openMemoryCoreStateStore;
  const factory = vi
    .spyOn(dreamingState, "openMemoryCoreStateStore")
    .mockImplementation(<T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
      const store = open<T>(options);
      if (options.namespace !== dreamingState.SHORT_TERM_LOCK_NAMESPACE) {
        return store;
      }
      const observe = store.observe;
      const compare = store.compareAndApply;
      // The real keyed store is a plain object of enumerable closure methods.
      return {
        ...store,
        registerIfAbsent: (key, value, opts) =>
          tap(
            key,
            "registerIfAbsent",
            // Failed offers change their timestamp every retry but own no lease.
            () => ({}),
            () => store.registerIfAbsent(key, value, opts),
            (acquired) => ({
              outcome: acquired ? "acquired" : "contended",
              details: acquired ? row(value) : {},
              distinction: acquired ? rowIdentity(value) : undefined,
            }),
          ),
        lookup: (key) =>
          tap(
            key,
            "lookup",
            () => ({}),
            () => store.lookup(key),
            (value) => ({
              outcome: value === undefined ? "missing" : "present",
              details: row(value),
              distinction: rowIdentity(value),
            }),
          ),
        ...(observe
          ? {
              observe: (key: string) =>
                tap(
                  key,
                  "observe",
                  () => ({}),
                  () => observe.call(store, key),
                  (value) => ({
                    outcome: "observed",
                    details: { row: row(value.value), comparison: identity(value.comparison) },
                    distinction: identity(value.comparison),
                  }),
                ),
            }
          : {}),
        ...(compare
          ? {
              compareAndApply: (...args: Parameters<typeof compare>) => {
                const [key, comparison, intent] = args;
                return tap(
                  key,
                  "compareAndApply",
                  () => ({
                    comparison: identity(comparison),
                    operation: intent.operation,
                    action: intent.action,
                  }),
                  () => compare.call(store, ...args),
                  (value) => ({
                    outcome: value.status,
                    details:
                      value.status === "conflict"
                        ? {
                            row: row(value.current.value),
                            comparison: identity(value.current.comparison),
                          }
                        : { comparison: identity(comparison), action: intent.action },
                    distinction: [
                      identity(comparison),
                      intent.operation,
                      intent.action,
                      value.status === "conflict" ? identity(value.current.comparison) : "",
                    ].join("/"),
                  }),
                );
              },
            }
          : {}),
      };
    });

  // Vitest runs these after fixture afterEach cleanup, and before onTestFailed.
  onTestFinished(async () => {
    try {
      while (observers.size > 0) {
        await Promise.all(observers);
      }
      if (observerFailure) {
        throw observerFailure.error;
      }
    } finally {
      factory.mockRestore();
    }
  });
  onTestFailed(() => {
    const prefix = "[memory-workspace-diagnostic]";
    const payloadBytes = limits.outputBytes - Buffer.byteLength(prefix) - 2;
    const importantOutput: Record<string, Summary> = {};
    const summaryOutput: Record<string, Summary> = {};
    const report = {
      note: "Dropped or truncated facts are unknown, not evidence of absence.",
      limits,
      dropped,
      truncated: false,
      totals: Object.fromEntries(totals),
      firstErrors: Object.fromEntries(firstErrors),
      phases,
      settlements,
      important: importantOutput,
      summaries: summaryOutput,
    };
    for (const [source, output] of [
      [important, report.important],
      [summaries, report.summaries],
    ] as const) {
      for (const [key, value] of source) {
        output[key] = value;
        // Reserve space for the final overflow counters and truncation flag.
        if (Buffer.byteLength(JSON.stringify(report)) > payloadBytes - 1024) {
          delete output[key];
          dropped.outputGroups += 1;
          dropped.outputFacts += value.count;
        }
      }
    }
    report.truncated = Object.values(dropped).some((count) => count > 0);
    let output = JSON.stringify(report);
    if (Buffer.byteLength(output) > payloadBytes) {
      for (const summary of [...Object.values(importantOutput), ...Object.values(summaryOutput)]) {
        dropped.outputGroups += 1;
        dropped.outputFacts += summary.count;
      }
      dropped.phaseMarkers += phases.length;
      output = JSON.stringify({
        note: report.note,
        limits,
        dropped,
        truncated: true,
        detailedOutputOmitted: true,
        totals: report.totals,
        firstErrors: report.firstErrors,
        settlements,
      });
    }
    console.error(prefix, output);
  });
  phases.push(point());
  return {
    phase(next: Phase) {
      phase = next;
      if (phases.length < limits.phaseMarkers) {
        phases.push(point());
      } else {
        dropped.phaseMarkers += 1;
      }
    },
    settled(label: "active" | "queued", result: PromiseSettledResult<void> | undefined) {
      settlements[label] = {
        ...point(),
        status: result?.status ?? "missing-result",
        ...(result?.status === "rejected" ? { error: errorFacts(result.reason) } : {}),
      };
    },
  };
}

export function describeSqliteFailure(failure: unknown): string {
  const details = [String(failure)];
  if (failure && typeof failure === "object") {
    const record = failure as Record<string, unknown>;
    for (const key of ["message", "code"] as const) {
      if (typeof record[key] === "string") {
        details.push(record[key]);
      }
    }
    if (record.cause && typeof record.cause === "object") {
      const cause = record.cause as Record<string, unknown>;
      for (const key of ["message", "code"] as const) {
        if (typeof cause[key] === "string") {
          details.push(cause[key]);
        }
      }
    }
  }
  return details.join(" ");
}
